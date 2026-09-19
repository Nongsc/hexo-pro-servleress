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

test('get/set 往返（sync:false 不触发 GitHub）', async () => {
  const store = new SiteConfigStore(fakeDb(), { writeFile: async () => ({}) });
  await store.set('site', 'title: X', { sync: false });
  const v = await store.get('site');
  assert.equal(v, 'title: X');
});

test('githubPath 映射', () => {
  const store = new SiteConfigStore(fakeDb(), null);
  assert.equal(store.githubPath('site'), '_config.yml');
  assert.equal(store.githubPath('theme:landscape'), '_config.landscape.yml');
  assert.equal(store.githubPath('templates'), '_yaml_templates/templates.json');
});
