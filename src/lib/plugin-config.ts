import type { AdminActionContext } from '@/lib/admin-auth';
import { purgeSiteCache } from '@/lib/cache';
import { PLUGIN_CONFIG_TIMEOUT_MS } from '@/lib/constants';
import { setOption, type SiteOptions } from '@/lib/options';
import {
  applyFilter,
  getPlugin,
  getPluginConfigDefaults,
  isPluginActive,
  loadPluginConfig,
  parsePluginConfigFormData,
  pluginHasConfig,
  PLUGIN_CONFIG_ROW_ID,
  type PluginConfigField,
} from '@/lib/plugin';
import { withTimeout } from '@/lib/timeout';

export const PLUGIN_CONFIG_SECRET_PLACEHOLDER = '__PLUGIN_CONFIG_SECRET__';
export { PLUGIN_CONFIG_ROW_ID };

export class PluginConfigurationError extends Error {
  constructor(
    public readonly code: 'not_found' | 'inactive' | 'invalid' | 'validation_failed',
    message: string,
    public readonly status: 400 | 404 = code === 'not_found' ? 404 : 400,
  ) {
    super(message);
    this.name = 'PluginConfigurationError';
  }
}

export interface PluginConfigurationView {
  plugin: string;
  name: string;
  fields: Record<string, PluginConfigField>;
  values: Record<string, unknown>;
}

export interface PluginConfigurationSaveInput {
  pluginId: string;
  settings: Record<string, unknown> | FormData;
  request: Request;
}

export interface PluginConfigurationSaveResult {
  success: true;
  message: string;
  plugin: string;
  settings: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSecretField(field: PluginConfigField): boolean {
  return field.type === 'password' || field.type === 'hidden';
}

function maskValue(field: PluginConfigField, value: unknown): unknown {
  if (isSecretField(field)) {
    return value === null || value === undefined || String(value).length === 0
      ? ''
      : PLUGIN_CONFIG_SECRET_PLACEHOLDER;
  }
  if (field.type !== 'repeatable' || !Array.isArray(value)) return value;
  const itemFields = field.itemFields || {};
  return value.map((row, index) => {
    if (!isRecord(row)) return {};
    const masked: Record<string, unknown> = { [PLUGIN_CONFIG_ROW_ID]: String(index) };
    for (const [key, itemField] of Object.entries(itemFields)) {
      masked[key] = maskValue(itemField, row[key]);
    }
    return masked;
  });
}

function maskValues(
  fields: Record<string, PluginConfigField>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    masked[key] = maskValue(field, values[key]);
  }
  return masked;
}

function maskFieldDefinition(field: PluginConfigField): PluginConfigField {
  const masked: PluginConfigField = { ...field };
  if (isSecretField(field) && field.default !== undefined) {
    masked.default = field.default === '' ? '' : PLUGIN_CONFIG_SECRET_PLACEHOLDER;
  }
  if (field.itemFields) {
    masked.itemFields = Object.fromEntries(
      Object.entries(field.itemFields).map(([key, item]) => [key, maskFieldDefinition(item)]),
    );
  }
  return masked;
}

function maskedDefinitions(fields: Record<string, PluginConfigField>): Record<string, PluginConfigField> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, maskFieldDefinition(field)]),
  );
}

function sanitizeValue(field: PluginConfigField, value: unknown): unknown {
  if (field.type !== 'repeatable') return value;
  if (!Array.isArray(value)) return [];
  const itemFields = field.itemFields || {};
  return value.filter(isRecord).map((row) => {
    const clean: Record<string, unknown> = {};
    if (typeof row[PLUGIN_CONFIG_ROW_ID] === 'string' && /^\d+$/.test(row[PLUGIN_CONFIG_ROW_ID])) {
      clean[PLUGIN_CONFIG_ROW_ID] = row[PLUGIN_CONFIG_ROW_ID];
    }
    for (const [key, itemField] of Object.entries(itemFields)) {
      if (Object.hasOwn(row, key)) clean[key] = sanitizeValue(itemField, row[key]);
      else if (itemField.default !== undefined) clean[key] = itemField.default;
      else clean[key] = itemField.type === 'checkbox' || itemField.type === 'repeatable' ? [] : '';
    }
    return clean;
  });
}

function allowlistSettings(
  fields: Record<string, PluginConfigField>,
  incoming: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    clean[key] = sanitizeValue(field, Object.hasOwn(incoming, key) ? incoming[key] : defaults[key]);
  }
  return clean;
}

