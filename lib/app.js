'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const { buildConfig } = require('./config');

async function createApp(env = process.env) {
  const cfg = buildConfig(env);
  const databaseManager = require('./db');
  const { GitHubClient } = require('./github');
  const { SiteConfigStore } = require('./site-config');
  const { ContentStore } = require('./content-store');
  const HexoShim = require('./hexo-shim');
  const yaml = require('js-yaml');

  const db = await databaseManager.initialize({ config: cfg.config, log: console });
  const github = cfg.githubToken && cfg.githubRepo
    ? new GitHubClient({ token: cfg.githubToken, repo: cfg.githubRepo, branch: cfg.githubBranch })
    : null;
  const siteConfig = new SiteConfigStore(db.siteConfigDb, github);
  await ensureSiteConfig(siteConfig, github);
  const siteRaw = await siteConfig.get('site');
  if (siteRaw) {
    const parsed = yaml.load(siteRaw) || {};
    cfg.config = Object.assign({}, cfg.config, parsed);
  }
  await databaseManager.ensureInitialUser(cfg.config);

  const hexo = new HexoShim(cfg, { github, siteConfig });
  const store = new ContentStore(hexo, db.articleDb);
  hexo.store = store;

  // dataDir 无写入（持久化全在 DB），仅本地开发兜底；serverless 只读 FS 下用 try/catch 容忍
  try { if (!fs.existsSync(cfg.dataDir)) fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch (_) {}
  const n = await store.load();
  if (n.length === 0 && github) await importFromGithub(github, store);
  console.log(`[Hexo Pro]: indexed ${store.models.Post.count()} posts, ${store.models.Page.count()} pages`);

  const app = express();
  app.disable('x-powered-by');
  await require('../api/api')(app, hexo);

  const uploadDir = cfg.upload_dir;
  try { if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true }); } catch (_) {}
  app.use('/images', express.static(uploadDir, { maxAge: '7d' }));

  const wwwDir = path.join(__dirname, '..', 'www');
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
  const { parsePost, parsePage } = require('./content-store');
  let paths;
  try {
    paths = await github.listTree();
  } catch (e) {
    console.warn('[Hexo Pro]: 从 GitHub 列出内容失败，跳过首次导入:', e.message);
    return;
  }
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

let appPromise = null;
function getApp() {
  if (!appPromise) appPromise = createApp();
  return appPromise;
}

module.exports = { createApp, getApp };
