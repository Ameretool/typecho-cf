/**
 * Cross-cutting constants.
 * Prefer importing named constants over inline magic numbers.
 */

/** Minimum password length enforced by install, register, admin user create/update, and profile flows. */
export const PASSWORD_MIN_LENGTH = 12;

/** Slug fallback suffix cap in install.ts to prevent theoretical infinite loops on pathological data. */
export const SLUG_RESOLVE_MAX_SUFFIX = 1000;

/** Per-user upload rate limit (uploads per window). */
export const UPLOAD_RATE_LIMIT = { windowSeconds: 60, maxRequests: 60 } as const;

/** Options cache TTL (seconds). */
export const OPTIONS_CACHE_TTL_SECONDS = 600;

/** Plugin config apply hook timeout (ms). */
export const PLUGIN_CONFIG_TIMEOUT_MS = 5_000;

/** Maximum page number accepted from untrusted pagination input. */
export const MAX_PAGE_NUMBER = 10_000;

/** Declared request-body limits grouped by endpoint risk and payload shape. */
export const REQUEST_BODY_LIMITS = {
  auth: 16 * 1024,
  publicForm: 64 * 1024,
  adminForm: 256 * 1024,
  uploadEnvelope: 11 * 1024 * 1024,
  uploadFile: 10 * 1024 * 1024,
} as const;
