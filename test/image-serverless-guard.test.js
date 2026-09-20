'use strict';
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs'); // 原生 fs，未被 spy，供断言读取磁盘
const Module = require('module');

// ---------- mock multer + 对象存储 SDK（不真连网） ----------

function makeFakeMulter() {
  const calls = { memoryStorage: 0 };
  function multer() {
    return {
      any: () => (req, res, cb) => cb(null),
      single: () => (req, res, cb) => cb(null),
    };
  }
  multer.memoryStorage = () => { calls.memoryStorage++; return { __memoryStorage: true }; };
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
  constructor(opts) { this.opts = opts; }
  put(key, data) { return Promise.resolve({ url: `https://cdn.example.com/${key}` }); }
}

const fakeQiniu = {
  auth: { digest: { Mac: class { constructor() {} } } },
  rs: { PutPolicy: class { constructor() {} uploadToken() { return 't'; } } },
  conf: { Config: class { constructor() { this.zone = null; } } },
  zone: { Zone_z0: 'z0' },
  form_up: { FormUploader: class { put(token, key, data, extra, cb) { cb(null, { key }, { statusCode: 200 }); } } },
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

// ---------- spy fs-extra 的 writeFileSync，断言 serverless+local 不落盘 ----------

const fse = require('fs-extra');
const writeCalls = [];
const origWriteFileSync = fse.writeFileSync;
fse.writeFileSync = (...a) => { writeCalls.push(a); return origWriteFileSync(...a); };

const tmpDirs = [];
function setupImageApi() {
  const handlers = {};
  const use = (name, fn) => { handlers[name] = fn; };
  const hexo = {
    upload_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'img-guard-')),
    config: { url: 'http://localhost:8001', root: '/' },
  };
  tmpDirs.push(hexo.upload_dir);
  imageApi({}, hexo, use, {});
  return { handlers, hexo };
}
function fakeRes() {
  const res = {};
  res.done = (v) => { res._done = v; };
  res.send = (s, d) => { res._send = [s, d]; };
  return res;
}

const MSG = 'serverless 环境请配置对象存储（COS/OSS/七牛）';

beforeEach(() => { writeCalls.length = 0; });
afterEach(() => {
  delete global.hexoProStorageConfig;
  delete process.env.VERCEL;
  delete process.env.EDGEONE;
  delete process.env.SERVERLESS;
  writeCalls.length = 0;
});
after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
});

// ---------- 守卫测试 ----------

test('serverless + local：upload/list/delete 返回 400 与明确消息且不落盘', async () => {
  process.env.VERCEL = '1';
  const { handlers, hexo } = setupImageApi();
  global.hexoProStorageConfig = { type: 'local', customPath: 'images', aliyun: {}, qiniu: {}, tencent: {} };

  const uploadRes = fakeRes();
  await handlers['images/upload']({
    headers: { 'content-type': 'application/json' },
    query: {},
    body: { data: 'data:image/png;base64,AAAA', filename: 'a.png' },
  }, uploadRes, () => {});
  assert.deepEqual(uploadRes._send, [400, MSG], 'upload 应返回 400 与明确消息');
  assert.equal(uploadRes._done, undefined, 'upload 不应成功');

  const listRes = fakeRes();
  await handlers['images/list']({ query: {} }, listRes, () => {});
  assert.deepEqual(listRes._send, [400, MSG], 'list 应返回 400 与明确消息');

  const delRes = fakeRes();
  await handlers['images/delete']({ body: { path: 'images/a.png' }, query: {} }, delRes, () => {});
  assert.deepEqual(delRes._send, [400, MSG], 'delete 应返回 400 与明确消息');

  assert.equal(writeCalls.length, 0, '不应写本地盘');
  assert.ok(!fs.existsSync(path.join(hexo.upload_dir, 'images')), '不应创建 images 目录');
});

