'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const databaseManager = require('../lib/db');

function promisify(db, method, ...args) {
  return new Promise((resolve, reject) => {
    db[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

beforeEach(() => {
  databaseManager.reset();
});

test('ensureInitialUser 导入初始管理员用户与 JWT secret', async () => {
  const db = await databaseManager.initialize({ config: {} });
  await databaseManager.ensureInitialUser({
    hexo_pro: { username: 'admin', password: 'pw', secret: 's3cret' }
  });

  const userCount = await promisify(db.userDb, 'count', {});
  assert.equal(userCount, 1);

  const users = await promisify(db.userDb, 'find', {});
  assert.equal(users[0].username, 'admin');

  const settings = await promisify(db.settingsDb, 'findOne', { type: 'system' });
  assert.equal(settings.jwtSecret, 's3cret');
});

test('ensureInitialUser 幂等：重复调用不重复导入', async () => {
  const db = await databaseManager.initialize({ config: {} });
  const cfg = { hexo_pro: { username: 'admin', password: 'pw', secret: 's3cret' } };
  await databaseManager.ensureInitialUser(cfg);
  await databaseManager.ensureInitialUser(cfg);

  const userCount = await promisify(db.userDb, 'count', {});
  assert.equal(userCount, 1);
});
