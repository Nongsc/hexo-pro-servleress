'use strict';
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs'); // node 原生 fs（未被 spy，供断言读取磁盘）
const Module = require('module');

// ---------- mock multer + 对象存储 SDK（不真连网） ----------

function makeFakeMulter() {
  const calls = { memoryStorage: 0, diskStorage: 0 };
  function multer(opts) {
    return {
      any: () => (req, res, cb) => cb(null),
      single: () => (req, res, cb) => cb(null),
    };
  }
  multer.memoryStorage = () => { calls.memoryStorage++; return { __memoryStorage: true }; };
  multer.diskStorage = () => { calls.diskStorage++; throw new Error('diskStorage 不应被使用'); };
  multer.__calls = calls;
  return multer;
}
const fakeMulter = makeFakeMulter();

class FakeCOS {
  constructor(opts) { this.opts = opts; this.putObjectCalls = []; FakeCOS.instances.push(this); }
  putObject(params, cb) { this.putObjectCalls.push(params); cb(null, { statusCode: 200 }); }
}
FakeCOS.instances = [];

class FakeOSS {
  constructor(opts) { this.opts = opts; this.putCalls = []; FakeOSS.instances.push(this); }
  put(key, data) { this.putCalls.push({ key, data }); return Promise.resolve({ url: `https://cdn.example.com/${key}` }); }
}
FakeOSS.instances = [];

class FakeFormUploader {
  constructor(cfg) { this.cfg = cfg; this.putCalls = []; FakeFormUploader.instances.push(this); }
  put(token, key, data, extra, cb) { this.putCalls.push({ token, key, data }); cb(null, { key }, { statusCode: 200 }); }
}
FakeFormUploader.instances = [];

const fakeQiniu = {
  auth: { digest: { Mac: class { constructor(ak, sk) { this.ak = ak; this.sk = sk; } } } },
  rs: { PutPolicy: class { constructor(opts) { this.opts = opts; } uploadToken() { return 'token-123'; } } },
  conf: { Config: class { constructor() { this.zone = null; } } },
  zone: { Zone_z0: 'z0', Zone_z1: 'z1', Zone_z2: 'z2' },
  form_up: { FormUploader: FakeFormUploader },
};

const mocks = new Map([
  ['multer', fakeMulter],
  ['cos-nodejs-sdk-v5', FakeCOS],
  ['ali-oss', FakeOSS],
  ['qiniu', fakeQiniu],
]);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (mocks.has(request)) return mocks.get(request);
  return originalLoad.apply(this, arguments);
};
const imageApi = require('../api/image_api');
Module._load = originalLoad;

// ---------- spy fs-extra（image_api.js 内部 `const fs = require('fs-extra')`） ----------

const fse = require('fs-extra');
const fsCalls = { readFileSync: [], unlinkSync: [], writeFileSync: [], moveSync: [] };
const orig = {
  readFileSync: fse.readFileSync,
  unlinkSync: fse.unlinkSync,
  writeFileSync: fse.writeFileSync,
  moveSync: fse.moveSync,
};
fse.readFileSync = (...a) => { fsCalls.readFileSync.push(a); return orig.readFileSync(...a); };
fse.unlinkSync = (...a) => { fsCalls.unlinkSync.push(a); return orig.unlinkSync(...a); };
fse.writeFileSync = (...a) => { fsCalls.writeFileSync.push(a); return orig.writeFileSync(...a); };
fse.moveSync = (...a) => { fsCalls.moveSync.push(a); return orig.moveSync(...a); };

const tmpDirs = [];
function resetFsCalls() {
  fsCalls.readFileSync.length = 0;
  fsCalls.unlinkSync.length = 0;
  fsCalls.writeFileSync.length = 0;
  fsCalls.moveSync.length = 0;
}
function setupImageApi() {
  const handlers = {};
  const use = (name, fn) => { handlers[name] = fn; };
  const hexo = {
    upload_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'img-upload-')),
    config: { url: 'http://localhost:8001', root: '/' },
  };
  tmpDirs.push(hexo.upload_dir);
  imageApi({}, hexo, use, {});
  return { handlers, hexo };
}
function fakeRes() {
  const res = { _done: undefined, _send: undefined };
  res.done = (v) => { res._done = v; };
  res.send = (s, d) => { res._send = [s, d]; };
  return res;
}
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => { resetFsCalls(); });
afterEach(() => {
  delete global.hexoProStorageConfig;
  delete process.env.VERCEL;
  delete process.env.EDGEONE;
  delete process.env.SERVERLESS;
});
after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
});

