'use strict';

const path = require('path');
const hfm = require('hexo-front-matter');
const { marked } = require('marked');
const { slugize } = require('hexo-util');
const moment = require('moment');
const { postPath, postPermalink, pagePermalink } = require('./permalink');

function queryMatches(doc, query) {
  if (!query) return true;
  return Object.keys(query).every(field => {
    const expected = query[field];
    const actual = doc[field];
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      return Object.keys(expected).every(op => {
        const val = expected[op];
        switch (op) {
          case '$in': return Array.isArray(val) && val.some(v => String(v) === String(actual));
          case '$ne': return String(actual) !== String(val);
          case '$lt': return actual < val;
          case '$lte': return actual <= val;
          case '$gt': return actual > val;
          case '$gte': return actual >= val;
          default: return true;
        }
      });
    }
    return String(actual) === String(expected);
  });
}

class Query {
  constructor(data) {
    this.data = data || [];
  }
  toArray() { return this.data.slice(); }
  forEach(fn) { this.data.forEach(fn); }
  map(fn) { return this.data.map(fn); }
  filter(fn) { return new Query(this.data.filter(fn)); }
  sort(fn) { this.data = this.data.slice().sort(fn); return this; }
  slice(a, b) { return this.data.slice(a, b); }
  get length() { return this.data.length; }
}

class Model {
  constructor(name) {
    this.name = name;
    this._docs = [];
  }
  _reset(docs) { this._docs = docs || []; }
  insert(doc) { this._docs.push(doc); return doc; }
  toArray() { return this._docs.slice(); }
  forEach(fn) { this._docs.forEach(fn); }
  count(query) { return query ? this._docs.filter(d => queryMatches(d, query)).length : this._docs.length; }
  findOne(query) { return this._docs.find(d => queryMatches(d, query)); }
  findOneById(id) { return this._docs.find(d => d._id === id); }
  findById(id) { return this.findOneById(id); }
  find(query) {
    if (typeof query === 'function') return new Query(this._docs.filter(query));
    return new Query(this._docs.filter(d => queryMatches(d, query)));
  }
  filter(fn) { return new Query(this._docs.filter(fn)); }
  remove(query, cb) {
    const matched = this._docs.filter(d => queryMatches(d, query));
    const ids = new Set(matched.map(d => d._id));
    this._docs = this._docs.filter(d => !ids.has(d._id));
    if (cb) cb(null, matched.length);
    return matched.length;
  }
  removeById(id) {
    const before = this._docs.length;
    this._docs = this._docs.filter(d => d._id !== id);
    return before - this._docs.length;
  }
  update(id, data, cb) {
    const doc = this._docs.find(d => d._id === id);
    if (doc) Object.assign(doc, data);
    if (cb) cb(null, doc ? 1 : 0);
  }
}

// Attach warehouse-document-style methods as non-enumerable own properties, so
// `_.cloneDeep` (used heavily by the API) copies the data fields but not these.
function attachMethods(doc, model) {
  const define = (key, fn) => Object.defineProperty(doc, key, { value: fn, enumerable: false, writable: true });
  define('setTags', function (tags) {
    const list = Array.isArray(tags) ? tags : (tags == null ? [] : [tags]);
    this.tags = list.map(t => String(t)).filter(t => t !== '');
  });
  define('setCategories', function (cats) {
    this.categories = cats == null ? [] : (Array.isArray(cats) ? cats : [cats]);
  });
  define('save', function () { return Promise.resolve(this); });
  define('remove', function () { model.removeById(this._id); return Promise.resolve(); });
  define('replace', function (data) { Object.assign(this, data); return this; });
  return doc;
}

