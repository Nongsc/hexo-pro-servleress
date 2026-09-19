# Hexo Pro Serverless 双平台部署 设计文档

> **面向 AI 代理的工作者：** 本规格是后续实现计划（writing-plans）的权威依据；计划内部冲突时以本规格为准。

**目标：** 让 `hexo-pro-serverless` 用**一套代码**同时部署到 Vercel 与腾讯云 EdgeOne Pages（Node Functions），功能对本地运行**严格全量对齐**。

**架构：** 把长驻型 Express 服务改造成「平台无关核心 + 两个薄入口」；图片走对象存储（COS/OSS/七牛三套全保留）；所有本地文件状态迁移到 PostgreSQL；主题「安装」改为「部署时克隆」。

**技术栈：** Express + pg(Neon) + multer(memoryStorage) + cos-nodejs-sdk-v5 / ali-oss / qiniu（已为 optionalDependencies）。

**规格来源决策（本会话已确认）：**
1. 图床：COS / 阿里 OSS / 七牛**三者全保留**，默认仍 `local`（本地开发），serverless 环境走远程。
2. 功能范围：**严格全量对齐**，不做降级。
3. 主题安装：**部署时克隆**（见 §6）。

---

## 全局约束

- **禁止 `app.listen`。** 核心通过 `createApp()` 返回 Express 实例，由平台入口挂载。
- 两平台均使用 **Node.js 20 函数运行时**（Vercel `api/`、EdgeOne `node-functions/`）；**不使用** EdgeOne 的 Edge Functions（V8，无 npm/TCP）。
- 图片上传用 `multer.memoryStorage()`，**绝不写本地磁盘**；对象存储直传（从内存 buffer）。
- 所有持久化走 PostgreSQL（Neon）；本地文件系统仅允许 `/tmp` 临时用途。
- 数据库连接串用 pooled（含 `-pooler.`）+ `sslmode=require`（现状已满足）。
- 前端 `www/` **无需重打包**（相对路径 `/hexopro/api`、publicPath `/pro/` 不变）。
- 平台差异只允许出现在：两个入口文件 + 各一个配置文件；`lib/`、`api/`、`www/` 100% 共享。

---

## 1. 入口改造（长驻服务 → 无服务器函数）

当前 `index.js` 的 `main()` 做了：加载 .env → 建 config → 初始化 DB → 建 GitHub 客户端 → 站点配置 → 内容存储 → 导入 → 建 Express app → 注册路由 → 静态服务 → `listen`。

**改造为：**

- `lib/app.js`（新增）：导出 `async function createApp(env = process.env)`，包含上述**除 `listen` 外**的全部逻辑，返回组装好的 Express app。模块级缓存一个 Promise 单例（`let p; function getApp(){ return p || (p = createApp()); }`），避免 serverless 每次冷启动重复初始化 DB / 重复 `store.load()`。
- `server.js`（新增，本地开发入口）：加载 `.env` → `await createApp()` → `app.listen(port)`。原 `index.js` 的 `.env` 加载器只留在这里。
- `api/index.js`（Vercel 入口）：`export default async (req, res) => (await getApp())(req, res)`（导出 Node `(req,res)` handler 形式，避免依赖 ESM 顶层 await / 默认导出的平台差异）。
- `node-functions/[[default]].js`（EdgeOne 入口）：EdgeOne Node Functions 的 express 模式要求 `export default app`；因 `createApp` 异步，此入口用 `onRequest` 形式 + `serverless-http`（或等价桥接）把 Express 接到 Web Request/Response。**具体桥接签名在 Task 1 用最小样例实测后敲定。**

**静态资源：** 由函数内部的 `express.static(wwwDir)` 继续服务（读打包进函数的 `www/`，只读 OK），入口做 catch-all 路由。这样两平台配置都能收敛为「所有请求 → 函数」，最简、最统一。（可选优化：把 `www/` 交给平台静态托管以省函数冷启动，非必需。）

---

## 2. 图片上传与图床（memoryStorage + 三 provider）

- `image_api.js` 的 `multer.diskStorage({...})` 改为 `multer.memoryStorage()`。
- 三处 remote 上传 handler（`handleAliyunUpload` / `handleQiniuUpload` / `handleTencentUpload`）的 multipart 分支：`fs.readFileSync(req.file.path)` → `req.file.buffer`，删除 `fs.unlinkSync(req.file.path)`。
- `handleLocalUpload` multipart 分支：`upload.any()` 后 `fs.moveSync(f.path, dstPath)` → 改用 `req.files[].buffer` 写 `dstPath`（仅本地开发环境命中；serverless 上 `local` 类型不可用）。
- `settings_api.js` 站点图标上传（`fs.writeFileSync` 本地）：同样改 memory + 走对象存储。
- **serverless 强制远程：** 检测 serverless 环境（`process.env.VERCEL` 或 EdgeOne 注入的环境变量）且 `type === 'local'` 时，上传/列表/删除等操作返回明确错误提示「请配置对象存储」，不落盘、不崩溃；本地开发仍可用 `local`。
- 远程分支（列举/删除/移动/重命名/回收站/占位文件夹）**已存在且完整**，无需重写，仅确保在 memory 上传路径下可用。

---

## 3. 未引用图片扫描（改读 DB）

`collectReferencedImageKeys`（`image_api.js`）当前遍历本地 `_posts/_drafts` 源文件提取图片引用。新模型下源文件在 DB + GitHub，本地无此目录。

**改为：** 从 `hexo.store`（`articles` 表，经 `ContentStore` 模型）读取全部 post/page 的 `raw`（或已解析正文），交给现有的 `extractImageReferences` 提取引用 key。其余扫描逻辑不变。

---

## 4. 数据迁移到 DB（消灭本地 JSON 文件）

