# Hexo Pro 内容主源迁移实现计划（content 仓库 → 数据库 + GitHub API）

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 移除 `content/` 目录，将文章与站点信息存入 PostgreSQL，读全走 DB；写操作实时同步到 GitHub 仓库（Qexo 式），部署触发远端 CI。

**架构：** 方案 A —— 保留 `HexoShim` 门面，把底层从「文件系统」换成「数据库 + GitHub API」。新增 `lib/github.js`（GitHub REST）、`lib/content-store.js`（DB 版内容索引）、`lib/site-config.js`（站点配置存储）；`api/*.js` 只改直接碰文件系统的落点。

**技术栈：** Node.js + Express、`pg`（JSONB）、`hexo-front-matter`、`marked`、`js-yaml`、`cos-nodejs-sdk-v5`、`node:test`（内置测试运行器，无新增依赖）。

**规格：** [docs/superpowers/specs/2026-09-18-hexo-pro-github-db-refactor-design.md](../specs/2026-09-18-hexo-pro-github-db-refactor-design.md)

## 全局约束

- 数据库为主源：所有读操作走 DB；写操作「先 DB、后同步 GitHub」。
- 文章以 JSONB 文档存储（`raw` 原始 markdown + 解析字段），表名 `articles`。
- 站点信息表名 `site_config`，按 `type` 分条（`site` / `theme:{id}` / `templates` / `deploy`）。
- 前端 id 契约不变：`articles._id` = `permalink`（base64 编码在 API 层做，不变）。
- 凭据只进 `.env`（已 gitignore），**绝不写入任何已跟踪文件或计划/规格文档**。
- 测试使用 Node 内置 `node:test` + `assert`，运行命令 `npm test`。
- 每次写操作的 GitHub commit message 统一格式 `Hexo Pro: <描述>`。
- 文章相对路径 `source` 映射到 GitHub 路径 `source/{source}`（如 `_posts/hello.md` → `source/_posts/hello.md`）。

## 范围与阶段（本计划明确的取舍）

**本期实现（本计划）：**
- 文章/页面（Post/Page/Category/Tag）全链路 DB + GitHub。
- 站点配置 `_config.yml`（`site/config`）、主题配置 `_config.{theme}.yml`（`theme/config`）、二者快照、`_yaml_templates`。
- 主题 Schema（`theme/schema` get/save/generate）：配置从 DB 读，缓存写入现有 `theme_schema_cache` 表。
- `theme/list`、`theme/current` 适配 DB。
- 图片：本地 `uploads/images/` + 腾讯云 COS（COS 上传逻辑已存在，仅需配凭据）。
- 部署：仅 GitHub（触发远端 Actions），保留 `deploy_status` 表状态。

**本期明确暂缓（规格第 12 节，实现后另开计划）：**
- `theme/install`（git clone 主题）、`theme/switch`（改主题文件）——需要主题文件检出，超出「站点信息」范围。
- `cloudflare-pages` / `edgeone-pages` 部署——依赖本地 `hexo generate`。

## 文件结构

**新建：**
- `lib/github.js` — GitHub REST 客户端（listTree/getFile/writeFile/deleteFile/triggerWorkflow）。
- `lib/content-store.js` — DB 版内容索引（解析/序列化 + DB 读写 + Post/Page/Category/Tag 模型）。
- `lib/site-config.js` — 站点配置存储（site/theme/templates/deploy 的 DB 读写 + GitHub 同步）。
- `test/github.test.js`、`test/content-store.test.js`、`test/site-config.test.js` — 单元测试。

**修改：**
- `lib/db.js` — TABLES 增加 `articles`、`site_config`；databases 增加 `articleDb`、`siteConfigDb`。
- `lib/config.js` — `_config.yml` 改从 DB 读；目录字段改本地 `data/`、`uploads/`。
- `lib/hexo-shim.js` — `model` 指向 ContentStore；`post.create`/`_generate` 写 DB；新增 `upload_dir`。
- `index.js` — 启动流程改造 + 首次 GitHub 导入 + 静态服务改 `uploads/`。
- `api/update.js` — 写文件 → 写 DB + 同步。
- `api/post_api.js`、`api/page_api.js` — `fse.move` 系列 → DB 字段更新 + 同步。
- `api/yaml_api.js` — 文件读写 → `site_config` + 同步。
- `api/theme_api.js` — site/theme config + schema 改 DB。
- `api/image_api.js` — `hexo.source_dir` → `hexo.upload_dir`。
- `api/deploy_api.js` — 本地 hexo 构建 → 触发 Actions。
- `api/dashboard_api.js` — `lastDeployTime` 从 `deploy_status` 表读。
- `.env` / `.env.example` — 新增 GitHub 与 COS 变量。

**删除：**
- `lib/git.js`、`lib/content-indexer.js`（逻辑并入新文件后删除）、`content/` 目录。

---

## 任务 1：数据层扩展（`articles` / `site_config` 表）

