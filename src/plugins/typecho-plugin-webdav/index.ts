import { hasPermission, verifyPassword, registerPluginAdminPath } from 'typecho/plugin-sdk';
import type { PluginInitContext, PluginRouteResult } from 'typecho/plugin-sdk';
import type { Database } from 'typecho/db';
import { schema } from 'typecho/db';
import { eq } from 'drizzle-orm';
import { validateAuthToken, getAuthCookies, requireAdminCSRF } from '@/lib/auth';

type StorageProvider = 's3' | 'r2' | 'tianyi';

export interface WebDavConfig {
  routePath: string;
  protocolEnabled: boolean;
  mounts: StorageMount[];
  failBanEnabled: boolean;
  failBanMaxFailures: number;
  failBanWindowSeconds: number;
  failBanSeconds: number;
}

export interface StorageMount {
  mount: string;
  provider: StorageProvider;
  bindingName: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  pathStyle: boolean;
  appKey: string;
  appSecret: string;
  accessToken: string;
  rootDir: string;
}

interface WebDavRouteExtra {
  request?: Request;
  url?: URL;
  path?: string;
  db?: Database;
  options?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface ConfigValidationResult {
  success: boolean;
  settings?: Record<string, unknown>;
  error?: string;
}

interface S3Object {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
}

interface S3ListResult {
  objects: S3Object[];
  prefixes: string[];
}

interface AuthFailureState {
  failures: number;
  windowStartedAt: number;
  bannedUntil: number;
}

export const PLUGIN_ID = 'typecho-plugin-webdav';
const DEFAULT_ROUTE = '/webdav';
const LEGACY_DEFAULT_ROUTE = '/dav';
const DEFAULT_FAIL_BAN_ENABLED = true;
const DEFAULT_FAIL_BAN_MAX_FAILURES = 5;
const DEFAULT_FAIL_BAN_WINDOW_SECONDS = 300;
const DEFAULT_FAIL_BAN_SECONDS = 900;
const ALLOWED_METHODS = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE';
const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };
const authFailureStates = new Map<string, AuthFailureState>();

const DEFAULT_MOUNTS = `[
  {
    "mount": "/",
    "provider": "r2",
    "bindingName": "BUCKET",
    "prefix": ""
  }
]`;

export function readObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function readPluginSettings(options?: Record<string, unknown>): Record<string, unknown> {
  return readObject(options?.[`plugin:${PLUGIN_ID}`]);
}

export function normalizeRoutePath(value: unknown): string {
  const raw = String(value || DEFAULT_ROUTE).trim();
  if (!raw || raw === '/') return DEFAULT_ROUTE;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '') || DEFAULT_ROUTE;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizePrefix(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    if (value === '1') return true;
    if (value === '0') return false;
  }
  return fallback;
}

export function parseMounts(value: unknown): StorageMount[] {
  const source = value === undefined || value === null || (typeof value === 'string' && !value.trim())
    ? DEFAULT_MOUNTS
    : value;
  let parsed: unknown;
  if (typeof source === 'string') {
    parsed = JSON.parse(source);
  } else {
    parsed = source;
  }

  if (!Array.isArray(parsed)) {
    throw new Error('后端存储挂载必须是 JSON 数组');
  }
  if (parsed.length === 0) {
    throw new Error('至少配置一个后端存储挂载');
  }

  const seen = new Set<string>();
  return parsed.map((item, index): StorageMount => {
    if (!item || typeof item !== 'object') {
      throw new Error(`第 ${index + 1} 个挂载配置不是对象`);
    }

    const record = item as Record<string, unknown>;
    const rawMount = String(record.mount ?? '').trim();
    const mount = rawMount === '/' ? '' : rawMount.replace(/^\/+|\/+$/g, '');
    const provider = String(record.provider || 's3').toLowerCase() as StorageProvider;
    const bindingName = String(record.bindingName || record.binding || 'BUCKET').trim();
    const endpoint = String(record.endpoint || '').trim().replace(/\/+$/, '');
    const bucket = String(record.bucket || '').trim();
    const region = String(record.region || (provider === 'r2' ? 'auto' : 'us-east-1')).trim();
    const accessKeyId = String(record.accessKeyId || '').trim();
    const secretAccessKey = String(record.secretAccessKey || '');
    const prefix = normalizePrefix(record.prefix);
    const pathStyle = parseBoolean(record.pathStyle, provider === 'r2');

    if (mount === '' && parsed.length > 1) {
      throw new Error('根目录挂载不能与其他挂载共存');
    }
    if (mount && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(mount)) {
      throw new Error(`第 ${index + 1} 个挂载 mount 只能包含字母、数字、点、下划线和连字符`);
    }
    if (seen.has(mount)) {
      throw new Error(`挂载目录重复：${mount}`);
    }
    seen.add(mount);

    if (!['s3', 'r2', 'tianyi'].includes(provider)) {
      throw new Error(`挂载 ${mount} 的 provider 仅支持 s3、r2 或 tianyi`);
    }

    const appKey = String(record.appKey || '').trim();
    const appSecret = String(record.appSecret || '');
    const accessToken = String(record.accessToken || '').trim();
    const rootDir = String(record.rootDir || '-11').trim();

    if (provider === 'r2') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bindingName)) {
        throw new Error(`挂载 ${mount} 的 R2 绑定名格式不正确`);
      }
    } else if (provider === 'tianyi') {
      if (!accessToken && (!appKey || !appSecret)) {
        throw new Error(`挂载 ${mount} 的天翼云盘需要填写 accessToken 或 (appKey + appSecret)`);
      }
    } else {
      try {
        const url = new URL(endpoint);
        if (!['https:', 'http:'].includes(url.protocol)) {
          throw new Error('invalid protocol');
        }
      } catch {
        throw new Error(`挂载 ${mount} 的 endpoint 格式不正确`);
      }
      if (!bucket || !region || !accessKeyId || !secretAccessKey) {
        throw new Error(`挂载 ${mount} 需要填写 bucket、region、accessKeyId 和 secretAccessKey`);
      }
    }

    return {
      mount,
      provider,
      bindingName,
      endpoint,
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      prefix,
      pathStyle,
      appKey,
      appSecret,
      accessToken,
      rootDir,
    };
  });
}

export function resolveWebDavTarget(
  config: WebDavConfig,
  relativePath: string,
): { mount: StorageMount; key: string; rootMount: boolean } | null {
  const rootMount = config.mounts.find(item => item.mount === '');
  if (rootMount) {
    const segments = splitPath(relativePath);
    if (hasPathTraversal(segments)) return null;
    return {
      mount: rootMount,
      key: segments.join('/'),
      rootMount: true,
    };
  }

  const parts = splitPath(relativePath);
  if (hasPathTraversal(parts)) return null;
  const mountName = parts.shift() || '';
  if (!mountName) return null;

  const mount = config.mounts.find(item => item.mount === mountName);
  if (!mount) return null;

  return {
    mount,
    key: parts.join('/'),
    rootMount: false,
  };
}

export function normalizeConfig(settings?: Record<string, unknown>): WebDavConfig {
  return {
    routePath: normalizeRoutePath(settings?.routePath),
    protocolEnabled: parseBoolean(settings?.protocolEnabled, true),
    mounts: parseMounts(settings?.mounts),
    failBanEnabled: parseBoolean(settings?.failBanEnabled, DEFAULT_FAIL_BAN_ENABLED),
    failBanMaxFailures: normalizeInteger(settings?.failBanMaxFailures, DEFAULT_FAIL_BAN_MAX_FAILURES, 1, 100),
    failBanWindowSeconds: normalizeInteger(settings?.failBanWindowSeconds, DEFAULT_FAIL_BAN_WINDOW_SECONDS, 10, 86_400),
    failBanSeconds: normalizeInteger(settings?.failBanSeconds, DEFAULT_FAIL_BAN_SECONDS, 10, 86_400),
  };
}

export function getWebDavClientIp(request: Request): string {
  const forwarded = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-real-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]
    || '';
  const ip = forwarded.trim();
  return ip || 'unknown';
}

export function isWebDavClientBanned(config: WebDavConfig, ip: string, now = Date.now()): boolean {
  if (!config.failBanEnabled) return false;
  const state = authFailureStates.get(ip);
  if (!state) return false;
  if (state.bannedUntil > now) return true;
  if (state.bannedUntil > 0) {
    authFailureStates.delete(ip);
  }
  return false;
}

export function recordWebDavAuthFailure(config: WebDavConfig, ip: string, now = Date.now()): void {
  if (!config.failBanEnabled) return;
  const windowMs = config.failBanWindowSeconds * 1000;
  const banMs = config.failBanSeconds * 1000;
  const current = authFailureStates.get(ip);
  const state = !current || now - current.windowStartedAt > windowMs
    ? { failures: 0, windowStartedAt: now, bannedUntil: 0 }
    : current;

  state.failures += 1;
  if (state.failures >= config.failBanMaxFailures) {
    state.bannedUntil = now + banMs;
  }
  authFailureStates.set(ip, state);
}

export function clearWebDavAuthFailures(ip: string): void {
  authFailureStates.delete(ip);
}

export function matchWebDavRoute(routePath: string, pathname: string): string | null {
  const normalized = normalizeRoutePath(routePath);
  if (pathname === normalized) return '';
  if (pathname.startsWith(`${normalized}/`)) {
    return pathname.slice(normalized.length + 1);
  }
  return null;
}

function matchConfiguredWebDavRoute(
  settings: Record<string, unknown>,
  pathname: string,
): { routePath: string; relativePath: string } | null {
  const configuredRoutePath = normalizeRoutePath(settings.routePath);
  const configuredRelative = matchWebDavRoute(configuredRoutePath, pathname);
  if (configuredRelative !== null) {
    return { routePath: configuredRoutePath, relativePath: configuredRelative };
  }

  if (configuredRoutePath === LEGACY_DEFAULT_ROUTE) {
    const defaultRelative = matchWebDavRoute(DEFAULT_ROUTE, pathname);
    if (defaultRelative !== null) {
      return { routePath: DEFAULT_ROUTE, relativePath: defaultRelative };
    }
  }

  return null;
}