// ---------- image_api 测试 ----------

test('multer 改用 memoryStorage（不再使用 diskStorage）', () => {
  setupImageApi();
  assert.ok(fakeMulter.__calls.memoryStorage >= 1, '应调用 memoryStorage');
  assert.equal(fakeMulter.__calls.diskStorage, 0, '不应调用 diskStorage');
});

test('本地 multipart 上传：写盘用 buffer，不依赖 f.path', async () => {
  const { handlers, hexo } = setupImageApi();
  global.hexoProStorageConfig = { type: 'local', customPath: 'images', aliyun: {}, qiniu: {}, tencent: {} };
  const buf = Buffer.from('fake-image-bytes');
  const req = {
    headers: { 'content-type': 'multipart/form-data' },
    query: {},
    body: { folder: '', storageType: 'local' },
    files: [{ buffer: buf, originalname: 'photo.png', path: path.join(os.tmpdir(), 'no-such-file-xyz') }],
  };
  const res = fakeRes();
  handlers['images/upload'](req, res, () => {});
  assert.ok(res._done, '应成功返回');
  assert.equal(res._done.code, 0);
  assert.equal(res._done.name, 'photo.png');
  const writes = fsCalls.writeFileSync.filter((c) => c[1] && Buffer.isBuffer(c[1]));
  assert.ok(writes.length >= 1, '应调用 writeFileSync');
  assert.ok(writes[0][1].equals(buf), '写入内容应等于上传 buffer');
  assert.equal(fsCalls.moveSync.length, 0, '不应调用 moveSync（即不依赖 multer 临时文件路径）');
  const dst = path.join(hexo.upload_dir, 'images', 'photo.png');
  assert.ok(fs.existsSync(dst), '文件应落在 upload_dir/images 下');
  assert.ok(fs.readFileSync(dst).equals(buf));
});

test('本地 multipart 上传：无文件名时不依赖 f.filename，回退 uuid', async () => {
  const { handlers } = setupImageApi();
  global.hexoProStorageConfig = { type: 'local', customPath: 'images', aliyun: {}, qiniu: {}, tencent: {} };
  const req = {
    headers: { 'content-type': 'multipart/form-data' },
    query: {},
    body: { folder: '' },
    files: [{ buffer: Buffer.from('x'), originalname: '' }],
  };
  const res = fakeRes();
  handlers['images/upload'](req, res, () => {});
  assert.equal(res._done && res._done.code, 0, '应成功（不因 f.filename 未定义而报错）');
  assert.equal(res._send, undefined, '不应返回 500');
});

test('腾讯云 multipart 上传：用 req.file.buffer，不读盘不 unlink', async () => {
  FakeCOS.instances.length = 0;
  const { handlers } = setupImageApi();
  global.hexoProStorageConfig = {
    type: 'tencent',
    customPath: 'images',
    tencent: { region: 'ap-guangzhou', bucket: 'bkt', secretId: 'sid', secretKey: 'skey', domain: 'https://cdn.example.com' },
  };
  const buf = Buffer.from('tencent-bytes');
  const req = {
    headers: { 'content-type': 'multipart/form-data' },
    query: {},
    body: { storageType: 'tencent' },
    file: { buffer: buf, originalname: 't.png', path: path.join(os.tmpdir(), 'no-such-qq') },
  };
  const res = fakeRes();
  handlers['images/upload'](req, res, () => {});
  await flush();
  assert.ok(res._done, '应成功返回');
  assert.equal(res._done.code, 0);
  const cos = FakeCOS.instances[0];
  assert.ok(cos, '应创建 COS 客户端');
  const put = cos.putObjectCalls[0];
  assert.ok(put, '应调用 putObject');
  assert.ok(Buffer.isBuffer(put.Body) && put.Body.equals(buf), 'putObject Body 应为上传 buffer');
  assert.equal(fsCalls.readFileSync.length, 0, '不应 readFileSync req.file.path');
  assert.equal(fsCalls.unlinkSync.length, 0, '不应 unlinkSync 临时文件');
  assert.equal(fsCalls.writeFileSync.length, 0, '不应写本地盘');
});

