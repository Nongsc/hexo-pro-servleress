'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const appModule = require('../lib/app');

test('createApp 是导出的 async 函数', () => {
  assert.equal(typeof appModule.createApp, 'function');
  assert.equal(appModule.createApp.constructor.name, 'AsyncFunction');
});

test('getApp 是模块级 Promise 单例：两次调用返回同一实例', () => {
  const p1 = appModule.getApp();
  const p2 = appModule.getApp();
  assert.ok(p1 instanceof Promise, 'getApp 应返回 Promise');
  assert.strictEqual(p1, p2, '两次 getApp() 应返回同一个 Promise 实例');
});
