'use strict';

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const defaults = require('./constants');

const ROOT_DIR = path.resolve(__dirname, '..');

function ensureTrailingSep(p) {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

function loadYaml(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(content);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

/**
 * Build the merged hexo-style config + directory layout.
 *
 * CONTENT_DIR is the hexo "base_dir": the git checkout holding _config.yml,
 * source/, themes/, scaffolds/. This matches the Qexo model where the content
 * repo is a full hexo site (minus the generated output).
 */
function buildConfig(env) {
  env = env || process.env;

  const contentDir = path.resolve(env.CONTENT_DIR || path.join(ROOT_DIR, 'content'));
  const siteConfig = loadYaml(path.join(contentDir, '_config.yml'));

  const merged = Object.assign({}, defaults, siteConfig);

  // Environment overrides (used to point at a different public url/root without
  // editing _config.yml, and for secrets that never belong in the repo).
  if (env.HEXO_PRO_URL) merged.url = env.HEXO_PRO_URL;
  if (env.HEXO_PRO_ROOT) merged.root = env.HEXO_PRO_ROOT;
  if (env.JWT_SECRET) merged.jwtSecret = env.JWT_SECRET;

  // Fallbacks for anything the indexer assumes exists.
  merged.root = merged.root || '/';
  merged.permalink = merged.permalink || ':year/:month/:day/:title/';
  merged.theme = merged.theme || 'landscape';

  const baseDir = ensureTrailingSep(contentDir);
  const themeName = merged.theme || 'landscape';

  return {
    // Raw values
    env,
    contentDir,
    databaseUrl: env.DATABASE_URL || null,
    gitRepoUrl: env.GIT_REPO_URL || null,
    port: parseInt(env.PORT, 10) || 8001,
    autoPush: (env.AUTO_PUSH || '').toLowerCase() === 'true',
    autoCommit: (env.AUTO_COMMIT || '').toLowerCase() !== 'false', // default true
    gitName: env.GIT_AUTHOR_NAME || 'Hexo Pro',
    gitEmail: env.GIT_AUTHOR_EMAIL || 'hexo-pro@example.com',

    // Hexo-compatible layout
    base_dir: baseDir,
    source_dir: ensureTrailingSep(path.join(contentDir, 'source')),
    public_dir: ensureTrailingSep(path.join(contentDir, 'public')),
    theme_dir: ensureTrailingSep(path.join(contentDir, 'themes', themeName)),
    scaffold_dir: ensureTrailingSep(path.join(contentDir, 'scaffolds')),
    config: merged
  };
}

module.exports = { buildConfig, loadYaml };