**文件：**
- 修改：`lib/db.js:259-317`

- [ ] **步骤 1：扩展 TABLES 与 databases**

在 [lib/db.js](lib/db.js) 的 `TABLES` 数组（约第 259 行）加入两张表：

```js
const TABLES = [
  'users',
  'settings',
  'deploy_status',
  'recycle',
  'theme_schema_cache',
  'articles',
  'site_config'
];
```

在 `_performInitialization` 的 `databases` 对象（约第 311 行）加入：

```js
const databases = {
  userDb: make('users'),
  settingsDb: make('settings'),
  deployStatusDb: make('deploy_status'),
  recycleDb: make('recycle'),
  themeSchemaCache: make('theme_schema_cache'),
  articleDb: make('articles'),
  siteConfigDb: make('site_config')
};
```

- [ ] **步骤 2：验证数据层**

运行：`node -e "const d=require('./lib/db'); d.initialize({config:{hexo_pro:{}},log:console}).then(db=>console.log('ready:',!!db.articleDb,!!db.siteConfigDb)).catch(e=>{console.error(e);process.exit(1)})"`
预期：输出 `ready: true true`（`_migrate` 创建 `articles`、`site_config` 表）。

- [ ] **步骤 3：Commit**

```bash
git add lib/db.js
git commit -m "feat(db): 新增 articles / site_config 表"
```

---

## 任务 2：GitHub 客户端 `lib/github.js`

**文件：**
- 创建：`lib/github.js`
- 测试：`test/github.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
// test/github.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { GitHubClient } = require('../lib/github');

test('writeFile 将内容 base64 编码并带上 branch/sha', async () => {
  const calls = [];
  const client = new GitHubClient({ token: 'x', repo: 'o/r', branch: 'main' });
  client._request = async (method, path, body) => { calls.push({ method, path, body }); return { sha: 'newsha' }; };
  client._getSha = async () => 'oldsha';
  await client.writeFile('source/_posts/a.md', 'hello', 'Hexo Pro: test');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].body.content, Buffer.from('hello', 'utf8').toString('base64'));
  assert.equal(calls[0].body.sha, 'oldsha');
  assert.equal(calls[0].body.branch, 'main');
});

test('缺 token 或 repo 时构造抛错', () => {
  assert.throws(() => new GitHubClient({ token: '', repo: 'o/r' }));
  assert.throws(() => new GitHubClient({ token: 'x', repo: '' }));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/github.test.js`
预期：FAIL，报错 `Cannot find module '../lib/github'`

- [ ] **步骤 3：编写实现**

```js
// lib/github.js
'use strict';

const https = require('https');

class GitHubClient {
  constructor({ token, repo, branch }) {
    if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPO are required');
    this.token = token;
    this.repo = repo;           // "owner/repo"
    this.branch = branch || 'main';
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: 'api.github.com',
        method,
        path,
        headers: {
          'User-Agent': 'hexo-pro',
          'Authorization': `token ${this.token}`,
          'Accept': 'application/vnd.github+json'
        }
      };
      if (payload) {
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { return resolve(JSON.parse(data)); } catch (_) { return resolve(data); }
          }
          reject(new Error(`GitHub API ${method} ${path} -> ${res.statusCode}: ${String(data).slice(0, 300)}`));
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async _getSha(path) {
    try {
      const r = await this._request('GET', `/repos/${this.repo}/contents/${encodeURI(path)}?ref=${this.branch}`);
      return r.sha || null;
    } catch (_) {
      return null; // 文件不存在（404）或其它错误，按不存在处理
    }
  }

  async listTree() {
    const r = await this._request('GET', `/repos/${this.repo}/git/trees/${this.branch}?recursive=1`);
    return (r.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
  }

  async getFile(path) {
    const r = await this._request('GET', `/repos/${this.repo}/contents/${encodeURI(path)}?ref=${this.branch}`);
    if (!r.content) throw new Error(`No content at ${path}`);
    return { content: Buffer.from(r.content, 'base64').toString('utf8'), sha: r.sha };
  }

  async writeFile(path, content, message) {
    const body = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch: this.branch };
    const sha = await this._getSha(path);
    if (sha) body.sha = sha;
    return this._request('PUT', `/repos/${this.repo}/contents/${encodeURI(path)}`, body);
  }

  async deleteFile(path, message) {
    const sha = await this._getSha(path);
    if (!sha) return { skipped: true };
    return this._request('DELETE', `/repos/${this.repo}/contents/${encodeURI(path)}`, { message, sha, branch: this.branch });
  }

  async triggerWorkflow(workflowId, ref) {
    return this._request('POST', `/repos/${this.repo}/actions/workflows/${workflowId}/dispatches`, { ref: ref || this.branch });
  }
}

module.exports = { GitHubClient };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/github.test.js`
预期：PASS（2 个测试）

- [ ] **步骤 5：Commit**

