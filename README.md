# Hexo Pro Serverless

Hexo Pro 的无 hexo 运行时后端。一个独立的 Express 服务，同时托管管理后台的
React 前端（`/pro`）和 REST API（`/hexopro/api`）。

内容更新不再依赖 `hexo generate`，而是直接读写一个 **git 内容仓库**（一个完整的
hexo 站点：`_config.yml`、`source/`、`scaffolds/`），每次写操作后自动 `git commit`
（可选 `git push`，由 CI 负责构建静态站点）——与 Qexo 的思路一致。

持久化数据（用户、系统设置、部署状态、回收站等）使用 **Neon PostgreSQL**；未配置
`DATABASE_URL` 时自动降级为内存模式（重启即失），适合本地试用。

## 目录结构

```
index.js            入口：Express + 静态资源 + API 挂载 + 启动流程
lib/                配置、hexo shim、内容索引器、permalink、git、数据库适配层
api/                /hexopro/api/* 的 REST 处理器
www/                已构建的前端（webpack.prod.js 产物，publicPath /pro/）
content/            内容 git 仓库（运行时自动初始化，已 gitignore）
package.json        后端依赖
.env.example        环境变量样例
```

## 快速开始

```bash
npm install            # 安装后端依赖
cp .env.example .env   # 按需填写 DATABASE_URL / GIT_REPO_URL 等
npm start              # 默认 http://localhost:8001/pro
```

启动后访问 <http://localhost:8001/pro>。首次使用时页面会引导注册管理员账号。

### 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `DATABASE_URL` | Neon PostgreSQL 连接串 | 未配置则内存模式 |
| `CONTENT_DIR` | 内容 git 仓库路径 | `./content` |
| `GIT_REPO_URL` | 首次启动时克隆到 `CONTENT_DIR`（目录为空时） | 无 |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | 内容提交的作者身份 | `Hexo Pro` / `hexo-pro@example.com` |
| `AUTO_PUSH` | 每次提交后是否 `git push` | `false` |
| `PORT` | 服务端口 | `8001` |
| `HEXO_PRO_URL` / `HEXO_PRO_ROOT` | 覆盖 permalink 计算的站点 url/root | 读 `_config.yml` |
| `JWT_SECRET` | JWT 密钥 | 自动生成并存入 DB |

## 前端

`www/` 是前端构建产物，已随仓库提交，克隆后即可运行。前端源码仍在原仓库
（`client/`）中，如需重新构建，在原仓库执行 `npm run build`（`webpack.prod.js`
输出到 `hexo-pro/www`）后将其拷贝回本仓库的 `www/` 即可。

## 内容更新模型（Qexo 风格）

- 所有文章/页面/图片/配置都以 **markdown + YAML front-matter** 文件的形式存放在
  `CONTENT_DIR` 的 git 仓库中，文件是唯一数据源。
- 每次变更（新建/编辑/发布/删除文章或页面、上传/删除图片、修改配置）后，后端会自动
  提交一次 commit（去抖 800ms）。设置 `AUTO_PUSH=true` 时同时推送到远程，由远程 CI
  构建并部署静态站点。

## 数据契约

- API 前缀：`/hexopro/api`
- 成功响应：`res.done(val)` → `CircularJSON` 字符串（HTTP 200）
- 失败响应：`res.send(code, msgOrData)` → `{ code, msg }`
- 鉴权：`Authorization: Bearer <JWT>`，HS256，7 天有效期
