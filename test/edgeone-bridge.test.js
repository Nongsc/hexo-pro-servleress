// test/edgeone-bridge.test.js
// Critical #1：requestToEvent 把 Fetch Request 显式映射为 serverless-http aws
// provider 期望的 AWS v1 事件形状，覆盖 method / path / query / headers / body。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { requestToEvent } = require('../lib/edgeone-bridge.js');

test('requestToEvent 把 POST JSON 请求映射为 AWS v1 事件', async () => {
    const request = new Request('http://localhost/api/posts?x=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-foo': 'bar' },
        body: '{"a":1}',
    });

    const event = await requestToEvent(request);

    assert.equal(event.httpMethod, 'POST');
    assert.equal(event.path, '/api/posts');
    assert.equal(event.queryStringParameters.x, '1');
    assert.equal(event.headers['x-foo'], 'bar');
    assert.equal(event.headers['content-type'], 'application/json');
    assert.equal(event.body, '{"a":1}');
    assert.equal(event.isBase64Encoded, false);
});

test('requestToEvent 对二进制 body 使用 base64 且 isBase64Encoded=true', async () => {
    const bytes = Buffer.from([0x01, 0x02, 0x03, 0xff]);
    const request = new Request('http://localhost/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
    });

    const event = await requestToEvent(request);

    assert.equal(event.isBase64Encoded, true);
    assert.equal(event.body, bytes.toString('base64'));
    assert.equal(event.httpMethod, 'POST');
});

test('requestToEvent 对无 body 的 GET 请求产出空 body 与非 base64', async () => {
    const request = new Request('http://localhost/api/posts?x=1');

    const event = await requestToEvent(request);

    assert.equal(event.httpMethod, 'GET');
    assert.equal(event.path, '/api/posts');
    assert.equal(event.queryStringParameters.x, '1');
    assert.equal(event.body, '');
    assert.equal(event.isBase64Encoded, false);
});