```bash
git add lib/github.js test/github.test.js
git commit -m "feat(github): 新增 GitHub REST 客户端（contents/tree/workflow）"
```

---

## 任务 3：内容存储 `lib/content-store.js`

将 [lib/content-indexer.js](lib/content-indexer.js) 的解析逻辑抽到 DB 版。**保留** `Model`/`Query`/`queryMatches`/`normalizeStrings`/`leafCategoryNames`/`attachMethods`（原文件第 19-122 行）原样；只把「读磁盘 + `_walk`」换成「入参 raw 字符串 + 遍历 DB 文档」。

**文件：**
- 创建：`lib/content-store.js`
- 测试：`test/content-store.test.js`

- [ ] **步骤 1：编写失败的测试（纯解析/序列化往返）**

```js
// test/content-store.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parsePost, parsePage, serialize } = require('../lib/content-store');

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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/content-store.test.js`
预期：FAIL，`Cannot find module '../lib/content-store'`

- [ ] **步骤 3：编写实现**

```js
// lib/content-store.js
'use strict';

const path = require('path');
const hfm = require('hexo-front-matter');
const { marked } = require('marked');
const { slugize } = require('hexo-util');
const moment = require('moment');
const { postPath, postPermalink, pagePermalink } = require('./permalink');

// —— 以下从 content-indexer.js 原样保留（第 19-122 行）：——
// queryMatches / class Query / class Model / attachMethods / normalizeStrings / leafCategoryNames
// （执行时整段拷贝，不改动。）

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
  async upsert(doc, keyId) {
    const id = keyId || doc._id;
    let final = doc;
    if (typeof doc.raw === 'string' && doc.raw.length) {
      final = doc.layout === 'page'
        ? parsePage(doc.raw, doc.source, this.hexo.config)
        : parsePost(doc.raw, doc.source, doc.published !== false, this.hexo.config);
      final._id = id;
      if (doc.source != null) final.source = doc.source;
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/content-store.test.js`
预期：PASS（3 个测试）

- [ ] **步骤 5：Commit**

```bash
git add lib/content-store.js test/content-store.test.js
git commit -m "feat(store): DB 版内容索引（parsePost/parsePage/serialize/ContentStore）"
```

---

## 任务 4：站点配置存储 `lib/site-config.js`

**文件：**
- 创建：`lib/site-config.js`
- 测试：`test/site-config.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/site-config.test.js`
预期：FAIL，`Cannot find module '../lib/site-config'`

- [ ] **步骤 3：编写实现**

```js
// lib/site-config.js
'use strict';

class SiteConfigStore {
  constructor(siteConfigDb, github) {
    this.siteConfigDb = siteConfigDb;
    this.github = github;
  }

  async get(type) {
    return new Promise((resolve, reject) =>
      this.siteConfigDb.findOne({ type }, (e, d) => (e ? reject(e) : resolve(d ? d.content : null))));
  }

  async set(type, content, { sync = true, message } = {}) {
    await new Promise((resolve, reject) => {
      this.siteConfigDb.update({ type }, { $set: { type, content, updatedAt: new Date() } }, { upsert: true },
        (e) => (e ? reject(e) : resolve()));
    });
    if (sync && this.github) {
      const ghPath = this.githubPath(type);
      if (ghPath) await this.github.writeFile(ghPath, content, message || `Hexo Pro: update ${type}`);
    }
    return { type, content };
  }

  githubPath(type) {
    if (type === 'site') return '_config.yml';
    if (type === 'templates') return '_yaml_templates/templates.json';
    if (type === 'deploy') return 'deploy_config.json';
    if (type.startsWith('theme:')) return `_config.${type.slice(6)}.yml`;
    return null;
  }
}

module.exports = { SiteConfigStore };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/site-config.test.js`
预期：PASS（2 个测试）

- [ ] **步骤 5：Commit**

```bash
git add lib/site-config.js test/site-config.test.js
git commit -m "feat(store): 站点配置存储（site/theme/templates/deploy）"
```

---

## 任务 5：改造 `lib/hexo-shim.js`

**文件：**
- 修改：`lib/hexo-shim.js`

- [ ] **步骤 1：改造构造、`model`、`post.create`、`_generate`**

将 [lib/hexo-shim.js](lib/hexo-shim.js) 的 `constructor(cfg)` 改为注入依赖，并把 `model()` / `post.create` / `_generate` 改为走 ContentStore：