test('阿里云 multipart 上传：用 req.file.buffer，不读盘不 unlink', async () => {
  FakeOSS.instances.length = 0;
  const { handlers } = setupImageApi();
  global.hexoProStorageConfig = {
    type: 'aliyun',
    customPath: 'images',
    aliyun: { region: 'oss-cn-hangzhou', bucket: 'bkt', accessKeyId: 'ak', accessKeySecret: 'sk', domain: 'https://cdn.example.com' },
  };
  const buf = Buffer.from('aliyun-bytes');
  const req = {
    headers: { 'content-type': 'multipart/form-data' },
    query: {},
    body: { storageType: 'aliyun' },
    file: { buffer: buf, originalname: 'a.png', path: path.join(os.tmpdir(), 'no-such-ali') },
  };
  const res = fakeRes();
  handlers['images/upload'](req, res, () => {});
  await flush();
  assert.ok(res._done, '应成功返回');
  assert.equal(res._done.code, 0);
  const client = FakeOSS.instances[0];
  assert.ok(client, '应创建 OSS 客户端');
  const put = client.putCalls[0];
  assert.ok(put, '应调用 put');
  assert.ok(Buffer.isBuffer(put.data) && put.data.equals(buf), 'put 数据应为上传 buffer');
  assert.equal(fsCalls.readFileSync.length, 0, '不应 readFileSync req.file.path');
  assert.equal(fsCalls.unlinkSync.length, 0, '不应 unlinkSync 临时文件');
  assert.equal(fsCalls.writeFileSync.length, 0, '不应写本地盘');
});

test('七牛云 multipart 上传：用 req.file.buffer，不读盘不 unlink', async () => {
  FakeFormUploader.instances.length = 0;
  const { handlers } = setupImageApi();
  global.hexoProStorageConfig = {
    type: 'qiniu',
    customPath: 'images',
    qiniu: { region: 'Zone_z0', bucket: 'bkt', accessKey: 'ak', secretKey: 'sk', domain: 'https://cdn.example.com' },
  };
  const buf = Buffer.from('qiniu-bytes');
  const req = {
    headers: { 'content-type': 'multipart/form-data' },
    query: {},
    body: { storageType: 'qiniu' },
    file: { buffer: buf, originalname: 'q.png', path: path.join(os.tmpdir(), 'no-such-qn') },
  };
  const res = fakeRes();
  handlers['images/upload'](req, res, () => {});
  await flush();
  assert.ok(res._done, '应成功返回');
  assert.equal(res._done.code, 0);
  const fu = FakeFormUploader.instances[0];
  assert.ok(fu, '应创建 FormUploader');
  const put = fu.putCalls[0];
  assert.ok(put, '应调用 put');
  assert.ok(Buffer.isBuffer(put.data) && put.data.equals(buf), 'put 数据应为上传 buffer');
  assert.equal(fsCalls.readFileSync.length, 0, '不应 readFileSync req.file.path');
  assert.equal(fsCalls.unlinkSync.length, 0, '不应 unlinkSync 临时文件');
  assert.equal(fsCalls.writeFileSync.length, 0, '不应写本地盘');
});

// ---------- settings_api 头像端点（serverless 分支） ----------

const settingsApi = require('../api/settings_api');
const { isServerless } = require('../lib/config');

test('isServerless 识别 VERCEL / EDGEONE / SERVERLESS', () => {
  assert.equal(isServerless({ VERCEL: '1' }), true);
  assert.equal(isServerless({ EDGEONE: '1' }), true);
  assert.equal(isServerless({ SERVERLESS: 'true' }), true);
  assert.equal(isServerless({}), false);
  assert.equal(isServerless({ VERCEL: '0' }), false);
  assert.equal(isServerless({ SERVERLESS: 'false' }), false);
});

test('头像上传在 serverless 下不落盘，base64 直接存 dataURL', () => {
  process.env.VERCEL = '1';
  const handlers = {};
  const use = (name, fn) => { handlers[name] = fn; };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-'));
  tmpDirs.push(tmp);
  const userDb = {
    updates: [],
    update(q, u, opts, cb) { this.updates.push({ q, u, opts }); cb(null, 1); },
  };
  settingsApi({}, { upload_dir: tmp, config: { url: 'http://localhost:8001' } }, use, { userDb });
  const h = handlers['settings/upload-avatar'];
  const res = fakeRes();
  const req = { auth: { username: 'alice' }, body: { data: 'data:image/png;base64,AAAA', filename: 'a.png' } };
  h(req, res);
  assert.ok(res._done, '应成功返回');
  assert.equal(res._done.code, 0);
  assert.equal(res._done.data.url, 'data:image/png;base64,AAAA');
  assert.equal(userDb.updates.length, 1, '应更新用户记录');
  assert.equal(userDb.updates[0].u.$set.avatar, 'data:image/png;base64,AAAA');
  assert.ok(!fs.existsSync(path.join(tmp, 'images')), 'serverless 下不应创建 images 目录');
});
