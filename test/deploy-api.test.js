// test/deploy-api.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const deployApi = require('../api/deploy_api');

const { maskSensitiveConfig, triggerGithubDeploy } = deployApi._test;

test('maskSensitiveConfig 脱敏 token 与各平台 apiToken', () => {
    const masked = maskSensitiveConfig({
        token: 'ghp_secret',
        cloudflare: { accountId: 'acc', projectName: 'p', apiToken: 'cf_secret' },
        edgeone: { projectName: 'p', apiToken: 'eo_secret', env: 'production' }
    });

    assert.equal(masked.token, '******');
    assert.equal(masked.cloudflare.apiToken, '******');
    assert.equal(masked.cloudflare.accountId, 'acc');
    assert.equal(masked.edgeone.apiToken, '******');
    assert.equal(masked.edgeone.env, 'production');
});

test('maskSensitiveConfig 空值不脱敏', () => {
    const masked = maskSensitiveConfig({ token: '', cloudflare: { apiToken: '' }, edgeone: { apiToken: '' } });
    assert.equal(masked.token, '');
    assert.equal(masked.cloudflare.apiToken, '');
    assert.equal(masked.edgeone.apiToken, '');
});

test('triggerGithubDeploy 使用 workflowId 与 branch', async () => {
    const calls = [];
    const github = { triggerWorkflow: async (wfId, ref) => { calls.push({ wfId, ref }); } };

    await triggerGithubDeploy(github, { workflowId: 'deploy.yml', branch: 'main' });

    assert.deepEqual(calls, [{ wfId: 'deploy.yml', ref: 'main' }]);
});

test('triggerGithubDeploy 兼容 workflow 字段与默认 main 分支', async () => {
    const calls = [];
    const github = { triggerWorkflow: async (wfId, ref) => { calls.push({ wfId, ref }); } };

    await triggerGithubDeploy(github, { workflow: 'ci.yml' });

    assert.deepEqual(calls, [{ wfId: 'ci.yml', ref: 'main' }]);
});

test('triggerGithubDeploy 无 workflowId 报「未配置部署工作流」', async () => {
    const github = { triggerWorkflow: async () => {} };
    await assert.rejects(triggerGithubDeploy(github, {}), /未配置部署工作流/);
});

test('triggerGithubDeploy 未配置 GitHub 凭据报错', async () => {
    await assert.rejects(triggerGithubDeploy(null, { workflowId: 'deploy.yml' }), /未配置 GitHub 凭据/);
});
