const path = require('path');
const fs = require('hexo-fs');
const fse = require('fs-extra');
const { exec } = require('child_process');
const yaml = require('js-yaml');

/**
 * 清理 public 目录，确保静态文件重新生成
 * @param {string} publicDir - public 目录路径
 */
async function cleanPublicDir(publicDir) {
  try {
    if (fs.existsSync(publicDir)) {
      await fse.emptyDir(publicDir);
    }
  } catch (err) {
    console.error('[Hexo Pro] 清理 public 目录失败:', err.message);
  }
}
const {
  segmentConfig,
  generateSchemaForSegment,
  mergeSegmentResults,
  countSchemaFields,
  calculateHash,
} = require('./schema_generator')

function schemaCacheId(themeId) {
  return 'schema:' + themeId
}

/**
 * 从 schema 缓存 doc 中提取纯 schema（去掉 _meta）
 */
function extractSchemaFromFileContent(fullObj) {
  if (!fullObj || typeof fullObj !== 'object') return null
  const { _meta, ...schema } = fullObj
  return Object.keys(schema).length > 0 ? schema : null
}

/**
 * 读取 schema 缓存（theme_schema_cache 表，_id = 'schema:' + themeId）。
 * 返回 { _meta, ...schema }，不含 _id，避免 _id 泄漏进 extractSchemaFromFileContent。
 */
function readSchemaFileWithMeta(db, themeId) {
  return new Promise((resolve, reject) => {
    db.themeSchemaCache.findOne({ _id: schemaCacheId(themeId) }, (err, doc) => {
      if (err) return reject(err)
      if (!doc) return resolve(null)
      const { _id, ...rest } = doc
      resolve(rest)
    })
  })
}

/**
 * 写入 schema 缓存（含 _id 与 _meta）。
 */
function writeSchemaFileWithMeta(db, themeId, schema, configHash, language) {
  const fullObj = {
    _id: schemaCacheId(themeId),
    _meta: { configHash, language, generatedAt: new Date().toISOString() },
    ...schema,
  }
  // 全量替换（不带 $set），复刻原 fs 整文件覆盖语义：
  // 主题配置删字段后重新 generate/save，旧字段必须被移除而不是残留。
  return new Promise((resolve, reject) => {
    db.themeSchemaCache.update({ _id: fullObj._id }, fullObj, { upsert: true }, (err) => {
      err ? reject(err) : resolve()
    })
  })
}

// 内置主题列表
const BUILTIN_THEMES = [
  {
    id: 'anzhiyu',
    name: '安知鱼',
    description: '简洁美丽的 Hexo 主题，功能丰富，支持多种评论系统、音乐、相册等',
    author: 'anzhiyu-c',
    repo: 'https://github.com/anzhiyu-c/hexo-theme-anzhiyu.git',
    branch: 'main',
    installType: 'git',
    dependencies: ['hexo-renderer-pug', 'hexo-renderer-stylus'],
    configFile: '_config.anzhiyu.yml',
    themeDir: 'anzhiyu',
  },
  {
    id: 'butterfly',
    name: 'Butterfly',
    description: '一款美观且功能强大的 Hexo 主题，支持丰富的文章样式与多种扩展功能',
    author: 'jerryc127',
    repo: 'https://github.com/jerryc127/hexo-theme-butterfly.git',
    branch: 'master',
    installType: 'git',
    dependencies: ['hexo-renderer-pug', 'hexo-renderer-stylus'],
    configFile: '_config.butterfly.yml',
    themeDir: 'butterfly',
  },
  {
    id: 'next',
    name: 'NexT',
    description: '经典老牌主题，极简优雅，性能极佳；支持多种布局（Muse/Mist/Pisces/Gemini），集成 MathJax、Disqus，配置高度灵活；适合喜欢稳定、轻量、SEO 友好的用户，文档与社区支持极强。',
    author: 'theme-next',
    repo: 'https://github.com/theme-next/hexo-theme-next.git',
    branch: 'master',
    installType: 'git',
    dependencies: [],
    configFile: '_config.next.yml',
    themeDir: 'next',
  },
  {
    id: 'fluid',
    name: 'Fluid',
    description: 'Material Design 风格，界面清爽有层次；响应式完美，内置 LaTeX 与 Mermaid 图表支持，自定义项丰富；适合学术 / 技术写作，默认样式已足够美观，无需过多魔改。',
    author: 'fluid-dev',
    repo: 'https://github.com/fluid-dev/hexo-theme-fluid.git',
    branch: 'master',
    installType: 'git',
    dependencies: [],
    configFile: '_config.fluid.yml',
    themeDir: 'fluid',
  },
  {
    id: 'stellar',
    name: 'Stellar',
    description: '综合型主题（博客 + 知识库 + 专栏 + 笔记），组件化设计，内置海量标签 / 数据组件；适合搭建个人知识体系、多内容形态的站点，更新活跃，中文生态好。',
    author: 'xaoxuu',
    repo: 'https://github.com/xaoxuu/hexo-theme-stellar.git',
    branch: 'main',
    installType: 'git',
    dependencies: [],
    configFile: '_config.stellar.yml',
    themeDir: 'stellar',
  },
  {
    id: 'volantis',
    name: 'Volantis',
    description: '模块化、高自由度，卡片式布局 + 丰富的 shortcode；适合喜欢折腾、追求个性化展示的博主，支持多种插件与评论系统，文档详细。',
    author: 'volantis-x',
    repo: 'https://github.com/volantis-x/hexo-theme-volantis.git',
    branch: '7.x',
    installType: 'git',
    dependencies: [],
    configFile: '_config.volantis.yml',
    themeDir: 'volantis',
  },
];

