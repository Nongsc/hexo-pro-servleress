// test/theme-api.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const themeApi = require('../api/theme_api');
const databaseManager = require('../lib/db');

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

// 无 DATABASE_URL 时 databaseManager 走内存模式，theme_schema_cache 是真实 Table 实例，
// 其 applyUpdate 的「$set 合并 / 全量替换」语义与生产一致（不复刻、不掩盖行为）。
delete process.env.DATABASE_URL;

async function realSchemaDb() {
  const dbs = await databaseManager.initialize({ config: {}, log: console });
  return { themeSchemaCache: dbs.themeSchemaCache };
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
  const db = await realSchemaDb();
  const schema = { title: { type: 'input', label: '标题' } };

  await writeSchemaFileWithMeta(db, 'anzhiyu', schema, 'hash123', 'zh');

  const read = await readSchemaFileWithMeta(db, 'anzhiyu');
  assert.equal(read._id, undefined);
  assert.equal(read._meta.configHash, 'hash123');
  assert.equal(read._meta.language, 'zh');
  assert.deepEqual(read.title, { type: 'input', label: '标题' });

  const schemaOnly = extractSchemaFromFileContent(read);
  assert.equal(schemaOnly._id, undefined);
  assert.equal(schemaOnly._meta, undefined);
  assert.deepEqual(schemaOnly, { title: { type: 'input', label: '标题' } });
});

test('writeSchemaFileWithMeta 全量替换：再生成后不残留旧字段', async () => {
  const db = await realSchemaDb();

  // 先写含 { a, b } 的 schema，再写只含 { a } 的 schema（模拟配置删掉字段后重新生成）
  await writeSchemaFileWithMeta(db, 'stale', { a: { type: 'input' }, b: { type: 'input' } }, 'h1', 'zh');
  await writeSchemaFileWithMeta(db, 'stale', { a: { type: 'input' } }, 'h2', 'zh');

  const read = await readSchemaFileWithMeta(db, 'stale');
  assert.equal(read._id, undefined);
  assert.equal(read._meta.configHash, 'h2');

  const schema = extractSchemaFromFileContent(read);
  assert.deepEqual(schema, { a: { type: 'input' } });
  assert.equal(schema.b, undefined, '旧字段 b 应被全量替换移除');
});

test('readSchemaFileWithMeta 无缓存返回 null', async () => {
  const db = await realSchemaDb();
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
