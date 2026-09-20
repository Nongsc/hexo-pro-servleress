// test/theme-deploy-clone.test.js
// 主题「部署时克隆」：admin 侧只选定主题 + 生成覆盖配置 + 更新 _config.yml theme 字段，
// 不再本地 git clone / npm install / 读本地主题源码。
'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const yaml = require('js-yaml');
const Module = require('module');

// ---------- 记录型 mock（回归护栏：若重新引入 clone/读源码，计数会增长） ----------

const execCalls = [];
const fseCalls = { copyFileSync: [], readFileSync: [], ensureDirSync: [], emptyDir: [] };
const hexoFsExistsSyncCalls = [];

const fakeChildProcess = {
  exec: (cmd, opts, cb) => {
    execCalls.push({ cmd, opts });
    if (cb) cb(new Error('exec blocked in test'));
  },
};

const fakeFsExtra = {
  copyFileSync: (...a) => { fseCalls.copyFileSync.push(a); },
  readFileSync: (...a) => { fseCalls.readFileSync.push(a); return ''; },
  ensureDirSync: (...a) => { fseCalls.ensureDirSync.push(a); },
  emptyDir: (...a) => { fseCalls.emptyDir.push(a); return Promise.resolve(); },
};

const fakeHexoFs = {
  existsSync: (...a) => { hexoFsExistsSyncCalls.push(a); return false; },
};

const mocks = new Map([
  ['child_process', fakeChildProcess],
  ['fs-extra', fakeFsExtra],
  ['hexo-fs', fakeHexoFs],
]);

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (mocks.has(request)) return mocks.get(request);
  return originalLoad.apply(this, arguments);
};
const themeApi = require('../api/theme_api');
Module._load = originalLoad;

const { defaultThemeConfig } = themeApi._test;

// ---------- 最小 mock ----------

function makeSiteConfig(seed = {}) {
  const map = new Map(Object.entries(seed));
  const getCalls = [];
  const setCalls = [];
  return {
    map,
    getCalls,
    setCalls,
    get: async (type) => { getCalls.push(type); return map.has(type) ? map.get(type) : null; },
    set: async (type, content, opts) => { setCalls.push({ type, content, opts }); map.set(type, content); return { type, content }; },
  };
}

function makeHexo(overrides = {}) {
  const hexo = {
    siteConfig: makeSiteConfig(),
    config: { theme: 'landscape' },
    log: { info: () => {}, error: () => {}, warn: () => {} },
  };
  return Object.assign(hexo, overrides);
}

function registerRoutes(hexo) {
  const handlers = {};
  const use = (name, fn) => { handlers[name] = fn; };
  themeApi({}, hexo, use, null);
  return handlers;
}

function fakeRes() {
  const res = {};
  res.done = (v) => { res._done = v; };
  res.send = (s, d) => { res._send = [s, d]; };
  return res;
}

beforeEach(() => {
  execCalls.length = 0;
  fseCalls.copyFileSync.length = 0;
  fseCalls.readFileSync.length = 0;
  fseCalls.ensureDirSync.length = 0;
  fseCalls.emptyDir.length = 0;
  hexoFsExistsSyncCalls.length = 0;
});

// ---------- defaultThemeConfig ----------

test('defaultThemeConfig 生成最小合法 YAML 占位符（不含本地源码内容）', () => {
  const content = defaultThemeConfig({ id: 'anzhiyu', name: '安知鱼' });
  assert.equal(typeof content, 'string');
  assert.match(content, /安知鱼/);
  assert.match(content, /anzhiyu/);
  assert.doesNotThrow(() => yaml.load(content), '占位符应能解析为合法 YAML');
});

// ---------- theme/install ----------

test('theme/install：选定主题，写默认覆盖配置与 _config.yml theme 字段，不执行 clone/exec', async () => {
  const siteConfig = makeSiteConfig();
  const hexo = makeHexo({ siteConfig });
  const handlers = registerRoutes(hexo);
  const res = fakeRes();

  await handlers['theme/install']({ method: 'POST', body: { themeId: 'anzhiyu' } }, res, () => {});

  assert.ok(res._done, '应成功返回');
  assert.equal(res._done.success, true);
  assert.equal(res._done.message, '主题已选定，将在部署构建阶段克隆');
  assert.equal(res._done.themeDir, 'anzhiyu');

  // (a) 写入 theme:<id> 默认覆盖配置
  const themeConfig = siteConfig.map.get('theme:anzhiyu');
  assert.ok(typeof themeConfig === 'string', '应写入 theme:anzhiyu 默认配置');
  assert.match(themeConfig, /anzhiyu/);
  assert.match(themeConfig, /安知鱼/);

  // (b) 写入 site 的 theme 字段
  const siteContent = siteConfig.map.get('site');
  assert.ok(siteContent, '应写入 site 配置');
  assert.equal(yaml.load(siteContent).theme, 'anzhiyu');

  // 内存 theme 同步
  assert.equal(hexo.config.theme, 'anzhiyu');

  // 不 clone / 不 exec / 不落盘
  assert.equal(execCalls.length, 0, '不应调用 exec（git clone / npm install）');
  assert.equal(fseCalls.copyFileSync.length, 0);
  assert.equal(fseCalls.ensureDirSync.length, 0);
  assert.equal(hexoFsExistsSyncCalls.length, 0, '不应调用 fs.existsSync');
});

