const { v4: uuidv4 } = require('uuid');
const { BUILTIN_THEMES } = require('./theme_api');

/**
 * 将受管文件路径映射为 siteConfig 的 type 键。
 * 仅 site / theme:{id} / templates 三类受管对象可读写，其余返回 null（暂不支持）。
 */
function resolveManagedType(filePath) {
  if (!filePath) return null;
  const p = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (p === '_config.yml' || p === '_config.yaml') return 'site';
  if (p === 'templates.json' || p === '_yaml_templates/templates.json') return 'templates';
  const m = p.match(/^_config\.([^/]+)\.ya?ml$/);
  if (m && m[1]) return `theme:${m[1]}`;
  return null;
}

/**
 * 读取模板数组（templates type 存 JSON 数组）。
 */
async function readTemplates(hexo) {
  const raw = await hexo.siteConfig.get('templates');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 写回模板数组。
 */
async function writeTemplates(hexo, templates) {
  await hexo.siteConfig.set('templates', JSON.stringify(templates, null, 2), {
    message: 'Hexo Pro: update templates',
  });
}

module.exports = function (app, hexo, use) {
  // 获取受管配置清单（site / theme:{id} / templates 三类）
  use('yaml/list', async function (req, res) {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;

    try {
      const managed = [];
      managed.push({
        name: '_config.yml',
        path: '_config.yml',
        type: 'site',
        content: await hexo.siteConfig.get('site'),
      });
      managed.push({
        name: 'templates.json',
        path: '_yaml_templates/templates.json',
        type: 'templates',
        content: await hexo.siteConfig.get('templates'),
      });
      for (const theme of BUILTIN_THEMES) {
        managed.push({
          name: `_config.${theme.id}.yml`,
          path: `_config.${theme.id}.yml`,
          type: `theme:${theme.id}`,
          content: await hexo.siteConfig.get(`theme:${theme.id}`),
        });
      }

      const total = managed.length;
      const startIndex = (page - 1) * pageSize;
      const endIndex = startIndex + pageSize;

      res.done({
        files: managed.slice(startIndex, endIndex),
        total,
        page,
        pageSize,
      });
    } catch (error) {
      hexo.log.error('获取 YAML 配置清单失败:', error);
      res.send(500, '获取 YAML 配置清单失败');
    }
  });

  // 创建 YAML 文件：无本地仓库可写任意文件，暂不支持
  use('yaml/create', function (req, res) {
    res.send(400, '暂不支持创建任意 YAML 文件（无本地内容仓库）');
  });

  // 更新 YAML 文件：仅受管对象走 siteConfig
  use('yaml/update', async function (req, res) {
    const { path: filePath, content } = req.body;

    if (!filePath) {
      return res.send(400, '文件路径不能为空');
    }

    const type = resolveManagedType(filePath);
    if (!type) {
      return res.send(400, '暂不支持：该路径不受管，仅支持 _config.yml / _config.<theme>.yml / templates.json');
    }

    try {
      await hexo.siteConfig.set(type, content || '', { message: `Hexo Pro: update ${type}` });
      res.done({ success: true, message: '文件保存成功。' });
    } catch (error) {
      hexo.log.error(`更新 YAML 文件 ${filePath} 时出错:`, error);
      res.send(500, '更新文件时出错');
    }
  });

  // 删除 YAML 文件：仅受管对象走 siteConfig（清空内容）
  use('yaml/delete', async function (req, res) {
    const { path: filePath } = req.body;

    if (!filePath) {
      return res.send(400, '文件路径不能为空');
    }

    const type = resolveManagedType(filePath);
    if (!type) {
      return res.send(400, '暂不支持：该路径不受管，仅支持 _config.yml / _config.<theme>.yml / templates.json');
    }

    try {
      await hexo.siteConfig.set(type, '', { message: `Hexo Pro: delete ${type}` });
      res.done({ success: true });
    } catch (error) {
      hexo.log.error(`删除 YAML 文件 ${filePath} 时出错:`, error);
      res.send(500, '删除文件时出错');
    }
  });

  // 获取模板列表
  use('yaml/templates', async function (req, res) {
    try {
      const templates = await readTemplates(hexo);
      res.done(templates);
    } catch (error) {
      hexo.log.error('获取模板列表失败:', error);
      res.send(500, '获取模板列表失败');
    }
  });

  // 创建模板
  use('yaml/template/create', async function (req, res) {
    const { name, description, structure, variables } = req.body;

    if (!name) {
      return res.send(400, '模板名称不能为空');
    }

    try {
      const templates = await readTemplates(hexo);
      const newTemplate = {
        id: uuidv4(),
        name,
        description: description || '',
        structure: structure || '',
        variables: variables || [],
        createdAt: new Date().toISOString(),
      };
      templates.push(newTemplate);
      await writeTemplates(hexo, templates);
      res.done(newTemplate);
    } catch (error) {
      hexo.log.error('创建模板失败:', error);
      res.send(500, '创建模板失败');
    }
  });

  // 更新模板
  use('yaml/templates/update', async function (req, res) {
    const { id, name, description, structure, variables } = req.body;

    if (!id || !name) {
      return res.send(400, '模板ID和名称不能为空');
    }

    try {
      const templates = await readTemplates(hexo);
      const templateIndex = templates.findIndex((t) => t.id === id);
      if (templateIndex === -1) {
        return res.send(404, '模板不存在');
      }

      templates[templateIndex] = {
        ...templates[templateIndex],
        name,
        description: description || '',
        structure: structure || '',
        variables: variables || [],
        updatedAt: new Date().toISOString(),
      };

      await writeTemplates(hexo, templates);
      res.done(templates[templateIndex]);
    } catch (error) {
      hexo.log.error('更新模板失败:', error);
      res.send(500, '更新模板失败');
    }
  });

  // 删除模板
  use('yaml/template/delete', async function (req, res) {
    const { id } = req.body;

    if (!id) {
      return res.send(400, '模板ID不能为空');
    }

    try {
      const templates = await readTemplates(hexo);
      const next = templates.filter((t) => t.id !== id);
      await writeTemplates(hexo, next);
      res.done({ success: true });
    } catch (error) {
      hexo.log.error('删除模板失败:', error);
      res.send(500, '删除模板失败');
    }
  });

  // 导入模板
  use('yaml/templates/import', async function (req, res) {
    const template = req.body;

    if (!template || !template.name) {
      return res.send(400, '模板数据无效');
    }

    try {
      const templates = await readTemplates(hexo);
      const existingTemplateIndex = templates.findIndex((t) => t.id === template.id);

      if (existingTemplateIndex !== -1) {
        templates[existingTemplateIndex] = {
          ...templates[existingTemplateIndex],
          name: template.name,
          description: template.description || '',
          structure: template.structure || '',
          variables: template.variables || [],
          updatedAt: new Date().toISOString(),
        };
      } else {
        const newTemplate = {
          id: template.id || uuidv4(),
          name: template.name,
          description: template.description || '',
          structure: template.structure || '',
          variables: template.variables || [],
          createdAt: new Date().toISOString(),
        };
        templates.push(newTemplate);
      }

      await writeTemplates(hexo, templates);
      res.done({ success: true });
    } catch (error) {
      hexo.log.error('导入模板失败:', error);
      res.send(500, '导入模板失败');
    }
  });

  // 应用模板：无本地仓库可写任意文件，暂不支持
  use('yaml/apply-template', function (req, res) {
    res.send(400, '暂不支持应用模板写入文件（无本地内容仓库）');
  });
};

// 供聚焦单元测试使用（不暴露给路由层）
module.exports._test = {
  resolveManagedType,
  readTemplates,
  writeTemplates,
};
