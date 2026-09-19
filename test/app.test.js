'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createApp, getApp } = require('../lib/app');

test('createApp 是导出的 async 函数', () => {
  assert.equal(typeof createApp, 'function');
  assert.equal(createApp.constructor.name, 'AsyncFunction');
});

test('getApp 返回可复用单例，且能组装 Express app', async () => {
  const p1 = getApp();
  const p2 = getApp();
  assert.strictEqual(p1, p2);
  const app = await p1;
  assert.strictEqual(typeof app.use, 'function');
});