export function parseBasicCredentials(header: string | null): { username: string; password: string } | null {
  const match = (header || '').match(/^Basic\s+(.+)$/i);
  if (!match) return null;

  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function unauthorized(message = 'Unauthorized'): Response {
  return new Response(message, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Typecho WebDAV", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  });
}

async function authenticate(
  request: Request,
  db: Database,
): Promise<Response | true> {
  const credentials = parseBasicCredentials(request.headers.get('authorization'));
  if (!credentials?.username || !credentials.password) {
    return unauthorized();
  }

  const user = await db.query.users.findFirst({
    where: eq(schema.users.name, credentials.username),
  });
  if (!user || !user.password) {
    return unauthorized();
  }

  const passwordResult = await verifyPassword(credentials.password, user.password);
  if (passwordResult === 'needs_reset') {
    return unauthorized('Password reset required');
  }
  if (passwordResult !== true) {
    return unauthorized();
  }
  if (!hasPermission(user.group || 'visitor', 'administrator')) {
    return unauthorized('Administrator account required');
  }

  return true;
}

function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter(Boolean)
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function hasPathTraversal(segments: string[]): boolean {
  return segments.some(s => s === '..' || s === '.' || s.includes('\0'));
}

function withMountPrefix(mount: StorageMount, key: string): string {
  const cleanKey = key.replace(/^\/+/, '');
  return [mount.prefix, cleanKey].filter(Boolean).join('/');
}

function stripMountPrefix(mount: StorageMount, key: string): string {
  if (!mount.prefix) return key;
  return key.startsWith(`${mount.prefix}/`) ? key.slice(mount.prefix.length + 1) : key;
}

function isCollectionPath(path: string): boolean {
  return path === '' || path.endsWith('/');
}

function href(routePath: string, parts: string[], collection = false): string {
  const base = normalizeRoutePath(routePath);
  const encoded = parts
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join('/');
  const path = encoded ? `${base}/${encoded}` : base;
  return collection && !path.endsWith('/') ? `${path}/` : path;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function responseXml(
  itemHref: string,
  displayName: string,
  collection: boolean,
  object?: Partial<S3Object>,
): string {
  const props = [
    `<d:displayname>${escapeXml(displayName)}</d:displayname>`,
    collection ? '<d:resourcetype><d:collection /></d:resourcetype>' : '<d:resourcetype />',
    object?.lastModified ? `<d:getlastmodified>${escapeXml(new Date(object.lastModified).toUTCString())}</d:getlastmodified>` : '',
    object?.etag ? `<d:getetag>${escapeXml(object.etag)}</d:getetag>` : '',
    !collection ? `<d:getcontentlength>${Number(object?.size || 0)}</d:getcontentlength>` : '',
  ].filter(Boolean).join('');

  return [
    '<d:response>',
    `<d:href>${escapeXml(itemHref)}</d:href>`,
    '<d:propstat>',
    `<d:prop>${props}</d:prop>`,
    '<d:status>HTTP/1.1 200 OK</d:status>',
    '</d:propstat>',
    '</d:response>',
  ].join('');
}

function multistatus(responses: string[]): Response {
  return new Response(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`, {
    status: 207,
    headers: XML_HEADERS,
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function htmlPage(title: string, items: string[]): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeXml(title)}</title>`,
    '<style>',
    'body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:2rem;line-height:1.5;color:#1f2933;background:#fff}',
    'main{max-width:860px}',
    'h1{font-size:1.4rem;margin:0 0 1rem}',
    'ul{list-style:none;padding:0;margin:0;border-top:1px solid #d8dee4}',
    'li{border-bottom:1px solid #d8dee4}',
    'a{display:block;padding:.55rem 0;color:#0b5cad;text-decoration:none}',
    'a:hover{text-decoration:underline}',
    'p{color:#536471}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeXml(title)}</h1>`,
    items.length > 0
      ? `<ul>${items.join('')}</ul>`
      : '<p>This WebDAV collection is empty.</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('');
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: ALLOWED_METHODS,
      DAV: '1, 2',
      'MS-Author-Via': 'DAV',
      'Cache-Control': 'no-store',
    },
  });
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key: string): string {
  return key.split('/').map(encodePathSegment).join('/');
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function shortDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// --- Tianyi Cloud Disk API ---

const TIANYI_API_BASE = 'https://openapi.cloud.189.cn';

async function tianyiGetToken(appKey: string, appSecret: string): Promise<string> {
  const url = `${TIANYI_API_BASE}/open/oauth2/token.action`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    appKey,
    appSecret,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`天翼云盘认证失败 (${response.status})`);
  const json = await response.json() as Record<string, unknown>;
  if (json.code !== 0 && json.code !== '0') {
    throw new Error(`天翼云盘认证失败: ${json.message || json.code}`);
  }
  const data = json.data as Record<string, unknown> | undefined;
  const token = String(data?.accessToken || data?.access_token || '');
  if (!token) throw new Error('天翼云盘认证返回空 token');
  return token;
}

async function tianyiEnsureToken(mount: StorageMount): Promise<string> {
  if (mount.accessToken) return mount.accessToken;
  if (!mount.appKey || !mount.appSecret) {
    throw new Error('天翼云盘未配置 accessToken 或 App Key/Secret');
  }
  const token = await tianyiGetToken(mount.appKey, mount.appSecret);
  mount.accessToken = token;
  return token;
}

async function tianyiApiCall(mount: StorageMount, endpoint: string, params: Record<string, string>, method = 'GET', body?: BodyInit): Promise<Record<string, unknown>> {
  const token = await tianyiEnsureToken(mount);
  const url = new URL(endpoint, TIANYI_API_BASE);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

  const response = await fetch(url.toString(), { method, headers, body });
  if (!response.ok) throw new Error(`天翼云盘 API 请求失败 (${response.status})`);
  const json = await response.json() as Record<string, unknown>;
  if (json.code !== 0 && json.code !== '0') {
    throw new Error(`天翼云盘 API 错误: ${json.message || json.code}`);
  }
  return json;
}

async function tianyiListFiles(mount: StorageMount, folderId: string): Promise<S3ListResult> {
  const objects: S3Object[] = [];
  const prefixes: string[] = [];
  let pageNum = 1;
  let totalCount = 0;

  do {
    const result = await tianyiApiCall(mount, '/open/file/listFiles.action', {
      folderId,
      pageNum: String(pageNum),
      pageSize: '1000',
      orderBy: 'filename',
      descending: 'false',
    });

    const data = (result.data || {}) as Record<string, unknown>;
    const folders = (data.folders || []) as Array<Record<string, unknown>>;
    const files = (data.files || []) as Array<Record<string, unknown>>;
    totalCount = Number(data.count || 0);

    for (const folder of folders) {
      prefixes.push(String(folder.folderName || '') + '/');
    }
    for (const file of files) {
      objects.push({
        key: String(file.fileName || ''),
        size: Number(file.fileSize || 0),
        etag: String(file.fileId || ''),
        lastModified: String(file.lastOpTime || file.createTime || ''),
      });
    }
    pageNum++;
  } while ((pageNum - 1) * 1000 < totalCount);

  return { objects, prefixes };
}

async function tianyiResolvePath(mount: StorageMount, targetPath: string): Promise<{ id: string; isFolder: boolean; name: string } | null> {
  if (!targetPath || targetPath === '/' || targetPath === '') {
    return { id: mount.rootDir || '-11', isFolder: true, name: '' };
  }

  const segments = targetPath.replace(/^\//, '').replace(/\/$/, '').split('/').filter(Boolean);
  if (segments.length === 0) {
    return { id: mount.rootDir || '-11', isFolder: true, name: '' };
  }

  let currentId = mount.rootDir || '-11';
  for (let i = 0; i < segments.length; i++) {
    const target = segments[i];
    const isLast = i === segments.length - 1;

    // Search for matching folder
    let pageNum = 1;
    let found = false;
    while (true) {
      const result = await tianyiApiCall(mount, '/open/file/listFiles.action', {
        folderId: currentId,
        pageNum: String(pageNum),
        pageSize: '1000',
      });
      const data = (result.data || {}) as Record<string, unknown>;
      const folders = (data.folders || []) as Array<Record<string, unknown>>;
      const files = (data.files || []) as Array<Record<string, unknown>>;

      if (isLast) {
        // Check files in the last segment
        for (const file of files) {
          if (String(file.fileName || '') === target) {
            return { id: String(file.fileId || ''), isFolder: false, name: target };
          }
        }
      }

      for (const folder of folders) {
        if (String(folder.folderName || '') === target) {
          if (isLast) return { id: String(folder.folderId || ''), isFolder: true, name: target };
          currentId = String(folder.folderId || '');
          found = true;
          break;
        }
      }

      if (found) break;
      const totalCount = Number(data.count || 0);
      if (pageNum * 1000 >= totalCount) break;
      pageNum++;
    }

    if (!found) return null;
  }

  return null;
}

async function tianyiGetDownloadUrl(mount: StorageMount, fileId: string): Promise<string> {
  const result = await tianyiApiCall(mount, '/open/file/getFileDownloadUrl.action', { fileId });
  const data = (result.data || {}) as Record<string, unknown>;
  return String(data.downloadUrl || data.fileDownloadUrl || '');
}

async function tianyiCreateFolder(mount: StorageMount, parentId: string, folderName: string): Promise<string> {
  const body = new URLSearchParams({ parentFolderId: parentId, folderName });
  const result = await tianyiApiCall(mount, '/open/file/createFolder.action', {}, 'POST', body.toString());
  const data = (result.data || {}) as Record<string, unknown>;
  return String(data.folderId || '');
}

async function tianyiDeleteFile(mount: StorageMount, fileId: string): Promise<void> {
  const body = new URLSearchParams({ fileId });
  await tianyiApiCall(mount, '/open/file/deleteFile.action', {}, 'POST', body.toString());
}

async function tianyiDeleteFolder(mount: StorageMount, folderId: string): Promise<void> {
  const body = new URLSearchParams({ folderId });
  await tianyiApiCall(mount, '/open/file/deleteFolder.action', {}, 'POST', body.toString());
}

async function tianyiRenameFile(mount: StorageMount, fileId: string, newName: string): Promise<void> {
  const body = new URLSearchParams({ fileId, destFileName: newName });
  await tianyiApiCall(mount, '/open/file/renameFile.action', {}, 'POST', body.toString());
}

async function tianyiRenameFolder(mount: StorageMount, folderId: string, newName: string): Promise<void> {
  const body = new URLSearchParams({ folderId, destFolderName: newName });
  await tianyiApiCall(mount, '/open/file/renameFolder.action', {}, 'POST', body.toString());
}

async function tianyiMoveFile(mount: StorageMount, fileId: string, destFolderId: string): Promise<void> {
  const body = new URLSearchParams({ fileId, destFolderId });
  await tianyiApiCall(mount, '/open/file/moveFile.action', {}, 'POST', body.toString());
}

async function tianyiCopyFile(mount: StorageMount, fileId: string, destFolderId: string): Promise<void> {
  const body = new URLSearchParams({ fileId, destFolderId });
  await tianyiApiCall(mount, '/open/file/copyFile.action', {}, 'POST', body.toString());
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const rawKey = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodePathSegment(key)}=${encodePathSegment(value)}`)
    .join('&');
}

function buildS3Url(mount: StorageMount, key: string, query: Record<string, string>): { url: string; host: string; canonicalUri: string; canonicalQuery: string } {
  const endpoint = new URL(mount.endpoint);
  if (!mount.pathStyle) {
    endpoint.hostname = `${mount.bucket}.${endpoint.hostname}`;
  }

  const encodedKey = encodeKeyPath(key);
  const canonicalUri = mount.pathStyle
    ? `/${encodePathSegment(mount.bucket)}${encodedKey ? `/${encodedKey}` : ''}`
    : `/${encodedKey}`;
  const queryString = canonicalQuery(query);
  const url = `${endpoint.protocol}//${endpoint.host}${canonicalUri}${queryString ? `?${queryString}` : ''}`;

  return {
    url,
    host: endpoint.host,
    canonicalUri,
    canonicalQuery: queryString,
  };
}

async function signS3Headers(
  mount: StorageMount,
  method: string,
  key: string,
  query: Record<string, string>,
  headers: Record<string, string>,
): Promise<{ url: string; headers: Headers }> {
  const now = new Date();
  const date = shortDate(now);
  const timestamp = amzDate(now);
  const urlParts = buildS3Url(mount, key, query);
  const normalizedHeaders: Record<string, string> = {
    ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()])),
    host: urlParts.host,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-amz-date': timestamp,
  };

  const signedHeaderNames = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = signedHeaderNames
    .map(name => `${name}:${normalizedHeaders[name]}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    urlParts.canonicalUri,
    urlParts.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const credentialScope = `${date}/${mount.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode(`AWS4${mount.secretAccessKey}`), date);
  const kRegion = await hmac(kDate, mount.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  normalizedHeaders.authorization = [
    `AWS4-HMAC-SHA256 Credential=${mount.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return {
    url: urlParts.url,
    headers: new Headers(normalizedHeaders),
  };
}

async function s3Fetch(
  mount: StorageMount,
  method: string,
  key = '',
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
  body?: BodyInit | null,
): Promise<Response> {
  const signed = await signS3Headers(mount, method, key, query, headers);
  return fetch(signed.url, {
    method,
    headers: signed.headers,
    body,
  });
}

function isR2BucketBinding(value: unknown): value is R2Bucket {
  return !!value
    && typeof value === 'object'
    && typeof (value as R2Bucket).get === 'function'
    && typeof (value as R2Bucket).put === 'function'
    && typeof (value as R2Bucket).delete === 'function'
    && typeof (value as R2Bucket).head === 'function'
    && typeof (value as R2Bucket).list === 'function';
}

function getR2Bucket(mount: StorageMount, workerEnv?: Record<string, unknown>): R2Bucket {
  const bucket = workerEnv?.[mount.bindingName || 'BUCKET'];
  if (!isR2BucketBinding(bucket)) {
    throw new Error(`R2 binding not found: ${mount.bindingName || 'BUCKET'}`);
  }
  return bucket;
}

async function listR2Objects(mount: StorageMount, prefix: string, workerEnv?: Record<string, unknown>): Promise<S3ListResult> {
  const bucket = getR2Bucket(mount, workerEnv);
  const objects: S3Object[] = [];
  const prefixes: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await bucket.list({
      prefix,
      delimiter: '/',
      limit: 1000,
      cursor,
    });
    prefixes.push(...(result.delimitedPrefixes || []));
    objects.push(...(result.objects || []).map(object => ({
      key: object.key,
      size: object.size,
      etag: object.httpEtag || object.etag,
      lastModified: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded || ''),
    })));
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return { prefixes, objects };
}

async function listObjects(mount: StorageMount, prefix: string, workerEnv?: Record<string, unknown>): Promise<S3ListResult> {
  if (mount.provider === 'r2') {
    return listR2Objects(mount, prefix, workerEnv);
  }
  if (mount.provider === 'tianyi') {
    // Tianyi uses folder IDs. For listing, we resolve the prefix to a folder ID.
    // Remove trailing slash for path resolution
    const cleanPrefix = prefix.replace(/\/+$/, '');
    const resolved = await tianyiResolvePath(mount, cleanPrefix);
    if (!resolved || !resolved.isFolder) {
      return { objects: [], prefixes: [] };
    }
    return tianyiListFiles(mount, resolved.id);
  }

  const response = await s3Fetch(mount, 'GET', '', {
    'delimiter': '/',
    'list-type': '2',
    'max-keys': '1000',
    'prefix': prefix,
  });
  if (!response.ok) {
    throw new Error(`List storage failed (${response.status})`);
  }

  const xml = await response.text();
  const prefixes = Array.from(xml.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g))
    .map(match => decodeXml(match[1] || ''));
  const objects = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g))
    .map((match): S3Object => {
      const block = match[1] || '';
      return {
        key: decodeXml(block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] || ''),
        size: Number(block.match(/<Size>([\s\S]*?)<\/Size>/)?.[1] || 0),
        etag: decodeXml(block.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1] || ''),
        lastModified: decodeXml(block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] || ''),
      };
    });

  return { prefixes, objects };
}

async function objectMeta(mount: StorageMount, key: string, workerEnv?: Record<string, unknown>): Promise<S3Object | null> {
  if (mount.provider === 'r2') {
    const object = await getR2Bucket(mount, workerEnv).head(key);
    if (!object) return null;
    return {
      key: object.key,
      size: object.size,
      etag: object.httpEtag || object.etag,
      lastModified: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded || ''),
    };
  }
  if (mount.provider === 'tianyi') {
    // key already includes mount prefix from caller's withMountPrefix
    const cleanKey = key.replace(/\/+$/, '');
    const resolved = await tianyiResolvePath(mount, cleanKey);
    if (!resolved || resolved.isFolder) return null;
    // Look up file size from parent folder listing
    let size = 0;
    let lastModified = '';
    try {
      const lastSlash = cleanKey.lastIndexOf('/');
      const parentPath = lastSlash >= 0 ? cleanKey.slice(0, lastSlash) : '';
      const parent = parentPath ? await tianyiResolvePath(mount, parentPath) : { id: mount.rootDir || '-11' };
      if (parent) {
        const listing = await tianyiListFiles(mount, parent.id);
        const found = listing.objects.find(o => o.key === resolved.name);
        if (found) { size = found.size; lastModified = found.lastModified; }
      }
    } catch { /* fall back to zero */ }
    return {
      key: cleanKey,
      size,
      etag: resolved.id,
      lastModified,
    };
  }

  const response = await s3Fetch(mount, 'HEAD', key);
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) {
    throw new Error(`Read storage metadata failed (${response.status})`);
  }

  return {
    key,
    size: Number(response.headers.get('content-length') || 0),
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
  };
}

async function collectionExists(mount: StorageMount, prefix: string, workerEnv?: Record<string, unknown>): Promise<boolean> {
  const normalizedPrefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  const listing = await listObjects(mount, normalizedPrefix, workerEnv);
  return listing.prefixes.length > 0 || listing.objects.length > 0;
}

async function propfindRoot(config: WebDavConfig, depth: string): Promise<Response> {
  const responses = [
    responseXml(href(config.routePath, [], true), 'WebDAV', true),
  ];

  if (depth !== '0') {
    for (const mount of config.mounts) {
      responses.push(responseXml(href(config.routePath, [mount.mount], true), mount.mount, true));
    }
  }

  return multistatus(responses);
}

async function browserRootListing(config: WebDavConfig, method: string): Promise<Response> {
  if (method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const items = config.mounts.map(mount => {
    const label = mount.mount || 'Root storage';
    return `<li><a href="${escapeXml(href(config.routePath, [mount.mount], true))}">${escapeXml(label)}/</a></li>`;
  });
  return htmlResponse(htmlPage('WebDAV', items));
}

async function browserMountListing(
  config: WebDavConfig,
  mount: StorageMount,
  key: string,
  method: string,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  if (method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const cleanKey = key.replace(/^\/+|\/+$/g, '');
  const fullKey = withMountPrefix(mount, cleanKey);
  const prefix = fullKey && !fullKey.endsWith('/') ? `${fullKey}/` : fullKey;
  const listing = await listObjects(mount, prefix, workerEnv);
  const baseParts = [
    ...(mount.mount ? [mount.mount] : []),
    ...cleanKey.split('/').filter(Boolean),
  ];
  const items: string[] = [];
  const emittedCollections = new Set<string>();

  for (const itemPrefix of listing.prefixes) {
    const relative = stripMountPrefix(mount, itemPrefix).replace(/\/+$/, '');
    emittedCollections.add(relative);
    const display = relative.split('/').pop() || relative;
    items.push(`<li><a href="${escapeXml(href(config.routePath, [
      ...(mount.mount ? [mount.mount] : []),
      ...relative.split('/').filter(Boolean),
    ], true))}">${escapeXml(display)}/</a></li>`);
  }

  for (const object of listing.objects) {
    if (object.key === prefix) continue;
    const relative = stripMountPrefix(mount, object.key);
    if (object.key.endsWith('/')) {
      const collectionRelative = relative.replace(/\/+$/, '');
      if (!collectionRelative || emittedCollections.has(collectionRelative)) continue;
      emittedCollections.add(collectionRelative);
      const display = collectionRelative.split('/').pop() || collectionRelative;
      items.push(`<li><a href="${escapeXml(href(config.routePath, [
        ...(mount.mount ? [mount.mount] : []),
        ...collectionRelative.split('/').filter(Boolean),
      ], true))}">${escapeXml(display)}/</a></li>`);
      continue;
    }
    const normalizedCleanKey = cleanKey ? `${cleanKey}/` : '';
    if (relative.includes('/') && !relative.startsWith(normalizedCleanKey)) continue;
    const display = relative.split('/').pop() || relative;
    items.push(`<li><a href="${escapeXml(href(config.routePath, [
      ...(mount.mount ? [mount.mount] : []),
      ...relative.split('/').filter(Boolean),
    ], false))}">${escapeXml(display)}</a></li>`);
  }

  return htmlResponse(htmlPage(baseParts.length > 0 ? `WebDAV / ${baseParts.join('/')}` : 'WebDAV', items));
}

