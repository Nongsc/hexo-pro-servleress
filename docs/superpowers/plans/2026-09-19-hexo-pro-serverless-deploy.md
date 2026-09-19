# Hexo Pro Serverless 双平台部署 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 让 `hexo-pro-serverless` 一套代码同时部署到 Vercel 与腾讯云 EdgeOne Pages（Node Functions），功能对本地运行严格全量对齐。

**架构：** 把长驻型 Express 服务改造为「平台无关核心 `createApp()` + 两个薄入口」；图片走对象存储（memoryStorage + COS/OSS/七牛）；所有本地文件状态迁 PostgreSQL；主题安装改为「部署时克隆」。

**技术栈：** Express + pg(Neon) + multer(memoryStorage) + cos-nodejs-sdk-v5 / ali-oss / qiniu。

**规格：** [docs/superpowers/specs/2026-09-19-hexo-pro-serverless-deploy-design.md](../specs/2026-09-19-hexo-pro-serverless-deploy-design.md)（权威依据，先读它）

## 全局约束

- 禁止 `app.listen`（核心内）；两平台均用 Node.js 20 函数运行时，不用 Edge Functions(V8)。
- 图片上传用 `multer.memoryStorage()`，绝不写本地磁盘。
- 所有持久化走 PostgreSQL（Neon，`settings` 表加新 `type`）；本地文件仅 `/tmp`。
- 图床 COS/OSS/七牛三者全保留；`local` 仅本地开发，serverless 环境强制远程。
- 前端 `www/` 不重打包（`/hexopro/api`、`/pro/` 不变）。
- 平台差异只允许出现在两个入口文件 + 各一个配置文件。
- 现有测试（`npm test`）每个任务结束时保持全绿；每个任务结束一个独立可测交付物。

---

## 任务 1：入口 serverless 化（createApp + 本地启动入口）

**文件：**
- 创建：`lib/app.js`（`createApp(env)` + `getApp()` 单例 + `ensureSiteConfig` + `importFromGithub`）
- 创建：`server.js`（本地开发入口：加载 `.env` → `createApp()` → `listen`）
- 修改：`package.json`（`start` 脚本改为 `node server.js`）

- [ ] **步骤 1：新建 `lib/app.js`**，把 `index.js` 的 `main()` 主体搬进去，改为 `async function createApp(env = process.env)`，**去掉 `app.listen`**，返回 `app`。`ensureSiteConfig` 与 `importFromGithub` 两个函数原样搬入（`importFromGithub` 内部第一行保留 `const { parsePost, parsePage } = require('./content-store');`）。

  关键骨架：

  ```js
  'use strict';
  const path = require('path');
  const fs = require('fs');
  const express = require('express');
  const { buildConfig } = require('./config');

  async function createApp(env = process.env) {
    const cfg = buildConfig(env);
    const databaseManager = require('./db');
    const { GitHubClient } = require('./github');
    const { SiteConfigStore } = require('./site-config');
    const { ContentStore } = require('./content-store');
    const HexoShim = require('./hexo-shim');
    const yaml = require('js-yaml');

    const db = await databaseManager.initialize({ config: cfg.config, log: console });
    const github = cfg.githubToken && cfg.githubRepo
      ? new GitHubClient({ token: cfg.githubToken, repo: cfg.githubRepo, branch: cfg.githubBranch })
      : null;
    const siteConfig = new SiteConfigStore(db.siteConfigDb, github);
    await ensureSiteConfig(siteConfig, github);
    const siteRaw = await siteConfig.get('site');
    if (siteRaw) {
      const parsed = yaml.load(siteRaw) || {};
      cfg.config = Object.assign({}, cfg.config, parsed);
    }
    await databaseManager.ensureInitialUser(cfg.config);

    const hexo = new HexoShim(cfg, { github, siteConfig });
    const store = new ContentStore(hexo, db.articleDb);
    hexo.store = store;

    // dataDir 无写入（持久化全在 DB），仅本地开发兜底；serverless 只读 FS 下用 try/catch 容忍
    try { if (!fs.existsSync(cfg.dataDir)) fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch (_) {}
    const n = await store.load();
    if (n.length === 0 && github) await importFromGithub(github, store);
    console.log(`[Hexo Pro]: indexed ${store.models.Post.count()} posts, ${store.models.Page.count()} pages`);

    const app = express();
    app.disable('x-powered-by');
    await require('../api/api')(app, hexo);

    const uploadDir = cfg.upload_dir;
    try { if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true }); } catch (_) {}
    app.use('/images', express.static(uploadDir, { maxAge: '7d' }));

    const wwwDir = path.join(__dirname, '..', 'www');
    if (fs.existsSync(wwwDir)) {
      app.use('/pro', express.static(wwwDir));
      app.use('/pro', (req, res, next) => {
        if (req.method !== 'GET' || /\.[a-zA-Z0-9]+$/.test(req.path)) return next();
        res.sendFile(path.join(wwwDir, 'index.html'));
      });
      app.get('/', (req, res) => res.redirect('/pro/'));
    }

    app.use((err, req, res, next) => {
      console.error('[Hexo Pro]: unhandled error:', err && err.stack ? err.stack : err);
      res.status(500).json({ code: 500, msg: 'internal error' });
    });
    return app;
  }

  // ensureSiteConfig / importFromGithub 原样搬入（见 index.js 当前实现）

  let appPromise = null;
  function getApp() {
    if (!appPromise) appPromise = createApp();
    return appPromise;
  }

  module.exports = { createApp, getApp };
  ```

