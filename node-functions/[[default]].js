// EdgeOne Pages Node Functions 入口（catch-all）。
//
// 注意：本文件的桥接签名（onRequest(context) -> Response，Cloudflare-Pages 风格 +
// serverless-http）属规格 §10 明示的「待验证」项。本机大概率无 `edgeone` CLI，无法实测；
// 请留待 Task 10 平台冒烟验证。若 EdgeOne 的 Node Functions 约定与此不同（例如
// 期望 `export default app`、或 context 结构不同），需据此调整。
import serverless from 'serverless-http';
import { getApp } from '../lib/app.js';

let handler;
async function getHandler() {
  if (!handler) handler = serverless(await getApp());
  return handler;
}

export default async function onRequest(context) {
  const h = await getHandler();
  // serverless-http v4 接受 (event, context)，返回 { statusCode, headers, body }
  const result = await h(context.request, context);
  const body = result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body;
  return new Response(body, {
    status: result.statusCode,
    headers: result.headers,
  });
}