function execPromise(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: options.cwd || process.cwd(), timeout: 120000, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

const MAX_THEME_CONFIG_SNAPSHOTS = 30
const GLOBAL_CONFIG_SNAPSHOT_ID = '__global__site_config__'

/**
 * 快照存储在 site_config 表：
 *   - 全局快照 → type 'snapshot:site'
 *   - 主题快照 → type 'snapshot:theme:{id}'
 * 这些 type 的 githubPath 均为 null，因此只写 DB、不同步 GitHub。
 */
function snapshotTypeFor(themeId) {
  return themeId === GLOBAL_CONFIG_SNAPSHOT_ID ? 'snapshot:site' : `snapshot:theme:${themeId}`
}

function toSnapshotMeta(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const { content, ...meta } = snapshot
  return meta
}

async function readThemeConfigSnapshots(hexo, themeId) {
  const raw = await hexo.siteConfig.get(snapshotTypeFor(themeId))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.content === 'string')
  } catch {
    return []
  }
}

async function writeThemeConfigSnapshots(hexo, themeId, snapshots) {
  const type = snapshotTypeFor(themeId)
  await hexo.siteConfig.set(type, JSON.stringify(snapshots, null, 2), {
    message: `Hexo Pro: update ${type}`,
  })
}

async function createThemeConfigSnapshot(hexo, themeId, content, options = {}) {
  if (typeof content !== 'string') return null
  const { source = 'manual', note = '' } = options
  const snapshots = await readThemeConfigSnapshots(hexo, themeId)
  const hash = calculateHash(content)

  if (snapshots[0] && snapshots[0].hash === hash) {
    return null
  }

  const createdAt = new Date().toISOString()
  const snapshot = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    themeId,
    createdAt,
    source,
    note: String(note).slice(0, 120),
    hash,
    size: Buffer.byteLength(content, 'utf-8'),
    content,
  }

  const next = [snapshot, ...snapshots].slice(0, MAX_THEME_CONFIG_SNAPSHOTS)
  await writeThemeConfigSnapshots(hexo, themeId, next)
  return toSnapshotMeta(snapshot)
}

async function readThemeConfigContent(hexo, theme) {
  return hexo.siteConfig.get('theme:' + theme.id)
}

async function readGlobalConfigContent(hexo) {
  return hexo.siteConfig.get('site')
}

async function applyGlobalConfigContent(hexo, content) {
  await hexo.siteConfig.set('site', content, { message: 'Hexo Pro: update _config.yml' })
  const parsed = yaml.load(content) || {}
  hexo.config = Object.assign({}, hexo.config, parsed)
  return { success: true, needRestart: true, message: '全局配置已保存' }
}

async function isThemeInstalled(hexo, theme) {
  if (getThemeById(theme.id)) return true
  const content = await hexo.siteConfig.get('theme:' + theme.id)
  return content !== null && content !== undefined
}

