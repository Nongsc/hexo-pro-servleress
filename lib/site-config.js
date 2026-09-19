// lib/site-config.js
'use strict';

class SiteConfigStore {
  constructor(siteConfigDb, github) {
    this.siteConfigDb = siteConfigDb;
    this.github = github;
  }

  async get(type) {
    return new Promise((resolve, reject) =>
      this.siteConfigDb.findOne({ type }, (e, d) => (e ? reject(e) : resolve(d ? d.content : null))));
  }

  async set(type, content, { sync = true, message } = {}) {
    await new Promise((resolve, reject) => {
      this.siteConfigDb.update({ type }, { $set: { type, content, updatedAt: new Date() } }, { upsert: true },
        (e) => (e ? reject(e) : resolve()));
    });
    if (sync && this.github) {
      const ghPath = this.githubPath(type);
      if (ghPath) await this.github.writeFile(ghPath, content, message || `Hexo Pro: update ${type}`);
    }
    return { type, content };
  }

  githubPath(type) {
    if (type === 'site') return '_config.yml';
    if (type === 'templates') return '_yaml_templates/templates.json';
    if (type.startsWith('theme:')) return `_config.${type.slice(6)}.yml`;
    return null;
  }
}

module.exports = { SiteConfigStore };
