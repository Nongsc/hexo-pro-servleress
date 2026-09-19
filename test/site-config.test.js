// test/site-config.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { SiteConfigStore } = require('../lib/site-config');

function fakeDb() {
  const map = new Map();
  return {
    findOne: (q, cb) => cb(null, map.get(q.type) || null),
    update: (q, u, o, cb) => { map.set(q.type, Object.assign(map.get(q.type) || { type: q.type }, u.$set)); cb(null, 1); }
  };
}

function fakeGithub() {
  const calls = [];
  return {
    calls,
    writeFile: async (...args) => { calls.push(args); return {}; }
  };
}

test('get/set 往返（sync:false 不触发 GitHub）', async () => {
  const github = fakeGithub();
  const store = new SiteConfigStore(fakeDb(), github);
  await store.set('site', 'title: X', { sync: false });
  const v = await store.get('site');
  assert.equal(v, 'title: X');
  assert.equal(github.calls.length, 0, 'sync:false 不应调用 writeFile');
});

test('githubPath 映射', () => {
  const store = new SiteConfigStore(fakeDb(), null);
  assert.equal(store.githubPath('site'), '_config.yml');
  assert.equal(store.githubPath('theme:landscape'), '_config.landscape.yml');
  assert.equal(store.githubPath('templates'), '_yaml_templates/templates.json');
  assert.equal(store.githubPath('deploy'), null, 'deploy 配置只存 DB、不同步 GitHub');
});

test('set("deploy") 只写 DB、不触发 GitHub writeFile（避免凭据泄漏）', async () => {
  const github = fakeGithub();
  const store = new SiteConfigStore(fakeDb(), github);
  await store.set('deploy', JSON.stringify({ token: 'ghp_secret', workflowId: 'deploy.yml' }));
  assert.equal(github.calls.length, 0, 'githubPath("deploy") 为 null 时不应调用 writeFile');
  assert.ok(await store.get('deploy'), '仍应持久化到 DB');
});

test('set 默认 sync 时按 githubPath 写入并使用默认 message', async () => {
  const github = fakeGithub();
  const store = new SiteConfigStore(fakeDb(), github);
  const content = 'title: Y';
  await store.set('theme:landscape', content);
  assert.deepEqual(github.calls, [
    ['_config.landscape.yml', content, 'Hexo Pro: update theme:landscape']
  ]);
});

test('set 支持自定义 message', async () => {
  const github = fakeGithub();
  const store = new SiteConfigStore(fakeDb(), github);
  await store.set('site', 'title: Z', { message: 'Hexo Pro: custom' });
  assert.deepEqual(github.calls, [['_config.yml', 'title: Z', 'Hexo Pro: custom']]);
});

test('githubPath 为 null 的 type 不写入 GitHub，但仍持久化', async () => {
  const github = fakeGithub();
  const store = new SiteConfigStore(fakeDb(), github);
  await store.set('snapshot:site', 'c1');
  assert.equal(github.calls.length, 0, 'githubPath 为 null 时不应调用 writeFile');
  assert.equal(await store.get('snapshot:site'), 'c1');
});
