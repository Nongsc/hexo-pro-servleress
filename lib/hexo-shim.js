'use strict';

const moment = require('moment');
const hfm = require('hexo-front-matter');
const { slugize } = require('hexo-util');

/**
 * A plain-object stand-in for the hexo instance the ported API modules expect.
 *
 * The reference backend ran inside `hexo` and called `hexo.model()`,
 * `hexo.source.process()`, `hexo.post.create()`, `hexo.config`, `hexo.log`, etc.
 * Here every one of those is backed by the ContentStore (DB) + GitHubClient, so
 * no hexo runtime is needed.
 */

function makeLogger() {
  const prefix = '[Hexo Pro]';
  return {
    d: (...args) => console.debug(prefix, ...args),
    debug: (...args) => console.debug(prefix, ...args),
    i: (...args) => console.info(prefix, ...args),
    info: (...args) => console.info(prefix, ...args),
    w: (...args) => console.warn(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    e: (...args) => console.error(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    log: (...args) => console.log(prefix, ...args)
  };
}

class HexoShim {
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

    // theme.config mirrors hexo.config.theme_config (updated by yaml_api/theme_api).
    this.theme = { config: Object.assign({}, cfg.config.theme_config || {}) };

    this.store = deps.store;            // ContentStore 实例（index.js 稍后回填）
    this.siteConfig = deps.siteConfig;  // SiteConfigStore 实例
    this.github = deps.github;          // GitHubClient 实例（可为 null）

    // hexo.source.process(files) — reprocess the source directory. In our model
    // that simply reloads the ContentStore from the DB.
    this.source = {
      process: (files) => this._process(files)
    };

    // hexo.post.create(data) — write a new post/draft markdown file. Returns a
    // thenable that resolves to `{ path, _id }` (and supports `.error` like
    // Bluebird, which the reference backend's `posts/new` handler calls).
    this.post = {
      create: (data) => {
        const p = this._createPost(data);
        p.error = (fn) => { p.catch(err => fn(err)); return p; };
        return p;
      }
    };

    // hexo._generate(opts) — the reference calls this after theme/yaml config
    // edits; here it just reloads the store (and returns a promise).
    this._generate = (opts) => this._process(opts && opts.source ? opts.source : undefined);
  }

  model(name) {
    return this.store ? this.store.models[name] : undefined;
  }

  rebuild() {
    return this.store ? this.store.load() : Promise.resolve();
  }

  _process() {
    return Promise.resolve().then(() => (this.store ? this.store.load() : undefined));
  }

  async _createPost(data) {
    const layout = (data.layout || this.config.default_layout || 'post').toLowerCase();
    const isDraft = layout === 'draft';
    const dir = isDraft ? '_drafts' : '_posts';
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

    // 文件名来自 new_post_name（默认 ':title.md'），与原实现一致。
    const nameTemplate = this.config.new_post_name || ':title.md';
    let filename = nameTemplate
      .replace(/:title/g, slug)
      .replace(/:year/g, date.format('YYYY'))
      .replace(/:month/g, date.format('MM'))
      .replace(/:day/g, date.format('DD'));
    if (!/\.(md|markdown)$/i.test(filename)) filename += '.md';

    let source = `${dir}/${filename}`;

    const { parsePost } = require('./content-store');
    // 冲突处理：store 中已有相同 source 的文章 → 追加时间戳后缀（适配原 fs.existsSync）。
    await this.store.load();
    if (this.store.models.Post.find(d => d.source === source).length > 0) {
      const base = filename.replace(/\.(md|markdown)$/i, '');
      filename = `${base}-${Date.now()}.md`;
      source = `${dir}/${filename}`;
    }

    const raw = hfm.stringify(fm, { prefixSeparator: true }) + '\n';
    const doc = parsePost(raw, source, !isDraft, this.config);
    await this.store.upsert(doc);

    if (this.github) await this.github.writeFile(`source/${source}`, raw, `Hexo Pro: create ${source}`);
    return { path: source, _id: doc._id };
  }
}

module.exports = HexoShim;
