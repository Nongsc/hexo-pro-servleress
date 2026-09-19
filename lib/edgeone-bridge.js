'use strict';

// 将 Fetch Request 显式转换为 serverless-http 默认 aws provider 期望的
// AWS v1 API Gateway 事件形状（httpMethod / path / queryStringParameters /
// headers / body / isBase64Encoded）。
//
// 背景：serverless-http 的 aws provider 只认识 API Gateway 事件、不认识 Fetch
// Request。若把 Request 直接传入，clean-up-event 会把 httpMethod 兜底成 GET、
// path 兜底成 '/'，create-request 用 Object.keys(event.headers) 遍历拿不到任何
// 头，requestBody 对 ReadableStream 走 JSON.stringify 变成 "{}"，请求体损坏。
// 参考 node_modules/serverless-http/lib/provider/aws/{clean-up-event,create-request}.js。

const TEXTUAL_CONTENT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|x-yaml))/i;

function isTextual(contentType) {
  return !contentType || TEXTUAL_CONTENT_TYPE.test(contentType);
}

async function requestToEvent(request) {
  const url = new URL(request.url);
  const contentType = request.headers.get('content-type') || '';

  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key] = value;
  }

  const queryStringParameters = {};
  for (const [key, value] of url.searchParams.entries()) {
    queryStringParameters[key] = value;
  }

  let body = '';
  let isBase64Encoded = false;
  if (request.body != null) {
    if (isTextual(contentType)) {
      body = await request.text();
    } else {
      body = Buffer.from(await request.arrayBuffer()).toString('base64');
      isBase64Encoded = true;
    }
  }

  return {
    httpMethod: request.method,
    path: url.pathname,
    queryStringParameters,
    headers,
    body,
    isBase64Encoded,
  };
}

module.exports = { requestToEvent };