- [ ] **步骤 2：新建 `server.js`**，加载 `.env`（把 `index.js` 顶部的 `loadDotEnv` IIFE 搬过来）→ `const { createApp } = require('./lib/app'); createApp().then(app => app.listen(port, ...))`，端口用 `process.env.PORT || 8001`。

- [ ] **步骤 3：修改 `package.json`** `"start": "node server.js"`。

- [ ] **步骤 4：运行验证** — `npm test` 全绿（40 个现有测试），再 `node server.js` 能启动并打印 `indexed ... posts`（若有 GitHub 凭据；无凭据则内存模式也能启动）。

- [ ] **步骤 5：Commit**

  ```bash
  git add lib/app.js server.js package.json
  git commit -m "refactor(boot): 抽出 createApp() 支持 serverless，保留本地 server.js 启动"
  ```

---

## 任务 2：平台入口适配器 + 配置

**文件：**
- 创建：`api/index.js`（Vercel 入口）
- 创建：`node-functions/[[default]].js`（EdgeOne 入口）
- 创建：`vercel.json`

- [ ] **步骤 1：新建 `api/index.js`**（Vercel Node handler 形式，规避 ESM 默认导出差异）：

  ```js
  const { getApp } = require('../lib/app.js');
  module.exports = async (req, res) => {
    const app = await getApp();
    return app(req, res);
  };
  ```

- [ ] **步骤 2：新建 `vercel.json`**（catch-all 到函数，函数提高超时）：

  ```json
  {
    "functions": { "api/index.js": { "maxDuration": 60 } },
    "rewrites": [{ "source": "/(.*)", "destination": "/api/index.js" }]
  }
  ```

- [ ] **步骤 3：新建 `node-functions/[[default]].js`**。EdgeOne Node Functions 的 Express 模式要求 `export default app`，但 `createApp` 异步，故用 `onRequest` 形式 + `serverless-http` 桥接（若实测 EdgeOne 支持异步默认导出，可简化为 `export default await getApp()`）。给出首版（CommonJS 不行，用 ESM）：

  ```js
  import serverless from 'serverless-http';
  import { getApp } from '../../lib/app.js';

  let handler;
  async function getHandler() {
    if (!handler) handler = serverless(await getApp());
    return handler;
  }

  export default async function onRequest(context) {
    const h = await getHandler();
    // serverless-http v4 接受 (event, context)，返回 { statusCode, headers, body }
    const result = await h(context.request, context);
    return new Response(result.body, {
      status: result.statusCode,
      headers: result.headers,
    });
  }
  ```

  > 注：`serverless-http` 需加入 `dependencies`。若该桥接在 EdgeOne 实测不匹配，回退方案为「把 `createApp` 改为可同步的懒加载、入口 `export default` 一个返回 Promise 的默认导出」——以最小样例实测为准（见规格 §10）。

- [ ] **步骤 4：安装 `serverless-http`** — `npm install serverless-http`。

- [ ] **步骤 5：验证** — `npm test` 仍全绿；`node server.js` 仍可本地启动。平台侧冒烟（`vercel dev` / `edgeone pages dev`）若本机无 CLI 则记录为手工步骤，不作为本任务阻塞。

- [ ] **步骤 6：Commit**

  ```bash
  git add api/index.js node-functions/[[default]].js vercel.json package.json package-lock.json
  git commit -m "feat(deploy): 新增 Vercel / EdgeOne Node Functions 入口与配置"
  ```

