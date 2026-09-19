// test/deploy-await.test.js
// 任务 9：部署触发 await 化 —— triggerWorkflow 必须在 res.done 之前完成，
// 触发失败必须返回 500 且把状态记为 failed（不允许 fire-and-forget 吞掉触发结果）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const deployApi = require('../api/deploy_api');

function makeSiteConfig(seed = {}) {
    const map = new Map(Object.entries(seed));
    return {
        map,
        get: async (type) => (map.has(type) ? map.get(type) : null),
        set: async (type, content, opts) => { map.set(type, content); return { type, content }; },
    };
}

function makeDeployStatusDb(initial = {}) {
    let status = Object.assign(
        { type: 'status', isDeploying: false, progress: 0, stage: 'idle', logs: [], error: null },
        initial
    );
    return {
        getStatus: () => status,
        findOne: (query, cb) => { cb(null, status); },
        update: (query, update, opts, cb) => {
            if (update && update.$set) status = Object.assign({}, status, update.$set);
            if (cb) cb(null);
        },
    };
}

// 模拟「触发失败后，恢复状态写入也故障」的 DB：任何 stage==='failed' 的写入都回调错误
function makeDeployStatusDbFailingRecovery(initial = {}) {
    let status = Object.assign(
        { type: 'status', isDeploying: false, progress: 0, stage: 'idle', logs: [], error: null },
        initial
    );
    return {
        getStatus: () => status,
        findOne: (query, cb) => { cb(null, status); },
        update: (query, update, opts, cb) => {
            if (update && update.$set && update.$set.stage === 'failed') {
                if (cb) cb(new Error('DB 故障'));
                return;
            }
            if (update && update.$set) status = Object.assign({}, status, update.$set);
            if (cb) cb(null);
        },
    };
}

function registerRoutes(hexo, db) {
    const handlers = {};
    const use = (name, fn) => { handlers[name] = fn; };
    deployApi({}, hexo, use, db);
    return handlers;
}

function fakeRes(state) {
    const res = {};
    let resolveDone;
    res.donePromise = new Promise((resolve) => { resolveDone = resolve; });
    res.done = (v) => {
        // 顺序探针：res.done 被调用时，workflow 必须已经触发过
        state.triggeredBeforeDone = state.triggerCount > 0;
        res._done = v;
        resolveDone();
    };
    res.send = (s, d) => {
        res._send = [s, d];
        resolveDone();
    };
    return res;
}

test('deploy/execute：triggerWorkflow 在 res.done 之前完成，且只触发一次', async () => {
    const state = { triggerCount: 0, triggerCalls: [], triggeredBeforeDone: false };
    const hexo = {
        siteConfig: makeSiteConfig({ deploy: JSON.stringify({ workflowId: 'deploy.yml', branch: 'main' }) }),
        github: {
            triggerWorkflow: async (wfId, ref) => {
                state.triggerCount += 1;
                state.triggerCalls.push({ wfId, ref });
            },
        },
    };
    const db = { deployStatusDb: makeDeployStatusDb() };
    const handlers = registerRoutes(hexo, db);
    const res = fakeRes(state);

    handlers['deploy/execute']({ method: 'POST', body: {} }, res, () => {});
    await res.donePromise;

    assert.ok(res._done, '应成功响应');
    assert.equal(res._done.success, true);
    assert.equal(state.triggeredBeforeDone, true, 'triggerWorkflow 必须在 res.done 之前被调用');
    assert.equal(state.triggerCount, 1, 'workflow 应只触发一次');
    assert.deepEqual(state.triggerCalls, [{ wfId: 'deploy.yml', ref: 'main' }]);
});

test('deploy/execute：触发失败返回 500（脱敏文案）且状态记为 failed', async () => {
    const state = { triggerCount: 0, triggeredBeforeDone: false };
    const deployStatusDb = makeDeployStatusDb();
    const hexo = {
        siteConfig: makeSiteConfig({ deploy: JSON.stringify({ workflowId: 'deploy.yml', branch: 'main' }) }),
        github: {
            triggerWorkflow: async () => {
                state.triggerCount += 1;
                throw new Error('workflow 触发失败');
            },
        },
    };
    const db = { deployStatusDb };
    const handlers = registerRoutes(hexo, db);
    const res = fakeRes(state);

    handlers['deploy/execute']({ method: 'POST', body: {} }, res, () => {});
    await res.donePromise;

    assert.equal(res._send[0], 500);
    assert.equal(res._send[1], '部署失败，请查看服务端日志');
    assert.equal(res._done, undefined, '触发失败不应 res.done 成功响应');

    const status = deployStatusDb.getStatus();
    assert.equal(status.isDeploying, false);
    assert.equal(status.stage, 'failed');
    assert.equal(status.error, '部署失败，请查看服务端日志');
});

test('deploy/execute：触发失败且恢复状态写入也故障时，客户端仍拿到 500', { timeout: 2000 }, async () => {
    const state = { triggerCount: 0, triggeredBeforeDone: false };
    const deployStatusDb = makeDeployStatusDbFailingRecovery();
    const hexo = {
        siteConfig: makeSiteConfig({ deploy: JSON.stringify({ workflowId: 'deploy.yml', branch: 'main' }) }),
        github: {
            triggerWorkflow: async () => {
                state.triggerCount += 1;
                throw new Error('workflow 触发失败');
            },
        },
    };
    const db = { deployStatusDb };
    const handlers = registerRoutes(hexo, db);
    const res = fakeRes(state);

    handlers['deploy/execute']({ method: 'POST', body: {} }, res, () => {});
    await res.donePromise;

    assert.equal(res._send[0], 500, '恢复状态写入失败也不得阻断响应，客户端必须拿到 500');
    assert.equal(res._send[1], '部署失败，请查看服务端日志');
    assert.equal(res._done, undefined, '触发失败不应 res.done 成功响应');
});
