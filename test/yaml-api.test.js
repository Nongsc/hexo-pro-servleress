// test/yaml-api.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const yamlApi = require('../api/yaml_api');

const { resolveManagedType, readTemplates, writeTemplates } = yamlApi._test;

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
