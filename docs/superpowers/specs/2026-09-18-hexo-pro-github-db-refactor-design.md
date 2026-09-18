# 设计规格：Hexo Pro 内容主源迁移（content 仓库 → 数据库 + GitHub API）

日期：2026-09-18
状态：待评审
方案：A（保留 HexoShim 门面，重定向底层存储）

## 1. 背景与目标

### 现状
- 文章/页面的唯一真相源是本地 `content/` git 仓库里的 markdown 文件。
- 启动时 [lib/git.js](../lib/git.js) clone/init 仓库，[lib/content-indexer.js](../lib/content-indexer.js) 从磁盘扫描 markdown 构建内存索引（Post/Page/Category/Tag）。
- 数据库只存 5 张表：`users` / `settings` / `deploy_status` / `recycle` / `theme_schema_cache`，与文章无关。
- 问题：`content/` 一旦与远程脱节（空仓库、无 remote），CMS 就无数据；文章正文没有数据库备份。

### 目标
1. 移除 `content/` 目录，改用 GitHub API 管理 hexo 站点（Qexo 式）。
2. 站点信息 + 文章内容存入数据库。
3. 项目所有读操作使用数据库数据。

## 2. 决策记录（已与用户确认）

| 决策 | 选择 |
|---|---|
| 数据主源 | 数据库。读全走 DB；写先写 DB，再序列化同步 GitHub |
| 文章存储 | JSONB 文档（含 `raw` markdown + 解析字段），表 `articles` |
| GitHub 同步 | 实时同步（每次写立即 commit）+ 独立部署（触发远端 CI） |
| 站点信息范围 | `_config.yml`、主题配置、`_yaml_templates`、图床/上传配置 |
| 图片 | 本地 `uploads/images/` + 腾讯云 COS |
| 部署 | 仅 GitHub（触发远端 Actions） |
| 实现方案 | A：保留 HexoShim 门面，把底层从文件系统换成 DB + GitHub |

## 3. 目标仓库事实（2026-09-18 只读探测）

- 仓库：`Nongsc/hexo-blog`，私有，默认分支 `main`。
- 共 16 个文件；`source/_posts/` 下 2 篇文章（`hello-world.md`、`test.md`）。
- 另有 `scaffolds/`（3 个 md，导入时跳过）、`.github/`（CI 工作流）、`_config.yml`、`_config.landscape.yml`、`themes/`、`package.json`。
- 首次导入预期灌入 2 篇文章。

## 4. 架构与数据流

```
GitHub 仓库 (hexo 源码: source/_posts/*.md, _config.yml, themes/, .github/)
        ▲  GitHub REST API
        │   写: 序列化 markdown → PUT /contents（带 sha）
        │   删: DELETE /contents
        │   批量读: GET /git/trees/{branch}?recursive=1 → GET /contents
        │   部署: POST /actions/workflows/{id}/dispatches
        ▼
  ┌──────────────────────────────┐
  │  PostgreSQL (Neon) ← 主源     │
  │  articles / site_config / …    │
  └──────────────────────────────┘
        ▲  读全走 DB
        ▼
   HexoShim（model: Post/Page/Category/Tag）← 门面，数据来自 DB
        ▲
        ▼
   api/*.js（几乎不动，只改直接碰 fs 的落点）
```

- **读路径**：`posts/list` 等 → `hexo.model('Post')` → 读 `articles` 表（不再扫磁盘）。
- **写路径**：`posts/new` / `post/update` / `remove` → 更新 `articles` → 序列化 markdown → GitHub 写文件并 commit（实时）。
- **启动路径**：`index.js` 不再 clone；改为「初始化 DB → 若 `articles` 为空 → 从 GitHub 全量导入 → 建索引」。
- **站点信息**：`_config.yml` / 主题配置 / 模板 / 图床配置存 DB，写时同步回 GitHub 对应文件。

## 5. 数据库 schema

沿用现有 `_id TEXT PRIMARY KEY, doc JSONB` 结构（与 [lib/db.js](../lib/db.js) 的 `Table` 类天然兼容），新增 2 张表：

| 表 | 新增/保留 | 内容 |
|---|---|---|
| `articles` | 新增 | 每篇文章/页面一条 JSONB：`raw`(原始 markdown)、`content`(渲染 HTML)、`title`/`date`/`slug`/`tags`/`categories`/`permalink`/`source`/`layout`/`published` 等，即现有 `ContentIndexer` 产出的完整 `doc` |
| `site_config` | 新增 | 站点级配置，按 `type` 键分条：`_config.yml` 内容、主题配置、`_yaml_templates`、`deploy_config` |
| `users` / `settings` / `deploy_status` / `recycle` / `theme_schema_cache` | 保留 | 不变 |

约束：
- `articles._id` 继续用 `permalink`（保证前端 `base64(permalink)` 的 id 契约不变）。
- `articles.source` 保留为相对路径（如 `_posts/hello-world.md`），用于映射 GitHub 文件路径 `source/{source}`。

## 6. GitHub 同步层（新增 `lib/github.js`，替换 `lib/git.js`）

### 凭据与环境变量
- `GITHUB_TOKEN`：Personal Access Token（`contents: write`；触发构建需 `workflows: write`）。
- `GITHUB_REPO`：`Nongsc/hexo-blog`。
- `GITHUB_BRANCH`：`main`。
- 凭据只存 `.env`（已 gitignore），绝不写入仓库文件或规格文档。

