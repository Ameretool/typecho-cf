# Project Hardening Implementation Plan

- [x] 1. Establish validated input and configuration foundations
  - Add bounded form parsing, bounded page parsing, query preservation, and Unicode-safe slug normalization to `src/lib/input.ts`.
  - Add shared request-size constants and stable 4xx input errors.
  - Add `src/lib/options-input.ts` for Site Option URL, range, enum, boolean, and Permalink Pattern validation.
  - Persist valid Site Options through one semantic batch and invalidate the option cache once; reject invalid batches without partial writes.
  - Add unit tests for declared-size rejection, malformed pages, query construction, slug normalization, valid option batches, and negative schema cases.
  - _Requirements: R7, R8, R9, R13, R14_

- [x] 2. Deepen Plugin Configuration into one security boundary
  - Add `src/lib/plugin-config.ts` with masked read and canonical save Interfaces.
  - Recursively mask top-level and repeatable `password`/`hidden` fields, restore unchanged sentinels, and allow only manifest-declared keys.
  - Centralize active-plugin checks, authorization inputs, validation timeout, `plugin:config:beforeSave`, persistence, and cache invalidation.
  - Route both HTML form and JSON saves through the same Module; return only masked configuration data and use safe redirects for form submissions.
  - Add positive and negative tests for nested masking, sentinel restoration, omitted/default fields, inactive plugins, Origin/CSRF enforcement, timeout/error handling, and response secret leakage.
  - _Requirements: R1, R13, R14_

- [x] 3. Make password changes invalidate existing Sessions
  - Enforce the centralized password minimum in install, registration, profile, user administration, and password reset flows.
  - Require and verify the current password for self-service profile changes.
  - Write a fresh `authCode` with every changed/reset password, clear current auth Cookies after a profile password change, and redirect to login.
  - Reject reset confirmation mismatches before consuming or mutating the reset request.
  - Add regressions proving old Cookies fail, current-password failures are rejected, confirmation mismatches preserve reset tokens, and all entry points share the policy.
  - _Requirements: R2, R9, R14_

- [x] 4. Make login failure tracking atomic
  - Replace read/modify/write failure tracking with one SQLite/D1-compatible UPSERT that resets expired windows, increments live windows, and derives bans atomically.
  - Keep successful-login clearing observable to subsequent checks.
  - Add threshold, window-reset, clear, and concurrent failure regression tests.
  - _Requirements: R3, R14_

- [x] 5. Scope D1 Sessions and Request Core to one request
  - Stop caching Drizzle clients backed by mutable `D1DatabaseSession` objects across requests.
  - Reuse one database handle inside each Request Core and retain any bookmark only for that logical request.
  - Audit module-level caches to ensure they contain no request-scoped I/O objects.
  - Add tests proving within-request reuse and cross-request Session isolation.
  - _Requirements: R5, R13, R14_

- [x] 6. Introduce the Request Bootstrap and response finalization seam
  - Add `src/lib/request-bootstrap.ts` for bounded pagination target resolution, request initialization, and plugin-aware response finalization.
  - Refactor middleware so `/page/N/` rewrites continue through option loading, activation, plugin routing, edge-cache policy, and common security headers.
  - Keep the original URL as the cache key, use the effective path for matching, and expose both to plugin route metadata.
  - Route install, static, plugin, cache-hit, rewrite, and normal responses through the same finalization policy.
  - Add regressions for rewritten pagination, plugin routing/CSP, cache behavior, and every early response family.
  - _Requirements: R7, R11, R13, R14_

- [x] 7. Centralize Attachment Lifecycle deletion
  - Add `src/lib/attachment-lifecycle.ts` to normalize IDs, load once, authorize by current actor and content author, parse metadata, delete R2 objects, run Hooks, and delete rows set-wise.
  - Use structured, secret-free orphan diagnostics and the documented policy that R2 failure does not block row cleanup.
  - Refactor detail, list, batch, and editor deletion adapters to use the canonical Module.
  - Add tests for allowed, forbidden, missing, malformed-metadata, R2-failure, Hook, deduplication, and equivalent adapter behavior.
  - _Requirements: R6, R13, R14, R15_

