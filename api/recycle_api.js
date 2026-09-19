const path = require('path');
const hfm = require('hexo-front-matter');
const { parsePost, parsePage } = require('../lib/content-store');

module.exports = function (app, hexo, use, db) {
    const recycleDb = db && db.recycleDb;

    function formatDateTime(date) {
        const d = new Date(date);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const seconds = String(d.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    // 列表
    use('recycle/list', function (req, res) {
        try {
            const parsedUrl = new URL(req.url, hexo.config.url || 'http://localhost');
            const type = parsedUrl.searchParams.get('type') || 'all';
            const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
            const pageSize = parseInt(parsedUrl.searchParams.get('pageSize') || '12', 10);
            const query = (parsedUrl.searchParams.get('query') || '').trim().toLowerCase();

            const filter = {};
            if (type !== 'all') filter.type = type;

            recycleDb.find(filter).sort({ deletedAt: -1 }).exec((err, docs) => {
                if (err) return res.send(500, '读取回收站失败');
                let items = docs || [];
                if (query) {
                    items = items.filter(it => {
                        const s = (it.title || it.originalSource || it.permalink || '').toLowerCase();
                        return s.includes(query);
                    });
                }
                const total = items.length;
                const startIndex = (Math.max(page, 1) - 1) * pageSize;
                const data = items.slice(startIndex, startIndex + pageSize);
                res.done({ total, data });
            });
        } catch (e) {
            console.error('[Recycle API] 列表失败:', e);
            return res.send(500, '列表失败: ' + e.message);
        }
    });

    // 统计
    use('recycle/stats', function (req, res) {
        try {
            recycleDb.find({}, (err, docs) => {
                if (err) return res.send(500, '统计失败');
                const total = docs.length;
                const posts = docs.filter(d => d.type === 'post').length;
                const pages = docs.filter(d => d.type === 'page').length;
                res.done({ total, posts, pages });
            });
        } catch (e) {
            console.error('[Recycle API] 统计失败:', e);
            return res.send(500, '统计失败: ' + e.message);
        }
    });

    // 还原
    use('recycle/restore', async function (req, res, next) {
        if (req.method !== 'POST') return next();
        const { id } = req.body || {};
        if (!id) return res.send(400, '缺少ID');
        recycleDb.findOne({ _id: id }, async (err, doc) => {
            if (err || !doc) return res.send(404, '未找到记录');
            try {
                const raw = doc.raw;
                const source = doc.originalSource;
                const isPage = doc.type === 'page';
                const published = doc.type === 'post' ? !doc.isDraft : undefined;
                const restoredSuffix = ` (restored ${Date.now()})`;

                let finalSource = source;
                let rawToWrite = raw;
                const exists = isPage
                    ? hexo.store.models.Page.find(d => d.source === source).length > 0
                    : hexo.store.models.Post.find(d => d.source === source).length > 0;
                if (exists) {
                    if (isPage) {
                        // 页面：重命名目录
                        const slash = source.lastIndexOf('/');
                        const dirPart = slash >= 0 ? source.slice(0, slash) : '';
                        const basePart = slash >= 0 ? source.slice(slash + 1) : source;
                        finalSource = `${dirPart}${restoredSuffix}/${basePart}`;
                    } else {
                        // 博客：重命名文件名
                        const ext = path.extname(source);
                        const base = path.basename(source, ext);
                        const dirRel = path.dirname(source);
                        finalSource = (dirRel && dirRel !== '.' ? dirRel + '/' : '') + `${base}${restoredSuffix}${ext}`;
                    }
                    // 标题追加后缀，避免重复
                    const split = hfm.split(raw || '');
                    const parsed = hfm.parse([split.data, '---'].join('\n'));
                    const oldTitle = parsed && typeof parsed.title === 'string' ? parsed.title : (doc.title || '');
                    parsed.title = oldTitle ? `${oldTitle}${restoredSuffix}` : `restored${restoredSuffix}`;
                    const fmStr = hfm.stringify(parsed);
                    rawToWrite = [fmStr, split.content || ''].join('\n');
                }

                const finalDoc = isPage
                    ? parsePage(rawToWrite, finalSource, hexo.config)
                    : parsePost(rawToWrite, finalSource, published, hexo.config);
                await hexo.store.upsert(finalDoc);
                if (hexo.github) {
                    await hexo.github.writeFile('source/' + finalSource, rawToWrite, `Hexo Pro: restore ${finalSource}`);
                }
                recycleDb.remove({ _id: id }, {}, () => {
                    return res.done({ success: true });
                });
            } catch (e) {
                console.error('[Recycle API] 还原失败:', e);
                return res.send(500, '还原失败: ' + e.message);
            }
        });
    });

    // 彻底删除
    use('recycle/delete', function (req, res, next) {
        if (req.method !== 'POST') return next();
        const { id } = req.body || {};
        if (!id) return res.send(400, '缺少ID');
        recycleDb.remove({ _id: id }, {}, (rmErr) => {
            if (rmErr) return res.send(500, '删除记录失败');
            return res.done({ success: true });
        });
    });

    // 清空
    use('recycle/empty', function (req, res, next) {
        if (req.method !== 'POST') return next();
        const { type, olderThanDays } = req.body || {};
        const days = Number.isFinite(olderThanDays) ? olderThanDays : null;
        const now = Date.now();
        const query = {};
        if (type && type !== 'all') query.type = type;
        recycleDb.find(query, (err, docs) => {
            if (err) return res.send(500, '清空失败');
            const toDelete = (docs || []).filter(d => {
                if (!days) return true;
                const t = new Date(d.deletedAt).getTime();
                return now - t >= days * 86400000;
            });
            const ids = toDelete.map(d => d._id);
            recycleDb.remove({ _id: { $in: ids } }, { multi: true }, (rmErr, numRemoved) => {
                if (rmErr) return res.send(500, '清空记录失败');
                res.done({ success: true, removed: numRemoved || 0 });
            });
        });
    });
}