async function propfindMount(
  config: WebDavConfig,
  mount: StorageMount,
  key: string,
  depth: string,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  const cleanKey = key.replace(/^\/+/, '');
  const fullKey = withMountPrefix(mount, cleanKey);
  const mountParts = [
    ...(mount.mount ? [mount.mount] : []),
    ...cleanKey.split('/').filter(Boolean),
  ];
  const responses: string[] = [];

  if (cleanKey === '' || isCollectionPath(key)) {
    const prefix = fullKey && !fullKey.endsWith('/') ? `${fullKey}/` : fullKey;
    const listing = await listObjects(mount, prefix, workerEnv);
    responses.push(responseXml(href(config.routePath, mountParts, true), mountParts.at(-1) || mount.mount || 'WebDAV', true));

    if (depth !== '0') {
      const emittedCollections = new Set<string>();
      for (const itemPrefix of listing.prefixes) {
        const relative = stripMountPrefix(mount, itemPrefix).replace(/\/+$/, '');
        emittedCollections.add(relative);
        const display = relative.split('/').pop() || relative;
        responses.push(responseXml(href(config.routePath, [
          ...(mount.mount ? [mount.mount] : []),
          ...relative.split('/').filter(Boolean),
        ], true), display, true));
      }
      for (const object of listing.objects) {
        if (object.key === prefix) continue;
        const relative = stripMountPrefix(mount, object.key);
        if (object.key.endsWith('/')) {
          const collectionRelative = relative.replace(/\/+$/, '');
          if (!collectionRelative || emittedCollections.has(collectionRelative)) continue;
          emittedCollections.add(collectionRelative);
          const display = collectionRelative.split('/').pop() || collectionRelative;
          responses.push(responseXml(href(config.routePath, [
            ...(mount.mount ? [mount.mount] : []),
            ...collectionRelative.split('/').filter(Boolean),
          ], true), display, true));
          continue;
        }
        if (relative.includes('/') && !relative.startsWith(cleanKey ? `${cleanKey.replace(/\/+$/, '')}/` : '')) continue;
        const display = relative.split('/').pop() || relative;
        responses.push(responseXml(href(config.routePath, [
          ...(mount.mount ? [mount.mount] : []),
          ...relative.split('/').filter(Boolean),
        ], false), display, false, object));
      }
    }
    return multistatus(responses);
  }

  const meta = await objectMeta(mount, fullKey, workerEnv);
  if (meta) {
    return multistatus([
      responseXml(href(config.routePath, mountParts, false), mountParts.at(-1) || cleanKey, false, meta),
    ]);
  }

  const existsAsCollection = await collectionExists(mount, fullKey, workerEnv);
  if (!existsAsCollection) return new Response('Not Found', { status: 404 });
  if (depth !== '0') {
    return propfindMount(config, mount, `${cleanKey}/`, depth, workerEnv);
  }
  return multistatus([
    responseXml(href(config.routePath, mountParts, true), mountParts.at(-1) || cleanKey, true),
  ]);
}

