# Typecho-CF

[中文](README.md)

A modern rewrite of [Typecho](https://typecho.org) in TypeScript, running on **Astro + Cloudflare Workers + D1**. Preserves Typecho's database schema for seamless data migration from PHP Typecho.

---

## Features

**Frontend**: Post list / category / tag / author / search archives (FTS5 full-text with automatic LIKE fallback for short terms), nested comments (Gravatar), RSS 2.0 / Atom 1.0 / RSS 1.0, password-protected posts, responsive default theme

**Admin Dashboard**: Post & page editor, comment moderation, media manager (R2 drag-and-drop upload), user management (5 roles), theme switcher, plugin manager (enable/disable/configure), site settings, installation wizard

**System**: Theme system (npm package distribution), lazily loaded plugin system with 30+ wired hooks, PHP Typecho migration tools, PBKDF2-SHA256 authentication, CSRF protection, security headers, request-body limits, and R2 upload validation

---

## Installation & Deployment

### Prerequisites

- Node.js **22.12+**
- [pnpm](https://pnpm.io) (`npm install -g pnpm`)
- A Cloudflare account (only required for Cloudflare deployment)

### Local development (zero to running)

```bash
git clone https://github.com/eslizn/typecho-cf.git
cd typecho-cf
pnpm install

# Create local Wrangler config (placeholder database_id is fine for local D1/R2 simulation)
cp wrangler.toml.example wrangler.toml

# Optional: protect the local install window (restart dev after writing)
# echo 'INSTALL_TOKEN=your-secret' >> .dev.vars

pnpm run dev
```

1. Open http://localhost:4321 — uninstalled sites redirect to `/install`
2. Complete the install form: site title / description, admin username, password (min 12 chars), email; if `INSTALL_TOKEN` is set, enter the install token too
3. After submit, tables and the admin user are created; sign in at `/admin`

`wrangler.toml` is gitignored — do not commit real `database_id` values or secrets.

### Deploy to Cloudflare (zero to production)

**1. Log in to Cloudflare**

```bash
pnpm exec wrangler login
```

**2. Create resources**

```bash
pnpm exec wrangler d1 create typecho-cf-db
pnpm exec wrangler r2 bucket create typecho-cf-uploads
```

Note the D1 `database_id` from the create output.

**3. Configure `wrangler.toml`**

```bash
cp wrangler.toml.example wrangler.toml
```

Replace `database_id` with the real ID:

```toml
[[d1_databases]]
binding = "DB"
database_name = "typecho-cf-db"
database_id = "your-actual-database-id"
```

If you used a different R2 bucket name, update `[[r2_buckets]].bucket_name` to match.

**4. Set an install token (recommended)**

```bash
pnpm exec wrangler secret put INSTALL_TOKEN
```

Install still works without it, but anyone who reaches `/install` first can claim the initial administrator. With the secret set, the install form requires the same token.

**5. Build and deploy**

```bash
pnpm run deploy
```

**6. Finish installation**

Visit the Worker URL → `/install` → submit site + admin details (and `INSTALL_TOKEN`) → sign in at `/admin`.

---

## Command Reference

| Command | Description |
|---------|-------------|
| `pnpm run dev` | Start local dev server |
| `pnpm run build` | Production build |
| `pnpm run deploy` | Build + deploy to Cloudflare Workers |
| `pnpm run lint` | Type-aware static checks, including floating Promises |
| `pnpm run types:workers` | Generate Worker binding and runtime types from Wrangler config |
| `pnpm run typecheck` | Generate Workers / Astro types and run the TypeScript check |
| `pnpm run test` | Run all tests |
| `pnpm run test:watch` | Watch mode |
| `pnpm run test:coverage` | Generate coverage report |
| `pnpm run db:generate` | Generate Drizzle migrations |
| `pnpm run db:studio` | Launch Drizzle Studio |
| `pnpm run db:migrate:local` | Migrate PHP Typecho data to local |
| `pnpm run db:migrate:cloudflare` | Migrate PHP Typecho data to Cloudflare D1 |
| `pnpm run db:migrate:dry-run` | Preview migration (no writes) |
| `pnpm run reset-password` | Reset user password (local) |
| `pnpm run reset-password:cloudflare` | Reset user password (Cloudflare) |

After changing bindings in `wrangler.toml` or `wrangler.toml.example`, run `pnpm run types:workers`. Generated `worker-configuration.d.ts` is for local/CI use only and is not committed. On a clean checkout without `wrangler.toml`, type generation falls back to `wrangler.toml.example`.

The example config persists searchable Workers Logs and records traces at about 1% sampling; tune for production traffic and cost. Put secrets via `wrangler secret put` (or `.dev.vars` locally), never in tracked config files.

---

## Migrating from PHP Typecho

```bash
# Cloudflare (production)
pnpm run db:migrate:cloudflare \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# Local (development)
pnpm run db:migrate:local \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# Preview (no writes)
pnpm run db:migrate:dry-run \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads
```

| Option | Description | Default |
|--------|-------------|---------|
| `--source`, `-s` | Source SQLite database path | (required) |
| `--uploads`, `-u` | Source `usr/uploads/` directory; omit to migrate database data only | (optional) |
| `--prefix` | Source table prefix | `typecho_` |
| `--dry-run`, `-n` | Preview mode | `false` |
| `--site-url` | New site URL (for rewriting attachment URLs) | — |
| `--d1-name` | D1 database name | `typecho-cf-db` |
| `--r2-bucket` | R2 bucket name | `typecho-cf-uploads` |

Password hashing is incompatible (PHP phpass → PBKDF2-SHA256), so reset passwords after migration:

```bash
pnpm run reset-password              # local
pnpm run reset-password:cloudflare   # Cloudflare
```

---

## Plugin Development

See [Plugin Development Guide](src/plugins/README.en.md).

There is no built-in SMTP or mail API adapter. Password-reset messages and comment notifications are delivered only when mail is enabled and an active plugin implements the `mail:send` hook; without one, delivery safely degrades to an unsent result.

---

## Theme Development

See [Theme Development Guide](src/themes/README.en.md).

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | [Astro](https://astro.build) 7.x (SSR) |
| Adapter | [@astrojs/cloudflare](https://docs.astro.build/en/guides/integrations-guide/cloudflare/) 14.x |
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| ORM | [Drizzle ORM](https://orm.drizzle.team) 0.45.x |
| File Storage | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| Language | TypeScript 7.x |
| Testing | [Vitest](https://vitest.dev) 4.x |
| Package Manager | pnpm |

---

## Security & Test Rules

- Admin APIs must use `requireAdminAction()` for authentication, authorization, and CSRF checks; admin redirects must be same-origin and limited to `/admin` paths.
- Comment referer checks and post-comment redirects must trust sources by URL `origin`, not by string prefix or host-only comparison.
- Frontend, admin, plugin route, and cache-hit responses are normalized by middleware with baseline security headers.
- Every feature or bug fix needs matching regression coverage and must pass both `pnpm run test` and `pnpm run typecheck`.

---

## Compatibility with PHP Typecho

| Aspect | Status |
|--------|--------|
| Database schema | ✅ Seven core tables remain compatible; runtime setup adds login-rate-limit and password-reset helper tables |
| Default theme style | ✅ CSS & HTML structure matches Typecho default theme |
| URL structure | ✅ Routes match Typecho default permalink settings |
| Password hashing | ⚠️ Reset required after migration (different algorithm) |
| PHP themes / plugins | ❌ Must be repackaged in the new format (TypeScript / npm) |

---

## License

MIT

---

## Development Guides

- Plugin guide: [src/plugins/README.en.md](src/plugins/README.en.md)
- Theme guide: [src/themes/README.en.md](src/themes/README.en.md)
- AI agent spec: [AGENTS.md](AGENTS.md)
