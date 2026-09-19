'use strict';

const path = require('path');
const defaults = require('./constants');

function ensureTrailingSep(p) {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

/**
 * Build the merged hexo-style config + directory layout.
 *
 * The source of truth is the DB (site_config) + GitHub content repo; this only
 * resolves env + defaults into the layout the shim and API expect. The actual
 * _config.yml merge happens in index.js after the site config is loaded from
 * the DB (or imported from GitHub on first boot).
 */
function isServerless(env) {
  env = env || process.env;
  return env.VERCEL === '1' || env.EDGEONE === '1' || env.SERVERLESS === 'true';
}

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

module.exports = { buildConfig, isServerless };