function getThemeById(themeId) {
  return BUILTIN_THEMES.find((t) => t.id === themeId)
}

function formatYamlParseError(error) {
  const fallback = 'YAML 语法错误'
  if (!error || typeof error !== 'object') return fallback

  const baseMessage = typeof error.message === 'string' ? error.message : fallback
  const line = typeof error.mark?.line === 'number' ? error.mark.line + 1 : null
  const column = typeof error.mark?.column === 'number' ? error.mark.column + 1 : null

  if (line && column) {
    return `${baseMessage} (line ${line}, column ${column})`
  }
  return baseMessage
}

function validateYamlContent(content) {
  try {
    yaml.load(content)
    return null
  } catch (error) {
    return formatYamlParseError(error)
  }
}

async function applyThemeConfigContent(hexo, theme, content) {
  if (!(await isThemeInstalled(hexo, theme))) {
    throw new Error('主题未安装')
  }

  await hexo.siteConfig.set('theme:' + theme.id, content, {
    message: `Hexo Pro: update theme:${theme.id}`,
  })
  const isCurrentTheme = (hexo.config.theme === theme.themeDir)

  if (!isCurrentTheme) {
    return {
      success: true,
      message: '配置已保存（非当前主题，未热更新）',
      tip: '切换到该主题后配置会生效',
    }
  }

  try {
    const newThemeConfig = yaml.load(content) || {}
    if (newThemeConfig && typeof newThemeConfig === 'object') {
      hexo.config.theme_config = Object.assign({}, hexo.config.theme_config, newThemeConfig)
      if (hexo.theme && hexo.theme.config) {
        hexo.theme.config = Object.assign({}, hexo.theme.config, newThemeConfig)
      }
      hexo.log.info('主题配置已在内存中热更新')
    }
  } catch (err) {
    hexo.log.warn('解析主题配置失败，已保存:', err.message)
  }

  if (hexo.locals && hexo.locals.invalidate) {
    hexo.locals.invalidate()
    hexo.log.info('Hexo locals 缓存已清除')
  }

  return {
    success: true,
    message: '配置已保存',
    tip: '如果页面未更新，请尝试强制刷新浏览器 (Ctrl+F5 或 Cmd+Shift+R)',
  }
}