function normalizeStrings(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

// Flatten a category list (which may contain nested arrays) into leaf names.
function leafCategoryNames(cats) {
  const list = cats == null ? [] : (Array.isArray(cats) ? cats : [cats]);
  return list.map(item => {
    const chain = Array.isArray(item) ? item : [item];
    return String(chain[chain.length - 1]);
  });
}

function pagePath(source) {
  let p = String(source).replace(/\.(md|markdown)$/i, '');
  if (p.endsWith('/index')) p = p.slice(0, -'/index'.length);
  if (p === 'index') p = '';
  p = '/' + p.replace(/\/$/, '');
  return p === '/' ? '/' : p;
}

// _parsePost 的 DB 版：raw 由入参提供（原实现 fs.readFileSync），full_source/asset_dir 不再产生。
function parsePost(raw, source, published, config) {
  const parsed = hfm.parse(raw);
  const body = parsed._content || '';
  let date = parsed.date;
  if (date) date = moment(date).isValid() ? moment(date).toDate() : new Date();
  else date = new Date();
  const updated = parsed.updated ? moment(parsed.updated).toDate() : date;
  const slug = parsed.slug || path.basename(String(source), path.extname(String(source)));
  if (parsed.permalink) { parsed.__permalink = parsed.permalink; delete parsed.permalink; }
  const categories = normalizeStrings(parsed.categories);
  const tags = normalizeStrings(parsed.tags);
  const data = {
    id: parsed.id, slug, title: parsed.title || '', date, __permalink: parsed.__permalink,
    categories: categories.map(name => ({ name, slug: slugize(name) }))
  };
  const relPath = postPath(config, data);
  const permalink = postPermalink(config, data);
  const moreSplit = body.split('<!-- more -->');
  const doc = Object.assign({}, parsed);
  delete doc._content;
  Object.assign(doc, {
    _id: permalink, source, raw, slug, title: parsed.title || '', date, updated, published,
    layout: parsed.layout || 'post', _content: body,
    content: marked.parse(body),
    excerpt: moreSplit.length > 1 ? marked.parse(moreSplit[0]) : '',
    more: moreSplit.length > 1 ? marked.parse(moreSplit.slice(1).join('<!-- more -->')) : '',
    permalink, path: relPath, tags, categories: leafCategoryNames(categories)
  });
  return doc;
}

// _parsePage 的 DB 版。
function parsePage(raw, source, config) {
  const parsed = hfm.parse(raw);
  const body = parsed._content || '';
  const urlPath = pagePath(source);
  const permalink = pagePermalink(config, urlPath);
  const doc = Object.assign({}, parsed);
  delete doc._content;
  Object.assign(doc, {
    _id: permalink, source, raw, title: parsed.title || urlPath.replace(/^\//, '').replace(/\/$/, '') || 'index',
    date: parsed.date ? moment(parsed.date).toDate() : new Date(),
    updated: parsed.updated ? moment(parsed.updated).toDate() : new Date(),
    layout: parsed.layout || 'page', _content: body, content: marked.parse(body),
    permalink, path: urlPath
  });
  return doc;
}

// doc → markdown（front matter + body）。日期字段还原为字符串。
function serialize(doc) {
  const internal = ['raw', 'content', 'excerpt', 'more', '_id', 'source', 'slug', 'published', 'layout',
    'permalink', 'path', 'full_source', 'asset_dir', 'photos', '_content'];
  const fm = {};
  Object.keys(doc).forEach((k) => {
    if (internal.includes(k) || k.startsWith('__')) return;
    fm[k] = doc[k];
  });
  if (doc.date) fm.date = moment(doc.date).format('YYYY-MM-DD HH:mm:ss');
  if (doc.updated) fm.updated = moment(doc.updated).format('YYYY-MM-DD HH:mm:ss');
  return hfm.stringify(fm, { prefixSeparator: true }) + (doc._content != null ? doc._content : '');
}

class ContentStore {
  constructor(hexo, articleDb) {
    this.hexo = hexo;
    this.articleDb = articleDb;
    this.models = {};
    ['Post', 'Page', 'Category', 'Tag'].forEach((n) => { this.models[n] = new Model(n); });
  }

  async load() {
    const docs = await new Promise((resolve, reject) =>
      this.articleDb.find({}, (e, d) => (e ? reject(e) : resolve(d || []))));
    this._rebuild(docs);
    return docs;
  }

  _rebuild(docs) {
    const posts = [], pages = [];
    const taxonomy = { categories: {}, tags: {} };
    const addPost = (doc) => {
      posts.push(doc);
      const list = Array.isArray(doc.categories) ? doc.categories : [];
      list.forEach((item) => {
        const chain = Array.isArray(item) ? item : [item];
        let parentPath = '';
        for (const seg of chain) {
          const name = String(seg);
          const slug = slugize(name);
          const fullPath = parentPath ? parentPath + '/' + slug : slug;
          if (!taxonomy.categories[fullPath]) {
            taxonomy.categories[fullPath] = { name, slug, path: fullPath, parent: parentPath || undefined, postIds: new Set() };
          }
          taxonomy.categories[fullPath].postIds.add(doc._id);
          parentPath = fullPath;
        }
      });
      (doc.tags || []).forEach((name) => {
        if (!taxonomy.tags[name]) taxonomy.tags[name] = { name, slug: slugize(String(name)), path: slugize(String(name)), postIds: new Set() };
        taxonomy.tags[name].postIds.add(doc._id);
      });
    };
    docs.forEach((d) => {
      const doc = Object.assign({}, d);
      if (doc.layout === 'page') pages.push(doc);
      else addPost(doc);
    });
    const catDocs = Object.values(taxonomy.categories).map((c) => {
      const doc = { _id: c.path, name: c.name, slug: c.slug, path: c.path };
      if (c.parent !== undefined) doc.parent = c.parent;
      doc.posts = new Query(posts.filter((p) => c.postIds.has(p._id)));
      doc.length = doc.posts.length;
      return doc;
    });
    const tagDocs = Object.values(taxonomy.tags).map((t) => {
      const doc = { _id: t.name, name: t.name, slug: t.slug, path: t.path };
      doc.posts = new Query(posts.filter((p) => t.postIds.has(p._id)));
      doc.length = doc.posts.length;
      return doc;
    });
    posts.forEach((d) => attachMethods(d, this.models.Post));
    pages.forEach((d) => attachMethods(d, this.models.Page));
    posts.sort((a, b) => new Date(b.date) - new Date(a.date));
    this.models.Post._reset(posts);
    this.models.Page._reset(pages);
    this.models.Category._reset(catDocs);
    this.models.Tag._reset(tagDocs);
  }

  // keyId：DB 写入用 _id（默认 doc._id）。带 raw 时重解析以刷新派生字段，但 _id 与 source 用 keyId/doc.source 覆盖，保证改名不产生重复行。
  async upsert(doc, keyId, preserve) {
    const id = keyId || doc._id;
    let final = doc;
    if (typeof doc.raw === 'string' && doc.raw.length) {
      final = doc.layout === 'page'
        ? parsePage(doc.raw, doc.source, this.hexo.config)
        : parsePost(doc.raw, doc.source, doc.published !== false, this.hexo.config);
      final._id = id;
      if (doc.source != null) final.source = doc.source;
      if (preserve) {
        Object.keys(preserve).forEach(k => { final[k] = preserve[k]; });
      }
    }
    await new Promise((resolve, reject) =>
      this.articleDb.update({ _id: id }, { $set: final }, { upsert: true }, (e) => (e ? reject(e) : resolve())));
    await this.load();
    return this.findByPermalink(id);
  }

  async remove(id) {
    await new Promise((resolve, reject) =>
      this.articleDb.remove({ _id: id }, {}, (e) => (e ? reject(e) : resolve())));
    await this.load();
  }

  findByPermalink(id) {
    return this.models.Post.findOneById(id) || this.models.Page.findOneById(id) || null;
  }
}

module.exports = { ContentStore, parsePost, parsePage, serialize, Model, Query };