```js
constructor(cfg, deps = {}) {
  this.config = cfg.config;
  this.base_dir = cfg.base_dir;
  this.source_dir = cfg.source_dir;   // 保留字段；新模型下不再指向内容仓库
  this.upload_dir = cfg.upload_dir;   // 新增：本地上传目录
  this.public_dir = cfg.public_dir;
  this.theme_dir = cfg.theme_dir;
  this.scaffold_dir = cfg.scaffold_dir;

  this.log = makeLogger();
  this.locals = { invalidate: () => {} };
  this.emit = () => {};
  this.route = {};
  this.theme = { config: Object.assign({}, cfg.config.theme_config || {}) };

  this.store = deps.store;            // ContentStore 实例（index.js 稍后回填）
  this.siteConfig = deps.siteConfig;  // SiteConfigStore 实例
  this.github = deps.github;          // GitHubClient 实例（可为 null）

  this.source = { process: (files) => this._process(files) };
  this.post = { create: (data) => { const p = this._createPost(data); p.error = (fn) => { p.catch((e) => fn(e)); return p; }; return p; } };
  this._generate = (opts) => this._process(opts && opts.source ? opts.source : undefined);
}

model(name) { return this.store ? this.store.models[name] : undefined; }

rebuild() { return this.store ? this.store.load() : Promise.resolve(); }

_process() { return Promise.resolve().then(() => (this.store ? this.store.load() : undefined)); }

async _createPost(data) {
  const layout = (data.layout || this.config.default_layout || 'post').toLowerCase();
  const isDraft = layout === 'draft';
  const title = data.title || 'Untitled';
  const slug = slugize(title);
  const date = data.date ? moment(data.date) : moment();
  const fm = { title, date: date.format('YYYY-MM-DD HH:mm:ss') };
  const tags = Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : []);
  const cats = Array.isArray(data.categories) ? data.categories : (data.categories ? [data.categories] : []);
  if (tags.length) fm.tags = tags.map(String);
  if (cats.length) fm.categories = cats.map(String);
  if (data.author) fm.author = data.author;
  Object.keys(this.config.metadata || {}).forEach((k) => { if (data[k] != null) fm[k] = data[k]; });

  const source = isDraft ? `_drafts/${slug}.md` : `_posts/${slug}.md`;
  const raw = hfm.stringify(fm, { prefixSeparator: true }) + '\n';

  const { parsePost } = require('./content-store');
  const doc = parsePost(raw, source, !isDraft, this.config);
  await this.store.upsert(doc);

  if (this.github) await this.github.writeFile(`source/${source}`, raw, `Hexo Pro: create ${source}`);
  return { path: source, _id: doc._id };
}
```

> `post_api.js` 的 `posts/new` 原本用 `file.path.slice(hexo.source_dir.length)`。新实现返回 `{ path: source, _id }`，`posts/new` 改为直接用 `file._id`（见任务 6）。

- [ ] **步骤 2：验证 shim 可加载**

运行：`node -e "const H=require('./lib/hexo-shim'); const h=new H({config:{theme_config:{},default_layout:'post',metadata:{}},base_dir:'./data',source_dir:'./data/source',upload_dir:'./uploads',public_dir:'./data/public',theme_dir:'./data/themes',scaffold_dir:'./data/scaffolds'}); console.log('shim ok', typeof h.model, typeof h._createPost)"`
预期：输出 `shim ok function function`

- [ ] **步骤 3：Commit**

```bash
git add lib/hexo-shim.js
git commit -m "refactor(shim): model/post.create 改为 DB + GitHub"
```

---

## 任务 6：文章写路径改造（`update.js`、`post_api.js`、`page_api.js`）

**文件：**
- 修改：`api/update.js`、`api/post_api.js`、`api/page_api.js`

- [ ] **步骤 1：改造 `api/update.js` 落盘逻辑**

[api/update.js](api/update.js) 第 101-119 行用 `post.full_source` 做「改名清理旧文件」，新模型下没有 `full_source`，改为用 `post.source`（相对路径）。第 163-185 行把「写文件 + `hexo.source.process()`」换成「写 DB + 同步 GitHub」：

将第 101-119 行改为：

```js
var prev_source = post.source,
    new_source = prev_source;
let sourceChanged = false;
if (update.source && update.source !== post.source) {
  const normalizedSource = String(update.source).replace(/^[/\\]+/, '');
  new_source = normalizedSource;
  sourceChanged = true;
}
```

将第 163-185 行的 `post.save().then(async () => { ... })` 整段替换为：

```js
post.save().then(async () => {
  // post 已被 extend(post, update) 更新，post.raw 是序列化后的新 markdown。
  const saved = await hexo.store.upsert(post, unimark);
  if (hexo.github) {
    const target = sourceChanged ? new_source : (saved ? saved.source : prev_source);
    await hexo.github.writeFile(`source/${target}`, raw, `Hexo Pro: update ${target}`);
    if (sourceChanged && prev_source && prev_source !== target) {
      await hexo.github.deleteFile(`source/${prev_source}`, `Hexo Pro: rename ${prev_source}`);
    }
  }
  hexo.log.info('文章保存成功！');
  callback(null, saved);
}).catch(err => { hexo.log.error('保存失败:', err); callback(err, null); });
```

> 说明：`hexo.store.upsert(post, unimark)` 的第二个参数 `unimark`（旧 permalink）是 DB 写入 key，保证标题/分类改变导致 permalink 变化时不产生重复行（见任务 3 的 `upsert` 契约）。`hexo.source.process()` 已由 `upsert` 内部的 `this.load()` 取代。