async function handleRead(
  method: string,
  mount: StorageMount,
  key: string,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  const fullKey = withMountPrefix(mount, key);
  if (mount.provider === 'r2') {
    const object = await getR2Bucket(mount, workerEnv).get(fullKey);
    if (!object) return new Response('Not Found', { status: 404 });
    const headers = new Headers();
    if (object.size != null) headers.set('Content-Length', String(object.size));
    if (object.httpEtag || object.etag) headers.set('ETag', object.httpEtag || object.etag || '');
    if (object.uploaded) headers.set('Last-Modified', object.uploaded.toUTCString());
    if (object.httpMetadata?.contentType) headers.set('Content-Type', object.httpMetadata.contentType);
    return new Response(method === 'HEAD' ? null : object.body, { status: 200, headers });
  }
  if (mount.provider === 'tianyi') {
    const cleanKey = fullKey.replace(/\/+$/, '');
    const resolved = await tianyiResolvePath(mount, cleanKey);
    if (!resolved || resolved.isFolder) return new Response('Not Found', { status: 404 });
    if (method === 'HEAD') {
      return new Response(null, { status: 200 });
    }
    const downloadUrl = await tianyiGetDownloadUrl(mount, resolved.id);
    if (!downloadUrl) return new Response('Not Found', { status: 404 });
    const downloadResp = await fetch(downloadUrl);
    if (!downloadResp.ok) return new Response('Download failed', { status: 502 });
    return downloadResp;
  }

  const response = await s3Fetch(mount, method, fullKey);
  if (response.status === 404 || response.status === 403) {
    return new Response('Not Found', { status: 404 });
  }
  return response;
}

async function handlePut(
  request: Request,
  mount: StorageMount,
  key: string,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  if (!key || key.endsWith('/')) return new Response('Invalid target', { status: 409 });
  const headers: Record<string, string> = {};
  const contentType = request.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;

  if (mount.provider === 'r2') {
    await getR2Bucket(mount, workerEnv).put(withMountPrefix(mount, key), request.body || '', {
      httpMetadata: contentType ? { contentType } : undefined,
    });
    return new Response(null, { status: 201 });
  }
  if (mount.provider === 'tianyi') {
    // Resolve parent path to folder ID (use fullKey to include mount prefix)
    const fullKey = withMountPrefix(mount, key);
    const lastSlash = fullKey.lastIndexOf('/');
    const parentPath = lastSlash >= 0 ? fullKey.slice(0, lastSlash) : '';
    const fileName = lastSlash >= 0 ? fullKey.slice(lastSlash + 1) : fullKey;
    const parent = await tianyiResolvePath(mount, parentPath || '');
    if (!parent || !parent.isFolder) return new Response('Parent folder not found', { status: 404 });

    const token = await tianyiEnsureToken(mount);
    const form = new FormData();
    form.append('access_token', token);
    form.append('folderId', parent.id);
    form.append('file', request.body instanceof Blob ? request.body : new Blob([await request.arrayBuffer()]), fileName);

    const uploadUrl = `${TIANYI_API_BASE}/open/file/uploadFile.action`;
    const uploadResp = await fetch(uploadUrl, { method: 'POST', body: form });
    if (!uploadResp.ok) return new Response('Upload failed', { status: 502 });
    return new Response(null, { status: 201 });
  }

  const response = await s3Fetch(mount, 'PUT', withMountPrefix(mount, key), {}, headers, request.body);
  if (!response.ok) return new Response('Storage write failed', { status: 502 });
  return new Response(null, { status: 201 });
}

async function handleMkcol(mount: StorageMount, key: string, workerEnv?: Record<string, unknown>): Promise<Response> {
  if (!key) return new Response('Method Not Allowed', { status: 405 });
  const dirKey = withMountPrefix(mount, key.endsWith('/') ? key : `${key}/`);
  if (mount.provider === 'r2') {
    await getR2Bucket(mount, workerEnv).put(dirKey, '', {
      httpMetadata: { contentType: 'application/x-directory' },
    });
    return new Response(null, { status: 201 });
  }
  if (mount.provider === 'tianyi') {
    const cleanKey = dirKey.replace(/\/+$/, '');
    const segments = cleanKey.split('/').filter(Boolean);
    const folderName = segments.pop() || cleanKey;
    const parentPath = segments.join('/');
    const parent = await tianyiResolvePath(mount, parentPath || '');
    if (!parent || !parent.isFolder) return new Response('Parent folder not found', { status: 409 });
    await tianyiCreateFolder(mount, parent.id, folderName);
    return new Response(null, { status: 201 });
  }

  const response = await s3Fetch(mount, 'PUT', dirKey, {}, { 'content-type': 'application/x-directory' }, '');
  if (!response.ok) return new Response('Storage write failed', { status: 502 });
  return new Response(null, { status: 201 });
}

async function handleDelete(mount: StorageMount, key: string, workerEnv?: Record<string, unknown>): Promise<Response> {
  if (!key) return new Response('Cannot delete mount root', { status: 409 });

  if (key.endsWith('/')) {
    const prefix = withMountPrefix(mount, key);
    const listing = await listObjects(mount, prefix, workerEnv);
    if (listing.prefixes.length > 0 || listing.objects.some(object => object.key !== prefix)) {
      return new Response('Directory is not empty', { status: 409 });
    }
  }

  if (mount.provider === 'r2') {
    await getR2Bucket(mount, workerEnv).delete(withMountPrefix(mount, key));
    return new Response(null, { status: 204 });
  }
  if (mount.provider === 'tianyi') {
    const prefixedKey = withMountPrefix(mount, key || '');
    const cleanKey = prefixedKey.replace(/\/+$/, '');
    const resolved = await tianyiResolvePath(mount, cleanKey);
    if (!resolved) return new Response('Not Found', { status: 404 });
    if (resolved.isFolder) {
      await tianyiDeleteFolder(mount, resolved.id);
    } else {
      await tianyiDeleteFile(mount, resolved.id);
    }
    return new Response(null, { status: 204 });
  }

  const response = await s3Fetch(mount, 'DELETE', withMountPrefix(mount, key));
  if (!response.ok && response.status !== 404) return new Response('Storage delete failed', { status: 502 });
  return new Response(null, { status: 204 });
}

