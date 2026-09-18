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
const HexoShim = require('./lib/hexo-shim');
const databaseManager = require('./lib/db');
const git = require('./lib/git');

async function main() {
  const cfg = buildConfig(process.env);
  const contentDir = cfg.contentDir;

  // 1. Ensure the content directory exists (git repo: clone remote if empty).
  console.log(`[Hexo Pro]: content dir = ${contentDir}`);
  const repo = await git.ensureRepo(contentDir, cfg.gitRepoUrl);
  if (repo.cloned) console.log('[Hexo Pro]: cloned content repo');
  else if (repo.initialized) console.log('[Hexo Pro]: initialized new content repo');
  await git.configureIdentity(contentDir, cfg.gitName, cfg.gitEmail);
  git.ensureIgnore(contentDir);

  // 2. Ensure a minimal hexo source layout exists.
  ensureSourceLayout(contentDir);

  // 3. Build the hexo shim (config + dirs + content indexer).
  const hexo = new HexoShim(cfg);

  // 4. Initialize the Postgres-backed database (users/settings/deploy/recycle…).
  const db = await databaseManager.initialize(hexo);

  // 5. Build the in-memory content index from the markdown files.
  try {
    hexo.rebuild();
    console.log(`[Hexo Pro]: indexed ${hexo.model('Post').count()} posts, ${hexo.model('Page').count()} pages`);
  } catch (err) {
    console.error('[Hexo Pro]: content index failed:', err.message);
  }

  // 6. HTTP server.
  const app = express();
  app.disable('x-powered-by');

  // Git commit hook: register a `finish` listener on every mutating API request
  // BEFORE the API routes, so it fires once the handler ends the response. It
  // commits the content repo (and pushes when AUTO_PUSH=true), debounced so a
  // burst of related calls collapses into one commit.
  let commitTimer = null;
  app.use('/hexopro/api', (req, res, next) => {
    res.on('finish', () => {
      if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return;
      if (commitTimer) return;
      commitTimer = setTimeout(async () => {
        commitTimer = null;
        try {
          const r = await git.commitAndMaybePush(contentDir, 'Hexo Pro: content update', {
            autoPush: cfg.autoPush,
            name: cfg.gitName,
            email: cfg.gitEmail
          });
          if (r.committed) {
            console.log(`[Hexo Pro]: committed ${r.hash}${r.pushed ? ' (pushed)' : ''}`);
          }
        } catch (err) {
          console.error('[Hexo Pro]: git commit failed:', err.message);
        }
      }, 800);
    });
    next();
  });

  // API (registers body-parser, CORS, JWT and all /hexopro/api routes).
  await require('./api/api')(app, hexo);

  // Static content assets (uploaded images live under source/<customPath>).
  const imagesDir = path.join(cfg.source_dir, 'images');
  if (fs.existsSync(imagesDir)) {
    app.use('/images', express.static(imagesDir, { maxAge: '7d' }));
  }
  // Guarded fallback for other static assets from the source tree.
  app.use(staticGuard);
  app.use('/', express.static(cfg.source_dir, { dotfiles: 'deny', index: false }));

  // SPA (built React client, publicPath /pro/).
  const wwwDir = path.join(__dirname, 'www');
  if (fs.existsSync(wwwDir)) {
    app.use('/pro', express.static(wwwDir));
    app.use('/pro', (req, res, next) => {
      if (req.method !== 'GET' || /\.[a-zA-Z0-9]+$/.test(req.path)) return next();
      res.sendFile(path.join(wwwDir, 'index.html'));
    });
    app.get('/', (req, res) => res.redirect('/pro/'));
  } else {
    console.warn('[Hexo Pro]: www/ not found — build the client first (`npm run build`).');
  }

  // Final error handler (API errors already handled inside api.js).
  app.use((err, req, res, next) => {
    console.error('[Hexo Pro]: unhandled error:', err && err.stack ? err.stack : err);
    res.status(500).json({ code: 500, msg: 'internal error' });
  });

  const port = cfg.port;
  app.listen(port, () => {
    console.log(`[Hexo Pro]: admin server listening on http://localhost:${port}/pro`);
    console.log(`[Hexo Pro]: API base http://localhost:${port}/hexopro/api`);
  });

  return app;
}

// Create the minimum hexo content layout if the repo is empty.
function ensureSourceLayout(contentDir) {
  const dirs = [
    path.join(contentDir, 'source', '_posts'),
    path.join(contentDir, 'source', '_drafts'),
    path.join(contentDir, 'source', 'images'),
    path.join(contentDir, 'scaffolds')
  ];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  const scaffold = path.join(contentDir, 'scaffolds', 'post.md');
  if (!fs.existsSync(scaffold)) {
    fs.writeFileSync(scaffold, '---\ntitle: {{ title }}\ndate: {{ date }}\ntags:\n---\n', 'utf8');
  }
  const configFile = path.join(contentDir, '_config.yml');
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, [
      'title: Hexo Pro Site',
      'url: http://localhost:8001',
      'root: /',
      'permalink: :year/:month/:day/:title/',
      'theme: landscape',
      ''
    ].join('\n'), 'utf8');
  }
}

// Block raw source files (markdown, yaml, drafts, discarded) from being served
// as static assets, while allowing uploaded media (images etc.).
function staticGuard(req, res, next) {
  const p = req.path || '';
  const first = p.split('/')[1] || '';
  if (first.startsWith('_')) return next();
  if (/\.(md|markdown|yml|yaml|json|db)$/i.test(p)) return next();
  next();
}

main().catch(err => {
  console.error('[Hexo Pro]: fatal startup error:', err);
  process.exit(1);
});
