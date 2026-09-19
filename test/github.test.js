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

test('_request 在非 2xx 时抛出的错误带 status', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const origRequest = https.request;
  https.request = (options, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 401;
      cb(res);
      res.emit('data', 'bad credentials');
      res.emit('end');
    };
    return req;
  };
  try {
    const client = new GitHubClient({ token: 'x', repo: 'o/r', branch: 'main' });
    await assert.rejects(() => client._request('GET', '/x'), (e) => e.status === 401);
  } finally {
    https.request = origRequest;
  }
});

test('_getSha 仅 404 返回 null，其余错误向上抛', async () => {
  const client = new GitHubClient({ token: 'x', repo: 'o/r', branch: 'main' });

  const notFound = new Error('404');
  notFound.status = 404;
  client._request = async () => { throw notFound; };
  assert.equal(await client._getSha('a.md'), null);

  const unauthorized = new Error('401');
  unauthorized.status = 401;
  client._request = async () => { throw unauthorized; };
  await assert.rejects(() => client._getSha('a.md'), /401/);
});

test('deleteFile 仅真 404 返回 skipped，非 404 错误向上抛', async () => {
  const client = new GitHubClient({ token: 'x', repo: 'o/r', branch: 'main' });

  const notFound = new Error('404');
  notFound.status = 404;
  let calls = 0;
  client._request = async () => { calls++; throw notFound; };
  assert.deepEqual(await client.deleteFile('a.md', 'msg'), { skipped: true });
  assert.equal(calls, 1);

  const unauthorized = new Error('401');
  unauthorized.status = 401;
  client._request = async () => { throw unauthorized; };
  await assert.rejects(() => client.deleteFile('a.md', 'msg'), /401/);
});