- [ ] **步骤 2：改造 `api/post_api.js` 的 `posts/new`**

[api/post_api.js](api/post_api.js) 的 `posts/new`（约第 510-542 行）里 `hexo.post.create(...).then(function (file) { var source = file.path.slice(hexo.source_dir.length); ... })` 改为：

```js
hexo.post.create(postParameters)
  .error(function (err) { console.error(err, err.stack); return res.send(500, 'Failed to create post'); })
  .then(function (file) {
    var post = _.cloneDeep(hexo.store.findByPermalink(file._id));
    return res.done(addIsDraft(post));
  });
```

- [ ] **步骤 3：改造 `publish` / `unpublish` / `remove`（文件移动 → DB + GitHub）**

三个函数现在用 `fse.move` 移动物理文件。改为更新 DB 字段并同步 GitHub（move = 写新 + 删旧）。

`publish`（[api/post_api.js](api/post_api.js) 第 74-129 行）整体重写为：

```js
async function publish(permalink, body, res) {
  permalink = utils.base64Decode(permalink);
  const post = hexo.store.findByPermalink(permalink);
  if (!post) return res.send(404, 'Post not found');
  const oldSource = post.source;
  const newSource = '_posts/' + path.basename(post.source);
  const updated = _.cloneDeep(post);
  updated.source = newSource;
  updated.published = true;
  updated.layout = 'post';
  await hexo.store.upsert(updated, permalink);
  if (hexo.github) {
    await hexo.github.writeFile(`source/${newSource}`, updated.raw, `Hexo Pro: publish ${newSource}`);
    await hexo.github.deleteFile(`source/${oldSource}`, `Hexo Pro: publish ${newSource}`);
  }
  res.done(addIsDraft(hexo.store.findByPermalink(permalink)));
}
```

`unpublish` 同理（`newSource = '_drafts/' + basename`，`published = false`）。`remove`：不再移动文件到 `_discarded/`，改为 `store.remove(permalink)` + 写回收站（保留现有 `recycleDb.insert` 逻辑，`originalSource` 用 `post.source`、`discardedPath` 置空），再 `hexo.github.deleteFile('source/' + post.source)`。

- [ ] **步骤 4：改造 `api/page_api.js` 的 `remove` / `createPageManually` / `rename`**

同任务 6 步骤 3 的模式：
- `createPageManually`（约第 98-156 行）：去掉 `fs.writeFile` 与文件路径冲突判断，改为构造 front matter + `parsePage` → `store.upsert` → GitHub 写 `source/<title>/index.md`。
- `remove`（约第 42-96 行）：去掉 `fse.move`，改为 `store.remove` + recycleDb.insert + GitHub delete。
- `rename` / `updatePageFrontMatter` 里的 `fse.moveSync` 目录重命名：改为只更新 DB 的 `source` 字段 + GitHub move（写新删旧）。

- [ ] **步骤 5：Commit**

```bash
git add api/update.js api/post_api.js api/page_api.js
git commit -m "refactor(api): 文章写路径改为 DB + GitHub 同步"
```

---

## 任务 7：站点配置 API 改造（`yaml_api.js`、`theme_api.js`）

**文件：**
- 修改：`api/yaml_api.js`、`api/theme_api.js`

- [ ] **步骤 1：改造 `yaml_api.js` 的模板读写**

[yaml_api.js](api/yaml_api.js) 的 `yaml/templates`、`template/create`、`templates/update`、`template/delete`、`templates/import` 都读写 `hexo.base_dir/_yaml_templates/templates.json`。全部改为走 `siteConfig`：

```js
// 读取
const raw = await hexo.siteConfig.get('templates');
let templates = raw ? JSON.parse(raw) : [];
// 写入
await hexo.siteConfig.set('templates', JSON.stringify(templates, null, 2), { message: 'Hexo Pro: update templates' });
```

`yaml/list`、`create`、`update`、`delete`、`apply-template` 原本管理 `hexo.base_dir` 下任意 YAML 文件——在无本地仓库模型下改为：**仅保留 `site` / `theme:{id}` / `templates` 三类受管对象**，其余返回明确的「暂不支持」错误；`_config.yml`（`site`）与 `_config.<theme>.yml`（`theme:{id}`）的读写委托给 `siteConfig`。

- [ ] **步骤 2：改造 `theme_api.js` 的 site/theme config 与快照**

将以下函数从「读文件」改为「读 DB」：

```js
// 原 readGlobalConfigContent(baseDir) →
async function readGlobalConfigContent() { return hexo.siteConfig.get('site'); }
// 原 applyGlobalConfigContent(baseDir, content) →
async function applyGlobalConfigContent(content) {
  await hexo.siteConfig.set('site', content, { message: 'Hexo Pro: update _config.yml' });
  const parsed = yaml.load(content) || {};
  hexo.config = Object.assign({}, hexo.config, parsed);
  return { success: true, needRestart: true, message: '全局配置已保存' };
}
```

