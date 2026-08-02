# Project Hardening Requirements

## 1. Problem statement

Typecho-CF already has broad automated coverage and established security helpers, but several request paths duplicate security-sensitive behavior or bypass the canonical implementation. This change shall fix the security, functional, performance, and accessibility defects found in the 2026-08-02 project review while deepening the modules that own plugin configuration, attachment lifecycle, request bootstrap, and validated input.

## 2. Scope

This specification covers:

- authentication and login-rate-limit hardening;
- plugin configuration secret handling;
- comment visibility and moderation consistency;
- request-scoped D1 access and middleware rewrite consistency;
- attachment deletion consistency;
- validated parsing for settings, slugs, pagination, and request bodies;
- admin filtering, pagination, and password-reset correctness;
- bounded uploads and public form requests;
- admin accessibility improvements;
- regression tests and project documentation for the deepened Modules.

## 3. User stories

### 3.1 Administrators and authors

- As an administrator, I want plugin secrets to remain masked in every management flow so that browser-rendered HTML and JSON responses do not disclose stored credentials.
- As a user, I want changing or resetting my password to invalidate all previously issued sessions.
- As an author, I want comment visibility and moderation rights to follow the current content owner rather than a historical snapshot.
- As an administrator, I want list filters and pagination to preserve my selected scope.
- As an administrator, I want media deletion to behave identically from detail, list, batch, and editor flows.

### 3.2 Site visitors and operators

- As a visitor, I want malformed or oversized requests to fail predictably without destabilizing other requests in the Worker isolate.
- As an operator, I want concurrent failed logins to count reliably and trigger the configured ban.
- As an operator, I want unrelated requests to avoid sharing one mutable D1 Session.
- As an operator, I want invalid settings, slugs, and page numbers rejected or normalized before reaching persistence and queries.

### 3.3 Keyboard and mobile users

- As a keyboard or screen-reader user, I want navigation controls to expose their state and remain operable without a pointer.
- As a mobile user, I want authentication pages to retain browser zoom support.

## 4. Acceptance criteria

### R1 — Plugin configuration secrets

1. When an administrator opens a plugin configuration page, the system shall render password and hidden values as an opaque sentinel or empty value, never as stored plaintext.
2. When a plugin contains repeatable fields with nested password or hidden values, the system shall apply the same masking recursively.
3. When an administrator submits an unchanged secret sentinel, the system shall preserve the previously stored value.
4. When plugin configuration is saved through HTML or JSON, the system shall apply the same authorization, Origin, CSRF, field filtering, validation timeout, persistence, and cache invalidation rules.
5. When plugin configuration is saved successfully, the response shall not include plaintext secret values.

### R2 — Password and session lifecycle

1. When a signed-in user changes their password, the system shall generate a fresh `authCode` in the same logical write as the new password hash.
2. After a password change or reset succeeds, every Cookie signed with the previous `authCode` shall be rejected.
3. When the password reset form contains mismatching password and confirmation values, the system shall reject the request without consuming the reset token.
4. The system shall enforce one centrally defined password policy in install, registration, profile, user management, and reset flows.

### R3 — Atomic login rate limiting

1. When multiple failed logins for one IP occur concurrently, the system shall record every failure without lost updates.
2. When the configured threshold is reached, the system shall atomically set the ban expiry.
3. When a successful login clears failures, subsequent checks shall observe the cleared state.

### R4 — Comment ownership

1. When content ownership changes, the system shall determine comment list visibility, moderation permission, and author statistics from `contents.authorId`.
2. The system shall not use `comments.ownerId` as an authorization source.
3. Regression tests shall cover both the old author losing access and the new author gaining access after reassignment.

### R5 — Request-scoped D1 access

1. When a request creates a database context, the system shall not reuse a mutable `D1DatabaseSession` created for another request.
2. When read-replica consistency is needed within one request, the system shall keep the relevant session and bookmark scoped to that request.
3. Module-level caches shall contain only request-independent values or explicitly bounded snapshots, never request-scoped I/O objects.

### R6 — Attachment lifecycle

1. When an attachment is deleted from any management flow, the system shall use one canonical Attachment Lifecycle Module.
2. The Module shall enforce ownership, parse metadata, attempt R2 deletion, invoke `upload:delete`, delete the database row, and produce structured diagnostics consistently.
3. When R2 deletion fails, the system shall apply one documented failure policy and shall not silently diverge between single and batch deletion.
4. Batch database changes shall use D1-compatible batched or set-based operations.

### R7 — Admin filtering and pagination

