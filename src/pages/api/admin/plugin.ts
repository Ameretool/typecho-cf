/**
 * Plugin management API
 * POST: Activate/deactivate a plugin
 */
import type { APIRoute } from 'astro';
import { setOption, deleteOption } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { pluginExists, parseActivatedPlugins, setActivatedPlugins, getAvailablePlugins, pluginHasConfig, getPluginConfigDefaults } from '@/lib/plugin';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';
import { jsonError, jsonOk } from '@/lib/http';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { readBoundedJson } from '@/lib/input';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) {
    return jsonError(auth.status === 401 ? 401 : 403, '权限不足');
  }

  try {
    const body = await readBoundedJson(request, REQUEST_BODY_LIMITS.adminForm) as { plugin?: string; action?: string };
    const pluginId = body.plugin;
    const action = body.action; // 'activate' or 'deactivate'

    if (!pluginId || typeof pluginId !== 'string') {
      return jsonError(400, '请指定插件标识');
    }

    if (action !== 'activate' && action !== 'deactivate') {
      return jsonError(400, '无效的操作，请使用 activate 或 deactivate');
    }

    if (!pluginExists(pluginId)) {
      return jsonError(404, `插件 "${pluginId}" 不存在，请先通过 npm 安装`);
    }

    // Get current activated list
    const currentIds = parseActivatedPlugins(auth.options.activatedPlugins as string | undefined);
    const idSet = new Set(currentIds);

    if (action === 'activate') {
      idSet.add(pluginId);

      // Save default config on activation (like PHP Typecho)
      if (pluginHasConfig(pluginId)) {
        const defaults = getPluginConfigDefaults(pluginId);
        if (Object.keys(defaults).length > 0) {
          const existing = auth.options[`plugin:${pluginId}`];
          if (!existing) {
            await setOption(auth.db, `plugin:${pluginId}`, JSON.stringify(defaults));
          }
        }
      }
    } else {
      idSet.delete(pluginId);

      // Delete plugin config on deactivation
      await deleteOption(auth.db, `plugin:${pluginId}`);
    }

    // Save to DB and update runtime state
    const newIds = Array.from(idSet);
    await setActivatedPlugins(auth.pluginCtx, newIds);
    await setOption(auth.db, 'activatedPlugins', JSON.stringify(newIds));

    // Plugin changes affect page rendering
    await bumpCacheVersion(auth.db);
    await purgeSiteCache(auth.options.siteUrl || '');

    return jsonOk({
      success: true,
      message: action === 'activate' ? `插件 "${pluginId}" 已启用` : `插件 "${pluginId}" 已禁用`,
      plugin: pluginId,
      action,
      activatedPlugins: newIds,
    });
  } catch (err) {
    return jsonError(400, '请求格式错误');
  }
};

/**
 * GET: List all available plugins and their activation status
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator', { csrf: false, plugins: true });
  if (isAdminActionResponse(auth)) {
    return jsonError(auth.status === 401 ? 401 : 403, '权限不足');
  }

  const activatedIds = parseActivatedPlugins(auth.options.activatedPlugins as string | undefined);
  const plugins = getAvailablePlugins(auth.pluginCtx);

  return jsonOk({
    plugins: plugins.map(p => ({
      id: p.id,
      name: p.manifest.name,
      description: p.manifest.description,
      author: p.manifest.author,
      version: p.manifest.version,
      homepage: p.manifest.homepage,
      isActive: p.isActive,
      packageName: p.packageName,
    })),
    activatedPlugins: activatedIds,
  });
};