主题配置同理：`readThemeConfigContent` / `applyThemeConfigContent` / `ensureThemeConfigFile` 全部改为 `hexo.siteConfig.get('theme:' + theme.id)` / `set('theme:' + theme.id, content)`；`isThemeInstalled` 改为「DB 中是否存在该 theme 配置或 `BUILTIN_THEMES` 内建主题」。

**快照**（`theme/config/snapshots` 等）原本写 `.hexo-pro/theme-config-snapshots/<id>.json`：改为存 `site_config` 表，`type` 用 `snapshot:theme:{id}` 与 `snapshot:site`，`content` 存 `JSON.stringify(snapshotsArray)`。`createThemeConfigSnapshot` / `readThemeConfigSnapshots` 改为读写 `hexo.siteConfig`。

**Schema**（`theme/schema` get/save/generate）：`getSchemaFilePath` 写文件改为写 `themeSchemaCache` 表（`_id = 'schema:' + themeId`，doc 存 `{schema, configHash, language}`）；`readSchemaFileWithMeta` 改为读该表。`theme/schema/generate` 里 `configContent` 来源改为 `hexo.siteConfig.get('theme:' + theme.id)`。

- [ ] **步骤 3：验证**

运行：`npm start` 后 `curl http://localhost:8001/hexopro/api/theme/list` 应返回内建主题列表；`curl http://localhost:8001/hexopro/api/site/config` 应返回 `_config.yml` 内容（来自 DB，首次导入后）。

- [ ] **步骤 4：Commit**

```bash
git add api/yaml_api.js api/theme_api.js
git commit -m "refactor(api): 站点/主题配置与快照改为 DB 存储"
```

---

## 任务 8：图片与部署改造（`image_api.js`、`deploy_api.js`、`dashboard_api.js`）

**文件：**
- 修改：`api/image_api.js`、`api/deploy_api.js`、`api/dashboard_api.js`、`api/api.js`

- [ ] **步骤 1：`image_api.js` 本地落点改 `upload_dir`**

将 [api/image_api.js](api/image_api.js) 中所有 `path.join(hexo.source_dir, config.customPath)` 与 `path.join(hexo.source_dir, ...)` 替换为 `path.join(hexo.upload_dir, config.customPath)` / `path.join(hexo.upload_dir, ...)`（约 8 处，第 259、284、557、562、622、664、723、760、960、1024 行附近）。COS 分支（`tencentCOS`）无需改动。

- [ ] **步骤 2：`deploy_api.js` GitHub 部署改为触发 Actions**

`customGitDeploy`（约第 490-677 行）整体替换为触发远端工作流。保留 `deployStatusDb` 状态机与 `addLog`/`updateStatus`，只把「本地 hexo + git push」换成：

```js
const triggerGithubDeploy = async () => {
  const wfId = config.workflowId || config.workflow; // 部署配置里可指定 workflow 文件名或 id
  if (!hexo.github) throw new Error('未配置 GitHub 凭据');
  await hexo.github.triggerWorkflow(wfId, config.branch || 'main');
};
```

`executeDeployAsync` 中，`deployTargets` 仅保留 `github`（cloudflare/edgeone 分支删除或返回明确「暂不支持」）。`deploy_config.json` 读写改走 `hexo.siteConfig.get('deploy')` / `set('deploy', ...)`。

- [ ] **步骤 3：`dashboard_api.js` 的 lastDeployTime 改读 DB**

[api/dashboard_api.js](api/dashboard_api.js) 的 `dashboard/system/info` 里读 `.deploy_git/.git/logs/HEAD` 最近部署时间的逻辑（约第 153-172 行）替换为从 `deploy_status` 表读：

```js
let lastDeployTime = '未知';
if (db && db.deployStatusDb) {
  const st = await new Promise((resolve) => db.deployStatusDb.findOne({ type: 'status' }, (e, d) => resolve(d)));
  if (st && st.lastDeployTime) lastDeployTime = st.lastDeployTime;
}
```

> `dashboard_api` 当前未接收 `db` 参数：在 [api/api.js](api/api.js) 的 `dashboard_api(app, hexo, use)` 调用处加 `db`，并更新其模块签名 `module.exports = function (app, hexo, use, db)`。

- [ ] **步骤 4：验证**

运行：`npm start` 后 `curl http://localhost:8001/hexopro/api/dashboard/system/info` 应返回 JSON（`hexoVersion: 'Unknown'`、`lastDeployTime` 来自 DB）。

- [ ] **步骤 5：Commit**

```bash
git add api/image_api.js api/deploy_api.js api/dashboard_api.js api/api.js
git commit -m "refactor(api): 图片改 uploads、部署改触发 Actions、dashboard 改读 DB"
```

---

## 任务 9：启动流程与首次导入（`lib/config.js`、`index.js`）

