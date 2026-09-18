'use strict';

const path = require('path');
const fs = require('fs');
const moment = require('moment');
const hfm = require('hexo-front-matter');
const yaml = require('js-yaml');
const { slugize } = require('hexo-util');
const ContentIndexer = require('./content-indexer');

/**
 * A plain-object stand-in for the hexo instance the ported API modules expect.
 *
 * The reference backend ran inside `hexo` and called `hexo.model()`,
 * `hexo.source.process()`, `hexo.post.create()`, `hexo.config`, `hexo.log`, etc.
 * Here every one of those is backed by the in-memory content indexer + the files
 * on disk (which are the single source of truth), so no hexo runtime is needed.
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
  constructor(cfg) {
    this.config = cfg.config;
    this.base_dir = cfg.base_dir;
    this.source_dir = cfg.source_dir;
    this.public_dir = cfg.public_dir;
    this.theme_dir = cfg.theme_dir;
    this.scaffold_dir = cfg.scaffold_dir;

    this.log = makeLogger();
    this.locals = { invalidate: () => {} };
    this.emit = () => {};
    this.route = {};

    // theme.config mirrors hexo.config.theme_config (updated by yaml_api/theme_api).
    this.theme = { config: Object.assign({}, cfg.config.theme_config || {}) };

    this.indexer = new ContentIndexer(this);

    // hexo.source.process(files) — reprocess the source directory. In our model
    // that simply rebuilds the in-memory index from disk.
    this.source = {
      process: (files) => this._process(files)
    };

    // hexo.post.create(data) — write a new post/draft markdown file. Returns a
    // thenable that resolves to `{ path }` (and supports `.error` like Bluebird,
    // which the reference backend's `posts/new` handler calls).
    this.post = {
      create: (data) => {
        const p = this._createPost(data);
        p.error = (fn) => { p.catch(err => fn(err)); return p; };
        return p;
      }
    };

    // hexo._generate(opts) — the reference calls this after theme/yaml config
    // edits; here it just rebuilds the index (and returns a promise).
    this._generate = (opts) => this._process(opts && opts.source ? opts.source : undefined);
  }

  model(name) {
    return this.indexer.models[name];
  }

  rebuild() {
    return this.indexer.rebuild();
  }

  _process(files) {
    return Promise.resolve().then(() => this.indexer.rebuild(files));
  }

  _createPost(data) {
    return new Promise((resolve, reject) => {
      try {
        const layout = (data.layout || this.config.default_layout || 'post').toLowerCase();
        const dir = layout === 'draft' ? '_drafts' : '_posts';
        const title = data.title || 'Untitled';
        const slug = slugize(title);
        const date = data.date ? moment(data.date) : moment();

        const fm = { title, date: date.format('YYYY-MM-DD HH:mm:ss') };

        const tags = Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : []);
        const cats = Array.isArray(data.categories) ? data.categories : (data.categories ? [data.categories] : []);
        if (tags.length) fm.tags = tags.map(String);
        if (cats.length) fm.categories = cats.map(String);
        if (data.author) fm.author = data.author;

        // Extra front-matter keys declared in `metadata`.
        Object.keys(this.config.metadata || {}).forEach(key => {
          if (data[key] != null) fm[key] = data[key];
        });

        // Filename from `new_post_name` (default `:title.md`).
        const nameTemplate = this.config.new_post_name || ':title.md';
        let filename = nameTemplate
          .replace(/:title/g, slug)
          .replace(/:year/g, date.format('YYYY'))
          .replace(/:month/g, date.format('MM'))
          .replace(/:day/g, date.format('DD'));
        if (!/\.(md|markdown)$/i.test(filename)) filename += '.md';

        const outDir = path.join(this.source_dir, dir);
        fs.mkdirSync(outDir, { recursive: true });

        let outPath = path.join(outDir, filename);
        if (fs.existsSync(outPath)) {
          const base = filename.replace(/\.(md|markdown)$/i, '');
          filename = `${base}-${Date.now()}.md`;
          outPath = path.join(outDir, filename);
        }

        const raw = hfm.stringify(fm, { prefixSeparator: true }) + '\n';
        fs.writeFileSync(outPath, raw, 'utf8');

        resolve({ path: outPath });
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = HexoShim;
