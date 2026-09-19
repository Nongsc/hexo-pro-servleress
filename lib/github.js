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
          const err = new Error(`GitHub API ${method} ${path} -> ${res.statusCode}: ${String(data).slice(0, 300)}`);
          err.status = res.statusCode;
          reject(err);
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
    } catch (e) {
      if (e.status === 404) return null; // 文件确实不存在
      throw e; // 401/429/网络错误等向上抛，不能误当成"文件不存在"
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