function resolveDestination(config: WebDavConfig, destinationHeader: string | null): { mountName: string; key: string } | null {
  if (!destinationHeader) return null;
  let pathname = destinationHeader;
  try {
    pathname = new URL(destinationHeader).pathname;
  } catch {
    // Relative Destination headers are allowed by some clients.
  }

  const relative = matchWebDavRoute(config.routePath, pathname);
  if (relative === null) return null;
  const target = resolveWebDavTarget(config, relative);
  if (!target) return null;
  return { mountName: target.mount.mount, key: target.key };
}

async function handleCopyMove(
  request: Request,
  config: WebDavConfig,
  sourceMount: StorageMount,
  sourceKey: string,
  move: boolean,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  if (!sourceKey || sourceKey.endsWith('/')) return new Response('Collection copy is not supported', { status: 409 });

  const destination = resolveDestination(config, request.headers.get('destination'));
  if (!destination) return new Response('Invalid Destination', { status: 400 });
  if (destination.mountName !== sourceMount.mount || !destination.key || destination.key.endsWith('/')) {
    return new Response('Cross-mount or collection copy is not supported', { status: 409 });
  }

  const overwrite = (request.headers.get('overwrite') || 'T').toUpperCase() !== 'F';
  if (!overwrite) {
    const existing = await objectMeta(sourceMount, withMountPrefix(sourceMount, destination.key), workerEnv);
    if (existing) return new Response('Precondition Failed', { status: 412 });
  }

  if (sourceMount.provider === 'r2') {
    const bucket = getR2Bucket(sourceMount, workerEnv);
    const sourceObject = await bucket.get(withMountPrefix(sourceMount, sourceKey));
    if (!sourceObject) return new Response('Not Found', { status: 404 });

    await bucket.put(withMountPrefix(sourceMount, destination.key), sourceObject.body, {
      httpMetadata: sourceObject.httpMetadata,
    });
    if (move) {
      await bucket.delete(withMountPrefix(sourceMount, sourceKey));
    }
    return new Response(null, { status: 201 });
  }
  if (sourceMount.provider === 'tianyi') {
    const cleanSource = sourceKey.replace(/\/+$/, '');
    const cleanDest = destination.key.replace(/\/+$/, '');
    const source = await tianyiResolvePath(sourceMount, cleanSource);
    if (!source) return new Response('Not Found', { status: 404 });

    // Extract destination parent path and name
    const destSlash = cleanDest.lastIndexOf('/');
    const destParentPath = destSlash >= 0 ? cleanDest.slice(0, destSlash) : '';
    const destName = destSlash >= 0 ? cleanDest.slice(destSlash + 1) : cleanDest;
    const destParent = await tianyiResolvePath(sourceMount, destParentPath || '/');
    if (!destParent || !destParent.isFolder) return new Response('Destination folder not found', { status: 409 });

    // Resolve source's parent folder to detect same-directory renames
    const srcSlash = cleanSource.lastIndexOf('/');
    const srcParentPath = srcSlash >= 0 ? cleanSource.slice(0, srcSlash) : '';
    const srcParent = srcParentPath ? await tianyiResolvePath(sourceMount, srcParentPath) : { id: sourceMount.rootDir || '-11', isFolder: true, name: '' };
    const sameParent = srcParent && destParent.id === srcParent.id;

    if (!move) {
      // Copy: copy to dest folder, then rename to dest name
      await tianyiCopyFile(sourceMount, source.id, destParent.id);
      if (destName && destName !== source.name) {
        // Retry lookup — tianyi API may have eventual consistency
        let copied = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 200));
          copied = await tianyiResolvePath(sourceMount, (destParentPath ? destParentPath + '/' : '') + source.name);
          if (copied) break;
        }
        if (copied && !copied.isFolder) {
          await tianyiRenameFile(sourceMount, copied.id, destName);
        }
      }
    } else if (sameParent) {
      // Same parent — just rename (avoids unnecessary moveFile call)
      await tianyiRenameFile(sourceMount, source.id, destName);
    } else {
      // Move to different parent
      await tianyiMoveFile(sourceMount, source.id, destParent.id);
      if (destName !== source.name) {
        let moved = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 200));
          moved = await tianyiResolvePath(sourceMount, (destParentPath ? destParentPath + '/' : '') + source.name);
          if (moved) break;
        }
        if (moved && !moved.isFolder) {
          await tianyiRenameFile(sourceMount, moved.id, destName);
        }
      }
    }
    return new Response(null, { status: 201 });
  }

  const copySource = `/${encodePathSegment(sourceMount.bucket)}/${encodeKeyPath(withMountPrefix(sourceMount, sourceKey))}`;
  const copyResponse = await s3Fetch(
    sourceMount,
    'PUT',
    withMountPrefix(sourceMount, destination.key),
    {},
    { 'x-amz-copy-source': copySource },
  );
  if (!copyResponse.ok) return new Response('Storage copy failed', { status: 502 });

  if (move) {
    const deleteResponse = await s3Fetch(sourceMount, 'DELETE', withMountPrefix(sourceMount, sourceKey));
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      return new Response('Storage move cleanup failed', { status: 502 });
    }
  }

  return new Response(null, { status: 201 });
}

async function handleWebDavRequest(config: WebDavConfig, relativePath: string, extra: WebDavRouteExtra): Promise<Response> {
  const request = extra.request!;
  if (request.method === 'OPTIONS') return optionsResponse();

  if (!extra.db) return new Response('Database unavailable', { status: 503 });
  const clientIp = getWebDavClientIp(request);
  const hasBasicAuthAttempt = /^Basic\s+/i.test(request.headers.get('authorization') || '');
  if (hasBasicAuthAttempt && isWebDavClientBanned(config, clientIp)) {
    return new Response('Too many failed login attempts', {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(config.failBanSeconds),
      },
    });
  }

  const authResult = await authenticate(request, extra.db);
  if (authResult instanceof Response) {
    if (hasBasicAuthAttempt && authResult.status === 401) {
      recordWebDavAuthFailure(config, clientIp);
    }
    return authResult;
  }
  if (hasBasicAuthAttempt) {
    clearWebDavAuthFailures(clientIp);
  }

  const depthHeader = (request.headers.get('depth') || '1').toLowerCase();
  const depth = depthHeader === 'infinity' ? '1' : depthHeader;
  if (request.method === 'PROPFIND' && !['0', '1'].includes(depth)) {
    return new Response('Unsupported Depth', { status: 400 });
  }

  const target = resolveWebDavTarget(config, relativePath);
  if (!target) {
    if (request.method === 'PROPFIND') return propfindRoot(config, depth);
    if (request.method === 'GET' || request.method === 'HEAD') return browserRootListing(config, request.method);
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'OPTIONS, PROPFIND' } });
  }

  const { mount, key } = target;
  const workerEnv = extra.env;
  const propfindKey = relativePath.endsWith('/') && key ? `${key}/` : key || (relativePath.endsWith('/') ? '/' : '');
  switch (request.method) {
    case 'PROPFIND':
      return propfindMount(config, mount, propfindKey, depth, workerEnv);
    case 'GET':
    case 'HEAD':
      if (!key || relativePath.endsWith('/')) {
        return browserMountListing(config, mount, key, request.method, workerEnv);
      }
      {
        const readResponse = await handleRead(request.method, mount, key, workerEnv);
        if (readResponse.status !== 404) return readResponse;
        if (await collectionExists(mount, withMountPrefix(mount, key), workerEnv)) {
          return browserMountListing(config, mount, key, request.method, workerEnv);
        }
        return readResponse;
      }
    case 'PUT':
      return handlePut(request, mount, key, workerEnv);
    case 'MKCOL':
      return handleMkcol(mount, key, workerEnv);
    case 'DELETE':
      return handleDelete(mount, key, workerEnv);
    case 'COPY':
      return handleCopyMove(request, config, mount, key, false, workerEnv);
    case 'MOVE':
      return handleCopyMove(request, config, mount, key, true, workerEnv);
    default:
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: ALLOWED_METHODS } });
  }
}

/**
 * Storage adapter for admin API. Returns an object with storage-level
 * operations keyed by relative path, bypassing the WebDAV protocol layer.
 */
