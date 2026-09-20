// EdgeOne Pages Node Functions 入口（catch-all）。
//
// EdgeOne 会根据 bundle 中是否含 express/koa/hono 自动判定「框架模式」；
// 本 app 依赖 Express，因此会被识别为框架模式，运行时直接以 Node (req,res)
// 调用默认导出的 Express app 实例（无需 serverless-http 桥接）。
//
// createApp() 是异步的（DB/GitHub 初始化），而框架模式要求同步导出 app，
// 故用外层同步 Express app 委托：首个请求时惰性初始化真正的 app 再转交。
import express from 'express';
import { getApp } from '../lib/app.js';

const app = express();

let appPromise = null;
app.use((req, res, next) => {
  (appPromise || (appPromise = getApp())).then(
    (realApp) => realApp(req, res, next),
    next
  );
});

export default app;
