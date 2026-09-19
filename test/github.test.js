'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { GitHubClient } = require('../lib/github');

test('writeFile 将内容 base64 编码并带上 branch/sha', async () => {
  const calls = [];
  const client = new GitHubClient({ token: 'x', repo: 'o/r', branch: 'main' });
  client._request = async (method, path, body) => { calls.push({ method, path, body }); return { sha: 'newsha' }; };
  client._getSha = async () => 'oldsha';
  await client.writeFile('source/_posts/a.md', 'hello', 'Hexo Pro: test');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].body.content, Buffer.from('hello', 'utf8').toString('base64'));
  assert.equal(calls[0].body.sha, 'oldsha');
  assert.equal(calls[0].body.branch, 'main');
});

test('缺 token 或 repo 时构造抛错', () => {
  assert.throws(() => new GitHubClient({ token: '', repo: 'o/r' }));
  assert.throws(() => new GitHubClient({ token: 'x', repo: '' }));
});
