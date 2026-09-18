'use strict';

const path = require('path');
const fs = require('fs');
const hfm = require('hexo-front-matter');
const { marked } = require('marked');
const { slugize } = require('hexo-util');
const moment = require('moment');
const { postPath, postPermalink, pagePermalink } = require('./permalink');

/**
 * In-memory content index that reproduces the slice of hexo's warehouse model
 * layer the admin API uses (Post / Page / Category / Tag). Posts are read from
 * `source/_posts` and `source/_drafts`; pages from any other `.md` under
 * `source/` (hexo's page processor). Every mutation rebuilds this index from
 * disk, so the markdown files remain the single source of truth.
 */

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

class ContentIndexer {
  constructor(hexo) {
    this.hexo = hexo;
    this.models = {};
    this._registerModels();
  }

  _registerModels() {
    ['Post', 'Page', 'Category', 'Tag'].forEach(name => {
      this.models[name] = new Model(name);
    });
  }

  _walk(dir, results) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        this._walk(full, results);
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name) && !entry.name.startsWith('.')) {
        results.push(full);
      }
    }
  }

  _rel(sourceDir, fullPath) {
    return fullPath.slice(sourceDir.length).replace(/\\/g, '/');
  }

  _statDate(fullPath) {
    try {
      const st = fs.statSync(fullPath);
      return st.birthtime && st.birthtime.getTime() ? st.birthtime : st.mtime;
    } catch (err) {
      return new Date();
    }
  }

  _parsePost(fullPath, sourceDir, published) {
    const raw = fs.readFileSync(fullPath, 'utf8');
    const parsed = hfm.parse(raw);
    const body = parsed._content || '';

    let date = parsed.date;
    if (date) {
      date = moment(date).isValid() ? moment(date).toDate() : new Date();
    } else {
      date = this._statDate(fullPath);
    }
    const updated = parsed.updated ? moment(parsed.updated).toDate() : this._statDate(fullPath);

    const source = this._rel(sourceDir, fullPath);
    const slug = parsed.slug || path.basename(fullPath, path.extname(fullPath));

    // Front-matter `permalink` wins (hexo maps it to __permalink).
    if (parsed.permalink) {
      parsed.__permalink = parsed.permalink;
      delete parsed.permalink;
    }

    const categories = normalizeStrings(parsed.categories);
    const tags = normalizeStrings(parsed.tags);

    const data = {
      id: parsed.id,
      slug,
      title: parsed.title || '',
      date,
      __permalink: parsed.__permalink,
      categories: categories.map(name => ({ name, slug: slugize(name) }))
    };
    const relPath = postPath(this.hexo.config, data);
    const permalink = postPermalink(this.hexo.config, data);

    const moreSplit = body.split('<!-- more -->');
    const excerpt = moreSplit.length > 1 ? marked.parse(moreSplit[0]) : '';
    const more = moreSplit.length > 1 ? marked.parse(moreSplit.slice(1).join('<!-- more -->')) : '';
    const content = marked.parse(body);

    const doc = Object.assign({}, parsed);
    delete doc._content;

    Object.assign(doc, {
      _id: permalink,
      source,
      raw,
      slug,
      title: parsed.title || '',
      date,
      updated,
      published,
      layout: parsed.layout || 'post',
      _content: body,
      content,
      excerpt,
      more,
      permalink,
      path: relPath,
      full_source: path.join(sourceDir, source),
      asset_dir: path.join(sourceDir, source).replace(/\.[^.]+$/, '') + path.sep,
      photos: parsed.photos != null ? (Array.isArray(parsed.photos) ? parsed.photos : [parsed.photos]) : parsed.photo != null ? (Array.isArray(parsed.photo) ? parsed.photo : [parsed.photo]) : undefined,
      tags,
      categories: leafCategoryNames(categories)
    });

    return { doc, categories, tags };
  }

  _parsePage(fullPath, sourceDir) {
    const raw = fs.readFileSync(fullPath, 'utf8');
    const parsed = hfm.parse(raw);
    const body = parsed._content || '';

    const source = this._rel(sourceDir, fullPath);
    const urlPath = this._pagePath(source);
    const permalink = pagePermalink(this.hexo.config, urlPath);

    const doc = Object.assign({}, parsed);
    delete doc._content;
    Object.assign(doc, {
      _id: permalink,
      source,
      raw,
      title: parsed.title || urlPath.replace(/^\//, '').replace(/\/$/, '') || 'index',
      date: parsed.date ? moment(parsed.date).toDate() : this._statDate(fullPath),
      updated: parsed.updated ? moment(parsed.updated).toDate() : this._statDate(fullPath),
      layout: parsed.layout || 'page',
      _content: body,
      content: marked.parse(body),
      permalink,
      path: urlPath,
      full_source: path.join(sourceDir, source)
    });
    return doc;
  }

  _pagePath(source) {
    let p = source.replace(/\.(md|markdown)$/i, '');
    if (p.endsWith('/index')) p = p.slice(0, -'/index'.length);
    if (p === 'index') p = '';
    p = '/' + p.replace(/\/$/, '');
    return p === '/' ? '/' : p;
  }

  rebuild(sourceFilter) {
    const hexo = this.hexo;
    const sourceDir = hexo.source_dir;

    const postFiles = [];
    const draftFiles = [];
    const pageFiles = [];

    // Collect posts/drafts.
    this._walk(path.join(sourceDir, '_posts'), postFiles);
    this._walk(path.join(sourceDir, '_drafts'), draftFiles);

    // Collect pages: any .md under source/ that is not a post/draft/discarded.
    const allFiles = [];
    this._walk(sourceDir, allFiles);
    const postSet = new Set(postFiles.map(f => this._rel(sourceDir, f)));
    const draftSet = new Set(draftFiles.map(f => this._rel(sourceDir, f)));
    for (const f of allFiles) {
      const rel = this._rel(sourceDir, f);
      if (postSet.has(rel) || draftSet.has(rel)) continue;
      if (rel.startsWith('_posts/') || rel.startsWith('_drafts/') || rel.startsWith('_discarded/')) continue;
      pageFiles.push(f);
    }

    // Build post docs + gather taxonomy.
    const posts = [];
    const taxonomy = {
      categories: {}, // fullPath -> {name, slug, path, parent, postIds:Set}
      tags: {}        // name -> {name, slug, path, postIds:Set}
    };

    const addPost = (full, published) => {
      const { doc, categories, tags } = this._parsePost(full, sourceDir, published);
      posts.push(doc);
      // Register categories (full hierarchy).
      const list = categories;
      list.forEach(item => {
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
      tags.forEach(name => {
        if (!taxonomy.tags[name]) taxonomy.tags[name] = { name, slug: slugize(name), path: slugize(name), postIds: new Set() };
        taxonomy.tags[name].postIds.add(doc._id);
      });
    };

    postFiles.forEach(f => addPost(f, true));
    draftFiles.forEach(f => addPost(f, false));

    const pages = pageFiles.map(f => this._parsePage(f, sourceDir));

    // Build Category / Tag models.
    const catDocs = Object.values(taxonomy.categories).map(c => {
      const doc = {
        _id: c.path,
        name: c.name,
        slug: c.slug,
        path: c.path,
        parent: c.parent
      };
      if (c.parent !== undefined) doc.parent = c.parent;
      doc.posts = new Query(posts.filter(p => c.postIds.has(p._id)));
      doc.length = doc.posts.length;
      return doc;
    });
    const tagDocs = Object.values(taxonomy.tags).map(t => {
      const doc = { _id: t.name, name: t.name, slug: t.slug, path: t.path };
      doc.posts = new Query(posts.filter(p => t.postIds.has(p._id)));
      doc.length = doc.posts.length;
      return doc;
    });

    // Attach document methods.
    posts.forEach(d => attachMethods(d, this.models.Post));
    pages.forEach(d => attachMethods(d, this.models.Page));

    // Sort posts by date desc (hexo's default order is arbitrary; list re-sorts anyway).
    this.models.Post._reset(posts);
    this.models.Page._reset(pages);
    this.models.Category._reset(catDocs);
    this.models.Tag._reset(tagDocs);

    this._writeBlogInfoList(posts, pages);

    return { posts, pages, categories: catDocs, tags: tagDocs };
  }

  _writeBlogInfoList(posts, pages) {
    const list = [];
    posts.forEach(p => {
      list.push({ title: p.title, content: p.content, isPage: false, isDraft: !p.published, permalink: p.permalink });
    });
    pages.forEach(p => {
      list.push({ title: p.title, content: p.content, isPage: true, isDraft: false, permalink: p.permalink });
    });
    try {
      fs.writeFileSync(path.join(this.hexo.base_dir, 'blogInfoList.json'), JSON.stringify(list));
    } catch (err) {
      this.hexo.log.error('write blogInfoList.json failed:', err.message);
    }
  }
}

module.exports = ContentIndexer;
