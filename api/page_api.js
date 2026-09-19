var url = require('url')
var yml = require('js-yaml')
var updateAny = require('./update'),
    update = updateAny.bind(null, 'Page')
const _ = require('lodash')
var hfm = require('hexo-front-matter')

const utils = require('./utils');
const { parsePage } = require('../lib/content-store');

module.exports = function (app, hexo, use) {
    function addIsDraft(post) {
        post.isDraft = post?.source && post?.source.indexOf('_draft') === 0 || false
        post.isDiscarded = post?.source && post?.source.indexOf('_discarded') === 0 || false
        post.updated = formatDateTime(post.updated)
        post.date = formatDateTime(post.date)
        return post
    }

    function addFormatDateTime(page) {
        // page.isDiscarded = page.source && page.source.indexOf('_discarded') === 0
        page.updated = formatDateTime(page.updated)
        page.date = formatDateTime(page.date)
        return page
    }

    function formatDateTime(dateString) {
        const date = new Date(dateString);

        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }
    async function remove(id, body, res) {
        id = utils.base64Decode(id)
        var page = hexo.store.findByPermalink(id)
        if (!page) return res.send(404, "Post not found")
        page = _.cloneDeep(page)

        await hexo.store.remove(id)

        // 写入回收站记录
        try {
            const databaseManager = require('../lib/db');
            if (databaseManager && databaseManager.isReady()) {
                const { recycleDb } = databaseManager.getDatabases();
                if (recycleDb) {
                    recycleDb.insert({
                        type: 'page',
                        title: page.title,
                        permalink: page.permalink,
                        originalSource: page.source,
                        raw: page.raw,
                        discardedPath: null,
                        isDraft: false,
                        deletedAt: new Date(),
                    }, function () { });
                }
            }
        } catch (_) { }

        if (hexo.github) {
            await hexo.github.deleteFile('source/' + page.source, `Hexo Pro: remove ${page.source}`);
        }

        res.done(addIsDraft(page))
    }

    async function createPageManually(req, res) {
        if (!req.body) {
            return res.send(400, 'No page body given');
        }

        const requestedTitle = String(req.body.title || '').trim();
        if (!requestedTitle) {
            return res.send(400, 'No title given');
        }

        try {
            // 循环生成唯一标题，避免重试时时间戳冲突导致创建失败
            let title = requestedTitle;
            let attempt = 0;

            while (hexo.store.models.Page.find(d => d.source === `${title}/index.md`).length > 0) {
                const suffix = `${Date.now()}${attempt ? `-${attempt}` : ''}`;
                title = `${requestedTitle}${suffix}`;
                attempt += 1;
                if (attempt > 1000) {
                    throw new Error('Failed to generate unique page filename');
                }
            }

            const frontMatter = {
                title: title,
                layout: 'page',
                date: new Date(),
                updated: new Date(),
            };
            const pageContent = hfm.stringify(frontMatter);

            const source = `${title}/index.md`;
            const page = parsePage(pageContent, source, hexo.config);
            const saved = await hexo.store.upsert(page);

            if (hexo.github) {
                await hexo.github.writeFile(`source/${source}`, pageContent, `Hexo Pro: create page ${source}`);
            }

            if (title !== requestedTitle) {
                saved.titleChanged = true;
                saved.originalTitle = requestedTitle;
            }

            return res.done(addFormatDateTime(saved));
        } catch (e) {
            console.error(e);
            return res.send(500, e?.message || 'Failed to create page');
        }
    }

    // 检查页面是否存在
    use('pages/check-exists', function (req, res, next) {
        if (req.method !== 'GET') return next();

        const parsedUrl = url.parse(req.url, true);
        const queryParams = parsedUrl.query;
        const { path: pagePath } = queryParams;  // 将参数名改为 pagePath

        if (!pagePath) {
            return res.send(400, 'No path provided');
        }

        const exists = hexo.store.models.Page.find(d => d.source === pagePath).length > 0;

        return res.done({ exists });
    });

    use('pages/list', function (req, res) {
        const parsedUrl = url.parse(req.url, true);
        const queryParams = parsedUrl.query;
        const { deleted, page = 1, pageSize = 12 } = queryParams;

        var pageModel = hexo.model('Page');
        let pages = pageModel.toArray()
            .map(page => {
                const { site, raw, content, _content, more, ...rest } = page;
                return rest;
            })
            .map(addIsDraft);

        if (deleted == 'false') {
            pages = pages.filter(page => page.isDiscarded == false);
        }

        // 排序逻辑
        var sortedList = pages.sort(function (a, b) {
            return new Date(b.date) - new Date(a.date);
        });

        // 分页处理
        const total = sortedList.length;
        const startIndex = (Math.max(parseInt(page), 1) - 1) * parseInt(pageSize);
        const endIndex = startIndex + parseInt(pageSize);
        const paginatedData = sortedList.slice(startIndex, endIndex);

        res.done({
            total: total,
            data: paginatedData
        });
    });

    use('pages/new', function (req, res, next) {
        if (req.method !== 'POST') return next();
        createPageManually(req, res);
    });

    use('pages/:id', function (req, res, next) {
        var id = req.params.id
        if (id === 'pages' || !id) return next()
        if (req.method === 'GET') {
            id = utils.base64Decode(id)
            var page = hexo.model('Page').filter(p => p.permalink === id)
            if (!page) return next()
            page = page.data[0]
            return res.done(addIsDraft(page))
        }

        if (!req.body) {
            return res.send(400, 'No page body given');
        }

        id = req.body._id

        update(id, req.body.update, function (err, page) {
            if (err) {
                return res.send(400, err);
            }
            res.done({
                page: addIsDraft(page)
            })
        }, hexo);
    });

    use('pages/:id/:action', function (req, res, next) {
        const id = req.params.id
        const action = req.params.action

        if (action === 'remove') {
            return remove(id, req.body, res)
        }
        if (action === 'rename') {
            return rename(id, req.body, res)
        }
    });

    use('page/update', function (req, res, next) {

        if (!req.body) {
            return res.send(400, 'No page body given');
        }

        id = req.body._id

        update(id, req.body.update, function (err, page) {
            if (err) {
                return res.send(400, err);
            }
            res.done({
                page: addIsDraft(page)
            })
        }, hexo);
    });

    use('pageMeta/:id', function (req, res, next) {
        var id = req.params.id
        if (req.method === 'GET') {
            id = utils.base64Decode(id)
            var post = hexo.model('Page').filter(p => p.permalink === id).data[0]
            if (!post) next()
            var split = hfm.split(post.raw)
            var parsed = hfm.parse([split.data, '---'].join('\n'))
            const { title, author, date, _content, ...rest } = parsed
            if (typeof rest['categories'] === 'string') {
                rest['categories'] = [rest['categories']]
            }
            if (typeof rest['tags'] === 'string') {
                rest['tags'] = [rest['tags']]
            }
            if (!rest.tags) {
                rest.tags = []
            }
            if (!rest.categories) {
                rest.categories = []
            }
            const ans = {}
            ans.categories = rest.categories
            ans.tags = rest.tags
            const fm = {}
            Object.keys(rest).forEach((name) => {
                if (name == 'categories' || name == 'tags') {
                    return
                }
                fm[name] = rest[name]
            })
            ans.frontMatter = fm
            ans.source = post.source
            return res.done(ans)
        }
    })

    use('updatePageFrontMatter', function (req, res, next) {
        if (req.method !== 'POST') return next();
        if (!req.body) {
            return res.send(500, 'No post body given');
        }
        if (!req.body.permalink) {
            return res.send(500, 'No permalink given');
        }
        if (!req.body.key || !req.body.value) {
            return res.send(500, 'Key or value missing');
        }

        const permalink = req.body.permalink;
        const key = req.body.key;
        const value = req.body.value;

        // 构建更新对象
        const frontMatterUpdate = {};
        frontMatterUpdate[key] = value;

        // 使用update函数更新文章
        update(permalink, { frontMatter: frontMatterUpdate }, async function (err, post) {
            if (err) {
                return res.send(400, err);
            }
            post = _.cloneDeep(post);

            // 如果是更新标题，则同步重命名页面目录（<title>/index.md）：只改 DB source + GitHub 写新删旧
            if (key === 'title' && typeof value === 'string' && value.trim()) {
                try {
                    const oldSource = post.source;
                    const oldPermalink = post.permalink;
                    let newSource = `${value.trim()}/index.md`;
                    if (hexo.store.models.Page.find(d => d.source === newSource).length > 0) {
                        // 若已存在同名目录，添加时间戳避免冲突
                        newSource = `${value.trim()} (${Date.now()})/index.md`;
                    }
                    post.source = newSource;
                    // 重解析派生新 permalink，_id 随之更新；旧 permalink 记录已在上方移除
                    post._id = parsePage(post.raw, newSource, hexo.config)._id;
                    await hexo.store.remove(oldPermalink);
                    const saved = await hexo.store.upsert(post);
                    if (hexo.github) {
                        await hexo.github.writeFile('source/' + newSource, post.raw, `Hexo Pro: rename page ${newSource}`);
                        await hexo.github.deleteFile('source/' + oldSource, `Hexo Pro: rename page ${oldSource}`);
                    }
                    return res.done(addIsDraft(saved));
                } catch (e) {
                    // 如果目录重命名失败，不影响标题更新
                    console.warn('[Pages API] 重命名页面目录失败:', e && e.message);
                }
            }

            res.done(addIsDraft(post));
        }, hexo);
    });

}
