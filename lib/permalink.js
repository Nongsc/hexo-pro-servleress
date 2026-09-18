'use strict';

const path = require('path');
const moment = require('moment');
const { Permalink, slugize, createSha1Hash, full_url_for } = require('hexo-util');

/**
 * Faithful port of hexo's `post_permalink` filter and the Post/Page `permalink`
 * virtual getter. Produces the exact same URL string hexo would, so the client's
 * base64(permalink) ids round-trip unchanged.
 */

let permalinkCache = null;

function postPath(config, data) {
  const { _id, id, slug, title, date, __permalink } = data;

  // front-matter `permalink` wins; ensure leading slash (mirrors hexo).
  if (__permalink) {
    return __permalink.startsWith('/') ? __permalink : `/${__permalink}`;
  }

  const d = date ? moment(date) : null;

  const hash = slug && d
    ? createSha1Hash().update(slug + d.unix().toString()).digest('hex').slice(0, 12)
    : null;

  const meta = {
    id: id || _id,
    title: slug,
    name: typeof slug === 'string' ? path.basename(slug) : '',
    post_title: slugize(title, { transform: 1 }),
    year: d ? d.format('YYYY') : '',
    month: d ? d.format('MM') : '',
    day: d ? d.format('DD') : '',
    hour: d ? d.format('HH') : '',
    minute: d ? d.format('mm') : '',
    second: d ? d.format('ss') : '',
    i_month: d ? d.format('M') : '',
    i_day: d ? d.format('D') : '',
    hash,
    category: config.default_category
  };

  if (!permalinkCache || permalinkCache.rule !== config.permalink) {
    permalinkCache = new Permalink(config.permalink, {});
  }

  const { categories } = data;
  if (categories && categories.length) {
    const last = categories[categories.length - 1];
    meta.category = last.slug || last.name || config.default_category;
  }

  // Copy any remaining keys (e.g. custom permalink variables from front-matter).
  Object.keys(data).forEach(key => {
    if (Object.prototype.hasOwnProperty.call(meta, key)) return;
    meta[key] = data[key];
  });

  if (config.permalink_defaults) {
    Object.keys(config.permalink_defaults).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(meta, key)) return;
      meta[key] = config.permalink_defaults[key];
    });
  }

  return permalinkCache.stringify(meta);
}

// Post.permalink / Page.permalink = full_url_for.call(ctx, path)
function permalink(config, pathValue) {
  return full_url_for.call({ config }, pathValue);
}

function postPermalink(config, data) {
  return permalink(config, postPath(config, data));
}

function pagePermalink(config, pagePath) {
  return permalink(config, pagePath);
}

module.exports = {
  postPath,
  postPermalink,
  pagePermalink,
  permalink
};
