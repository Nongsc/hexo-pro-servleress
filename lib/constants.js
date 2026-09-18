'use strict';

/**
 * A minimal, faithful subset of hexo's default_config. The real hexo reads
 * `hexo/dist/hexo/default_config`; we inline only the keys the backend and
 * content-indexer actually rely on (everything else comes from _config.yml).
 */

module.exports = {
  root: '/',
  url: 'http://example.com',
  permalink: ':year/:month/:day/:title/',
  permalink_defaults: null,
  pretty_urls: {
    trailing_index: true,
    trailing_html: true
  },
  default_category: 'uncategorized',
  default_layout: 'post',
  new_post_name: ':title.md',
  filename_case: 0,
  render_drafts: false,
  post_asset_folder: false,
  relative_link: false,
  future: true,
  highlight: {
    enable: false
  },
  category_map: {},
  tag_map: {},
  timezone: '',
  languages: [],
  metadata: {},
  date_format: 'YYYY-MM-DD',
  time_format: 'HH:mm:ss',
  updated_option: 'mtime',
  author: '',
  theme: 'landscape',
  theme_config: {},
  skip_render: [],
  titlecase: false,
  external_link: {
    enable: true,
    field: 'site',
    exclude: ''
  },
  hexo_pro: {}
};