---

## 任务 3：图片上传 memoryStorage 化（三 provider + local + 站点图标）

**文件：**
- 修改：`api/image_api.js`
- 修改：`api/settings_api.js`（站点图标上传）
- 测试：`test/image-memory-storage.test.js`（新建，或并入现有 image 测试）

- [ ] **步骤 1：写失败测试** — 验证「上传走内存，不调用 `fs.writeFileSync` 到 upload_dir」。用 `multer.memoryStorage` 模拟 multipart：构造一个带 `req.file = { buffer, originalname }` 的假请求，调 `handleTencentUpload`（需 mock `tencentCOS` 或改用 `handleLocalUpload` 的 buffer 分支），断言 `cos.putObject`/写盘用的是 `buffer` 而非 `req.file.path`。测试先跑通「当前代码依赖 `req.file.path`」的失败预期（或直接断言新契约 `req.file.buffer` 被使用）。

- [ ] **步骤 2：`image_api.js` 改 multer 存储** — 第 255 行 `multer.diskStorage({...})` 整个替换为 `const storage = multer.memoryStorage();`（删除 `destination`/`filename` 两个回调）。

- [ ] **步骤 3：改 `handleLocalUpload` multipart 分支**（约 947-997 行）：
  - `fs.moveSync(f.path, dstPath, ...)` → `fs.writeFileSync(dstPath, f.buffer)`。
  - 文件名回退 `path.basename(f.filename)` 删除（memory 下 `f.filename` 未定义），改为 `req.body.filename || ensureUtf8Filename(f.originalname) || (uuidv4() + ext)`。

- [ ] **步骤 4：改三个 remote handler 的 multipart 分支**（`handleAliyunUpload` 约 1462/1469、`handleQiniuUpload` 约 1549/1556、`handleTencentUpload` 约 1631/1638）：
  - `imageData = fs.readFileSync(req.file.path)` → `imageData = req.file.buffer`。
  - 删除 `fs.unlinkSync(req.file.path)`。

- [ ] **步骤 5：`settings_api.js` 站点图标上传**（约 654-669 行）：同法改为从 `req.file.buffer`（或 base64 body）直写/上传，不落 `imagesDir` 本地盘；若为站点图标且当前是本地存储，沿用 `/tmp` 或内存再上传对象存储。

- [ ] **步骤 6：运行测试** — 新测试通过 + `npm test` 全绿。

- [ ] **步骤 7：Commit**

  ```bash
  git add api/image_api.js api/settings_api.js test/
  git commit -m "refactor(image): 上传改 memoryStorage，直传对象存储 buffer"
  ```

---

## 任务 4：serverless 环境 `local` 图床守卫

**文件：**
- 修改：`api/image_api.js`（`getStorageConfig` 附近加环境判断）
- 测试：`test/image-serverless-guard.test.js`

- [ ] **步骤 1：写失败测试** — 当 `process.env.VERCEL` 或 EdgeOne 标记存在、且 storage `type === 'local'` 时，`images/upload`、`images/list`、`images/delete` 返回 400「请配置对象存储」而非尝试落盘。

- [ ] **步骤 2：实现守卫** — 在 `image_api.js` 顶部加 `const IS_SERVERLESS = !!(process.env.VERCEL || process.env.EDGEONE || process.env.EDGEONE_PAGES);`，在 `images/upload` 等入口判断 `if (IS_SERVERLESS && reqType === 'local') return res.send(400, 'serverless 环境请配置对象存储（COS/OSS/七牛）');`。

- [ ] **步骤 3：运行测试 + 全量** — `npm test` 全绿。

- [ ] **步骤 4：Commit**

  ```bash
  git add api/image_api.js test/
  git commit -m "feat(image): serverless 环境禁用 local 图床并给出明确提示"
  ```

---

## 任务 5：未引用图片扫描改读 DB

**文件：**
- 修改：`api/image_api.js`（`collectReferencedImageKeys` 约 1910-1963 行）
- 测试：`test/image-unused-store.test.js`

- [ ] **步骤 1：写失败测试** — 构造 `hexo.store.models.Post/Page`（含 `raw` 字段、正文含 `![x](images/foo.png)`），断言 `collectReferencedImageKeys` 返回含 `images/foo.png` 的 key 集合，且**不依赖本地源目录**（本地无 `_posts/_drafts` 也能扫描）。

