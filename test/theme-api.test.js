// test/theme-api.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const themeApi = require('../api/theme_api');

const {
  schemaCacheId,
  extractSchemaFromFileContent,
  readSchemaFileWithMeta,
  writeSchemaFileWithMeta,
  snapshotTypeFor,
  toSnapshotMeta,
  readThemeConfigSnapshots,
  createThemeConfigSnapshot,
} = themeApi._test;

// NeDB 风格回调 API 的最小 mock（theme_schema_cache 表）
function fakeSchemaCache() {
  const map = new Map();
  return {
    _map: map,
    findOne: (q, cb) => cb(null, map.get(q._id) || null),
    update: (q, u, o, cb) => { map.set(q._id, Object.assign({}, u.$set)); cb(null, 1); },
  };
}

// SiteConfigStore 的最小 mock（get/set 同步内存）
function fakeSiteConfig() {
  const map = new Map();
  return {
    _map: map,
    get: async (type) => (map.has(type) ? map.get(type) : null),
    set: async (type, content) => { map.set(type, content); return { type, content }; },
  };
}

test('schemaCacheId 生成 _id', () => {
  assert.equal(schemaCacheId('anzhiyu'), 'schema:anzhiyu');
});

test('writeSchemaFileWithMeta 写入 _id 与 _meta，readSchemaFileWithMeta 不含 _id 泄漏', async () => {
  const cache = fakeSchemaCache();
  const db = { themeSchemaCache: cache };
  const schema = { title: { type: 'input', label: '标题' } };

  await writeSchemaFileWithMeta(db, 'anzhiyu', schema, 'hash123', 'zh');

  // DB 中的 doc 含 _id 与 _meta（用于缓存校验）
  const stored = cache._map.get('schema:anzhiyu');
  assert.equal(stored._id, 'schema:anzhiyu');
  assert.equal(stored._meta.configHash, 'hash123');
  assert.equal(stored._meta.language, 'zh');
  assert.deepEqual(stored.title, { type: 'input', label: '标题' });

  // read 返回对象不含 _id，避免泄漏进 extractSchemaFromFileContent
  const read = await readSchemaFileWithMeta(db, 'anzhiyu');
  assert.equal(read._id, undefined);
  assert.equal(read._meta.configHash, 'hash123');
  assert.deepEqual(read.title, { type: 'input', label: '标题' });

  const schemaOnly = extractSchemaFromFileContent(read);
  assert.equal(schemaOnly._id, undefined);
  assert.equal(schemaOnly._meta, undefined);
  assert.deepEqual(schemaOnly, { title: { type: 'input', label: '标题' } });
});

test('readSchemaFileWithMeta 无缓存返回 null', async () => {
  const db = { themeSchemaCache: fakeSchemaCache() };
  const read = await readSchemaFileWithMeta(db, 'missing');
  assert.equal(read, null);
});

test('snapshotTypeFor 映射正确', () => {
  assert.equal(snapshotTypeFor('__global__site_config__'), 'snapshot:site');
  assert.equal(snapshotTypeFor('anzhiyu'), 'snapshot:theme:anzhiyu');
});

test('createThemeConfigSnapshot 写入 snapshot:theme:{id} 且 JSON 往返', async () => {
  const siteConfig = fakeSiteConfig();
  const hexo = { siteConfig };

  const meta = await createThemeConfigSnapshot(hexo, 'anzhiyu', 'title: hello\n', { source: 'manual', note: 'v1' });

  assert.ok(meta);
  assert.equal(meta.themeId, 'anzhiyu');
  assert.equal(meta.source, 'manual');
  assert.equal(meta.note, 'v1');
  assert.equal(meta.content, undefined, 'toSnapshotMeta 不应包含 content');

  // 存到 site_config 的 type 为 snapshot:theme:{id}
  assert.ok(siteConfig._map.has('snapshot:theme:anzhiyu'));

  const snapshots = await readThemeConfigSnapshots(hexo, 'anzhiyu');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].content, 'title: hello\n');
  assert.equal(snapshots[0].hash, meta.hash);
});

test('createThemeConfigSnapshot 相同内容去重（跳过创建）', async () => {
  const siteConfig = fakeSiteConfig();
  const hexo = { siteConfig };

  const first = await createThemeConfigSnapshot(hexo, 'anzhiyu', 'a: 1\n', {});
  assert.ok(first);
  const second = await createThemeConfigSnapshot(hexo, 'anzhiyu', 'a: 1\n', {});
  assert.equal(second, null);

  const snapshots = await readThemeConfigSnapshots(hexo, 'anzhiyu');
  assert.equal(snapshots.length, 1);
});

test('全局快照使用 snapshot:site 类型', async () => {
  const siteConfig = fakeSiteConfig();
  const hexo = { siteConfig };

  await createThemeConfigSnapshot(hexo, '__global__site_config__', 'title: X\n', {});

  assert.ok(siteConfig._map.has('snapshot:site'));
  assert.ok(!siteConfig._map.has('snapshot:theme:__global__site_config__'));
});

test('toSnapshotMeta 剥离 content', () => {
  const meta = toSnapshotMeta({ id: '1', themeId: 'a', content: 'xxx' });
  assert.deepEqual(meta, { id: '1', themeId: 'a' });
  assert.equal(toSnapshotMeta(null), null);
});