export interface WebDavStorageAdapter {
  list(path: string, workerEnv?: Record<string, unknown>): Promise<S3ListResult>;
  meta(path: string, workerEnv?: Record<string, unknown>): Promise<S3Object | null>;
  read(path: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  write(path: string, body: ReadableStream<Uint8Array> | null, contentType: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  mkdir(path: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  delete(path: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  getMounts(): { name: string; provider: string }[];
}

export function createStorageAdapter(config: WebDavConfig): WebDavStorageAdapter {
  return {
    list(path, workerEnv) {
      const target = resolveWebDavTarget(config, path);
      if (!target) throw new Error('Invalid path');
      const prefix = target.mount.prefix ? `${target.mount.prefix}/${target.key}` : target.key;
      const listPrefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
      return listObjects(target.mount, listPrefix, workerEnv);
    },
    meta(path, workerEnv) {
      const target = resolveWebDavTarget(config, path);
      if (!target) return Promise.resolve(null);
      const fullKey = withMountPrefix(target.mount, target.key);
      return objectMeta(target.mount, fullKey, workerEnv);
    },
    read(path, workerEnv) {
      const target = resolveWebDavTarget(config, path);
      if (!target) throw new Error('Invalid path');
      return handleRead('GET', target.mount, target.key, workerEnv);
    },
    async write(path, body, contentType, workerEnv) {
      const target = resolveWebDavTarget(config, path);
      if (!target) throw new Error('Invalid path');
      if (!target.key || target.key.endsWith('/')) throw new Error('Invalid target');
      if (target.mount.provider === 'r2') {
        const bucket = getR2Bucket(target.mount, workerEnv);
        const fullKey = withMountPrefix(target.mount, target.key);
        if (!body) throw new Error('No body');
        await bucket.put(fullKey, body, {
          httpMetadata: contentType ? { contentType } : undefined,
        });
        return new Response(null, { status: 201 });
      }
      if (target.mount.provider === 'tianyi') {
        const fullKey = withMountPrefix(target.mount, target.key);
        const lastSlash = fullKey.lastIndexOf('/');
        const parentPath = lastSlash >= 0 ? fullKey.slice(0, lastSlash) : '';
        const fileName = lastSlash >= 0 ? fullKey.slice(lastSlash + 1) : fullKey;
        const parent = await tianyiResolvePath(target.mount, parentPath || '/');
        if (!parent || !parent.isFolder) throw new Error('Parent folder not found');
        const token = await tianyiEnsureToken(target.mount);
        const form = new FormData();
        form.append('access_token', token);
        form.append('folderId', parent.id);
        if (body) {
          const buf = await new Response(body).arrayBuffer();
          form.append('file', new Blob([buf]), fileName);
        }
        const uploadUrl = `${TIANYI_API_BASE}/open/file/uploadFile.action`;
        const uploadResp = await fetch(uploadUrl, { method: 'POST', body: form });
        if (!uploadResp.ok) throw new Error(`Upload failed (${uploadResp.status})`);
        return new Response(null, { status: 201 });
      }
      const fullKey = withMountPrefix(target.mount, target.key);
      const response = await s3Fetch(target.mount, 'PUT', fullKey, {}, contentType ? { 'content-type': contentType } : {}, body);
      if (!response.ok) throw new Error(`Storage write failed (${response.status})`);
      return new Response(null, { status: 201 });
    },
    async mkdir(path, workerEnv) {
      const target = resolveWebDavTarget(config, path);
      if (!target) throw new Error('Invalid path');
      const response = await handleMkcol(target.mount, target.key, workerEnv);
      if (!response.ok) throw new Error(`Create directory failed (${response.status})`);
      return response;
    },
    async delete(path, workerEnv) {
      const target = resolveWebDavTarget(config, path);
      if (!target) throw new Error('Invalid path');
      const isCollection = path.endsWith('/') || path === '';
      if (isCollection && target.key) {
        const raw = withMountPrefix(target.mount, target.key);
        const prefix = raw && !raw.endsWith('/') ? `${raw}/` : raw;
        const listing = await listObjects(target.mount, prefix, workerEnv);
        if (listing.prefixes.length > 0 || listing.objects.some(o => o.key !== prefix)) {
          throw new Error('Directory is not empty');
        }
      }
      const response = await handleDelete(target.mount, target.key, workerEnv);
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      return response;
    },
    getMounts() {
      return config.mounts.map(m => ({ name: m.mount || '/', provider: m.provider }));
    },
  };
}

// ── Admin Panel (in-plugin) ──

const ADMIN_API_ROUTE = '/api/admin/webdav';

interface AdminAuthResult {
  uid: number;
  user: Record<string, unknown>;
  options: Record<string, unknown>;
  db: Database;
}

async function authenticateAdmin(request: Request, db: Database, options: Record<string, unknown>): Promise<AdminAuthResult | Response> {
  const { token } = getAuthCookies(request.headers.get('cookie'));
  if (!token || !options.secret) {
    return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const auth = await validateAuthToken(token, String(options.secret), db);
  if (!auth) {
    return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (!hasPermission(auth.user.group || 'visitor', 'administrator')) {
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  return {
    uid: auth.uid,
    user: auth.user as unknown as Record<string, unknown>,
    options,
    db,
  };
}


async function handleAdminApiRequest(request: Request, config: WebDavConfig, workerEnv?: Record<string, unknown>): Promise<Response> {
  const url = new URL(request.url);
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const adapter = createStorageAdapter(config);

  if (request.method === 'GET') {
    const action = url.searchParams.get('action') || 'list';
    const rawPath = url.searchParams.get('path') || '';

    if (action === 'list') {
      if (!rawPath && !config.mounts.some(mount => mount.mount === '')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            path: '/',
            objects: [],
            prefixes: config.mounts.map(mount => `${mount.mount}/`),
          },
        }), { headers: jsonHeaders });
      }

      const result = await adapter.list(rawPath, workerEnv);
      // Separate directory markers (keys ending with /) from real files.
      // Promote markers to prefixes if not already listed there.
      const prefixes = [...result.prefixes];
      const objects: typeof result.objects = [];
      for (const o of result.objects) {
        if (o.key.endsWith('/')) {
          const name = o.key.replace(/\/+$/, '');
          if (!prefixes.includes(name + '/')) {
            prefixes.push(name + '/');
          }
        } else {
          objects.push(o);
        }
      }
      return new Response(JSON.stringify({ success: true, data: { path: rawPath || '/', objects, prefixes } }), { headers: jsonHeaders });
    }
    if (action === 'download') {
      return adapter.read(rawPath, workerEnv);
    }
    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: jsonHeaders });
  }

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const action = String(formData.get('action') || 'upload');
      const dirPath = String(formData.get('path') || '');
      const file = formData.get('file') as File | null;

      if (action === 'upload') {
        if (!file) return new Response(JSON.stringify({ error: '没有选择文件' }), { status: 400, headers: jsonHeaders });
        const filePath = dirPath ? `${dirPath.replace(/\/+$/, '')}/${file.name}` : file.name;
        await adapter.write(filePath, file.stream(), file.type || 'application/octet-stream', workerEnv);
        return new Response(JSON.stringify({ success: true, message: '上传成功' }), { headers: jsonHeaders });
      }
      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: jsonHeaders });
    }

    const body = await request.json() as { action?: string; path?: string; newPath?: string; paths?: string[] };
    const action = body.action || '';
    const targetPath = body.path || '';

    if (action === 'mkdir') {
      if (!targetPath) return new Response(JSON.stringify({ error: '请输入目录名' }), { status: 400, headers: jsonHeaders });
      await adapter.mkdir(targetPath.endsWith('/') ? targetPath : `${targetPath}/`, workerEnv);
      return new Response(JSON.stringify({ success: true, message: '目录创建成功' }), { headers: jsonHeaders });
    }
    if (action === 'delete') {
      const raw = body.paths || (targetPath ? [targetPath] : []);
      const paths = Array.isArray(raw) ? raw : [String(raw)];
      if (!paths.length) return new Response(JSON.stringify({ error: '请选择要删除的文件或目录' }), { status: 400, headers: jsonHeaders });
      for (const p of paths) await adapter.delete(String(p), workerEnv);
      return new Response(JSON.stringify({ success: true, message: '删除成功' }), { headers: jsonHeaders });
    }
    if (action === 'rename') {
      const newPath = body.newPath || '';
      if (!targetPath || !newPath) return new Response(JSON.stringify({ error: '缺少参数' }), { status: 400, headers: jsonHeaders });
      if (targetPath === newPath) return new Response(JSON.stringify({ error: '新名称与旧名称相同' }), { status: 400, headers: jsonHeaders });
      const readResp = await adapter.read(targetPath, workerEnv);
      if (!readResp.ok) return new Response(JSON.stringify({ error: `读取源文件失败 (${readResp.status})` }), { status: 502, headers: jsonHeaders });
      if (!readResp.body) return new Response(JSON.stringify({ error: '无法读取源文件' }), { status: 500, headers: jsonHeaders });
      const ct = readResp.headers.get('content-type') || 'application/octet-stream';
      await adapter.write(newPath, readResp.body, ct, workerEnv);
      await adapter.delete(targetPath, workerEnv);
      return new Response(JSON.stringify({ success: true, message: '重命名成功' }), { headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ error: `未知操作: ${action}` }), { status: 400, headers: jsonHeaders });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: jsonHeaders });
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // Register plugin admin paths so middleware doesn't block them
  registerPluginAdminPath(ADMIN_API_ROUTE);

  // config validation (existing)
  addHook(
    'plugin:config:beforeSave',
    pluginId,
    (result: ConfigValidationResult, extra?: { pluginId?: string; settings?: Record<string, unknown> }) => {
      if (extra?.pluginId !== pluginId) return result;

      try {
        const config = normalizeConfig(extra.settings || {});
        return {
          success: true,
          settings: {
            routePath: config.routePath,
            protocolEnabled: config.protocolEnabled ? 'true' : 'false',
            mounts: config.mounts,
            failBanEnabled: config.failBanEnabled ? 'true' : 'false',
            failBanMaxFailures: config.failBanMaxFailures,
            failBanWindowSeconds: config.failBanWindowSeconds,
            failBanSeconds: config.failBanSeconds,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'WebDAV 配置校验失败',
        };
      }
    },
  );

  // Unified route:request handler — handles WebDAV protocol, admin page, and admin API
  addHook(
    'route:request',
    pluginId,
    async (result: PluginRouteResult, extra?: WebDavRouteExtra) => {
      if (result?.handled || !extra?.request || !extra.path) return result;

      // --- Admin API: /api/admin/webdav ---
      if (extra.path === ADMIN_API_ROUTE) {
        if (!extra.db) {
          return { handled: true, response: new Response(JSON.stringify({ error: 'Database unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } }) };
        }
        try {
          const options = extra.options || {};
          const authResult = await authenticateAdmin(extra.request, extra.db, options);
          if (authResult instanceof Response) {
            const msg = authResult.status === 403 ? 'Forbidden' : 'Unauthorized';
            return { handled: true, response: new Response(JSON.stringify({ error: msg }), { status: authResult.status, headers: { 'Content-Type': 'application/json' } }) };
          }

          // CSRF check for POST
          if (extra.request.method === 'POST') {
            const csrfError = await requireAdminCSRF(
              extra.request,
              String(options.secret || ''),
              String(authResult.user.authCode || authResult.user.auth_code || ''),
              authResult.uid,
            );
            if (csrfError) {
              return { handled: true, response: new Response(JSON.stringify({ error: 'CSRF validation failed' }), { status: 403, headers: { 'Content-Type': 'application/json' } }) };
            }
          }

          const apiSettings = readPluginSettings(extra.options);
          const apiConfig = normalizeConfig(apiSettings);
          return { handled: true, response: await handleAdminApiRequest(extra.request, apiConfig, extra.env) };
        } catch (error) {
          console.error('[webdav] Admin API error:', error);
          return { handled: true, response: new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } }) };
        }
      }

      // --- WebDAV protocol handler ---
      const settings = readPluginSettings(extra.options);

      // Skip WebDAV protocol if disabled — check before normalizeConfig
      // so broken mount config doesn't prevent turning the protocol off.
      if (!parseBoolean(settings?.protocolEnabled, true)) return result;

      const routeMatch = matchConfiguredWebDavRoute(settings, extra.path);
      if (!routeMatch) return result;

      let config: WebDavConfig;
      try {
        config = normalizeConfig(settings);
        config.routePath = routeMatch.routePath;
      } catch (error) {
        console.error('[webdav] Invalid configuration:', error);
        return {
          handled: true,
          response: new Response('WebDAV plugin is not configured', { status: 503 }),
        };
      }

      try {
        return {
          handled: true,
          response: await handleWebDavRequest(config, routeMatch.relativePath, extra),
        };
      } catch (error) {
        console.error('[webdav] Request failed:', error);
        return {
          handled: true,
          response: new Response('WebDAV storage error', { status: 502 }),
        };
      }
    },
    20,
  );

  // Inject WebDAV file manager body into admin plugin page framework
  addHook(
    'admin:page',
    pluginId,
    (html: string, extra?: { slug?: string; csrfToken?: string }) => {
      if (extra?.slug !== 'webdav') return html;
      const csrf = extra?.csrfToken || '';
      return `<div class="col-mb-12 typecho-list" id="webdav-app">
  <div id="webdav-notice" style="display:none"></div>
  <div class="typecho-list-operate clearfix">
    <div class="operate">
      <label><i class="sr-only">全选</i><input type="checkbox" class="typecho-table-select-all"></label>
      <div class="btn-group btn-drop">
        <button class="btn dropdown-toggle btn-s" type="button">选中项 <i class="i-caret-down"></i></button>
        <ul class="dropdown-menu"><li><a href="#" id="btn-delete-selected">删除</a></li></ul>
      </div>
      <button class="btn primary btn-s" id="btn-upload">上传文件</button>
      <button class="btn btn-s" id="btn-new-folder">新建文件夹</button>
      <span id="webdav-loading" style="display:none;margin-left:8px;vertical-align:middle" class="loading">加载中...</span>
    </div>
  </div>
  <div class="webdav-breadcrumb" style="margin:0 0 1em;padding:8px 12px;background:#FFF;border-radius:2px;font-size:.92857em">
    <a href="#" data-path="" class="breadcrumb-link">根目录</a><span id="breadcrumb-path"></span>
  </div>
  <div class="typecho-table-wrap" id="webdav-table-wrap">
    <table class="typecho-list-table">
      <colgroup><col width="20"><col width="40%"><col width="15%"><col width="20%"><col width="15%"></colgroup>
      <thead><tr><th><input type="checkbox" class="typecho-table-select-all"></th><th>名称</th><th>大小</th><th>修改时间</th><th>操作</th></tr></thead>
      <tbody id="file-list-body"><tr><td colspan="5"><h6 class="typecho-list-table-title"><span class="loading">加载中...</span></h6></td></tr></tbody>
    </table>
  </div>
  <div id="webdav-drop-zone" style="margin-top:1em;padding:2em;border:2px dashed #D9D9D6;text-align:center;color:#999;border-radius:2px;display:none">
    <p style="margin:0;font-size:1em">拖拽文件到此处上传</p>
    <p style="margin:4px 0 0;font-size:.857em">支持文件夹上传</p>
  </div>
  <div id="upload-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.45);z-index:1000"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#FFF;padding:24px;border-radius:4px;width:400px;max-width:90vw"><h3 style="margin:0 0 16px;font-size:1.1em">上传文件</h3><p style="color:#999;font-size:.92857em;margin:0 0 12px">上传到：<span id="upload-dir-path">/</span></p><input type="file" id="upload-file-input" multiple style="margin-bottom:12px;width:100%" webkitdirectory=""><progress id="upload-progress" value="0" max="100" style="width:100%;display:none;margin-bottom:12px"></progress><div style="text-align:right"><button class="btn btn-s" id="btn-upload-cancel">取消</button><button class="btn primary btn-s" id="btn-upload-confirm">上传</button></div></div></div>
  <div id="mkdir-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.45);z-index:1000"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#FFF;padding:24px;border-radius:4px;width:360px;max-width:90vw"><h3 style="margin:0 0 16px;font-size:1.1em">新建文件夹</h3><p style="color:#999;font-size:.92857em;margin:0 0 12px">在 <span id="mkdir-dir-path">/</span> 下创建</p><input type="text" id="mkdir-name-input" class="text w-100" placeholder="文件夹名称" style="margin-bottom:12px"><div style="text-align:right"><button class="btn btn-s" id="btn-mkdir-cancel">取消</button><button class="btn primary btn-s" id="btn-mkdir-confirm">创建</button></div></div></div>
  <div id="rename-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.45);z-index:1000"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#FFF;padding:24px;border-radius:4px;width:360px;max-width:90vw"><h3 style="margin:0 0 16px;font-size:1.1em">重命名</h3><input type="text" id="rename-input" class="text w-100" placeholder="新名称" style="margin-bottom:12px"><div style="text-align:right"><button class="btn btn-s" id="btn-rename-cancel">取消</button><button class="btn primary btn-s" id="btn-rename-confirm">确认</button></div></div></div>
</div>
<style>
.webdav-breadcrumb a{color:#467B96;text-decoration:none}.webdav-breadcrumb a:hover{text-decoration:underline}
.webdav-breadcrumb span{color:#999}
.file-link{color:#444;text-decoration:none}.file-link:hover{color:#467B96;text-decoration:none}
.folder-icon{color:#E8A838;margin-right:4px}.file-icon{color:#999;margin-right:4px}
#webdav-drop-zone.drag-over{background:#FFFBCC;border-color:#467B96;color:#467B96}
</style>
<script>
(function(){
var csrf=${JSON.stringify(csrf)},curPath="",entries=[],renameTarget="";

var _noticeTimer;function notice(msg,type){clearTimeout(_noticeTimer);var n=document.getElementById("webdav-notice");n.style.display="block";n.className="message "+(type==="success"?"success":type==="error"?"error":"notice");n.innerHTML='<p>'+E(msg)+'</p><button type="button" class="typecho-notice-close">&times;</button>';var b=n.querySelector(".typecho-notice-close");if(b)b.addEventListener("click",function(){n.style.display="none"});_noticeTimer=setTimeout(function(){n.style.display="none"},5000)}
function showLoading(){document.getElementById("webdav-loading").style.display="inline-block"}
function hideLoading(){document.getElementById("webdav-loading").style.display="none"}

function E(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function BP(p){if(!p)return"";var a=p.split("/").filter(Boolean),h="",c="",i;for(i=0;i<a.length;i++){c+="/"+a[i];h+=' / <a href="#" data-path="'+E(c.charAt(0)==="/" ? c.slice(1) : c)+'" class="breadcrumb-link">'+E(a[i])+"</a>"}return h}
function BS(b){if(!b||b===0)return"-";return b<1024?b+" B":b<1048576?Math.ceil(b/1024)+" KB":(b/1048576).toFixed(1)+" MB"}
function FD(d){if(!d)return"-";try{return new Date(d).toLocaleString()}catch(e){return d}}
function MI(n,f){if(f)return'<span class="folder-icon">&#128193;</span>';var x=n.split(".").pop().toLowerCase();var m={jpg:1,jpeg:1,png:1,gif:1,webp:1,svg:1,bmp:1,ico:1,avif:1,mp4:2,webm:2,avi:2,mov:2,mkv:2,mp3:3,wav:3,flac:3,aac:3,ogg:3,zip:4,rar:4,"7z":4,tar:4,gz:4,bz2:4,js:5,ts:5,jsx:5,tsx:5,py:5,rb:5,go:5,rs:5,java:5,c:5,cpp:5,h:5,css:5,html:5,xml:5,json:5,yaml:5,yml:5,pdf:6};var t=m[x]||0;if(t===1)return'<span class="file-icon" style="color:#5A9E5F">&#128247;</span>';if(t===2)return'<span class="file-icon" style="color:#6A5ACD">&#127910;</span>';if(t===3)return'<span class="file-icon" style="color:#D2691E">&#127925;</span>';if(t===4)return'<span class="file-icon" style="color:#8B7355">&#128230;</span>';if(t===5)return'<span class="file-icon" style="color:#467B96">&#128221;</span>';if(t===6)return'<span class="file-icon" style="color:#C0392B">&#128214;</span>';return'<span class="file-icon">&#128196;</span>'}
async function LD(p){showLoading();curPath=p;document.getElementById("breadcrumb-path").innerHTML=BP(p);try{var r=await fetch("/api/admin/webdav?action=list&path="+encodeURIComponent(p),{headers:{"X-CSRF-Token":csrf}});if(!r.ok)throw new Error("Server error ("+r.status+")");var j=await r.json();if(!j.success)throw new Error(j.error);entries=[];var d=j.data;(d.prefixes||[]).forEach(function(x){var nm=x.replace(/\\/$/,"").split("/").pop()||x;entries.push({name:nm,isFolder:true,size:0,lastModified:"",fullKey:x})});(d.objects||[]).forEach(function(x){var nm=x.key.split("/").pop()||x.key;entries.push({name:nm,isFolder:false,size:x.size,lastModified:x.lastModified,etag:x.etag,fullKey:x.key})});RT()}catch(e){document.getElementById("file-list-body").innerHTML='<tr><td colspan="5"><h6 class="typecho-list-table-title">加载失败：'+E(e.message)+'</h6></td></tr>'}finally{hideLoading()}}
function RT(){if(!entries.length){document.getElementById("file-list-body").innerHTML='<tr><td colspan="5"><h6 class="typecho-list-table-title">此目录为空</h6></td></tr>';return}var h=entries.map(function(e,i){var ep=(curPath?curPath+"/":"")+e.name;var dp=e.isFolder?ep+"/":ep;var ca=e.isFolder?'href="#" data-nav="'+E(dp)+'"':'href="/api/admin/webdav?action=download&path='+encodeURIComponent(ep)+'" target="_blank"';return'<tr><td><input type="checkbox" value="'+E(dp)+'" data-is-folder="'+(e.isFolder?"1":"0")+'"></td><td><a class="file-link" '+ca+'>'+MI(e.name,e.isFolder)+E(e.name)+(e.isFolder?"/":"")+'</a></td><td>'+(e.isFolder?"-":BS(e.size))+'</td><td>'+FD(e.lastModified)+'</td><td><a href="#" class="rename-link" data-path="'+E(ep)+'" data-is-folder="'+(e.isFolder?"1":"0")+'" title="重命名" style="margin-right:8px"><i class="i-edit"></i></a><a href="#" class="delete-link" data-path="'+E(dp)+'" title="删除"><i class="i-delete"></i></a></td></tr>'});document.getElementById("file-list-body").innerHTML=h.join("");document.querySelectorAll(".typecho-table-select-all").forEach(function(cb){cb.checked=false})}
document.addEventListener("click",function(e){var t=e.target;if(t.classList.contains("breadcrumb-link")){e.preventDefault();LD(t.dataset.path||"")}if(t.closest(".delete-link")){e.preventDefault();var p=t.closest(".delete-link").dataset.path;if(!p||p==="/"){notice("挂载根目录不允许删除","error");return}if(confirm("确认删除 "+p+" ？此操作不可撤销。"))DI([p])}if(t.closest(".rename-link")){e.preventDefault();var l=t.closest(".rename-link");renameTarget=l.dataset.path;var nm=renameTarget.replace(/\\/+$/,"").split("/").pop()||renameTarget;document.getElementById("rename-input").value=nm;document.getElementById("rename-modal").style.display="block";document.getElementById("rename-input").focus();document.getElementById("rename-input").select()}var nav=t.closest("[data-nav]");if(nav){e.preventDefault();LD(nav.dataset.nav)}});
async function DI(paths){showLoading();try{var r=await fetch("/api/admin/webdav",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({action:"delete",paths:paths})});if(!r.ok)throw new Error("Server error ("+r.status+")");var j=await r.json();if(!j.success)throw new Error(j.error);notice("删除成功","success");LD(curPath)}catch(e){notice("删除失败："+e.message,"error");hideLoading()}}
document.getElementById("btn-delete-selected").addEventListener("click",function(e){e.preventDefault();var cbs=document.querySelectorAll("#file-list-body input[type=checkbox]:checked");if(!cbs.length){notice("请先选择要删除的项目","notice");return}var ps=[],hasRoot=false;for(var j=0;j<cbs.length;j++){var v=cbs[j].value;if(!v||v==="/"){hasRoot=true;continue}ps.push(v)}if(hasRoot)notice("挂载根目录不允许删除，已跳过","error");if(!ps.length)return;if(confirm("确认删除选中的 "+ps.length+" 个项目？此操作不可撤销。"))DI(ps)});
document.getElementById("btn-upload").addEventListener("click",function(){document.getElementById("upload-dir-path").textContent=curPath?"/"+curPath+"/":"/";document.getElementById("upload-modal").style.display="block";document.getElementById("upload-file-input").value="";var p=document.getElementById("upload-progress");p.style.display="none";p.value=0});
document.getElementById("btn-upload-cancel").addEventListener("click",function(){document.getElementById("upload-modal").style.display="none"});
document.getElementById("btn-upload-confirm").addEventListener("click",async function(){var fs=document.getElementById("upload-file-input").files;if(!fs||!fs.length){notice("请选择文件","notice");return}var p=document.getElementById("upload-progress");p.style.display="block";p.value=0;var ok=0;for(var i=0;i<fs.length;i++){await uploadFile(fs[i],curPath||"/",function(v){ok+=v;p.value=Math.round(ok/fs.length*100)})}document.getElementById("upload-modal").style.display="none";LD(curPath)});
async function uploadFile(file,dirPath,onProgress){var fd=new FormData();fd.append("action","upload");fd.append("path",dirPath);fd.append("file",file,file.name);try{showLoading();var r=await fetch("/api/admin/webdav",{method:"POST",headers:{"X-CSRF-Token":csrf},body:fd});if(!r.ok)throw new Error("Server error ("+r.status+")");var j=await r.json();if(!j.success)throw new Error(j.error);onProgress&&onProgress(1)}catch(e){notice("上传 "+file.name+" 失败："+e.message,"error");onProgress&&onProgress(0)}finally{hideLoading()}}
document.getElementById("btn-new-folder").addEventListener("click",function(){document.getElementById("mkdir-dir-path").textContent=curPath?"/"+curPath+"/":"/";document.getElementById("mkdir-modal").style.display="block";document.getElementById("mkdir-name-input").value="";document.getElementById("mkdir-name-input").focus()});
document.getElementById("btn-mkdir-cancel").addEventListener("click",function(){document.getElementById("mkdir-modal").style.display="none"});
document.getElementById("btn-mkdir-confirm").addEventListener("click",async function(){var n=document.getElementById("mkdir-name-input").value.trim();if(!n){notice("请输入文件夹名称","notice");return}var p=curPath?curPath+"/"+n:n;showLoading();try{var r=await fetch("/api/admin/webdav",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({action:"mkdir",path:p})});if(!r.ok)throw new Error("Server error ("+r.status+")");var j=await r.json();if(!j.success)throw new Error(j.error);document.getElementById("mkdir-modal").style.display="none";notice("文件夹创建成功","success");LD(curPath)}catch(e){notice("创建失败："+e.message,"error");hideLoading()}});
document.getElementById("btn-rename-cancel").addEventListener("click",function(){document.getElementById("rename-modal").style.display="none"});
document.getElementById("btn-rename-confirm").addEventListener("click",async function(){var nn=document.getElementById("rename-input").value.trim();if(!nn){notice("请输入新名称","notice");return}var ps=renameTarget.replace(/\\/+$/,"").split("/");ps.pop();var pp=ps.join("/");var np=pp?pp+"/"+nn:nn;showLoading();try{var r=await fetch("/api/admin/webdav",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({action:"rename",path:renameTarget.replace(/\\/+$/,""),newPath:np})});if(!r.ok)throw new Error("Server error ("+r.status+")");var j=await r.json();if(!j.success)throw new Error(j.error);document.getElementById("rename-modal").style.display="none";notice("重命名成功","success");LD(curPath)}catch(e){notice("重命名失败："+e.message,"error");hideLoading()}});
document.querySelectorAll("#upload-modal, #mkdir-modal, #rename-modal").forEach(function(m){m.addEventListener("click",function(e){if(e.target===m)m.style.display="none"})});
document.addEventListener("keydown",function(e){if(e.key==="Escape"){document.getElementById("upload-modal").style.display="none";document.getElementById("mkdir-modal").style.display="none";document.getElementById("rename-modal").style.display="none"}});
document.getElementById("mkdir-name-input").addEventListener("keydown",function(e){if(e.key==="Enter")document.getElementById("btn-mkdir-confirm").click()});
document.getElementById("rename-input").addEventListener("keydown",function(e){if(e.key==="Enter")document.getElementById("btn-rename-confirm").click()});

// Drag-and-drop
var dropZone=document.getElementById("webdav-drop-zone");
dropZone.style.display="block";
var dragCounter=0;
document.addEventListener("dragenter",function(e){e.preventDefault();dragCounter=Math.min(dragCounter+1,1000);dropZone.style.display="block"});
document.addEventListener("dragleave",function(e){e.preventDefault();dragCounter--;if(dragCounter<=0){dragCounter=0;dropZone.classList.remove("drag-over");dropZone.style.display="none"}});
document.addEventListener("dragend",function(){dragCounter=0;dropZone.classList.remove("drag-over");dropZone.style.display="none"});
dropZone.addEventListener("dragover",function(e){e.preventDefault();e.dataTransfer.dropEffect="copy";dropZone.classList.add("drag-over")});
dropZone.addEventListener("drop",async function(e){e.preventDefault();dropZone.classList.remove("drag-over");dragCounter=0;var items=e.dataTransfer.items;if(!items||!items.length)return;var p=document.getElementById("upload-progress");p.style.display="block";p.value=0;var total=items.length,ok=0;for(var i=0;i<items.length;i++){try{var entry=(items[i].webkitGetAsEntry||items[i].getAsEntry).call(items[i]);if(entry)await processEntry(entry,curPath?curPath+"/":"/",function(v){ok+=v;p.value=Math.round(ok/total*100)})}catch(ex){}}p.style.display="none";notice("上传完成","success");LD(curPath)});
async function processEntry(entry,dirPath,onProgress){if(!entry)return;if(entry.isFile){return new Promise(function(resolve,reject){entry.file(function(file){uploadFile(file,dirPath).then(function(){onProgress&&onProgress(1);resolve()}).catch(function(){onProgress&&onProgress(0);resolve()})},function(){onProgress&&onProgress(0);resolve()})})}else if(entry.isDirectory){var base=dirPath;while(base.endsWith("/")&&base!=="/")base=base.slice(0,-1);var newDir=(base==="/"?"/":base+"/")+entry.name+"/";var dirOk=false;showLoading();try{var mr=await fetch("/api/admin/webdav",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({action:"mkdir",path:newDir})});dirOk=mr.ok;if(!mr.ok)throw new Error("mkdir failed");await new Promise(function(r){setTimeout(r,200)})}catch(e){notice("创建目录失败："+newDir+" "+e.message,"error");hideLoading();if(!dirOk)return}hideLoading();var reader=entry.createReader();var subEntries=[];var batch;do{batch=await new Promise(function(resolve){reader.readEntries(resolve)});subEntries=subEntries.concat(Array.from(batch))}while(batch.length>0);for(var i=0;i<subEntries.length;i++){await processEntry(subEntries[i],newDir,onProgress)}}
}

LD("");
})();
</script>`;
    },
  );

  // Inject "WebDav" menu item into admin nav bar under "管理"
  addHook(
    'admin:footer',
    pluginId,
    (html: string, extra?: { activeMenu?: string; user?: { group?: string } }) => {
      const isAdmin = extra?.user?.group && hasPermission(extra.user.group, 'administrator');
      if (!isAdmin) return html;

      const isActive = extra?.activeMenu === 'webdav';
      const extraHtml = `<script>
(function(){
  var mgmt = document.querySelector('#typecho-nav-list ul.root:nth-child(3) ul.child');
  if (mgmt) {
    var li = document.createElement('li');
    li.className = '${isActive ? 'focus' : ''}';
    li.innerHTML = '<a href="/admin/plugin/webdav">WebDav</a>';
    mgmt.appendChild(li);
  }
})();
</script>`;
      return html + extraHtml;
    },
  );
}