module.exports = function (app, hexo, use, db) {
  // 获取内置主题列表
  use('theme/list', function (req, res) {
    try {
      res.done(BUILTIN_THEMES);
    } catch (error) {
      hexo.log.error('获取主题列表失败:', error);
      res.send(500, '获取主题列表失败');
    }
  });

  // 获取当前主题信息
  use('theme/current', function (req, res) {
    try {
      const themeName = hexo.config.theme || 'landscape';
      const themesDir = path.join(hexo.base_dir, 'themes');
      const themePath = path.join(themesDir, themeName);
      const installed = fs.existsSync(themePath);

      const builtin = BUILTIN_THEMES.find((t) => t.themeDir === themeName || t.id === themeName);

      res.done({
        name: themeName,
        installed,
        builtin: !!builtin,
        themeInfo: builtin || null,
      });
    } catch (error) {
      hexo.log.error('获取当前主题失败:', error);
      res.send(500, '获取当前主题失败');
    }
  });

  // 一键安装主题
  use('theme/install', function (req, res) {
    if (req.method !== 'POST') return;

    const { themeId } = req.body || {};
    if (!themeId) {
      return res.send(400, '缺少主题ID');
    }

    const theme = BUILTIN_THEMES.find((t) => t.id === themeId);
    if (!theme) {
      return res.send(404, '主题不存在');
    }

    const baseDir = hexo.base_dir;
    const themesDir = path.join(baseDir, 'themes');
    const themePath = path.join(themesDir, theme.themeDir);

    if (fs.existsSync(themePath)) {
      return res.done({
        success: true,
        message: '主题已安装',
        themeDir: theme.themeDir,
      });
    }

    (async () => {
      try {
        fse.ensureDirSync(themesDir);

        // 1. git clone
        hexo.log.info(`[Theme] 正在克隆主题 ${theme.name}...`);
        await execPromise(`git clone -b ${theme.branch} ${theme.repo} "${themePath}"`, { cwd: baseDir });

        // 2. 安装依赖
        if (theme.dependencies && theme.dependencies.length > 0) {
          hexo.log.info(`[Theme] 正在安装主题依赖...`);
          await execPromise(`npm install ${theme.dependencies.join(' ')} --save`, { cwd: baseDir });
        }

        // 3. 复制主题配置到根目录作为覆盖配置
        const themeConfigSrc = path.join(themePath, '_config.yml');
        const themeConfigDest = path.join(baseDir, theme.configFile);
        if (fs.existsSync(themeConfigSrc) && !fs.existsSync(themeConfigDest)) {
          fse.copyFileSync(themeConfigSrc, themeConfigDest);
          hexo.log.info(`[Theme] 已创建覆盖配置文件 ${theme.configFile}`);
        }

        hexo.log.info(`[Theme] 主题 ${theme.name} 安装完成`);
        res.done({
          success: true,
          message: '主题安装完成',
          themeDir: theme.themeDir,
        });
      } catch (error) {
        hexo.log.error('[Theme] 安装失败:', error.message);
        res.send(500, error.message || '主题安装失败');
      }
    })();
  });

  // 获取主题配置内容
  use('theme/config', async function (req, res) {
    const themeId = req.query.themeId || req.body?.themeId;
    if (!themeId) {
      return res.send(400, '缺少主题ID');
    }

    const theme = getThemeById(themeId);
    if (!theme) {
      return res.send(404, '主题不存在');
    }

    try {
      const content = await readThemeConfigContent(hexo, theme);
      if (content === null || content === undefined) {
        return res.send(404, '主题配置文件不存在');
      }
      res.done({ content, configPath: theme.configFile });
    } catch (error) {
      hexo.log.error('读取主题配置失败:', error);
      res.send(500, '读取主题配置失败');
    }
  });

  // 保存主题配置
  use('theme/config/save', async function (req, res) {
    if (req.method !== 'POST') return;

    const { themeId, content } = req.body || {};
    if (!themeId || content === undefined) {
      return res.send(400, '缺少主题ID或配置内容');
    }

    const theme = getThemeById(themeId);
    if (!theme) {
      return res.send(404, '主题不存在');
    }

    if (typeof content !== 'string') {
      return res.send(400, {
        code: 400,
        message: '配置内容必须是字符串',
      })
    }

    const parseError = validateYamlContent(content)
    if (parseError) {
      return res.send(400, {
        code: 400,
        message: 'YAML 配置语法错误，保存已取消',
        details: parseError,
      })
    }

    try {
      if (!(await isThemeInstalled(hexo, theme))) {
        return res.send(404, '主题未安装');
      }

      const previousContent = await readThemeConfigContent(hexo, theme);
      let snapshot = null
      if (typeof previousContent === 'string' && previousContent !== content) {
        snapshot = await createThemeConfigSnapshot(hexo, themeId, previousContent, { source: 'auto-save' })
      }

      const result = await applyThemeConfigContent(hexo, theme, content)
      res.done(Object.assign({}, result, { snapshot }))
    } catch (error) {
      hexo.log.error('保存主题配置失败:', error);
      res.send(500, '保存主题配置失败');
    }
  });

  // 获取主题配置快照列表
  use('theme/config/snapshots', async function (req, res) {
    const themeId = req.query.themeId || req.body?.themeId;
    if (!themeId) {
      return res.send(400, '缺少主题ID');
    }

    const theme = getThemeById(themeId);
    if (!theme) {
      return res.send(404, '主题不存在');
    }

    try {
      const snapshots = (await readThemeConfigSnapshots(hexo, themeId))
        .map((item) => toSnapshotMeta(item))
        .filter(Boolean)
      res.done({ snapshots, total: snapshots.length, max: MAX_THEME_CONFIG_SNAPSHOTS })
    } catch (error) {
      hexo.log.error('读取主题快照失败:', error)
      res.send(500, '读取主题快照失败')
    }
  })

  // 手动创建主题配置快照
  use('theme/config/snapshot/create', async function (req, res) {
    if (req.method !== 'POST') return;

    const { themeId, note = '' } = req.body || {}
    if (!themeId) {
      return res.send(400, '缺少主题ID')
    }

    const theme = getThemeById(themeId)
    if (!theme) {
      return res.send(404, '主题不存在')
    }

    try {
      const content = await readThemeConfigContent(hexo, theme)
      if (typeof content !== 'string') {
        return res.send(404, '主题配置文件不存在')
      }

      const snapshot = await createThemeConfigSnapshot(hexo, themeId, content, {
        source: 'manual',
        note,
      })
      if (!snapshot) {
        return res.done({
          success: true,
          skipped: true,
          message: '当前配置与最近快照一致，已跳过创建',
        })
      }

      res.done({
        success: true,
        message: '快照已创建',
        snapshot,
      })
    } catch (error) {
      hexo.log.error('创建主题快照失败:', error)
      res.send(500, '创建主题快照失败')
    }
  })

  // 回滚主题配置到指定快照
  use('theme/config/rollback', async function (req, res) {
    if (req.method !== 'POST') return;

    const { themeId, snapshotId } = req.body || {}
    if (!themeId || !snapshotId) {
      return res.send(400, '缺少主题ID或快照ID')
    }

    const theme = getThemeById(themeId)
    if (!theme) {
      return res.send(404, '主题不存在')
    }

    try {
      const snapshots = await readThemeConfigSnapshots(hexo, themeId)
      const targetSnapshot = snapshots.find((item) => item.id === snapshotId)
      if (!targetSnapshot) {
        return res.send(404, '快照不存在')
      }

      const currentContent = await readThemeConfigContent(hexo, theme)
      let backupSnapshot = null
      if (typeof currentContent === 'string' && currentContent !== targetSnapshot.content) {
        backupSnapshot = await createThemeConfigSnapshot(hexo, themeId, currentContent, {
          source: 'rollback-backup',
          note: `before rollback to ${snapshotId}`,
        })
      }

      const result = await applyThemeConfigContent(hexo, theme, targetSnapshot.content)
      res.done(Object.assign({}, result, {
        rollbackTo: toSnapshotMeta(targetSnapshot),
        backupSnapshot,
      }))
    } catch (error) {
      hexo.log.error('回滚主题配置失败:', error)
      res.send(500, '回滚主题配置失败')
    }
  });

  // 获取全局配置内容（_config.yml）
  use('site/config', async function (req, res) {
    try {
      const content = await readGlobalConfigContent(hexo)
      if (content === null || content === undefined) {
        return res.send(404, '全局配置文件不存在')
      }
      res.done({ content, configPath: '_config.yml', needRestart: true })
    } catch (error) {
      hexo.log.error('读取全局配置失败:', error)
      res.send(500, '读取全局配置失败')
    }
  })

  // 保存全局配置
  use('site/config/save', async function (req, res) {
    if (req.method !== 'POST') return

    const { content } = req.body || {}
    if (content === undefined) {
      return res.send(400, '缺少配置内容')
    }
    if (typeof content !== 'string') {
      return res.send(400, {
        code: 400,
        message: '配置内容必须是字符串',
      })
    }

    const parseError = validateYamlContent(content)
    if (parseError) {
      return res.send(400, {
        code: 400,
        message: 'YAML 配置语法错误，保存已取消',
        details: parseError,
      })
    }

    try {
      const previousContent = await readGlobalConfigContent(hexo)
      let snapshot = null
      if (typeof previousContent === 'string' && previousContent !== content) {
        snapshot = await createThemeConfigSnapshot(hexo, GLOBAL_CONFIG_SNAPSHOT_ID, previousContent, {
          source: 'auto-save',
        })
      }

      const result = await applyGlobalConfigContent(hexo, content)
      res.done(Object.assign({}, result, { snapshot }))
    } catch (error) {
      hexo.log.error('保存全局配置失败:', error)
      res.send(500, '保存全局配置失败')
    }
  })

  // 获取全局配置快照列表
  use('site/config/snapshots', async function (req, res) {
    try {
      const snapshots = (await readThemeConfigSnapshots(hexo, GLOBAL_CONFIG_SNAPSHOT_ID))
        .map((item) => toSnapshotMeta(item))
        .filter(Boolean)
      res.done({ snapshots, total: snapshots.length, max: MAX_THEME_CONFIG_SNAPSHOTS })
    } catch (error) {
      hexo.log.error('读取全局配置快照失败:', error)
      res.send(500, '读取全局配置快照失败')
    }
  })

  // 手动创建全局配置快照
  use('site/config/snapshot/create', async function (req, res) {
    if (req.method !== 'POST') return

    const { note = '' } = req.body || {}
    try {
      const content = await readGlobalConfigContent(hexo)
      if (typeof content !== 'string') {
        return res.send(404, '全局配置文件不存在')
      }

      const snapshot = await createThemeConfigSnapshot(hexo, GLOBAL_CONFIG_SNAPSHOT_ID, content, {
        source: 'manual',
        note,
      })
      if (!snapshot) {
        return res.done({
          success: true,
          skipped: true,
          message: '当前配置与最近快照一致，已跳过创建',
        })
      }

      res.done({
        success: true,
        message: '快照已创建',
        snapshot,
      })
    } catch (error) {
      hexo.log.error('创建全局配置快照失败:', error)
      res.send(500, '创建全局配置快照失败')
    }
  })

  // 回滚全局配置到指定快照
  use('site/config/rollback', async function (req, res) {
    if (req.method !== 'POST') return

    const { snapshotId } = req.body || {}
    if (!snapshotId) {
      return res.send(400, '缺少快照ID')
    }

    try {
      const snapshots = await readThemeConfigSnapshots(hexo, GLOBAL_CONFIG_SNAPSHOT_ID)
      const targetSnapshot = snapshots.find((item) => item.id === snapshotId)
      if (!targetSnapshot) {
        return res.send(404, '快照不存在')
      }

      const currentContent = await readGlobalConfigContent(hexo)
      let backupSnapshot = null
      if (typeof currentContent === 'string' && currentContent !== targetSnapshot.content) {
        backupSnapshot = await createThemeConfigSnapshot(hexo, GLOBAL_CONFIG_SNAPSHOT_ID, currentContent, {
          source: 'rollback-backup',
          note: `before rollback to ${snapshotId}`,
        })
      }

      const result = await applyGlobalConfigContent(hexo, targetSnapshot.content)
      res.done(Object.assign({}, result, {
        rollbackTo: toSnapshotMeta(targetSnapshot),
        backupSnapshot,
      }))
    } catch (error) {
      hexo.log.error('回滚全局配置失败:', error)
      res.send(500, '回滚全局配置失败')
    }
  })

  // 检查主题是否已安装
  use('theme/installed', function (req, res) {
    const themeId = req.query.themeId;
    if (!themeId) {
      return res.send(400, '缺少主题ID');
    }

    const theme = BUILTIN_THEMES.find((t) => t.id === themeId);
    if (!theme) {
      return res.done({ installed: false });
    }

    const themePath = path.join(hexo.base_dir, 'themes', theme.themeDir);
    const currentTheme = hexo.config.theme;
    const isCurrent = currentTheme === theme.themeDir;

    res.done({
      installed: fs.existsSync(themePath),
      isCurrent,
    });
  });

  // 切换主题
  use('theme/switch', async function (req, res) {
    if (req.method !== 'POST') return;

    const { themeId } = req.body || {};
    if (!themeId) {
      return res.send(400, '缺少主题ID');
    }

    const theme = BUILTIN_THEMES.find((t) => t.id === themeId);
    if (!theme) {
      return res.send(404, '主题不存在');
    }

    const baseDir = hexo.base_dir;
    const themePath = path.join(baseDir, 'themes', theme.themeDir);

    // 检查主题是否已安装
    if (!fs.existsSync(themePath)) {
      return res.send(400, '主题未安装，请先安装主题');
    }

    try {
      // 从 siteConfig 读取 _config.yml 并更新 theme 字段（写回 DB + GitHub）
      const rawConfig = await hexo.siteConfig.get('site');
      let config;
      try {
        config = rawConfig ? yaml.load(rawConfig) : {};
        if (!config || typeof config !== 'object') config = {};
      } catch (e) {
        hexo.log.error('解析 _config.yml 失败:', e);
        return res.send(500, '解析站点配置失败');
      }

      // 检查是否已经是当前主题
      if (config.theme === theme.themeDir) {
        // _config.yml 已经是目标主题，但当前运行中的 hexo.config 可能尚未同步（常见于安装后未重启）
        const needRestart = hexo.config.theme !== theme.themeDir;
        if (needRestart) {
          hexo.config.theme = theme.themeDir;
        }

        return res.done({
          success: true,
          message: needRestart ? '主题已切换，重启后生效' : '已经是当前主题',
          themeDir: theme.themeDir,
          needRestart,
        });
      }

      config.theme = theme.themeDir;
      await hexo.siteConfig.set('site', yaml.dump(config), { message: 'Hexo Pro: switch theme' });
      hexo.log.info(`[Theme] 已切换主题为 ${theme.themeDir}`);

      // 更新内存中的配置，确保后续查询能获取正确的当前主题
      hexo.config.theme = theme.themeDir;

      // 若 DB 中尚无该主题覆盖配置，则从主题源码 _config.yml 复制到 siteConfig
      const themeConfigSrc = path.join(themePath, '_config.yml');
      let configCopied = false;
      const existingThemeConfig = await hexo.siteConfig.get('theme:' + theme.id);
      if (fs.existsSync(themeConfigSrc) && (existingThemeConfig === null || existingThemeConfig === undefined)) {
        const srcContent = fse.readFileSync(themeConfigSrc, 'utf-8');
        await hexo.siteConfig.set('theme:' + theme.id, srcContent, {
          message: `Hexo Pro: copy theme config ${theme.id}`,
        });
        hexo.log.info(`[Theme] 已创建覆盖配置 ${theme.configFile}`);
        configCopied = true;
      }

      res.done({
        success: true,
        message: '主题切换成功',
        themeDir: theme.themeDir,
        configCopied,
        needRestart: true, // 标记需要重启才能生效
      });
    } catch (error) {
      hexo.log.error('[Theme] 切换失败:', error.message);
      res.send(500, error.message || '主题切换失败');
    }
  });

  // 获取主题 Schema（从 theme_schema_cache 表）
  use('theme/schema', async function (req, res) {
    const themeId = req.query.themeId || req.body?.themeId
    if (!themeId) {
      return res.send(400, '缺少主题ID')
    }

    const theme = BUILTIN_THEMES.find((t) => t.id === themeId)
    if (!theme) {
      return res.send(404, '主题不存在')
    }

    try {
      const fullObj = await readSchemaFileWithMeta(db, themeId)
      if (!fullObj) {
        return res.done({ schema: null, hasSchema: false })
      }
      const schema = extractSchemaFromFileContent(fullObj)
      res.done({ schema: schema || null, hasSchema: !!schema })
    } catch (error) {
      hexo.log.error('读取 Schema 失败:', error)
      res.done({ schema: null, hasSchema: false })
    }
  })

  // 保存主题 Schema 到 theme_schema_cache 表（含 _meta 用于缓存校验）
  use('theme/schema/save', async function (req, res) {
    if (req.method !== 'POST') return

    const { themeId, schema, language = 'zh' } = req.body || {}
    if (!themeId || schema === undefined) {
      return res.send(400, '缺少主题ID或 Schema')
    }

    const theme = BUILTIN_THEMES.find((t) => t.id === themeId)
    if (!theme) {
      return res.send(404, '主题不存在')
    }

    try {
      const schemaObj = typeof schema === 'string' ? JSON.parse(schema) : schema
      const configContent = await hexo.siteConfig.get('theme:' + themeId)
      const configHash = configContent ? calculateHash(configContent) : ''
      await writeSchemaFileWithMeta(db, themeId, schemaObj, configHash, language)
      res.done({ success: true, message: 'Schema 已保存' })
    } catch (error) {
      hexo.log.error('保存 Schema 失败:', error)
      res.send(500, '保存 Schema 失败')
    }
  })

  // 生成主题配置 Schema（输出独立 JSON，不修改 YAML）
  use('theme/schema/generate', function (req, res) {
    if (req.method !== 'POST') return;

    const { themeId, language = 'zh', forceRegenerate = false } = req.body || {};

    if (!themeId) {
      return res.send(400, '缺少主题ID');
    }

    const theme = BUILTIN_THEMES.find((t) => t.id === themeId);
    if (!theme) {
      return res.send(404, '主题不存在');
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    (async () => {
      try {
        const configContent = await hexo.siteConfig.get('theme:' + theme.id);

        // 检查配置是否存在
        if (configContent === null || configContent === undefined) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: '主题配置文件不存在' })}\n\n`);
          return res.end();
        }

        const configHash = calculateHash(configContent);

        // 尝试从 schema 缓存读取（强制重新生成时跳过）
        if (!forceRegenerate) {
          const fileCache = await readSchemaFileWithMeta(db, themeId);
          if (fileCache && fileCache._meta && fileCache._meta.configHash === configHash && fileCache._meta.language === language) {
            const schemaFromFile = extractSchemaFromFileContent(fileCache);
            if (schemaFromFile && Object.keys(schemaFromFile).length > 0) {
              res.write(
                `data: ${JSON.stringify({
                  type: 'start',
                  totalChunks: 1,
                  configSize: configContent.length,
                  cached: true,
                })}\n\n`
              );
              const fieldCount = countSchemaFields(schemaFromFile);
              res.write(
                `data: ${JSON.stringify({
                  type: 'complete',
                  fullResult: configContent,
                  schema: schemaFromFile,
                  summary: `已为 ${fieldCount} 个字段生成 schema (从缓存)`,
                })}\n\n`
              );
              return res.end();
            }
          }
        }

        // 发送初始化消息
        const segments = segmentConfig(configContent, 5000);
        res.write(
          `data: ${JSON.stringify({
            type: 'start',
            totalChunks: segments.length,
            configSize: configContent.length,
          })}\n\n`
        );

        // 获取 AI 配置（从数据库读取）
        let aiSettings = null;
        if (db && db.settingsDb) {
          aiSettings = await new Promise((resolve, reject) => {
            db.settingsDb.findOne({ type: 'ai' }, (err, doc) => {
              if (err) resolve(null);
              else resolve(doc);
            });
          });
        }

        if (!aiSettings || !aiSettings.url || !aiSettings.apiKey) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'AI 配置不完整' })}\n\n`);
          return res.end();
        }

        const results = [];

        // 处理每个段
        for (let i = 0; i < segments.length; i++) {
          try {
            res.write(
              `data: ${JSON.stringify({
                type: 'chunk_processing',
                current: i + 1,
                total: segments.length,
                status: `正在分析第 ${i + 1}/${segments.length} 段...`,
              })}\n\n`
            );

            const segmentResult = await generateSchemaForSegment(
              segments[i],
              aiSettings,
              language,
              i + 1,
              segments.length
            );

            results.push(segmentResult);

            res.write(
              `data: ${JSON.stringify({
                type: 'chunk_result',
                chunk: i + 1,
                result: segmentResult.substring(0, 100) + '...',
              })}\n\n`
            );
          } catch (segmentError) {
            hexo.log.error(`[Schema] 第 ${i + 1} 段处理失败:`, segmentError.message);
            res.write(
              `data: ${JSON.stringify({
                type: 'error',
                message: `第 ${i + 1} 段处理失败: ${segmentError.message}`,
              })}\n\n`
            );
            return res.end();
          }
        }

        // 合并结果
        const schemaObj = mergeSegmentResults(results);
        if (typeof schemaObj !== 'object' || Object.keys(schemaObj).length === 0) {
          res.write(
            `data: ${JSON.stringify({
              type: 'error',
              message: 'AI 未返回有效的 schema',
            })}\n\n`
          );
          return res.end();
        }
        const fieldCount = countSchemaFields(schemaObj);

        // 保存到 schema 缓存（含 _meta 用于下次缓存校验）
        await writeSchemaFileWithMeta(db, themeId, schemaObj, configHash, language);

        // fullResult 为原始 YAML（不修改），schema 为独立 JSON
        res.write(
          `data: ${JSON.stringify({
            type: 'complete',
            fullResult: configContent,
            schema: schemaObj,
            summary: `已为 ${fieldCount} 个字段生成 schema`,
          })}\n\n`
        );

        res.end();
      } catch (error) {
        hexo.log.error('[Schema Generator] 错误:', error);
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            message: error.message || '生成 Schema 失败',
          })}\n\n`
        );
        res.end();
      }
    })();
  });
};

// 供 yaml_api 复用受管主题清单
module.exports.BUILTIN_THEMES = BUILTIN_THEMES;

// 供聚焦单元测试使用（不暴露给路由层）
module.exports._test = {
  schemaCacheId,
  extractSchemaFromFileContent,
  readSchemaFileWithMeta,
  writeSchemaFileWithMeta,
  snapshotTypeFor,
  toSnapshotMeta,
  readThemeConfigSnapshots,
  writeThemeConfigSnapshots,
  createThemeConfigSnapshot,
};