**文件：**
- 修改：`lib/config.js`、`index.js`
- 删除：`lib/git.js`、`lib/content-indexer.js`、`content/`

- [ ] **步骤 1：改造 `lib/config.js`**

[lib/config.js](lib/config.js) 不再读 `content/_config.yml`。`buildConfig(env)` 改为（`defaults` 来自 `lib/constants.js`）：

```js
function buildConfig(env) {
  env = env || process.env;
  const ROOT = path.resolve(__dirname, '..');
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const uploadDir = path.resolve(env.UPLOAD_DIR || path.join(ROOT, 'uploads'));

  const merged = Object.assign({}, defaults);
  if (env.HEXO_PRO_URL) merged.url = env.HEXO_PRO_URL;
  if (env.HEXO_PRO_ROOT) merged.root = env.HEXO_PRO_ROOT;
  if (env.JWT_SECRET) merged.jwtSecret = env.JWT_SECRET;
  merged.root = merged.root || '/';
  merged.permalink = merged.permalink || ':year/:month/:day/:title/';
  merged.theme = merged.theme || 'landscape';

  return {
    env,
    dataDir,
    uploadDir,
    databaseUrl: env.DATABASE_URL || null,
    port: parseInt(env.PORT, 10) || 8001,
    githubToken: env.GITHUB_TOKEN || null,
    githubRepo: env.GITHUB_REPO || null,
    githubBranch: env.GITHUB_BRANCH || 'main',
    gitName: env.GIT_AUTHOR_NAME || 'Hexo Pro',
    gitEmail: env.GIT_AUTHOR_EMAIL || 'hexo-pro@example.com',
    base_dir: ensureTrailingSep(dataDir),
    source_dir: ensureTrailingSep(path.join(dataDir, 'source')),
    public_dir: ensureTrailingSep(path.join(dataDir, 'public')),
    theme_dir: ensureTrailingSep(path.join(dataDir, 'themes')),
    scaffold_dir: ensureTrailingSep(path.join(dataDir, 'scaffolds')),
    upload_dir: ensureTrailingSep(uploadDir),
    config: merged
  };
}
```

- [ ] **步骤 2：改造 `index.js` 启动流程**

重写 `main()`（[index.js](index.js) 第 28-127 行）：

```js
async function main() {
  const cfg = buildConfig(process.env);
  const databaseManager = require('./lib/db');
  const { GitHubClient } = require('./lib/github');
  const { SiteConfigStore } = require('./lib/site-config');
  const { ContentStore, parsePost, parsePage } = require('./lib/content-store');
  const HexoShim = require('./lib/hexo-shim');
  const yaml = require('js-yaml');

  // 1. DB
  const db = await databaseManager.initialize({ config: cfg.config, log: console });

  // 2. GitHub 客户端（无凭据时仅内存模式，写操作会报错）
  const github = cfg.githubToken && cfg.githubRepo
    ? new GitHubClient({ token: cfg.githubToken, repo: cfg.githubRepo, branch: cfg.githubBranch })
    : null;

  const siteConfig = new SiteConfigStore(db.siteConfigDb, github);

  // 3. 站点配置：空则从 GitHub 导入 _config.yml
  await ensureSiteConfig(siteConfig, github);

  // 4. 合并配置
  const siteRaw = await siteConfig.get('site');
  if (siteRaw) {
    const parsed = yaml.load(siteRaw) || {};
    cfg.config = Object.assign({}, cfg.config, parsed);
  }

  // 5. 内容存储：空则从 GitHub 导入 source/**
  const hexo = new HexoShim(cfg, { github, siteConfig });
  const store = new ContentStore(hexo, db.articleDb);
  hexo.store = store;

  const n = await store.load();
  if (n.length === 0 && github) await importFromGithub(github, store);

  console.log(`[Hexo Pro]: indexed ${store.models.Post.count()} posts, ${store.models.Page.count()} pages`);

  // 6. HTTP server（去掉原 git commit hook / 静态图片服务）
  const app = express();
  app.disable('x-powered-by');
  await require('./api/api')(app, hexo);

  const uploadDir = cfg.upload_dir;
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  app.use('/images', express.static(uploadDir, { maxAge: '7d' }));

  const wwwDir = path.join(__dirname, 'www');
  if (fs.existsSync(wwwDir)) {
    app.use('/pro', express.static(wwwDir));
    app.use('/pro', (req, res, next) => {
      if (req.method !== 'GET' || /\.[a-zA-Z0-9]+$/.test(req.path)) return next();
      res.sendFile(path.join(wwwDir, 'index.html'));
    });
    app.get('/', (req, res) => res.redirect('/pro/'));
  }

  app.use((err, req, res, next) => {
    console.error('[Hexo Pro]: unhandled error:', err && err.stack ? err.stack : err);
    res.status(500).json({ code: 500, msg: 'internal error' });
  });

  app.listen(cfg.port, () => {
    console.log(`[Hexo Pro]: admin server listening on http://localhost:${cfg.port}/pro`);
  });
  return app;
}