- [ ] **步骤 2：实现** — 把 `collectReferencedImageKeys` 的「遍历本地 `_posts/_drafts` 文件」替换为「遍历 `hexo.store.models.Post` 与 `.Page`，对每个 doc 取 `doc.raw || doc.content` 交给现有 `extractImageReferences`」。`includeDrafts` 用 doc 的发布标志过滤（字段名以 `lib/content-store.js` 实际为准，实现前先读确认）。保留 `stripDomains`/`localBase`/`normalizeUrlToKey` 逻辑。

- [ ] **步骤 3：运行测试 + 全量** — `npm test` 全绿。

- [ ] **步骤 4：Commit**

  ```bash
  git add api/image_api.js test/
  git commit -m "refactor(image): 未引用图片扫描改从 store(DB) 读内容"
  ```

---

## 任务 6：本地文件状态迁 settings 表（todos / 访问统计 / blogInfoList / admin-config）

**文件：**
- 修改：`api/dashboard_api.js`（todos 四端点 + 访问统计）
- 修改：`lib/content-store.js`（`blogInfoList.json` 写入处）
- 修改：`api/post_api.js`（`blogInfoList.json` 读取处 + `_admin-config.yml` 读写处）
- 测试：`test/db-state-migration.test.js`

**统一模式**（settings 表是 `_id TEXT PK + doc JSONB`，按 `type` 查）：读 `settingsDb.findOne({ type }, cb)`，写 `settingsDb.update({ type }, { $set: { type, ...payload } }, { upsert: true }, cb)`。迁移后**不再 `require('fs')` 读写 `hexo.base_dir` 下的 JSON/YAML**。

- [ ] **步骤 1：写失败测试** — 用一个内存 `Table`（或 mock settingsDb）驱动 todos/list、add、toggle、delete 四端点，断言数据持久化到 `type: 'todos'` 的 doc，且无 `fs` 调用。

- [ ] **步骤 2：迁移 todos** — `dashboard_api.js` 的 `dashboard/todos/list|add|toggle|delete` 把 `todosPath` + `fse.readFileSync/writeFileSync` 替换为 settings 表 `type: 'todos'`（`items` 数组）。

- [ ] **步骤 3：迁移访问统计** — `dashboard_api.js` 约 382 行的 `visitStatsPath` 读改 settings `type: 'visit-stats'`。

- [ ] **步骤 4：迁移 blogInfoList** — `content-store.js` 约 265 行的 `fs.writeFileSync(blogInfoList.json)` 改为写 settings `type: 'blogInfoList'`（`items`）；`post_api.js` 约 177 行读改为读同一 settings doc（或改读 `hexo.store.models`，实现者按调用语义二选一，规格 §4）。

- [ ] **步骤 5：迁移 `_admin-config.yml`** — `post_api.js` 约 23-28 行读写改为 settings `type: 'admin-config'`（存 YAML 字符串 `content`）。

- [ ] **步骤 6：运行测试 + 全量** — `npm test` 全绿。

- [ ] **步骤 7：Commit**

  ```bash
  git add api/dashboard_api.js lib/content-store.js api/post_api.js test/
  git commit -m "refactor(db): todos/访问统计/blogInfoList/admin-config 迁入 settings 表"
  ```

---

## 任务 7：仪表盘系统信息去 node_modules 依赖

**文件：**
- 修改：`api/dashboard_api.js`（`dashboard/system/info` 约 112-170 行）
- 测试：`test/dashboard-system-info.test.js`

- [ ] **步骤 1：写失败测试** — 断言 `dashboard/system/info` 返回的 `hexoVersion` 来自本项目 `package.json`，`plugins` 为从 `package.json` 依赖筛出的 `hexo-*` 清单，且**不调用** `fs.readdirSync(node_modules)`。

- [ ] **步骤 2：实现** — 删除 `fs.existsSync(node_modules/hexo/package.json)` 与 `fs.readdirSync(node_modules)` 逻辑；`hexoVersion` 读 `require('../../package.json').version`（本项目版本），`plugins` 由 `Object.keys(pkg.dependencies).filter(d => d.startsWith('hexo-'))` 生成。

- [ ] **步骤 3：运行测试 + 全量** — `npm test` 全绿。

- [ ] **步骤 4：Commit**

  ```bash
  git add api/dashboard_api.js test/
  git commit -m "refactor(dashboard): 系统信息改为读本项目 package.json"
  ```

---

## 任务 8：主题「部署时克隆」

**文件：**
- 修改：`api/theme_api.js`（`theme/install`、`theme/current`、`theme/installed`、`theme/switch` 的 `fs` 判断）
- 测试：`test/theme-deploy-clone.test.js`

