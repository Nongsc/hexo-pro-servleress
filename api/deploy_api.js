'use strict';

// 脱敏辅助函数：避免 token / apiToken 直接回传前端
function maskSensitiveConfig(config) {
    const masked = {
        ...config,
        token: config.token ? '******' : ''
    };
    if (masked.cloudflare) {
        masked.cloudflare = {
            ...masked.cloudflare,
            apiToken: masked.cloudflare.apiToken ? '******' : ''
        };
    }
    if (masked.edgeone) {
        masked.edgeone = {
            ...masked.edgeone,
            apiToken: masked.edgeone.apiToken ? '******' : ''
        };
    }
    return masked;
}

// 触发远端 GitHub Actions 部署（纯函数，便于单测）
async function triggerGithubDeploy(github, config) {
    const wfId = (config && (config.workflowId || config.workflow)) || '';
    if (!wfId) throw new Error('未配置部署工作流');
    if (!github) throw new Error('未配置 GitHub 凭据');
    await github.triggerWorkflow(wfId, (config && config.branch) || 'main');
}

module.exports = function (app, hexo, use, db) {
    // 使用传入的统一数据库实例，而不是创建自己的
    if (!db || !db.deployStatusDb) {
        throw new Error('[Hexo Pro]: 部署API需要数据库实例');
    }

    const deployStatusDb = db.deployStatusDb;

    // 去除 ANSI 转义序列，避免前端显示乱码
    function stripAnsi(str) {
        if (typeof str !== 'string') return str;
        return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    }

    // 辅助函数：格式化日期时间
    function formatDateTime(dateString) {
        const date = new Date(dateString);

        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    const DEFAULT_CONFIG = {
        deployType: 'github',
        enabledPlatforms: ['github'],
        workflowId: '',
        repository: '',
        branch: 'main',
        message: 'Site updated: {{ now("YYYY-MM-DD HH:mm:ss") }}',
        token: '',
        cloudflare: {
            accountId: '',
            projectName: '',
            apiToken: ''
        },
        edgeone: {
            projectName: '',
            apiToken: '',
            env: 'production'
        },
        lastDeployTime: ''
    };

    // 读取部署配置（type 'deploy'，内容为 JSON 串）
    async function readDeployConfig() {
        const raw = await hexo.siteConfig.get('deploy');
        if (!raw) return {};
        try {
            return JSON.parse(raw);
        } catch (e) {
            console.error('解析部署配置失败:', e);
            return {};
        }
    }

    // 写入部署配置（仅存 DB，不同步 GitHub）
    function writeDeployConfig(config) {
        return hexo.siteConfig.set('deploy', JSON.stringify(config, null, 2), {
            message: 'Hexo Pro: update deploy config'
        });
    }

    // 更新部署状态（Promise 风格，供触发路径与可丢弃尾部复用）
    function updateStatus(update) {
        return new Promise((resolve, reject) => {
            deployStatusDb.update(
                { type: 'status' },
                { $set: update },
                {},
                (err) => {
                    if (err) {
                        console.error('更新部署状态失败:', err);
                        reject(err);
                    } else {
                        resolve();
                    }
                }
            );
        });
    }

    // 追加部署日志
    function addLog(message) {
        const cleanMessage = stripAnsi(String(message));
        console.log(cleanMessage);
        deployStatusDb.findOne({ type: 'status' }, (err, status) => {
            if (!err && status) {
                const logs = [...status.logs, cleanMessage];
                deployStatusDb.update(
                    { type: 'status' },
                    { $set: { logs: logs } },
                    {}
                );
            }
        });
    }

    // 获取部署配置
    use('deploy/config', async function (req, res) {
        try {
            const savedConfig = await readDeployConfig();
            const config = maskSensitiveConfig({
                ...DEFAULT_CONFIG,
                ...savedConfig
            });
            res.done(config);
        } catch (error) {
            console.error('获取部署配置失败:', error);
            res.send(500, '获取部署配置失败');
        }
    });

    // 保存部署配置
    use('deploy/save-config', async function (req, res, next) {
        if (req.method !== 'POST') return next();

        try {
            if (!req.body) {
                return res.send(400, '缺少配置信息');
            }

            const existingConfig = await readDeployConfig();

            // 合并配置，保留现有敏感信息（如果新配置中没有提供）
            const newConfig = {
                ...existingConfig,
                ...req.body,
                token: req.body.token === '******' ? existingConfig.token : req.body.token,
                enabledPlatforms: Array.isArray(req.body.enabledPlatforms)
                    ? req.body.enabledPlatforms
                    : (existingConfig.enabledPlatforms || ['github'])
            };

            // 合并 cloudflare 配置，保留 apiToken
            if (req.body.cloudflare) {
                const existingCf = existingConfig.cloudflare || {};
                newConfig.cloudflare = {
                    ...existingCf,
                    ...req.body.cloudflare,
                    apiToken: req.body.cloudflare.apiToken === '******'
                        ? existingCf.apiToken
                        : req.body.cloudflare.apiToken
                };
            }

            // 合并 edgeone 配置，保留 apiToken
            if (req.body.edgeone) {
                const existingEo = existingConfig.edgeone || {};
                newConfig.edgeone = {
                    ...existingEo,
                    ...req.body.edgeone,
                    apiToken: req.body.edgeone.apiToken === '******'
                        ? existingEo.apiToken
                        : req.body.edgeone.apiToken
                };
            }

            await writeDeployConfig(newConfig);

            res.done(maskSensitiveConfig(newConfig));
        } catch (error) {
            console.error('保存部署配置失败:', error);
            res.send(500, '保存部署配置失败');
        }
    });

    // 执行部署 - 改为异步方式，触发远端 Actions
    use('deploy/execute', function (req, res, next) {
        if (req.method !== 'POST') return next();

        try {
            // 检查是否正在部署
            deployStatusDb.findOne({ type: 'status' }, async (err, status) => {
                if (err) {
                    return res.send(500, '获取部署状态失败');
                }

                if (status && status.isDeploying) {
                    return res.send(400, '部署正在进行中，请等待完成');
                }

                try {
                    let config = await readDeployConfig();

                    // 若请求体传入 config，先合并保存
                    if (req.body && req.body.config) {
                        const existingConfig = config;
                        const newConfig = {
                            ...existingConfig,
                            ...req.body.config,
                            token: req.body.config.token === '******' ? existingConfig.token : req.body.config.token
                        };
                        if (req.body.config.cloudflare) {
                            const existingCf = existingConfig.cloudflare || {};
                            newConfig.cloudflare = {
                                ...existingCf,
                                ...req.body.config.cloudflare,
                                apiToken: req.body.config.cloudflare.apiToken === '******'
                                    ? existingCf.apiToken
                                    : req.body.config.cloudflare.apiToken
                            };
                        }
                        if (req.body.config.edgeone) {
                            const existingEo = existingConfig.edgeone || {};
                            newConfig.edgeone = {
                                ...existingEo,
                                ...req.body.config.edgeone,
                                apiToken: req.body.config.edgeone.apiToken === '******'
                                    ? existingEo.apiToken
                                    : req.body.config.edgeone.apiToken
                            };
                        }
                        await writeDeployConfig(newConfig);
                        config = newConfig;
                    }

                    // 解析部署目标：deployTargets 优先，兼容 deployType
                    let deployTargets = req.body && req.body.deployTargets;
                    if (!deployTargets && req.body && req.body.deployType) {
                        deployTargets = [req.body.deployType];
                    }
                    if (!Array.isArray(deployTargets)) {
                        deployTargets = [config.deployType || 'github'];
                    }

                    // 仅支持 github，其余平台返回「暂不支持」
                    const unsupported = deployTargets.filter(t => t !== 'github');
                    if (unsupported.length > 0) {
                        return res.send(400, `暂不支持该部署目标: ${unsupported.join(', ')}`);
                    }
                    if (deployTargets.length === 0) {
                        return res.send(400, '请指定至少一个部署目标');
                    }

                    // 校验工作流与 GitHub 凭据
                    if (!(config.workflowId || config.workflow)) {
                        return res.send(400, '未配置部署工作流');
                    }
                    if (!hexo.github) {
                        return res.send(400, '未配置 GitHub 凭据');
                    }

                    deployStatusDb.update(
                        { type: 'status' },
                        {
                            $set: {
                                isDeploying: true,
                                progress: 0,
                                stage: 'started',
                                logs: ['deploy.started'],
                                error: null
                            }
                        },
                        {},
                        async (updateErr) => {
                            if (updateErr) {
                                console.error('更新部署状态失败:', updateErr);
                                return res.send(500, '更新部署状态失败');
                            }
                            try {
                                // 状态写入失败也不得阻断响应路径，避免客户端请求挂起
                                await updateStatus({ stage: 'deploying', progress: 30 }).catch((e) => {
                                    console.error('更新部署进度状态失败:', e);
                                });
                                addLog('deploy.triggering');
                                // 先触发远端 workflow，成功后再响应，避免 serverless 冻结丢失触发
                                await triggerGithubDeploy(hexo.github, config);
                                addLog('deploy.triggered');
                                res.done({
                                    success: true,
                                    message: '部署已开始，请通过状态 API 查询进度',
                                    isDeploying: true
                                });
                                executeDeployAsync(config);
                            } catch (triggerErr) {
                                console.error('执行部署失败:', triggerErr);
                                // 恢复状态写入失败也不得阻断响应，保证客户端一定拿到 500
                                await updateStatus({ isDeploying: false, stage: 'failed', error: '部署失败，请查看服务端日志' }).catch((e) => {
                                    console.error('更新部署失败状态失败:', e);
                                });
                                addLog('deploy.failed');
                                res.send(500, '部署失败，请查看服务端日志');
                            }
                        }
                    );
                } catch (innerErr) {
                    console.error('执行部署失败:', innerErr);
                    return res.send(500, '部署失败，请查看服务端日志');
                }
            });
        } catch (error) {
            console.error('执行部署失败:', error);
            res.send(500, '部署失败，请查看服务端日志');
        }
    });

    // 检查部署状态 - 增强版
    use('deploy/status', function (req, res) {
        try {
            deployStatusDb.findOne({ type: 'status' }, (err, status) => {
                if (err) {
                    return res.send(500, '获取部署状态失败');
                }

                if (!status) {
                    return res.done({
                        isDeploying: false,
                        progress: 0,
                        stage: 'idle',
                        lastDeployTime: '未知',
                        logs: [],
                        hasDeployGit: false
                    });
                }

                // 无本地 .deploy_git，恒为 false，字段保留以兼容前端
                res.done({
                    ...status,
                    hasDeployGit: false
                });
            });
        } catch (error) {
            console.error('获取部署状态失败:', error);
            res.send(500, '获取部署状态失败');
        }
    });

    // 辅助函数：写入 lastDeployTime 并记录最终完成/失败状态（可丢弃尾部，fire-and-forget）
    function executeDeployAsync(config) {
        (async () => {
            try {
                const now = new Date();
                const formattedTime = formatDateTime(now);
                config.lastDeployTime = now.toISOString();
                await writeDeployConfig(config);

                await updateStatus({
                    isDeploying: false,
                    progress: 100,
                    stage: 'completed',
                    lastDeployTime: formattedTime
                });
                addLog('deploy.success');
            } catch (error) {
                console.error('部署过程出错:', error);
                await updateStatus({
                    isDeploying: false,
                    stage: 'failed',
                    error: '部署失败，请查看服务端日志'
                }).catch((e) => {
                    console.error('更新部署失败状态失败:', e);
                });
                addLog('deploy.failed');
                addLog('部署失败，请查看服务端日志');
            }
        })();
    }

    // 重置部署状态
    use('deploy/reset-status', function (req, res, next) {
        if (req.method !== 'POST') return next();

        try {
            deployStatusDb.update(
                { type: 'status' },
                {
                    $set: {
                        isDeploying: false,
                        progress: 0,
                        stage: 'idle',
                        error: null,
                        logs: ['deploy.status.reset']
                    }
                },
                {},
                (err) => {
                    if (err) {
                        console.error('重置部署状态失败:', err);
                        return res.send(500, '重置部署状态失败');
                    }

                    res.done({
                        success: true,
                        message: 'deploy.status.reset'
                    });
                }
            );
        } catch (error) {
            console.error('重置部署状态失败:', error);
            res.send(500, `重置部署状态失败: ${error.message}`);
        }
    });

    // 清理部署目录（本地 git 流程已移除，无本地部署目录）
    use('deploy/cleanup', function (req, res, next) {
        if (req.method !== 'POST') return next();

        try {
            // 重置部署状态
            deployStatusDb.update(
                { type: 'status' },
                {
                    $set: {
                        isDeploying: false,
                        progress: 0,
                        stage: 'idle',
                        error: null,
                        logs: ['deploy.cleanup.success']
                    }
                },
                {},
                (err) => {
                    if (err) {
                        console.error('重置部署状态失败:', err);
                    }
                }
            );

            res.done({
                success: true,
                message: '无本地部署目录，无需清理'
            });
        } catch (error) {
            console.error('清理部署目录失败:', error);
            res.send(500, `清理部署目录失败: ${error.message}`);
        }
    });
};

module.exports._test = { maskSensitiveConfig, triggerGithubDeploy };