function restoreValue(field: PluginConfigField, incoming: unknown, previous: unknown): unknown {
  if (isSecretField(field) && incoming === PLUGIN_CONFIG_SECRET_PLACEHOLDER) return previous ?? '';
  if (field.type !== 'repeatable' || !Array.isArray(incoming)) return incoming;
  const previousRows = Array.isArray(previous) ? previous : [];
  const itemFields = field.itemFields || {};
  return incoming.map((row, index) => {
    if (!isRecord(row)) return {};
    const submittedRowId = row[PLUGIN_CONFIG_ROW_ID];
    const previousIndex = typeof submittedRowId === 'string' && /^\d+$/.test(submittedRowId)
      ? Number(submittedRowId)
      : index;
    const previousRow = Number.isSafeInteger(previousIndex) && isRecord(previousRows[previousIndex])
      ? previousRows[previousIndex]
      : {};
    const restored: Record<string, unknown> = {};
    for (const [key, itemField] of Object.entries(itemFields)) {
      restored[key] = restoreValue(itemField, row[key], previousRow[key]);
    }
    return restored;
  });
}

function restoreSecrets(
  fields: Record<string, PluginConfigField>,
  incoming: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const restored: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    restored[key] = restoreValue(field, incoming[key], previous[key]);
  }
  return restored;
}

function getDefinition(pluginId: string) {
  const plugin = getPlugin(pluginId);
  if (!plugin || !pluginHasConfig(pluginId) || !plugin.manifest.config) {
    throw new PluginConfigurationError('not_found', '插件不存在或无配置项');
  }
  return { plugin, fields: plugin.manifest.config };
}

export function getPluginConfigurationView(
  options: SiteOptions | Record<string, unknown>,
  pluginId: string,
): PluginConfigurationView {
  const { plugin, fields } = getDefinition(pluginId);
  const values = loadPluginConfig(options, pluginId);
  return {
    plugin: pluginId,
    name: plugin.manifest.name,
    fields: maskedDefinitions(fields),
    values: maskValues(fields, values),
  };
}

export async function savePluginConfiguration(
  auth: AdminActionContext,
  input: PluginConfigurationSaveInput,
): Promise<PluginConfigurationSaveResult> {
  const pluginId = input.pluginId.trim();
  if (!pluginId) throw new PluginConfigurationError('invalid', '请指定插件标识');
  const { fields } = getDefinition(pluginId);
  if (!isPluginActive(auth.pluginCtx, pluginId)) {
    throw new PluginConfigurationError('inactive', '请先启用插件');
  }

  const submitted = input.settings instanceof FormData
    ? parsePluginConfigFormData(fields, input.settings)
    : input.settings;
  if (!isRecord(submitted)) {
    throw new PluginConfigurationError('invalid', '请提供配置数据');
  }

  const defaults = getPluginConfigDefaults(pluginId);
  const previous = loadPluginConfig(auth.options, pluginId);
  const sanitized = allowlistSettings(fields, submitted, defaults);
  const restored = restoreSecrets(fields, sanitized, previous);

  let validation: { success?: boolean; settings?: Record<string, unknown>; error?: string };
  try {
    validation = await withTimeout(
      applyFilter(auth.pluginCtx, 'plugin:config:beforeSave', {
        success: true,
        settings: restored,
      }, {
        pluginId,
        settings: restored,
        db: auth.db,
        options: auth.options,
        user: auth.user,
        request: input.request,
      }),
      PLUGIN_CONFIG_TIMEOUT_MS,
      '插件配置校验超时，请稍后重试',
    );
  } catch (error) {
    throw new PluginConfigurationError(
      'validation_failed',
      error instanceof Error ? error.message : '插件配置校验失败',
    );
  }

  if (!validation?.success) {
    throw new PluginConfigurationError(
      'validation_failed',
      validation?.error || '插件配置校验失败',
    );
  }

  const validatedInput = isRecord(validation.settings) ? validation.settings : restored;
  const finalAllowed = allowlistSettings(fields, validatedInput, restored);
  const finalSettings = restoreSecrets(fields, finalAllowed, previous);
  await setOption(auth.db, `plugin:${pluginId}`, JSON.stringify(finalSettings));
  await purgeSiteCache(auth.options.siteUrl || '');

  return {
    success: true,
    message: '插件设置已经保存',
    plugin: pluginId,
    settings: maskValues(fields, finalSettings),
  };
}