- [ ] **步骤 1：写失败测试** — 调 `theme/install`（mock `hexo.siteConfig`），断言：不调用 `git clone`/`exec`，且写入了 `theme:<id>` 覆盖配置与 `_config.yml` 的 `theme` 字段；`theme/installed` 返回 `installed: true` 基于 DB 而非 `fs.existsSync`。

- [ ] **步骤 2：改 `theme/install`** — 删除 `git clone`/`npm install`/`copyFileSync`（约 377-409 行的异步块），改为：若无 `siteConfig.get('theme:' + theme.id)` 则 `siteConfig.set('theme:' + theme.id, 默认配置, ...)`；更新 `_config.yml`（`siteConfig 'site'`）的 `theme` 为 `theme.themeDir`；返回 `{ success, message: '主题已选定，将在部署构建阶段克隆', themeDir }`。

- [ ] **步骤 3：改 `theme/current` / `theme/installed` / `theme/switch`** — 把 `fs.existsSync(themePath)` 判断改为 `isThemeInstalled`（`getThemeById` 或 `siteConfig.get('theme:' + id)` 存在）；`theme/switch` 里 `fse.readFileSync(themeConfigSrc)` 的分支改为从 `BUILTIN_THEMES` 元数据生成默认配置（不再读本地主题源码文件）。

- [ ] **步骤 4：运行测试 + 全量** — `npm test` 全绿。

- [ ] **步骤 5：Commit**

  ```bash
  git add api/theme_api.js test/
  git commit -m "refactor(theme): 主题安装改为部署时克隆（不再本地 git clone）"
  ```

---

## 任务 9：部署触发 await 化

**文件：**
- 修改：`api/deploy_api.js`（`deploy/execute` 与 `executeDeployAsync`）
- 测试：`test/deploy-await.test.js`

- [ ] **步骤 1：写失败测试** — mock `hexo.github.triggerWorkflow` 断言：`deploy/execute` 在 `res.done` 之前已调用 `triggerWorkflow`（用一个「先触发后响应」的顺序探针，或断言 handler 完成时 workflow 已被触发）。

- [ ] **步骤 2：实现** — 把「触发 workflow」从 `executeDeployAsync` 的 fire-and-forget 尾部提到响应前：`deploy/execute` 内先 `await triggerGithubDeploy(hexo.github, config)` 成功，再 `res.done(...)`；`executeDeployAsync` 仅保留「记录状态/写 lastDeployTime」这类可丢弃尾部。

- [ ] **步骤 3：运行测试 + 全量** — `npm test` 全绿。

- [ ] **步骤 4：Commit**

  ```bash
  git add api/deploy_api.js test/
  git commit -m "fix(deploy): 部署触发改为响应前 await，避免 serverless 冻结丢失"
  ```

---

## 任务 10：双平台冒烟 + 收尾

**文件：** 无新增（验证为主）

- [ ] **步骤 1：全量测试** — `npm test`，确认全部通过（现有 + 新增）。
- [ ] **步骤 2：本地启动回归** — `node server.js` 能启动、`/pro` 返回管理界面、`/hexopro/api/...` 可访问。
- [ ] **步骤 3：平台冒烟（尽力而为）** — 若本机装有 `vercel` / `edgeone` CLI：`vercel dev` 与 `edgeone pages dev` 各起一次，验证入口桥接签名（`api/index.js`、`node-functions/[[default]].js`）生效、API 可调。无 CLI 则在 commit message 中记录为后续手工步骤。
- [ ] **步骤 4：Commit（如平台冒烟触发入口微调则提交）**

  ```bash
  git add -A
  git commit -m "chore(deploy): 双平台冒烟与收尾"
  ```

---

## 自检记录

- **规格覆盖：** 规格 §1→任务 1/2；§2→任务 3/4；§3→任务 5；§4→任务 6；§5→任务 7；§6→任务 8；§7→任务 9；§8→任务 2；§9→各任务测试步骤；§10 风险由任务 2/9 覆盖。
- **占位符扫描：** 无 TODO/待定；各任务关键代码已给骨架，字段名以 `lib/content-store.js` 实际为准处已显式标注「先读确认」。
- **类型一致性：** `getApp()` 返回 `Promise<Express app>`；`createApp` 签名 `(env = process.env)`；settings 表 `type` 命名 `todos`/`visit-stats`/`blogInfoList`/`admin-config` 全计划一致；`serverless-http` 依赖由任务 2 引入并在任务 2 使用。