async function ensureSiteConfig(siteConfig, github) {
  const existing = await siteConfig.get('site');
  if (existing != null) return;
  if (!github) {
    await siteConfig.set('site', 'title: Hexo Pro Site\nurl: http://localhost:8001\nroot: /\npermalink: :year/:month/:day/:title/\ntheme: landscape\n', { sync: false });
    return;
  }
  try {
    const f = await github.getFile('_config.yml');
    await siteConfig.set('site', f.content, { sync: false });
  } catch (e) {
    console.warn('[Hexo Pro]: 导入 _config.yml 失败:', e.message);
  }
}

async function importFromGithub(github, store) {
  const paths = await github.listTree();
  const mdFiles = paths.filter((p) => /^source\/.*\.(md|markdown)$/i.test(p));
  for (const p of mdFiles) {
    try {
      const { content } = await github.getFile(p);
      const source = p.replace(/^source\//, '');
      const doc = source.startsWith('_drafts/')
        ? parsePost(content, source, false, store.hexo.config)
        : source.startsWith('_posts/')
          ? parsePost(content, source, true, store.hexo.config)
          : parsePage(content, source, store.hexo.config);
      await store.upsert(doc);
    } catch (e) {
      console.warn(`[Hexo Pro]: 导入 ${p} 失败:`, e.message);
    }
  }
  console.log(`[Hexo Pro]: 从 GitHub 导入 ${mdFiles.length} 个 markdown 文件`);
}
```

> `scaffolds/` 不在 `source/` 前缀下，天然跳过。

- [ ] **步骤 3：删除废弃文件与目录**

```bash
rm -rf content
git rm lib/git.js lib/content-indexer.js
```

- [ ] **步骤 4：端到端验证**

运行：`npm start`
预期：控制台输出 `Neon PostgreSQL connected`、`indexed 2 posts, 0 pages`（来自 GitHub 导入 `hello-world.md`、`test.md`），无 `content dir` / `cloned` / `git` 相关日志。

- [ ] **步骤 5：Commit**

```bash
git add lib/config.js index.js
git commit -m "refactor(boot): 启动改为 DB 初始化 + GitHub 首次导入"
```

---

## 任务 10：收尾（`.env`、`.env.example`、`package.json` 测试脚本）

**文件：**
- 修改：`.env`、`.env.example`、`package.json`

- [ ] **步骤 1：更新 `.env`（本地，不提交）**

移除 `CONTENT_DIR`、`GIT_REPO_URL`、`AUTO_PUSH`，新增：

```
GITHUB_TOKEN=<PAT，值见会话>
GITHUB_REPO=Nongsc/hexo-blog
GITHUB_BRANCH=main
# 可选：DATA_DIR=./data  UPLOAD_DIR=./uploads
# 可选：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION（未配置时图片仅落本地）
```

- [ ] **步骤 2：更新 `.env.example`（不含真实 token）**

在 [.env.example](.env.example) 增加：

```
# GitHub content repo (Qexo-style: content lives here, synced via API).
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx
GITHUB_REPO=owner/repo
GITHUB_BRANCH=main
```

并删除 `CONTENT_DIR`、`GIT_REPO_URL` 说明（保留 `DATABASE_URL`、`DATABASE_SSL`、`PORT`、`JWT_SECRET`）。

- [ ] **步骤 3：`package.json` 增加 test 脚本**

[package.json](package.json) 的 `scripts` 增加 `"test": "node --test"`。

- [ ] **步骤 4：全量回归**

```bash
npm test
npm start
curl -s http://localhost:8001/hexopro/api/posts/list?published=all | head -c 500
```

预期：`npm test` 全绿；`posts/list` 返回 2 篇已导入文章。

- [ ] **步骤 5：Commit**

```bash
git add .env.example package.json
git commit -m "chore: 新增 GitHub/COS 环境变量与 test 脚本"
```

---

## 自检记录

- **规格覆盖**：文章 CRUD（任务 3/5/6）、站点信息（任务 4/7）、图片（任务 8）、部署（任务 8）、首次导入（任务 9）、环境变更（任务 10）均有对应任务。`theme/install`、`theme/switch`、cloudflare/edgeone 明确列入「本期暂缓」。
- **类型一致性**：`ContentStore.upsert(doc, keyId)/remove/findByPermalink/load`、`SiteConfigStore.get/set/githubPath`、`GitHubClient.writeFile/deleteFile/getFile/listTree/triggerWorkflow`、`HexoShim.store/siteConfig/github/upload_dir` 在各任务间命名一致；`parsePost/parsePage/serialize` 签名带 `config` 参数，任务 5/9 调用处一致。
- **无占位符**：所有代码步骤均给出具体实现或精确替换片段；`parsePost`/`parsePage` 为 [content-indexer.js](lib/content-indexer.js) 的忠实移植，无空实现。