test('serverless + local：移动/重命名/新建文件夹/回收站等入口同样 400', async () => {
  process.env.SERVERLESS = 'true';
  const { handlers, hexo } = setupImageApi();
  global.hexoProStorageConfig = { type: 'local', customPath: 'images', aliyun: {}, qiniu: {}, tencent: {} };

  const cases = [
    ['images/move', { body: { path: 'images/a.png', targetFolder: 'sub' }, query: {} }],
    ['images/rename', { body: { oldPath: 'images/a.png', newName: 'b.png' }, query: {} }],
    ['images/createFolder', { body: { folderName: 'sub' } }],
    ['images/folder/delete', { body: { folder: 'sub', recursive: true } }],
    ['images/delete/batch', { body: { paths: ['images/a.png'] }, query: {} }],
    ['images/unused/cleanup', { body: { keys: ['images/a.png'], useRecycleBin: false } }],
    ['images/unused', { query: {} }],
    ['images/migrate', { headers: {}, body: { urls: ['https://example.com/a.png'] }, query: {} }],
  ];

  for (const [name, req] of cases) {
    const res = fakeRes();
    await handlers[name](req, res, () => {});
    assert.deepEqual(res._send, [400, MSG], `${name} 应返回 400`);
    assert.equal(res._done, undefined, `${name} 不应成功`);
  }
  assert.ok(!fs.existsSync(path.join(hexo.upload_dir, 'images')), '不应创建 images 目录');
});

test('SERVERLESS 非精确 "true" 不触发守卫（R8 判定语义）', async () => {
  process.env.SERVERLESS = '1'; // truthy 但非 'true'
  const { handlers } = setupImageApi();
  global.hexoProStorageConfig = { type: 'local', customPath: 'images', aliyun: {}, qiniu: {}, tencent: {} };
  const res = fakeRes();
  await handlers['images/list']({ query: {} }, res, () => {});
  assert.equal(res._send, undefined, '不应返回 400');
  assert.ok(res._done, '本地照常返回列表');
});

test('serverless + 远程（腾讯云 mock）上传不受影响', async () => {
  process.env.VERCEL = '1';
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
    file: { buffer: buf, originalname: 't.png' },
  };
  const res = fakeRes();
  handlers['images/upload'](req, res, () => {});
  await new Promise((r) => setImmediate(r));
  assert.ok(res._done, '应成功返回');
  assert.equal(res._done.code, 0);
  assert.equal(FakeCOS.instances.length, 1, '应创建 COS 客户端');
  assert.equal(writeCalls.length, 0, '不应写本地盘');
});

test('非 serverless：local 上传照常可用', () => {
  const { handlers, hexo } = setupImageApi();
  global.hexoProStorageConfig = { type: 'local', customPath: 'images', aliyun: {}, qiniu: {}, tencent: {} };
  const buf = Buffer.from('fake-image-bytes');
  const req = {
    headers: { 'content-type': 'multipart/form-data' },
    query: {},
    body: { folder: '', storageType: 'local' },
    files: [{ buffer: buf, originalname: 'photo.png' }],
  };
  const res = fakeRes();
  handlers['images/upload'](req, res, () => {});
  assert.ok(res._done, '应成功返回');
  assert.equal(res._done.code, 0);
  assert.ok(fs.existsSync(path.join(hexo.upload_dir, 'images', 'photo.png')), '文件应落盘');
});

test('非 serverless：local 列表/删除照常可用', async () => {
  const { handlers, hexo } = setupImageApi();
  global.hexoProStorageConfig = { type: 'local', customPath: 'images', aliyun: {}, qiniu: {}, tencent: {} };
  const imgDir = path.join(hexo.upload_dir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  fs.writeFileSync(path.join(imgDir, 'a.png'), Buffer.from('x'));

  const listRes = fakeRes();
  await handlers['images/list']({ query: {} }, listRes, () => {});
  assert.equal(listRes._send, undefined, '列表不应返回 400');
  assert.ok(listRes._done, '列表应成功返回');
  assert.equal(listRes._done.total, 1);

  const delRes = fakeRes();
  await handlers['images/delete']({ body: { path: 'images/a.png' }, query: {} }, delRes, () => {});
  assert.equal(delRes._send, undefined, '删除不应返回 400');
  assert.ok(delRes._done && delRes._done.success, '删除应成功');
  assert.ok(!fs.existsSync(path.join(imgDir, 'a.png')), '文件应被删除');
});
