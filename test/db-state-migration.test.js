'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const dashboardApi = require('../api/dashboard_api');
const postApi = require('../api/post_api');
const databaseManager = require('../lib/db');

// 无 DATABASE_URL 时走内存模式，settingsDb 是真实 Table 实例（findOne/update 语义与生产一致）。
delete process.env.DATABASE_URL;

beforeEach(() => {
  databaseManager.reset();
});

async function makeSettingsDb() {
  const dbs = await databaseManager.initialize({ config: {} });
  return dbs.settingsDb;
}

// 路由注册工厂的最小 harness：收集 use(path, fn) 注册的处理器
function collectRoutes(apiModule, hexo, db) {
  const routes = {};
  const use = (p, fn) => { routes[p] = fn; };
  apiModule({}, hexo, use, db);
  return routes;
}

function fakeRes() {
  const res = { calls: [] };
  res.send = (num, data) => { res.calls.push(['send', num, data]); return res; };
  res.done = (val) => { res.calls.push(['done', val]); return res; };
  return res;
}

function makeBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-dbmig-'));
}

function findOne(db, query) {
  return new Promise((resolve, reject) => db.findOne(query, (e, d) => (e ? reject(e) : resolve(d))));
}
function insert(db, doc) {
  return new Promise((resolve, reject) => db.insert(doc, (e, d) => (e ? reject(e) : resolve(d))));
}

test('todos 四端点读写 settings 表 type:todos，不落盘', async () => {
  const settingsDb = await makeSettingsDb();
  const base_dir = makeBaseDir();
  const hexo = { base_dir, config: {} };
  const routes = collectRoutes(dashboardApi, hexo, { settingsDb });
  const next = () => {};

  // 空列表
  const emptyRes = fakeRes();
  await routes['dashboard/todos/list']({}, emptyRes, next);
  assert.deepEqual(emptyRes.calls[0][1], []);

  // add
  const addRes = fakeRes();
  await routes['dashboard/todos/add']({ method: 'POST', body: { content: '写测试' } }, addRes, next);
  assert.equal(addRes.calls[0][0], 'done');
  const added = addRes.calls[0][1];
  assert.equal(added.content, '写测试');
  assert.equal(added.completed, false);

  // list
  const listRes = fakeRes();
  await routes['dashboard/todos/list']({}, listRes, next);
  assert.deepEqual(listRes.calls[0][1], [added]);

  // toggle
  const toggleRes = fakeRes();
  await routes['dashboard/todos/toggle/:id']({ method: 'PUT', params: { id: added.id } }, toggleRes, next);
  assert.equal(toggleRes.calls[0][1].completed, true);

  // delete
  const delRes = fakeRes();
  await routes['dashboard/todos/delete/:id']({ method: 'DELETE', params: { id: added.id } }, delRes, next);
  assert.deepEqual(delRes.calls[0][1], { success: true, message: '删除成功' });

  // 持久化断言：settings 表 type:'todos' doc 的 items 已被清空
  const doc = await findOne(settingsDb, { type: 'todos' });
  assert.ok(doc);
  assert.deepEqual(doc.items, []);

  // 无 fs 落盘
  assert.equal(fs.existsSync(path.join(base_dir, 'todos.json')), false);
  assert.deepEqual(fs.readdirSync(base_dir), []);
});

test('visit/stats 从 settings 表读 visitHistory（type:visit-stats），不读 visit_stats.json', async () => {
  const settingsDb = await makeSettingsDb();
  await insert(settingsDb, { type: 'visit-stats', items: [{ date: '2026-01-01', pv: 10, uv: 5 }] });

  const base_dir = makeBaseDir();
  const hexo = {
    base_dir,
    config: { url: 'http://example.com' },
    theme: { config: { busuanzi: true } },
  };
  const routes = collectRoutes(dashboardApi, hexo, { settingsDb });

  const originalGet = axios.get;
  axios.get = async () => ({ data: '<html></html>' });
  try {
    const res = fakeRes();
    await routes['dashboard/visit/stats']({}, res, () => {});
    assert.equal(res.calls[0][0], 'done');
    assert.deepEqual(res.calls[0][1].visitHistory, [{ date: '2026-01-01', pv: 10, uv: 5 }]);
  } finally {
    axios.get = originalGet;
  }

  assert.equal(fs.existsSync(path.join(base_dir, 'visit_stats.json')), false);
  assert.deepEqual(fs.readdirSync(base_dir), []);
});

