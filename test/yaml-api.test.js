// test/yaml-api.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const yamlApi = require('../api/yaml_api');

const { resolveManagedType, readTemplates, writeTemplates } = yamlApi._test;

// 路由注册工厂的最小 harness：收集 use(path, fn) 注册的处理器
function collectRoutes() {
  const routes = {};
  return {
    routes,
    use: (path, fn) => { routes[path] = fn; },
  };
}

function fakeRes() {
  const res = {
    calls: [],
    send: function (num, data) { res.calls.push(['send', num, data]); return res; },
    done: function (val) { res.calls.push(['done', val]); return res; },
  };
  return res;
}

test('resolveManagedType 映射三类受管对象', () => {
  assert.equal(resolveManagedType('_config.yml'), 'site');
  assert.equal(resolveManagedType('_config.yaml'), 'site');
  assert.equal(resolveManagedType('_config.anzhiyu.yml'), 'theme:anzhiyu');
  assert.equal(resolveManagedType('_config.next.yaml'), 'theme:next');
  assert.equal(resolveManagedType('templates.json'), 'templates');
  assert.equal(resolveManagedType('_yaml_templates/templates.json'), 'templates');
});

test('resolveManagedType 非受管路径返回 null', () => {
  assert.equal(resolveManagedType('_posts/hello.yml'), null);
  assert.equal(resolveManagedType('source/_config.yml'), null);
  assert.equal(resolveManagedType('other.json'), null);
  assert.equal(resolveManagedType(null), null);
  assert.equal(resolveManagedType(''), null);
});

test('templates JSON 往返', async () => {
  const map = new Map();
  const siteConfig = {
    get: async (type) => (map.has(type) ? map.get(type) : null),
    set: async (type, content) => { map.set(type, content); return { type, content }; },
  };
  const hexo = { siteConfig };

  const templates = [{ id: '1', name: 'A', structure: 'x', variables: [] }];
  await writeTemplates(hexo, templates);
  const read = await readTemplates(hexo);
  assert.deepEqual(read, templates);
});

test('readTemplates 空或坏 JSON 返回 []', async () => {
  assert.deepEqual(await readTemplates({ siteConfig: { get: async () => null } }), []);
  assert.deepEqual(await readTemplates({ siteConfig: { get: async () => '{bad json' } }), []);
  assert.deepEqual(await readTemplates({ siteConfig: { get: async () => '{"not":"array"}' } }), []);
});

test('yaml/delete 返回「暂不支持」且不写 siteConfig（R30）', async () => {
  const sets = [];
  const hexo = {
    siteConfig: {
      get: async () => null,
      set: async (type, content) => { sets.push({ type, content }); },
    },
    log: { error: () => {} },
  };
  const { routes, use } = collectRoutes();
  yamlApi({}, hexo, use);

  const res = fakeRes();
  await routes['yaml/delete']({ body: { path: '_config.yml' } }, res);

  assert.equal(sets.length, 0, '不应调用 siteConfig.set');
  assert.equal(res.calls[0][0], 'send');
  assert.equal(res.calls[0][1], 400);
});

test('yaml/update 受管路径委托 siteConfig.set', async () => {
  const sets = [];
  const hexo = {
    siteConfig: {
      get: async () => null,
      set: async (type, content, opts) => { sets.push({ type, content, opts }); },
    },
    log: { error: () => {} },
  };
  const { routes, use } = collectRoutes();
  yamlApi({}, hexo, use);

  const res = fakeRes();
  await routes['yaml/update']({ body: { path: '_config.yml', content: 'title: X' } }, res);

  assert.equal(sets.length, 1);
  assert.equal(sets[0].type, 'site');
  assert.equal(sets[0].content, 'title: X');
  assert.equal(res.calls[0][0], 'done');
});

test('yaml/update 非受管路径返回「暂不支持」', async () => {
  const sets = [];
  const hexo = {
    siteConfig: { get: async () => null, set: async () => { sets.push(1); } },
    log: { error: () => {} },
  };
  const { routes, use } = collectRoutes();
  yamlApi({}, hexo, use);

  const res = fakeRes();
  await routes['yaml/update']({ body: { path: '_posts/hello.yml', content: 'x' } }, res);

  assert.equal(sets.length, 0, '不应调用 siteConfig.set');
  assert.equal(res.calls[0][0], 'send');
  assert.equal(res.calls[0][1], 400);
});