### 接口
- `listTree()`：`GET /repos/{repo}/git/trees/{branch}?recursive=1` 枚举文件。
- `getFile(path)`：`GET /repos/{repo}/contents/{path}?ref={branch}`，base64 解码。
- `writeFile(path, content, message)`：`PUT /repos/{repo}/contents/{path}`，body `{message, content(base64), branch, sha?}`；文件已存在时需带 `sha`。
- `deleteFile(path, sha, message)`：`DELETE /repos/{repo}/contents/{path}`。
- `triggerWorkflow()`：`POST /repos/{repo}/actions/workflows/{id}/dispatches`。

### 同步时机
- 实时写：单文件 `PUT`（更新带 `sha`）/ `DELETE`，每次一个 commit。
- 批量导入：DB 为空时 `listTree` + 逐文件 `getFile` → 解析入库（一次）。
- 部署：`triggerWorkflow`，`deploy_status` 表继续记录状态。

## 7. 模块改动清单

| 文件 | 改动 |
|---|---|
| `index.js` | 删 `git.ensureRepo` / `ensureSourceLayout` / commit hook / 静态图片服务；改为「DB 初始化 → 空库则 GitHub 导入 → 建索引」 |
| `lib/git.js` → `lib/github.js` | git CLI → GitHub REST |
| `lib/config.js` | `_config.yml` 从文件读 → 从 `site_config` 表读 |
| `lib/content-indexer.js` → `lib/content-store.js` | 磁盘扫描 → 读 `articles` 表 |
| `lib/hexo-shim.js` | `post.create` / `_generate` 改为写 DB + 触发同步 |
| `api/update.js` | `fs.writeFileSync` → 写 DB + 同步 |
| `api/post_api.js` / `api/page_api.js` | `fse.move`（publish/unpublish/remove/rename）→ 更新 DB 字段 + 同步 |
| `api/yaml_api.js` | 文件读写 → `site_config` 表 + 同步 |
| `api/image_api.js` | 本地 `source/images` → `uploads/images/` + COS |
| `api/deploy_api.js` | 本地 `hexo g` → 触发 GitHub Actions |
| `api/dashboard_api.js` / `api/theme_api.js` | 改为从 DB 读统计/配置 |

## 8. 关键实现细节

### article doc 结构
复用 [lib/content-indexer.js](../lib/content-indexer.js) 的解析逻辑（`hfm.parse` + `marked`），产出的 `doc`（含 `raw`/`content`/`excerpt`/`more`/`tags`/`categories`/`permalink` 等）原样落库。序列化回 markdown 用 `hfm.stringify`，保证 front matter 往返不丢。

### 路径映射
- 文章：GitHub 路径 = `source/` + `source`（如 `source/_posts/hello-world.md`）。
- 页面：`source/` + `source`（如 `source/about/index.md`）。
- 站点配置：`_config.yml`、`_config.{theme}.yml` / `themes/{theme}/_config.yml`、`_yaml_templates/templates.json`。

### 首次导入
仅遍历 `source/` 下的 `.md`；跳过 `scaffolds/`、`node_modules/`、`.github/`、`.git`。每篇 markdown 经现有解析逻辑生成 `doc` 后写入 `articles`。

### 站点信息序列化
- `_config.yml` / 主题配置：存为 YAML 字符串（或解析后的对象），写回时 `yaml.dump`。
- `_yaml_templates/templates.json`：存 JSON 字符串。

### 图片
- 本地：`uploads/images/`（git 忽略，非 content），`/images` 静态服务不变。
- COS：复用现有 `cos-nodejs-sdk-v5`，图床配置（secretId/secretKey/bucket/region）沿用现有持久化位置（`settings` 表，`image_api` 已接 `db` 持久化），API 行为不变，本期不迁移到 `site_config`。

## 9. 错误处理与一致性

- 写序：先写 DB，成功后同步 GitHub；GitHub 失败时**保留 DB 数据**并返回错误（不静默丢数据），下次写或手动重试可覆盖。
- 幂等：`PUT /contents` 更新需带当前 `sha`；冲突（409）时重新 `getFile` 取最新 `sha` 重试一次。
- 鉴权/限流：401/403 视为配置错误并明确报错；429 限流退避重试（私有仓库 5000/h 足够）。
- 导入失败：单文件失败跳过并记日志，不中断整体导入。

## 10. 测试策略

- 单元：`content-store` 的解析/序列化往返；`github.js`（mock HTTP）。
- 集成：导入 → 读列表 → 新建/更新/删除 → 断言 DB 与 GitHub 一致。
- 回归：`posts/list`、`posts/:id`、`pages/list`、`recycle/*`、`yaml/*` 返回结构不变。

## 11. 迁移与环境变更

- 删除 `content/`（已被 gitignore，无版本影响）。
- `.env` 新增：`GITHUB_TOKEN`、`GITHUB_REPO`、`GITHUB_BRANCH`，及 COS 凭据（若启用 COS）。
- `.env.example` 同步新增字段（不含真实 token）。
- 首次启动：DB 为空 → 自动从 GitHub 导入，无需手动迁移。

## 12. 风险与开放问题

- GitHub PAT 已在会话中明文出现，建议在联调完成后**轮换/吊销该 token**。
- GitHub API 限流（私有仓库 5000 次/小时）对当前 2 篇文章量级无压力。
- COS 凭据（secretId/secretKey/bucket/region）待提供；未提供前图片仅落本地 `uploads/`。
- cloudflare-pages / edgeone-pages 部署本期移除，后续如需再评估。