test('visit/stats 无 visit-stats doc 返回空数组', async () => {
  const settingsDb = await makeSettingsDb();
  const base_dir = makeBaseDir();
  const hexo = {
    base_dir,
    config: { url: 'http://example.com' },
    theme: { config: { busuanzi: true } },
  };
  const routes = collectRoutes(dashboardApi, hexo, { settingsDb });

  const originalGet = axios.get;
  axios.get = async () => ({ data: '<html></html>' });
  try {
    const res = fakeRes();
    await routes['dashboard/visit/stats']({}, res, () => {});
    assert.deepEqual(res.calls[0][1].visitHistory, []);
  } finally {
    axios.get = originalGet;
  }
});

test('settings/list 从 settings 表读 admin-config（YAML content）', async () => {
  const settingsDb = await makeSettingsDb();
  await insert(settingsDb, { type: 'admin-config', content: 'title: MySite\nsubtitle: Hi\n' });

  const base_dir = makeBaseDir();
  const hexo = {
    base_dir,
    store: { models: { Post: { toArray: () => [] }, Page: { toArray: () => [] } } },
  };
  const routes = collectRoutes(postApi, hexo, { settingsDb });

  const res = fakeRes();
  await routes['settings/list']({}, res, () => {});
  assert.equal(res.calls[0][0], 'done');
  assert.deepEqual(res.calls[0][1], { title: 'MySite', subtitle: 'Hi' });

  assert.equal(fs.existsSync(path.join(base_dir, '_admin-config.yml')), false);
  assert.deepEqual(fs.readdirSync(base_dir), []);
});

test('settings/list 无 admin-config doc 返回 {}', async () => {
  const settingsDb = await makeSettingsDb();
  const base_dir = makeBaseDir();
  const hexo = {
    base_dir,
    store: { models: { Post: { toArray: () => [] }, Page: { toArray: () => [] } } },
  };
  const routes = collectRoutes(postApi, hexo, { settingsDb });

  const res = fakeRes();
  await routes['settings/list']({}, res, () => {});
  assert.deepEqual(res.calls[0][1], {});
});

test('blog/search 由 store.models 现算 blogInfoList（含草稿过滤），不读 blogInfoList.json', async () => {
  const settingsDb = await makeSettingsDb();
  const base_dir = makeBaseDir();
  const hexo = {
    base_dir,
    store: {
      models: {
        Post: { toArray: () => [
          { title: 'Hello World', content: '<p>hello world</p>', published: true, permalink: '/hello/' },
          { title: 'Secret Draft', content: '<p>draft body</p>', published: false, permalink: '/draft/' },
        ] },
        Page: { toArray: () => [
          { title: 'About', content: '<p>about me</p>', permalink: '/about/' },
        ] },
      },
    },
  };
  const routes = collectRoutes(postApi, hexo, { settingsDb });

  // includeDraft 默认 true：命中 Hello World
  const resAll = fakeRes();
  await routes['blog/search']({ body: { searchPattern: 'world', includeDraft: true } }, resAll, () => {});
  assert.equal(resAll.calls[0][0], 'done');
  assert.equal(resAll.calls[0][1].code, 0);
  const dataAll = resAll.calls[0][1].data;
  assert.equal(dataAll.length, 1);
  assert.equal(dataAll[0].permalink, '/hello/');
  assert.equal(dataAll[0].isPage, false);
  assert.equal(dataAll[0].isDraft, false);

  // includeDraft false：草稿（isDraft true）被过滤
  const resNoDraft = fakeRes();
  await routes['blog/search']({ body: { searchPattern: 'draft', includeDraft: false } }, resNoDraft, () => {});
  assert.equal(resNoDraft.calls[0][1].code, 0);
  assert.equal(resNoDraft.calls[0][1].data.length, 0, 'includeDraft=false 应过滤草稿');

  assert.equal(fs.existsSync(path.join(base_dir, 'blogInfoList.json')), false);
  assert.deepEqual(fs.readdirSync(base_dir), []);
});
