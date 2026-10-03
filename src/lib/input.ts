import { MAX_PAGE_NUMBER, REQUEST_BODY_LIMITS } from '@/lib/constants';

export class InputError extends Error {
  constructor(
    public readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
    this.name = 'InputError';
  }
}

/**
 * Read a bounded admin form body, returning a Response on size/parse errors
 * so call sites can `if (formData instanceof Response) return formData`.
 */
export async function readAdminFormOrError(
  request: Request,
  maxBytes: number = REQUEST_BODY_LIMITS.adminForm,
): Promise<FormData | Response> {
  try {
    return await readBoundedFormData(request, maxBytes);
  } catch (error) {
    if (error instanceof InputError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
}

/**
 * Reject an oversized declared body before invoking the runtime multipart or
 * URL-encoded parser. Field-level limits are still required by callers because
 * chunked requests legitimately omit Content-Length.
 */
export function assertBoundedContentLength(request: Request, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength.trim())) {
      throw new InputError(400, 'Invalid Content-Length');
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) {
      throw new InputError(400, 'Invalid Content-Length');
    }
    if (declaredBytes > maxBytes) {
      throw new InputError(413, 'Request body too large');
    }
  }
}

export async function readBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  const body = await readBoundedBody(request, maxBytes);

  try {
    const contentType = request.headers.get('content-type');
    return await new Response(body, {
      headers: contentType ? { 'content-type': contentType } : undefined,
    }).formData();
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(400, 'Malformed form data');
  }
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  assertBoundedContentLength(request, maxBytes);
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* preserve the 413 response */ }
        throw new InputError(413, 'Request body too large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(400, 'Malformed request body');
  } finally {
    reader.releaseLock();
  }

  const body = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Enforce the real byte count for chunked JSON bodies before JSON.parse. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const body = await readBoundedBody(request, maxBytes);
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(400, 'Malformed JSON');
  }
}

export interface ParsePageNumberOptions {
  defaultValue?: number;
  max?: number;
}

export function parsePositiveInteger(value: unknown, max = 2_147_483_647): number | null {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) return null;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}

/** Parse an untrusted page value into a finite, bounded, positive integer. */
export function parsePageNumber(
  value: unknown,
  { defaultValue = 1, max = MAX_PAGE_NUMBER }: ParsePageNumberOptions = {},
): number {
  const safeMax = Number.isSafeInteger(max) && max > 0 ? max : MAX_PAGE_NUMBER;
  const safeDefault = Number.isSafeInteger(defaultValue) && defaultValue > 0
    ? Math.min(defaultValue, safeMax)
    : 1;

  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || raw === null || raw === undefined) return safeDefault;
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) return safeDefault;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return safeDefault;
  return Math.min(parsed, safeMax);
}

/**
 * Produce a path-segment-safe, Unicode-preserving slug. Compatibility and
 * combining characters are normalized before unsafe URL characters are
 * removed. Callers remain responsible for namespace uniqueness.
 */
export function normalizeSlug(value: unknown, fallback = ''): string {
  const normalize = (candidate: string): string => {
    const sanitized = candidate
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\p{C}\p{Z}\s/\\?#%]+/gu, '-')
    .replace(/[^\p{L}\p{N}\p{M}._~-]+/gu, '-')
    .replace(/-+/g, '-')
      .replace(/^[._~-]+|[._~-]+$/g, '');
    return [...sanitized].slice(0, 150).join('').replace(/[._~-]+$/g, '');
  };

  return normalize(String(value ?? '')) || normalize(fallback);
}

export type QueryParamValue = string | number | boolean | null | undefined;

/** Merge query values into a relative path while omitting empty values. */
export function withQueryParams(
  path: string,
  values: Record<string, QueryParamValue>,
): string {
  const url = new URL(path, 'http://typecho-cf.local');
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '') {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
