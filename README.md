# Sergio Navarro · Blog

An independent, self-hosted personal blog. Astro 7 / TypeScript, Node 24 standalone adapter, SQLite WAL + FTS5, local image storage, and a private editorial workspace. English throughout. No paid APIs or AI calls.

## Start locally

Requires Node **24.22.1** and npm. `nvm use` selects the pinned version. Older runtimes are rejected at installation and startup. Dependencies are pinned in `package.json` and `package-lock.json`.

```sh
npm ci
cp .env.example .env
npm run migrate
# Optional, explicit, empty database only. Never enabled in production:
DEMO_MODE=true npm run demo
npm run dev
```

Astro loads `.env` for development. Standalone CLI scripts read the shell environment; use `node --env-file=.env --import tsx bin/migrate.ts` when setting custom paths. Defaults work without a config file for local data setup. The browser is available at `http://localhost:4321`.

For the complete production adapter and proxy-trust behavior:

```sh
npm run build
HOST=127.0.0.1 PORT=4321 PUBLIC_ORIGIN=http://127.0.0.1:4321 COOKIE_SECURE=false npm start
```

Always launch production with `npm start` / `bin/server.mjs`. The wrapper removes forwarding headers from untrusted TCP peers **before** Astro sees them. `TRUSTED_PROXIES` is an exact, comma-separated IP allowlist, empty by default. The dev server is for local development only.

Create the single administrator from an interactive terminal. The command prompts for a password, displays TOTP setup only in that terminal, and requires a confirming authenticator code:

```sh
COOKIE_SECURE=false bin/create-admin
# Replace the authenticator (revokes sessions):
COOKIE_SECURE=false bin/enroll-totp
# Replace password + authenticator (revokes sessions):
COOKIE_SECURE=false bin/recover-admin
```

There is no default password, public signup, or web recovery. Wait for a new TOTP code after enrollment, because the confirming code is consumed. Log in at `/admin/login`. Admin sessions expire after 12 hours. Production uses `__Host-` Secure/HttpOnly/SameSite=Lax cookies; local HTTP uses a separate cookie name.

## Included

- Responsive homepage, chronological archive, full text search, tags, article pages, projects and public editorial statistics.
- Visual/Markdown editor with private autosave, version conflicts and recovery, working copies for published posts, explicit publication/unpublication, sanitized article preview, reusable JPEG/PNG/WebP uploads re-encoded without EXIF, recoverable trash, revision comparisons, unlimited homepage pins, post filters/bulk actions, settings and tag management. See [the admin guide](docs/ADMIN.md).
- Redirects retained when slugs change, RSS/all articles, sitemap, canonical/Open Graph/JSON-LD and empty/error states.
- Private ZIP export containing Markdown, JSON, revisions, redirect mappings, original X records and uploads. Credentials and sessions are excluded.
- Public read-only API, OpenAPI contract and a stateless Streamable HTTP MCP server with four tools. Public interfaces query the same publication service; drafts, trash and future-dated entries are excluded.
- Separate Umami/PostgreSQL Compose stack, backend-only statistics, persisted 15-minute cache with stale fallback and no public credentials.
- X JSON/JavaScript/ZIP archive import into a private inbox, row error reports, duplicate IDs, original preservation, local media and selection-to-draft conversion. No scraping or URL fetching. Archives up to 32 MB, decompressed limit 128 MB; split larger archives outside the app. CLI import from the persistent volume is also available.
- Hardened Docker Compose, Caddy snippets, fail2ban examples, interactive setup, consistent backups/restoration, manual releases and database-aware rollback.

## Verification

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
# First browser run only:
npx playwright install chromium
npm run test:browser
```

Integration uses a fresh temporary database, launches a local server on port 44321, connects the official MCP client, checks private content exclusion, edits and redirects, session/CSRF behavior, spoofed forwarding headers, rate limits, exports, analytics outages, restart and a backup/restore drill.

See [deployment instructions](docs/DEPLOY.md), [architecture](docs/ARCHITECTURE.md), [acceptance evidence](docs/ACCEPTANCE.md) and [public API contract](public/openapi.json). No command against a production server has been run during implementation. Real biography, photograph and launch content must be supplied before launch; demonstration data is clearly marked and seeded only by explicit command.

## Git workflow

`development` is the default integration branch. `main` receives deployable releases through pull requests from `development`. CI uses GitHub-hosted Ubuntu runners only. Git commits use a GitHub noreply identity. Runtime files, archives, configuration and personal data are ignored from the first commit.

Browser smoke tests use disposable SQLite/uploads and synthetic credentials. They inspect the production build under its real CSP and check format buttons, sanitized preview, image upload/read, JSON-LD round-tripping, project/outbound/no-result events, and admin tracking exclusions. Analytics is intercepted locally; no test events leave the browser fixture. Integration also checks generated static HTML and every rendered page for inline script bodies without matching CSP hashes. Runtime scripts and styles are emitted externally; dynamic JSON-LD is escaped and its exact bytes are hash-authorized per response.
