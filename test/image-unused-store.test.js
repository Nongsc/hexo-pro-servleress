'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const imageApi = require('../api/image_api');

// 触发一次导出函数体，挂载 collectReferencedImageKeys 供单测直接调用
imageApi({}, {}, () => {}, {});

const config = { type: 'local', customPath: 'images', aliyun: {}, qiniu: {}, tencent: {} };

function makeModel(docs) {
  return { toArray: () => docs.slice() };
}

// 构造假的 hexo：只有 store.models.Post/Page，没有 upload_dir/_posts/_drafts
function makeHexo({ posts = [], pages = [], url = 'https://example.com' } = {}) {
  return {
    config: { url },
    store: { models: { Post: makeModel(posts), Page: makeModel(pages) } },
  };
}

test('从 store(DB) 读引用：Post 正文中的 images/foo.png 被识别，且不依赖本地源目录', async () => {
  const hexo = makeHexo({
    posts: [{ raw: '---\ntitle: t\n---\n![x](images/foo.png)\n', content: '<p>x</p>', published: true }],
  });
  // hexo 上没有 upload_dir/_posts/_drafts，证明扫描不再碰本地源目录
  assert.equal(hexo.upload_dir, undefined, '不构造本地源目录');

  const referenced = await imageApi.collectReferencedImageKeys(hexo, config, 'local', { includeDrafts: true });

  assert.ok(referenced instanceof Set, '返回 Set');
  assert.ok(referenced.has('images/foo.png'), '应包含 images/foo.png');
});

test('includeDrafts:false 时跳过草稿 Post，true 时纳入', async () => {
  const posts = [
    { raw: '---\ntitle: a\n---\n![x](images/pub.png)\n', published: true },
    { raw: '---\ntitle: b\n---\n![x](images/draft.png)\n', published: false },
  ];

  const hexoNoDraft = makeHexo({ posts });
  const refsNoDraft = await imageApi.collectReferencedImageKeys(hexoNoDraft, config, 'local', { includeDrafts: false });
  assert.ok(refsNoDraft.has('images/pub.png'), '发布态 Post 应被纳入');
  assert.ok(!refsNoDraft.has('images/draft.png'), '草稿 Post 应被排除');

  const hexoWithDraft = makeHexo({ posts });
  const refsWithDraft = await imageApi.collectReferencedImageKeys(hexoWithDraft, config, 'local', { includeDrafts: true });
  assert.ok(refsWithDraft.has('images/draft.png'), 'includeDrafts:true 时草稿应被纳入');
});

test('Page 始终纳入，不受 includeDrafts 影响', async () => {
  const pages = [{ raw: '---\ntitle: about\n---\n![x](images/page.png)\n' }];
  const hexo = makeHexo({ pages });

  const refs = await imageApi.collectReferencedImageKeys(hexo, config, 'local', { includeDrafts: false });
  assert.ok(refs.has('images/page.png'), 'Page 在 includeDrafts:false 下仍应纳入');
});

test('raw 缺失时回退到 content', async () => {
  const hexo = makeHexo({
    posts: [{ content: '<img src="images/from-content.png">', published: true }],
  });
  const refs = await imageApi.collectReferencedImageKeys(hexo, config, 'local', { includeDrafts: true });
  assert.ok(refs.has('images/from-content.png'), 'content 中的引用应被识别');
});

test('hexo.store 或 models 缺失时返回空集合，不抛 TypeError', async () => {
  const noStore = await imageApi.collectReferencedImageKeys({ config: { url: 'https://example.com' } }, config, 'local', { includeDrafts: true });
  assert.ok(noStore instanceof Set, '返回 Set');
  assert.equal(noStore.size, 0, '无 store 返回空集合');

  const noModels = await imageApi.collectReferencedImageKeys({ config: { url: 'https://example.com' }, store: {} }, config, 'local', { includeDrafts: true });
  assert.equal(noModels.size, 0, '无 models 返回空集合');
});