`settings` 表（通用 `{type, ...doc}`）复用，新增以下 `type`，语义与 NeDB 现有用法一致（`findOne({type})` / `update({type}, {$set})` / `insert`）：

| 本地文件 | 迁移目标 | 涉及代码 |
|---|---|---|
| `todos.json` | `settings` 表 `type: 'todos'`，字段 `items: []` | `dashboard_api.js` todos 四个端点 |
| 访问统计文件 | `settings` 表 `type: 'visit-stats'` | `dashboard_api.js` 访问统计 |
| `blogInfoList.json` | `settings` 表 `type: 'blogInfoList'`，或改读 `hexo.store.models`（实现者按调用语义二选一） | `content-store.js` 写入处、`post_api.js` 读取处 |
| `_admin-config.yml` | `settings` 表 `type: 'admin-config'`（存 YAML 字符串） | `post_api.js` 读写处 |

原则：**任何端点不再 `require('fs')` 读写 `hexo.base_dir` 下的 JSON/YAML**。

---

## 5. 仪表盘系统信息

`dashboard/system/info` 当前枚举 `node_modules/hexo/package.json` 与 `node_modules/hexo-*` 插件。serverless 打包后无此结构。

**改为：** `hexoVersion` 读本项目 `package.json`（或常量），`plugins` 改为静态清单（从 `package.json` 依赖中筛出 `hexo-*`），不再 `fs.readdirSync(node_modules)`。

---

## 6. 主题「部署时克隆」

`theme/install` 去掉 `git clone` + `npm install`（serverless 无 shell/无写盘，且 admin 本地 clone 到达不了部署环境）。

**新语义：**
1. `theme/install(themeId)`：在 `siteConfig` 写入 `theme:<id>` 覆盖配置（若尚无，从内置清单的 repo/branch 元数据生成默认配置头）→ 更新 `_config.yml` 的 `theme` 字段（`siteConfig 'site'`）→ 返回成功，并提示「部署时将在构建阶段克隆主题」。
2. 主题 repo/branch/themeDir 元数据仍来自 `BUILTIN_THEMES`（已含 `repo`/`branch`/`configFile`/`themeDir`）。
3. **契约（本仓库之外）：** 部署仓库的 GitHub Action 在构建时按主题元数据 `git clone` 对应主题到 `themes/<themeDir>` 再 `hexo generate`。本 admin 后端只负责「选主题 + 写配置 + 触发部署」。
4. `theme/current` / `theme/installed` / `theme/switch`：`fs.existsSync(themePath)` 的「已安装」判断改为 DB 判断（`siteConfig.get('theme:<id>')` 存在 或 属内置主题）。不再依赖本地 themes 目录。

---

## 7. 部署触发的 serverless 适配

`deploy/execute` 当前在 `res.done()` 之后 `fire-and-forget` 调用 `executeDeployAsync`（其中 `triggerGithubDeploy` 才真正触发 GitHub workflow）。serverless 在响应返回后会冻结进程，异步尾部可能**永不执行**，导致部署不触发。

**改为：** `triggerGithubDeploy`（触发 workflow 的 HTTP 调用）在响应返回**之前** await 完成；只有「轮询/记录状态」这类可丢弃的尾部工作留在后台。即：先 `await triggerGithubDeploy(...)` 成功，再 `res.done(...)`，状态更新异步即可。

---

## 8. 平台配置文件

- `vercel.json`：catch-all rewrite 到 `api/index.js`，`functions` 设 `maxDuration`（见 §10）。
- EdgeOne：`node-functions/` 目录即约定，`[[default]].js` 兜底路由；如需声明，使用其 CLI 生成的配置。
- 环境变量（两平台各自配置）：`DATABASE_URL`、`DATABASE_SSL`、`GITHUB_TOKEN`、`GITHUB_REPO`、`GITHUB_BRANCH`、`HEXO_PRO_URL`、`HEXO_PRO_ROOT`、`JWT_SECRET`（可选）、对象存储密钥。

---

## 9. 测试策略

- 现有 40 个测试必须保持全绿（`npm test`）。
- 新增/调整测试：
  - `memoryStorage` 上传路径（`image_api`）：用 buffer 上传，断言不落盘、三 provider handler 取 `req.file.buffer`。
  - `settings` 表迁移后的 todos / visit-stats / blogInfoList 端点（DB 读写作）。
  - 未引用图片扫描改读 `hexo.store`。
  - 主题 install 新语义（写配置 + 设 theme，无 git 调用）。
  - `deploy/execute` 改为 await 触发（用 mock github 断言在响应前调用）。
  - `createApp()` 不 `listen`、可复用单例。
- 双平台冒烟：Vercel `vercel dev`、EdgeOne `edgeone pages dev` 各起一次最小入口验证桥接签名。

---

## 10. 风险与待验证

| 风险 | 影响 | 处理 |
|---|---|---|
| 异步 `createApp` 的入口桥接签名（ESM 默认导出 / 顶层 await / serverless-http）在两平台略有差异 | 入口不生效 | Task 1 先用最小样例实测，再写正式入口 |
| 函数超时：Vercel 默认 10s（可配到 60s）；AI 主题 Schema 生成是长时 SSE 流 | 长任务被截断 | 设 `maxDuration`；Schema 生成标注「受平台超时限制」，超出时引导用户在本地/容器跑（全量对齐的已知边界） |
| 响应后冻结导致 fire-and-forget 丢失 | 部署不触发 | §7 已改为响应前 await |
| 冷启动重复初始化 DB / `store.load()` | 延迟、连接池压力 | `getApp()` 单例缓存；Neon pooled 连接 |
| `local` 图床在 serverless 误用 | 上传报错 | §2 启动守卫给出明确提示 |