- [x] 8. Make Comment Ownership follow current content ownership
  - Refactor comment lists, moderation checks, dashboard/profile statistics, and status totals to join/filter on `contents.authorId`.
  - Keep `comments.ownerId` only as a compatibility snapshot and remove it from authorization decisions.
  - Add reassignment regressions proving the old author loses and the new author gains visibility and moderation rights.
  - _Requirements: R4, R14_

- [x] 9. Enforce slug, pagination, and admin filter invariants
  - Normalize and uniquely resolve content, category, tag, and attachment slugs in their documented namespaces.
  - Fail installation when inserted IDs are not returned instead of assuming identifier `1`.
  - Bound admin page/UID inputs and preserve active post/comment filters across counts, pagination, and user article links.
  - Add regressions for unsafe/empty/conflicting slugs, missing install returns, hostile page values, author scope, and retained filter query strings.
  - _Requirements: R7, R8, R14_

- [x] 10. Bound public/admin request bodies and stream uploads
  - Apply the endpoint-class body limits to authentication, registration, reset, comment, admin, and Plugin Configuration forms before body parsing.
  - Preserve field-level limits for requests without `Content-Length` and return consistent 4xx errors for malformed or oversized bodies.
  - Enforce the multipart envelope and file limit, then stream the accepted file to R2 without a duplicate full-buffer copy.
  - Add positive and negative endpoint tests, including missing, malformed, and deceptive `Content-Length` cases.
  - _Requirements: R9, R14_

- [x] 11. Revalidate plugin Write Filter output
  - Restore protected identity, ownership, relationship, and type fields after comment/content Filters.
  - Validate permitted mutable fields, enums, lengths, numbers, status, and normalized slug before persistence.
  - Compute counters and relationships from the final validated record.
  - Document the mutable-field contracts in the plugin README and admin Hook reference.
  - Add malicious Filter regressions for ownership/type/cid mutation and valid transformation coverage.
  - _Requirements: R10, R14_

- [x] 12. Complete admin accessibility behavior
  - Remove browser zoom restrictions from authentication pages.
  - Add `aria-controls`, `aria-haspopup`, and synchronized `aria-expanded` state to mobile navigation and dropdown controls.
  - Add Enter/Space activation, Escape/outside-click dismissal, focus return, and visible `:focus-visible` styling without redesigning the admin theme.
  - Add DOM/render regressions for semantic state and keyboard behavior.
  - _Requirements: R12, R14_

- [x] 13. Generate Worker bindings and improve diagnostics/static checks
  - Replace duplicate hand-authored Worker bindings with Wrangler-generated types and add a repeatable `types:workers` script.
  - Enable searchable logs and sampled traces in the example Wrangler configuration and document binding regeneration.
  - Convert changed diagnostics to structured, credential-free records.
  - Add type-aware ESLint with `@typescript-eslint/no-floating-promises`, excluding generated/build output, and fix violations in Worker request paths.
  - _Requirements: R15_

- [x] 14. Run full verification and close traceability
  - Run `pnpm run lint`, `pnpm run test`, `pnpm run typecheck`, and `pnpm run build`.
  - Resolve failures without editing generated files under `drizzle/` manually.
  - Recheck each requirement against its regression coverage and update this checklist to reflect completed work.
  - _Requirements: R14, R15_

## Verification record — 2026-08-02

- `pnpm run lint`: passed with type-aware `@typescript-eslint/no-floating-promises`.
- `pnpm run typecheck`: passed using generated Workers bindings.
- `pnpm run test`: 86 files passed, 914 tests passed after the documentation consistency regression checks.
- `pnpm run build`: Astro Cloudflare production build passed.
- Requirements R1–R15 are mapped to completed tasks above; generated `drizzle/` files were not edited.
