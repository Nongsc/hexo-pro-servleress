'use strict';

// --- Minimal .env loader (avoids a dotenv dependency) ---------------------
(function loadDotEnv() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) return;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  });
})();

const path = require('path');
const fs = require('fs');
const express = require('express');
const { buildConfig } = require('./lib/config');

async function main() {
  const cfg = buildConfig(process.env);
  const databaseManager = require('./lib/db');
  const { GitHubClient } = require('./lib/github');
  const { SiteConfigStore } = require('./lib/site-config');
  const { ContentStore } = require('./lib/content-store');
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

  await databaseManager.ensureInitialUser(cfg.config);

  // 5. 内容存储：空则从 GitHub 导入 source/**
  const hexo = new HexoShim(cfg, { github, siteConfig });
  const store = new ContentStore(hexo, db.articleDb);
  hexo.store = store;

  if (!fs.existsSync(cfg.dataDir)) fs.mkdirSync(cfg.dataDir, { recursive: true });
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
  const { parsePost, parsePage } = require('./lib/content-store');
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

main().catch(err => {
  console.error('[Hexo Pro]: fatal startup error:', err);
  process.exit(1);
});
