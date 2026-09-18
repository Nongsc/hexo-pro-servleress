'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Qexo-style content mutation: edit markdown files in a git checkout, then
 * commit (and optionally push). No `hexo generate` — the remote's CI builds.
 */

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve((stdout || '').trim());
    });
  });
}

async function isGitInstalled() {
  try {
    await run(['--version'], process.cwd());
    return true;
  } catch (err) {
    return false;
  }
}

async function isRepo(contentDir) {
  try {
    await run(['rev-parse', '--is-inside-work-tree'], contentDir);
    return true;
  } catch (err) {
    return false;
  }
}

async function hasRemote(contentDir) {
  try {
    const out = await run(['remote'], contentDir);
    return out.trim().length > 0;
  } catch (err) {
    return false;
  }
}

function isEmptyDir(dir) {
  if (!fs.existsSync(dir)) return true;
  const entries = fs.readdirSync(dir).filter(e => e !== '.git');
  return entries.length === 0;
}

/**
 * Ensure `contentDir` is a git repo. If it is missing/empty and a remote URL is
 * provided, clone it; otherwise `git init`.
 */
async function ensureRepo(contentDir, gitRepoUrl) {
  if (await isRepo(contentDir)) return { cloned: false, initialized: false };

  if (gitRepoUrl && isEmptyDir(contentDir)) {
    fs.mkdirSync(contentDir, { recursive: true });
    const target = path.basename(contentDir);
    const parent = path.dirname(contentDir);
    await run(['clone', gitRepoUrl, target], parent);
    return { cloned: true, initialized: false };
  }

  fs.mkdirSync(contentDir, { recursive: true });
  await run(['init'], contentDir);
  return { cloned: false, initialized: true };
}

async function configureIdentity(contentDir, name, email) {
  try {
    await run(['config', 'user.name', name], contentDir);
    await run(['config', 'user.email', email], contentDir);
  } catch (err) {
    // Identity config failure is non-fatal.
  }
}

/**
 * Write a sensible default .gitignore if the content repo doesn't already have
 * one. Never overwrites an existing .gitignore.
 */
function ensureIgnore(contentDir) {
  const target = path.join(contentDir, '.gitignore');
  if (fs.existsSync(target)) return;
  try {
    fs.writeFileSync(target, [
      'node_modules/',
      'public/',
      'db/',
      '.deploy_git/',
      '.hexo-pro/',
      '.DS_Store',
      'blogInfoList.json',
      'deploy_config.json',
      '_admin-config.yml',
      ''
    ].join('\n'), 'utf8');
  } catch (err) {
    // Non-fatal.
  }
}

/**
 * Stage + commit. Returns the commit hash, or null when there is nothing to
 * commit (and true to signal the no-op).
 */
async function commit(contentDir, message) {
  if (!(await isRepo(contentDir))) return { committed: false, reason: 'not-a-repo' };
  try {
    await run(['add', '-A'], contentDir);
  } catch (err) {
    return { committed: false, reason: err.message };
  }

  let status;
  try {
    status = await run(['status', '--porcelain'], contentDir);
  } catch (err) {
    return { committed: false, reason: err.message };
  }

  if (!status.trim()) {
    return { committed: false, reason: 'nothing-to-commit' };
  }

  try {
    const hash = await run(['commit', '-m', message], contentDir);
    return { committed: true, hash };
  } catch (err) {
    return { committed: false, reason: err.message };
  }
}

async function push(contentDir) {
  if (!(await isRepo(contentDir))) return { pushed: false, reason: 'not-a-repo' };
  if (!(await hasRemote(contentDir))) return { pushed: false, reason: 'no-remote' };
  try {
    const out = await run(['push'], contentDir);
    return { pushed: true, out };
  } catch (err) {
    return { pushed: false, reason: err.message };
  }
}

// Best-effort mutation hook: commit, then optionally push.
async function commitAndMaybePush(contentDir, message, { autoPush, name, email } = {}) {
  if (!(await isRepo(contentDir))) return { committed: false, pushed: false };
  if (name || email) await configureIdentity(contentDir, name, email);
  const c = await commit(contentDir, message);
  if (!c.committed) return { committed: false, pushed: false };
  const p = autoPush ? await push(contentDir) : { pushed: false, reason: 'auto-push-disabled' };
  return { committed: true, hash: c.hash, pushed: p.pushed, pushReason: p.reason };
}

module.exports = {
  run,
  isGitInstalled,
  isRepo,
  hasRemote,
  ensureRepo,
  commit,
  push,
  commitAndMaybePush,
  configureIdentity,
  ensureIgnore
};