1. When an administrator follows a user's article-count link, the article list shall filter by that user ID.
2. When an administrator changes page while filtering posts or comments, the system shall preserve every active filter.
3. When a page parameter is non-finite, negative, malformed, or above the configured upper bound, the system shall normalize it before issuing a database query.

### R8 — Settings, permalink, and slug validation

1. When site settings are saved, the system shall validate URLs, numeric ranges, enums, booleans, and permalink patterns before persistence.
2. When multiple settings are valid, the system shall persist them through one semantic batch and perform cache-version invalidation once.
3. When a content, category, tag, or attachment slug is accepted, the system shall normalize unsafe URL characters and resolve uniqueness in its applicable namespace.
4. When an install `.returning()` call does not return the inserted row, the system shall fail installation rather than assume identifier `1`.

### R9 — Bounded request parsing

1. When a public or authentication form declares a body larger than its endpoint limit, the system shall reject it before calling `formData()` or `json()`.
2. When no `Content-Length` is available, the system shall still enforce field-level limits after parsing.
3. When an upload exceeds its configured size, the system shall reject it as early as the runtime interface permits and avoid an unnecessary full-buffer copy before writing to R2.
4. Every affected endpoint shall return a consistent 4xx response for malformed or oversized input.

### R10 — Plugin filter invariants

1. When a write Filter returns modified comment or content data, the system shall revalidate the returned value before persistence.
2. The system shall prevent Filters from changing protected identity or ownership fields unless the Hook contract explicitly permits it.
3. The system shall keep counters and relationships consistent with the final validated record.

### R11 — Request bootstrap and pagination rewrites

1. When `/page/N/` is rewritten, the request shall still pass through option loading, plugin activation, plugin routing, edge-cache policy, and plugin-aware security-header finalization.
2. Every middleware-managed response path shall apply the same security-header policy.
3. The Request Bootstrap Module shall expose one deep Interface for request initialization and response finalization, keeping route-specific differences inside its Implementation.

### R12 — Accessibility and UI behavior

1. Authentication pages shall not disable browser pinch zoom.
2. The mobile administration navigation toggle shall expose `aria-controls` and keep `aria-expanded` synchronized with its visible state.
3. Interactive navigation and dropdown controls shall have visible keyboard focus and support keyboard activation and dismissal.
4. Existing visual styling and responsive layout shall remain compatible with the current admin theme.

### R13 — Architecture and test surface

1. Plugin configuration shall be owned by one deep Plugin Configuration Module whose Interface is shared by HTML and JSON adapters.
2. Attachment deletion shall be owned by one deep Attachment Lifecycle Module whose Interface is shared by single and batch adapters.
3. Request initialization and response finalization shall be owned by one deep Request Bootstrap Module.
4. Reusable parsing and validation shall be owned by a Validated Input Module without turning individual field rules into shallow pass-through Modules.
5. Tests shall exercise these Modules through their public Interface so that security invariants have Locality and callers gain Leverage.

### R14 — Verification

1. Every security or functional fix shall include a positive and negative regression test.
2. Concurrency-sensitive behavior shall include a concurrent regression test.
3. The completed change shall pass `pnpm run test`, `pnpm run typecheck`, and `pnpm run build`.
4. The implementation shall not manually edit generated files under `drizzle/`.

### R15 — Workers configuration and observability

1. Worker binding types shall be generated from Wrangler configuration rather than maintained as a duplicate hand-written binding Interface.
2. The example deployment configuration shall enable searchable Workers logs and sampled traces with documented defaults.
3. New or changed error diagnostics shall use structured records and shall not contain credentials, reset tokens, session values, or plugin secrets.
4. The project shall provide a static check that rejects floating Promises in Worker request paths.

## 5. Constraints

- Existing `typecho_*` table and column names are immutable.
- D1 does not provide conventional application transactions; multi-statement changes must use supported set-based SQL or `db.batch()` semantics.
- Existing plugin packages and Hook names must remain source-compatible unless an unsafe behavior has no compatible interpretation.
- Existing public URLs and Typecho permalink formats must remain compatible.
- Secrets remain stored in `typecho_options`; `typecho_options.secret` must never be reset.
- Cloudflare bindings shall continue to be accessed through `cloudflare:workers`.

## 6. Non-goals

- Redesigning the admin visual language or replacing the current CSS framework.
- Changing the database table prefix or PHP Typecho-compatible column names.
- Sandboxing third-party plugins as untrusted code.
- Introducing external databases, queues, or authentication providers.
- Migrating all legacy Wrangler configuration solely as part of this hardening effort.
