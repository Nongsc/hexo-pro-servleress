// test/dashboard-system-info.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const dashboardApi = require('../api/dashboard_api');

// 期望来源：本项目 package.json
const pkg = require('../package.json');

// 捕获 use(path, fn) 注册的路由
function registerRoutes() {
    const routes = {};
    const app = { use() {} };
    const use = (path, fn) => { routes[path] = fn; };
    return { app, use, routes };
}

// 假 hexo：仅提供 handler 需要的 config；不触碰真实 hexo / DB / node_modules
function fakeHexo() {
    return { config: { theme: 'anzhiyu', author: 'tester' } };
}

// 假 res：捕获 done/send 的结果
function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        done(val) { this.body = val; },
        send(num, data) { this.statusCode = num; this.body = data; },
    };
}

async function runSystemInfo() {
    const { app, use, routes } = registerRoutes();
    dashboardApi(app, fakeHexo(), use, null);

    const handler = routes['dashboard/system/info'];
    assert.ok(handler, '应注册 dashboard/system/info 路由');

    const res = fakeRes();
    await handler({}, res);
    return res;
}

test('system/info 的 hexoVersion 来自本项目 package.json 的 version', async () => {
    const res = await runSystemInfo();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.hexoVersion, pkg.version);
});

test('plugins 为 {name,version,enabled} 对象数组，name 都以 hexo- 开头', async () => {
    const res = await runSystemInfo();
    const plugins = res.body.plugins;

    assert.ok(Array.isArray(plugins), 'plugins 应为数组');

    const expectedNames = Object.keys(pkg.dependencies || {}).filter(d => d.startsWith('hexo-'));
    assert.ok(expectedNames.length > 0, 'package.json 中应存在 hexo-* 依赖');
    assert.deepEqual(plugins.map(p => p.name), expectedNames, 'plugins 应与 dependencies 中的 hexo-* 依赖一一对应');

    for (const p of plugins) {
        assert.equal(typeof p, 'object');
        assert.ok(p.name.startsWith('hexo-'), `name 应以 hexo- 开头: ${p.name}`);
        assert.equal(typeof p.version, 'string', 'version 应为字符串');
        assert.equal(p.enabled, true, 'enabled 应为 true');
        assert.doesNotMatch(p.version, /^[^\d]/, `version 不应带前导 ^ ~ >= v 等字符: ${p.version}`);
    }
});

test('system/info 不调用 fs.readdirSync（不枚举 node_modules）', async () => {
    const original = fs.readdirSync;
    let calls = 0;
    fs.readdirSync = function (...args) { calls++; return original.apply(this, args); };

    try {
        const res = await runSystemInfo();
        assert.equal(res.statusCode, 200);
        assert.equal(calls, 0, 'handler 不应调用 fs.readdirSync');
    } finally {
        fs.readdirSync = original;
    }
});
