// EdgeOne Pages Node Functions 入口（catch-all）。
//
// 警示：本入口未在真实 EdgeOne 平台实测。桥接契约按 Cloudflare Pages 风格
// onRequest(context) -> Response 实现。若 EdgeOne 的 Node Functions 约定与此不同
// （例如期望 export default app、或 context 结构不同），需据此调整。
import serverless from 'serverless-http';
import { getApp } from '../lib/app.js';
import { requestToEvent } from '../lib/edgeone-bridge.js';

let handler;
async function getHandler() {
  if (!handler) handler = serverless(await getApp(), { binary: true });
  return handler;
}

export default async function onRequest(context) {
  const h = await getHandler();
  // serverless-http v4 默认 aws provider 只认识 API Gateway 事件，需先把 Fetch
  // Request 转成 AWS v1 事件形状，再以 (event, context) 调用。
  const event = await requestToEvent(context.request);
  const result = await h(event, context);
  const body = result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body;
  return new Response(body, {
    status: result.statusCode,
    headers: result.headers,
  });
}