test('theme/install：已存在覆盖配置时不覆盖，但仍更新 site theme 字段', async () => {
  const siteConfig = makeSiteConfig({ 'theme:anzhiyu': '# existing\n' });
  const hexo = makeHexo({ siteConfig });
  const handlers = registerRoutes(hexo);
  const res = fakeRes();

  await handlers['theme/install']({ method: 'POST', body: { themeId: 'anzhiyu' } }, res, () => {});

  assert.ok(res._done && res._done.success);
  assert.equal(siteConfig.map.get('theme:anzhiyu'), '# existing\n', '不应覆盖已有覆盖配置');
  assert.equal(yaml.load(siteConfig.map.get('site')).theme, 'anzhiyu');
});

// ---------- theme/installed ----------

test('theme/installed：installed 基于 DB（builtin 恒 true），不调用 fs.existsSync', async () => {
  const hexo = makeHexo(); // config.theme = 'landscape'
  const handlers = registerRoutes(hexo);
  const res = fakeRes();

  await handlers['theme/installed']({ query: { themeId: 'anzhiyu' } }, res, () => {});

  assert.deepEqual(res._done, { installed: true, isCurrent: false });
  assert.equal(hexoFsExistsSyncCalls.length, 0, '不应调用 fs.existsSync');
});

test('theme/installed：未知主题返回 installed:false', async () => {
  const hexo = makeHexo();
  const handlers = registerRoutes(hexo);
  const res = fakeRes();

  await handlers['theme/installed']({ query: { themeId: 'nope' } }, res, () => {});

  assert.deepEqual(res._done, { installed: false });
});

// ---------- theme/current ----------

test('theme/current：builtin 主题恒 installed，不读磁盘', async () => {
  const hexo = makeHexo();
  hexo.config.theme = 'anzhiyu';
  const handlers = registerRoutes(hexo);
  const res = fakeRes();

  await handlers['theme/current']({}, res, () => {});

  assert.equal(res._done.installed, true);
  assert.equal(res._done.builtin, true);
  assert.equal(res._done.name, 'anzhiyu');
  assert.equal(hexoFsExistsSyncCalls.length, 0, '不应调用 fs.existsSync');
});

test('theme/current：非 builtin 主题按 siteConfig（theme:<id>）判断 installed', async () => {
  const siteConfig = makeSiteConfig({ 'theme:landscape': '# cfg\n' });
  const hexo = makeHexo({ siteConfig });
  hexo.config.theme = 'landscape';
  const handlers = registerRoutes(hexo);
  const res = fakeRes();

  await handlers['theme/current']({}, res, () => {});

  assert.equal(res._done.installed, true, '存在 theme:<id> 覆盖配置 → installed');
  assert.equal(res._done.builtin, false);
  assert.equal(hexoFsExistsSyncCalls.length, 0);

  // 无覆盖配置 → installed false
  const hexo2 = makeHexo();
  hexo2.config.theme = 'landscape';
  const handlers2 = registerRoutes(hexo2);
  const res2 = fakeRes();
  await handlers2['theme/current']({}, res2, () => {});
  assert.equal(res2._done.installed, false);
});

// ---------- theme/switch ----------

test('theme/switch：切换主题，生成默认覆盖配置，不 readFileSync 本地源码', async () => {
  const siteConfig = makeSiteConfig({ site: 'theme: landscape\n' });
  const hexo = makeHexo({ siteConfig }); // config.theme = 'landscape'
  const handlers = registerRoutes(hexo);
  const res = fakeRes();

  await handlers['theme/switch']({ method: 'POST', body: { themeId: 'butterfly' } }, res, () => {});

  assert.ok(res._done && res._done.success);
  assert.equal(res._done.themeDir, 'butterfly');
  assert.equal(res._done.configCopied, true, '无覆盖配置时应生成默认配置');
  assert.equal(yaml.load(siteConfig.map.get('site')).theme, 'butterfly');
  assert.equal(hexo.config.theme, 'butterfly');

  const themeConfig = siteConfig.map.get('theme:butterfly');
  assert.ok(typeof themeConfig === 'string');
  assert.match(themeConfig, /Butterfly/);

  assert.equal(fseCalls.readFileSync.length, 0, '不应 readFileSync 本地主题源码');
  assert.equal(hexoFsExistsSyncCalls.length, 0, '不应 fs.existsSync');
});

test('theme/switch：_config.yml 已是目标主题时返回「已经是当前主题」', async () => {
  const siteConfig = makeSiteConfig({ site: 'theme: butterfly\n' });
  const hexo = makeHexo({ siteConfig });
  hexo.config.theme = 'butterfly';
  const handlers = registerRoutes(hexo);
  const res = fakeRes();

  await handlers['theme/switch']({ method: 'POST', body: { themeId: 'butterfly' } }, res, () => {});

  assert.equal(res._done.success, true);
  assert.equal(res._done.needRestart, false);
  assert.equal(res._done.message, '已经是当前主题');
});

test('theme/switch：已有覆盖配置时不重复生成（configCopied=false）', async () => {
  const siteConfig = makeSiteConfig({ site: 'theme: landscape\n', 'theme:stellar': '# existing\n' });
  const hexo = makeHexo({ siteConfig });
  const handlers = registerRoutes(hexo);
  const res = fakeRes();

  await handlers['theme/switch']({ method: 'POST', body: { themeId: 'stellar' } }, res, () => {});

  assert.ok(res._done && res._done.success);
  assert.equal(res._done.configCopied, false);
  assert.equal(siteConfig.map.get('theme:stellar'), '# existing\n', '不应覆盖已有配置');
});
