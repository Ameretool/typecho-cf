import type { WebDavConfig, StorageMount, S3Object } from './types';
import {
  resolveWebDavTarget, normalizeRoutePath, matchWebDavRoute,
  withMountPrefix, stripMountPrefix, isCollectionPath, href,
  getWebDavClientIp, isWebDavClientBanned, recordWebDavAuthFailure,
  clearWebDavAuthFailures, authenticate, encodePathSegment, encodeKeyPath,
} from './config';
import {
  listObjects, objectMeta, collectionExists, s3Fetch, getR2Bucket,
  tianyiResolvePath, tianyiGetDownloadUrl, tianyiCreateFolder,
  tianyiDeleteFile, tianyiDeleteFolder, tianyiRenameFile,
  tianyiEnsureSession, TIANYI_API_BASE, TIANYI_UA,
} from './adapters';

// --- Constants ---

const ALLOWED_METHODS = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE';
const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };

// --- XML / HTML Helpers ---

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function responseXml(
  itemHref: string, displayName: string, collection: boolean,
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
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`,
    { status: 207, headers: XML_HEADERS },
  );
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
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
    '<body><main>',
    `<h1>${escapeXml(title)}</h1>`,
    items.length > 0 ? `<ul>${items.join('')}</ul>` : '<p>This WebDAV collection is empty.</p>',
    '</main></body>',
    '</html>',
  ].join('');
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: ALLOWED_METHODS, DAV: '1, 2', 'MS-Author-Via': 'DAV', 'Cache-Control': 'no-store',
    },
  });
}

// --- WebDAV Protocol Handlers ---

async function propfindRoot(config: WebDavConfig, depth: string): Promise<Response> {
  const responses = [responseXml(href(config.routePath, [], true), 'WebDAV', true)];
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
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const items = config.mounts.map(mount => {
    const label = mount.mount || 'Root storage';
    return `<li><a href="${escapeXml(href(config.routePath, [mount.mount], true))}">${escapeXml(label)}/</a></li>`;
  });
  return htmlResponse(htmlPage('WebDAV', items));
}

async function browserMountListing(
  config: WebDavConfig, mount: StorageMount, key: string,
  method: string, workerEnv?: Record<string, unknown>,
): Promise<Response> {
  if (method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const cleanKey = key.replace(/^\/+|\/+$/g, '');
  const fullKey = withMountPrefix(mount, cleanKey);
  const prefix = fullKey && !fullKey.endsWith('/') ? `${fullKey}/` : fullKey;
  const listing = await listObjects(mount, prefix, workerEnv);
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

  return htmlResponse(htmlPage(basePartsLen(mount, cleanKey), items));
}

function basePartsLen(mount: StorageMount, cleanKey: string): string {
  const parts = [...(mount.mount ? [mount.mount] : []), ...cleanKey.split('/').filter(Boolean)];
  return parts.length > 0 ? `WebDAV / ${parts.join('/')}` : 'WebDAV';
}

async function propfindMount(
  config: WebDavConfig, mount: StorageMount, key: string,
  depth: string, workerEnv?: Record<string, unknown>,
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
  method: string, mount: StorageMount, key: string,
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
    if (method === 'HEAD') return new Response(null, { status: 200 });
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
  request: Request, mount: StorageMount, key: string,
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
    const fullKey = withMountPrefix(mount, key);
    const lastSlash = fullKey.lastIndexOf('/');
    const parentPath = lastSlash >= 0 ? fullKey.slice(0, lastSlash) : '';
    const fileName = lastSlash >= 0 ? fullKey.slice(lastSlash + 1) : fullKey;
    const parent = await tianyiResolvePath(mount, parentPath || '');
    if (!parent || !parent.isFolder) return new Response('Parent folder not found', { status: 404 });
    const cookie = await tianyiEnsureSession(mount);
    const form = new FormData();
    form.append('folderId', parent.id);
    form.append('file', request.body instanceof Blob ? request.body : new Blob([await request.arrayBuffer()]), fileName);
    const uploadUrl = `${TIANYI_API_BASE}/api/open/file/uploadFile.action`;
    const uploadResp = await fetch(uploadUrl, { method: 'POST', headers: { 'Cookie': cookie, 'Referer': 'https://cloud.189.cn/', 'User-Agent': TIANYI_UA }, body: form });
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
  try { pathname = new URL(destinationHeader).pathname; } catch { /* relative header */ }
  const relative = matchWebDavRoute(config.routePath, pathname);
  if (relative === null) return null;
  const target = resolveWebDavTarget(config, relative);
  if (!target) return null;
  return { mountName: target.mount.mount, key: target.key };
}

async function handleCopyMove(
  request: Request, config: WebDavConfig, sourceMount: StorageMount,
  sourceKey: string, move: boolean, workerEnv?: Record<string, unknown>,
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
    if (move) await bucket.delete(withMountPrefix(sourceMount, sourceKey));
    return new Response(null, { status: 201 });
  }

  if (sourceMount.provider === 'tianyi') {
    const cleanSource = sourceKey.replace(/\/+$/, '');
    const cleanDest = destination.key.replace(/\/+$/, '');
    const source = await tianyiResolvePath(sourceMount, cleanSource);
    if (!source) return new Response('Not Found', { status: 404 });

    const destSlash = cleanDest.lastIndexOf('/');
    const destParentPath = destSlash >= 0 ? cleanDest.slice(0, destSlash) : '';
    const destName = destSlash >= 0 ? cleanDest.slice(destSlash + 1) : cleanDest;
    const destParent = await tianyiResolvePath(sourceMount, destParentPath || '/');
    if (!destParent || !destParent.isFolder) return new Response('Destination folder not found', { status: 409 });

    const srcSlash = cleanSource.lastIndexOf('/');
    const srcParentPath = srcSlash >= 0 ? cleanSource.slice(0, srcSlash) : '';
    const srcParent = srcParentPath ? await tianyiResolvePath(sourceMount, srcParentPath) : { id: sourceMount.rootDir || '-11', isFolder: true, name: '' };
    const sameParent = srcParent && destParent.id === srcParent.id;

    if (!move) {
      await tianyiCopyFile(sourceMount, source.id, destParent.id);
      if (destName && destName !== source.name) {
        let copied = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 200));
          copied = await tianyiResolvePath(sourceMount, (destParentPath ? destParentPath + '/' : '') + source.name);
          if (copied) break;
        }
        if (copied && !copied.isFolder) await tianyiRenameFile(sourceMount, copied.id, destName);
      }
    } else if (sameParent) {
      await tianyiRenameFile(sourceMount, source.id, destName);
    } else {
      await tianyiMoveFile(sourceMount, source.id, destParent.id);
      if (destName !== source.name) {
        let moved = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 200));
          moved = await tianyiResolvePath(sourceMount, (destParentPath ? destParentPath + '/' : '') + source.name);
          if (moved) break;
        }
        if (moved && !moved.isFolder) await tianyiRenameFile(sourceMount, moved.id, destName);
      }
    }
    return new Response(null, { status: 201 });
  }

  const copySource = `/${encodePathSegment(sourceMount.bucket)}/${encodeKeyPath(withMountPrefix(sourceMount, sourceKey))}`;
  const copyResponse = await s3Fetch(
    sourceMount, 'PUT', withMountPrefix(sourceMount, destination.key), {},
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

// --- Main Dispatcher ---

export async function handleWebDavRequest(config: WebDavConfig, relativePath: string, extra: {
  request?: Request; url?: URL; path?: string; db?: unknown; options?: Record<string, unknown>; env?: Record<string, unknown>;
}): Promise<Response> {
  const request = extra.request!;
  if (request.method === 'OPTIONS') return optionsResponse();

  if (!extra.db) return new Response('Database unavailable', { status: 503 });
  const clientIp = getWebDavClientIp(request);
  const hasBasicAuthAttempt = /^Basic\s+/i.test(request.headers.get('authorization') || '');
  if (hasBasicAuthAttempt && isWebDavClientBanned(config, clientIp)) {
    return new Response('Too many failed login attempts', {
      status: 429,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': String(config.failBanSeconds) },
    });
  }

  const authResult = await authenticate(request, extra.db as any);
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

// --- Storage Adapter for Admin API ---

export function createStorageAdapter(config: WebDavConfig): {
  list(path: string, workerEnv?: Record<string, unknown>, limit?: number, offset?: number): Promise<S3ListResult>;
  meta(path: string, workerEnv?: Record<string, unknown>): Promise<S3Object | null>;
  read(path: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  write(path: string, body: ReadableStream<Uint8Array> | null, contentType: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  mkdir(path: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  delete(path: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  getMounts(): { name: string; provider: string }[];
} {
  return {
    list(path, workerEnv, limit, offset) {
      const target = resolveWebDavTarget(config, path);
      if (!target) throw new Error('Invalid path');
      const prefix = target.mount.prefix ? `${target.mount.prefix}/${target.key}` : target.key;
      const listPrefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
      return listObjects(target.mount, listPrefix, workerEnv, limit, offset);
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
        await bucket.put(fullKey, body, { httpMetadata: contentType ? { contentType } : undefined });
        return new Response(null, { status: 201 });
      }
      if (target.mount.provider === 'tianyi') {
        const fullKey = withMountPrefix(target.mount, target.key);
        const lastSlash = fullKey.lastIndexOf('/');
        const parentPath = lastSlash >= 0 ? fullKey.slice(0, lastSlash) : '';
        const fileName = lastSlash >= 0 ? fullKey.slice(lastSlash + 1) : fullKey;
        const parent = await tianyiResolvePath(target.mount, parentPath || '/');
        if (!parent || !parent.isFolder) throw new Error('Parent folder not found');
        const cookie = await tianyiEnsureSession(target.mount);
        const form = new FormData();
        form.append('folderId', parent.id);
        if (body) {
          const buf = await new Response(body).arrayBuffer();
          form.append('file', new Blob([buf]), fileName);
        }
        const uploadUrl = `${TIANYI_API_BASE}/api/open/file/uploadFile.action`;
        const uploadResp = await fetch(uploadUrl, { method: 'POST', headers: { 'Cookie': cookie, 'Referer': 'https://cloud.189.cn/', 'User-Agent': TIANYI_UA }, body: form });
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
