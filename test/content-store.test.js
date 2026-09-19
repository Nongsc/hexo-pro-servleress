'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePost, parsePage, serialize, ContentStore } = require('../lib/content-store');

const CONFIG = { permalink: ':year/:month/:day/:title/', url: 'http://example.com', root: '/', default_category: 'uncategorized' };
const RAW = '---\ntitle: Hello\ndate: 2026-01-02 03:04:05\ntags:\n  - a\n  - b\n---\n正文内容';

test('parsePost 产出 raw/source/published/tags/content', () => {
  const doc = parsePost(RAW, '_posts/hello.md', true, CONFIG);
  assert.equal(doc.title, 'Hello');
  assert.equal(doc.source, '_posts/hello.md');
  assert.equal(doc.published, true);
  assert.deepEqual(doc.tags, ['a', 'b']);
  assert.equal(doc.raw, RAW);
  assert.ok(doc.content.includes('正文内容'));
});

test('parsePage 产出 layout=page', () => {
  const doc = parsePage('---\ntitle: About\n---\n关于', 'about/index.md', CONFIG);
  assert.equal(doc.layout, 'page');
  assert.equal(doc.title, 'About');
});

test('serialize 与 parsePost 字段往返一致', () => {
  const doc = parsePost(RAW, '_posts/hello.md', true, CONFIG);
  const out = serialize(doc);
  const doc2 = parsePost(out, '_posts/hello.md', true, CONFIG);
  assert.equal(doc2.title, 'Hello');
  assert.deepEqual(doc2.tags, ['a', 'b']);
});

test('_rebuild 写出 blogInfoList.json 且条目正确', () => {
  const base_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-'));
  const store = new ContentStore({ base_dir, config: CONFIG, log: { error: () => {} } }, null);
  const postDoc = parsePost(RAW, '_posts/hello.md', true, CONFIG);
  const pageDoc = parsePage('---\ntitle: About\n---\n关于', 'about/index.md', CONFIG);
  store._rebuild([postDoc, pageDoc]);
  const list = JSON.parse(fs.readFileSync(path.join(base_dir, 'blogInfoList.json'), 'utf8'));
  assert.equal(list.length, 2);
  const post = list.find(x => !x.isPage);
  const page = list.find(x => x.isPage);
  assert.ok(post);
  assert.equal(post.title, 'Hello');
  assert.equal(post.isDraft, false);
  assert.equal(post.permalink, postDoc.permalink);
  assert.ok(page);
  assert.equal(page.title, 'About');
  assert.equal(page.isPage, true);
  assert.equal(page.isDraft, false);
  assert.equal(page.permalink, pageDoc.permalink);
});
