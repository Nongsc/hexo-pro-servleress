'use strict';

const crypto = require('crypto');

/**
 * Neon/PostgreSQL persistence layer with a NeDB-compatible API.
 *
 * The reference backend used `@seald-io/nedb` for five collections. We replace
 * that with Postgres (Neon) while keeping the exact callback surface the ported
 * `api/*.js` files call: findOne/find/insert/update/remove/count plus the
 * chained `find(query).sort().skip().limit().exec(cb)` cursor used by recycle.
 *
 * Strategy: each collection is a tiny table (`_id TEXT PRIMARY KEY, doc JSONB`).
 * For simplicity and to faithfully reproduce NeDB's query semantics ($in, $set
 * merge, etc.) we keep an in-memory copy and write every mutation through to
 * Postgres. Without DATABASE_URL we run memory-only (useful for local smoke
 * tests); with it, Postgres is the durable source of truth.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function reviveDates(value) {
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
    return new Date(value);
  }
  if (Array.isArray(value)) {
    return value.map(reviveDates);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    Object.keys(value).forEach(k => { out[k] = reviveDates(value[k]); });
    return out;
  }
  return value;
}

function matches(doc, query) {
  if (!query) return true;
  return Object.keys(query).every(field => {
    const expected = query[field];
    const actual = doc[field];

    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      return Object.keys(expected).every(op => {
        const val = expected[op];
        switch (op) {
          case '$in':
            return Array.isArray(val) && val.some(v => String(v) === String(actual));
          case '$ne':
            return String(actual) !== String(val);
          case '$exists':
            return val ? actual !== undefined : actual === undefined;
          case '$lt': return actual < val;
          case '$lte': return actual <= val;
          case '$gt': return actual > val;
          case '$gte': return actual >= val;
          default:
            return true;
        }
      });
    }

    return String(actual) === String(expected);
  });
}

function applyUpdate(doc, update) {
  if (!update || typeof update !== 'object') return doc;
  const hasOperator = Object.keys(update).some(k => k.startsWith('$'));
  if (!hasOperator) {
    // Full document replace (NeDB semantics).
    Object.keys(doc).forEach(k => delete doc[k]);
    Object.assign(doc, update);
    return doc;
  }
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$unset) Object.keys(update.$unset).forEach(k => delete doc[k]);
  if (update.$inc) {
    Object.keys(update.$inc).forEach(k => {
      doc[k] = (Number(doc[k]) || 0) + Number(update.$inc[k]);
    });
  }
  if (update.$push) {
    Object.keys(update.$push).forEach(k => {
      if (!Array.isArray(doc[k])) doc[k] = [];
      const val = update.$push[k];
      if (val && typeof val === 'object' && val.$each) {
        doc[k] = doc[k].concat(val.$each);
      } else {
        doc[k].push(val);
      }
    });
  }
  if (update.$pull) {
    Object.keys(update.$pull).forEach(k => {
      if (!Array.isArray(doc[k])) return;
      const val = update.$pull[k];
      doc[k] = doc[k].filter(item => String(item) !== String(val));
    });
  }
  return doc;
}

class Cursor {
  constructor(table, query) {
    this.table = table;
    this.query = query || {};
    this._sort = null;
    this._skip = 0;
    this._limit = -1;
  }
  sort(fieldObj) {
    this._sort = fieldObj || null;
    return this;
  }
  skip(n) { this._skip = n || 0; return this; }
  limit(n) { this._limit = n; return this; }

  exec(cb) {
    this.table._find(this.query).then(docs => {
      let result = docs.slice();
      if (this._sort) {
        const [field, dir] = Object.entries(this._sort)[0];
        result.sort((a, b) => {
          const av = a[field] instanceof Date ? a[field].getTime() : a[field];
          const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
          if (av < bv) return dir > 0 ? -1 : 1;
          if (av > bv) return dir > 0 ? 1 : -1;
          return 0;
        });
      }
      if (this._skip) result = result.slice(this._skip);
      if (this._limit >= 0) result = result.slice(0, this._limit);
      cb(null, result);
    }).catch(err => cb(err));
  }
}

class Table {
  constructor(pool, tableName) {
    this.pool = pool;
    this.tableName = tableName;
    this.docs = [];
    this.loaded = !pool;
  }

  async _ensureLoaded() {
    if (this.loaded) return;
    if (!this.pool) { this.loaded = true; return; }
    try {
      const res = await this.pool.query(`SELECT doc FROM "${this.tableName}"`);
      this.docs = res.rows.map(r => reviveDates(r.doc));
    } catch (err) {
      // Table may not exist yet if migration is deferred; fall back to empty.
      this.docs = [];
    }
    this.loaded = true;
  }

  async _persistInsert(doc) {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO "${this.tableName}" (_id, doc) VALUES ($1, $2)
       ON CONFLICT (_id) DO UPDATE SET doc = EXCLUDED.doc`,
      [doc._id, JSON.stringify(doc)]
    );
  }

  async _persistUpdate(id, doc) {
    if (!this.pool) return;
    await this.pool.query(
      `UPDATE "${this.tableName}" SET doc = $2 WHERE _id = $1`,
      [id, JSON.stringify(doc)]
    );
  }

  async _persistRemove(ids) {
    if (!this.pool || !ids.length) return;
    await this.pool.query(
      `DELETE FROM "${this.tableName}" WHERE _id = ANY($1::text[])`,
      [ids]
    );
  }

  async _find(query) {
    await this._ensureLoaded();
    const q = query || {};
    return this.docs.filter(doc => matches(doc, q));
  }

  findOne(query, cb) {
    this._find(query).then(docs => cb(null, docs[0] || null)).catch(err => cb(err));
  }

  find(query, cb) {
    if (typeof cb === 'function') {
      this._find(query).then(docs => cb(null, docs)).catch(err => cb(err));
      return;
    }
    return new Cursor(this, query);
  }

  insert(doc, cb) {
    this._ensureLoaded().then(() => {
      if (doc._id === undefined || doc._id === null) {
        doc._id = crypto.randomBytes(8).toString('hex');
      }
      const stored = Object.assign({}, doc, { _id: doc._id });
      this.docs.push(stored);
      return this._persistInsert(stored).then(() => cb(null, stored));
    }).catch(err => cb(err));
  }

  update(query, update, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    options = options || {};
    this._find(query).then(matched => {
      if (matched.length === 0 && options.upsert) {
        const base = {};
        Object.keys(query || {}).forEach(k => {
          const v = query[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) return;
          base[k] = v;
        });
        applyUpdate(base, update);
        return this.insert(base, cb);
      }
      let affected = 0;
      const writes = [];
      const targets = options.multi ? matched : matched.slice(0, 1);
      targets.forEach(doc => {
        applyUpdate(doc, update);
        affected++;
        writes.push(this._persistUpdate(doc._id, doc));
      });
      return Promise.all(writes).then(() => cb(null, affected));
    }).catch(err => cb(err));
  }

  remove(query, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    options = options || {};
    this._find(query).then(matched => {
      const targets = options.multi ? matched : matched.slice(0, 1);
      const ids = targets.map(d => d._id);
      ids.forEach(id => {
        const idx = this.docs.findIndex(d => d._id === id);
        if (idx >= 0) this.docs.splice(idx, 1);
      });
      return this._persistRemove(ids).then(() => cb(null, ids.length));
    }).catch(err => cb(err));
  }

  count(query, cb) {
    this._find(query).then(docs => cb(null, docs.length)).catch(err => cb(err));
  }
}

const TABLES = [
  'users',
  'settings',
  'deploy_status',
  'recycle',
  'theme_schema_cache',
  'articles',
  'site_config'
];

class DatabaseManager {
  constructor() {
    this.isInitialized = false;
    this.initPromise = null;
    this.pool = null;
    this.databases = null;
  }

  async initialize(hexo) {
    if (this.isInitialized) return this.databases;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._performInitialization(hexo);
    try {
      this.databases = await this.initPromise;
      this.isInitialized = true;
      return this.databases;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }

  async _performInitialization(hexo) {
    const cfg = hexo.config || {};
    let pool = null;

    if (process.env.DATABASE_URL) {
      try {
        // Lazy require so the backend still boots in memory when pg isn't needed.
        const { Pool } = require('pg');
        pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
        });
        await this._migrate(pool);
        console.log('[Database Manager]: Neon PostgreSQL connected');
      } catch (err) {
        console.error('[Database Manager]: PostgreSQL connect failed, falling back to memory:', err.message);
        pool = null;
      }
    }

    const make = name => new Table(pool, name);
    const databases = {
      userDb: make('users'),
      settingsDb: make('settings'),
      deployStatusDb: make('deploy_status'),
      recycleDb: make('recycle'),
      themeSchemaCache: make('theme_schema_cache'),
      articleDb: make('articles'),
      siteConfigDb: make('site_config')
    };

    await this._initializeDeployStatus(databases.deployStatusDb);
    await this._initializeUserAndSettings(databases.userDb, databases.settingsDb, cfg);

    return databases;
  }

  async _migrate(pool) {
    for (const name of TABLES) {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS "${name}" (
           _id TEXT PRIMARY KEY,
           doc JSONB NOT NULL
         )`
      );
    }
  }

  _initializeDeployStatus(db) {
    return new Promise((resolve, reject) => {
      db.findOne({ type: 'status' }, (err, doc) => {
        if (err) return reject(err);
        if (!doc) {
          db.insert({
            type: 'status',
            isDeploying: false,
            progress: 0,
            stage: 'idle',
            lastDeployTime: '',
            logs: [],
            error: null
          }, insertErr => insertErr ? reject(insertErr) : resolve());
        } else if (doc.isDeploying) {
          db.update(
            { type: 'status' },
            {
              $set: {
                isDeploying: false,
                stage: 'failed',
                error: 'deploy.interruption.cause.by.service.restart',
                logs: [...(doc.logs || []), 'deploy.interruption.cause.by.service.restart.status.reset']
              }
            },
            {},
            updateErr => updateErr ? reject(updateErr) : resolve()
          );
        } else {
          resolve();
        }
      });
    });
  }

  async _initializeUserAndSettings(userDb, settingsDb, cfg) {
    const count = await new Promise((resolve, reject) =>
      userDb.count({}, (err, n) => err ? reject(err) : resolve(n))
    );

    if (count === 0 && cfg.hexo_pro && cfg.hexo_pro.username && cfg.hexo_pro.password) {
      await new Promise((resolve, reject) => {
        userDb.insert({
          username: cfg.hexo_pro.username,
          password: cfg.hexo_pro.password,
          avatar: cfg.avatar ? cfg.avatar : '',
          createdAt: new Date(),
          updatedAt: new Date()
        }, (err, doc) => err ? reject(err) : resolve(doc));
      });
      console.log('[Database Manager]: imported initial user from _config.yml');

      const settingsCount = await new Promise((resolve, reject) =>
        settingsDb.count({ type: 'system' }, (err, n) => err ? reject(err) : resolve(n))
      );
      if (settingsCount === 0) {
        const jwtSecret = (cfg.hexo_pro && cfg.hexo_pro.secret)
          ? cfg.hexo_pro.secret
          : crypto.randomBytes(32).toString('hex');
        await new Promise((resolve, reject) => {
          settingsDb.insert({
            type: 'system',
            jwtSecret,
            createdAt: new Date()
          }, (err, doc) => err ? reject(err) : resolve(doc));
        });
      }
    }
  }

  getDatabases() {
    if (!this.isInitialized) throw new Error('Database not initialized');
    return this.databases;
  }

  isReady() {
    return this.isInitialized;
  }

  reset() {
    this.isInitialized = false;
    this.initPromise = null;
    this.databases = null;
    this.pool = null;
  }
}

module.exports = new DatabaseManager();
