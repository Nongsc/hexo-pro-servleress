'use strict';

// Vercel Node.js Functions 入口（CommonJS handler 形式，规避 ESM 默认导出差异）。
// catch-all rewrite（见 vercel.json）把一切请求交给 getApp()，Express 内部路由
// 负责服务 API、/pro 静态资源与 /images 上传目录。
const { getApp } = require('../lib/app.js');

module.exports = async (req, res) => {
  const app = await getApp();
  return app(req, res);
};
