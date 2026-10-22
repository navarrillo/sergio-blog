# Acceptance evidence

Implementation and local validation: **22 October 2026**. No production host was accessed or changed.

| Area                    | Evidence                                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static checks           | ESLint and Astro typecheck pass with no errors, warnings or hints.                                                                                                                                                                                                                                 |
| Unit/service behavior   | 10 Vitest tests pass: editorial states/revisions/redirects, FTS punctuation and cursors, proxy spoof resistance, RFC TOTP/replay, password + factor login/session hashing, CSRF, malicious Markdown, image decoding/EXIF stripping and X duplicates/error preservation.                            |
| Real server integration | Built standalone server passes public/private routes, browser-form editorial HTTP actions, exports, official SDK MCP search/full reads, authenticated cookies, CSRF rejection, shared rate limits, health isolation, stale analytics, restart and clean-directory backup restoration.              |
| Docker blog             | Node 24.14.1 multi-stage build succeeds. Compose reaches healthy with read-only root, UID 1000, bind mounts and loopback publication. Backup and restart succeed.                                                                                                                                  |
| Docker analytics        | Independent Umami 3.4.0 and PostgreSQL 17.9 stack reaches healthy. Earlier 2.20.2 ARM image failed because upstream Prisma binaries were absent; the final pinned version is 3.4.0.                                                                                                                |
| Actual analytics        | Local synthetic smoke sends one pageview and three named events; Umami API and blog public/cache aggregates agree. Credentials never appear in public responses.                                                                                                                                   |
| Versioned releases      | Delivered `bin/deploy` was run against two immutable Git refs in a disposable local clone. Both passed health checks. `bin/rollback` restored the previous image and the exact pre-update SQLite text, preserving a backup of later edits.                                                         |
| Combined recovery       | Delivered backup script successfully dumps PostgreSQL, online SQLite and uploads. Restore helper restores PostgreSQL into a separate clean project and recovers all four synthetic events. SQLite restoration is asserted in integration tests.                                                    |
| Visual review           | Homepage reviewed in browser at 375, 768 and 1440 px. Archive search returns the expected entry; mobile article is readable without horizontal overflow. Keyboard focus and skip link are supplied.                                                                                                |
| Lighthouse mobile       | Local production build, explicitly seeded demonstration content, Lighthouse 13.5.0: homepage performance **100**, accessibility **100**; representative article performance **100**, accessibility **100**. Real HTTPS origin must be remeasured after launch content and analytics configuration. |
| Dependency audit        | npm audit reports zero known vulnerabilities for the final pinned installation.                                                                                                                                                                                                                    |
| Hosted CI               | GitHub Actions on Ubuntu-hosted runners passes lint, typecheck, tests, build, real integration and Docker build/health check. The independent Umami smoke is also included in the final workflow.                                                                                                  |

## Operator checks before public launch

The code and scripts are delivered; these require the actual deployment environment or owner-supplied material:

- Approved biography, photograph, projects and first articles. Current local examples are explicitly marked demo content and are absent from production bootstrap.
- DNS/HTTPS, host Caddy import and journals, actual Docker bridge gateway trust, production filesystem ownership, fail2ban-regex against real host journal lines and the existing restic schedule/selection.
- Interactive administrator and TOTP enrollment in the operator's terminal. No real administrator credentials were created during implementation.
- Umami production website and least-privilege credentials, change the upstream default password, confirm dashboard totals and test traffic exclusions on the real origin.
- Review/merge the development-to-main pull request before manually deploying. Main is kept at the repository bootstrap until this review.

## Scope limits

X imports accept JSON, official `tweets.js`, and ZIP media archives up to 32 MB compressed / 128 MB decompressed. Larger official archives must be split before import. The private inbox is the batch preview; selection creates drafts and never publishes. Video/animated media are reported as unsupported/missing and are not transcoded. There are no paid X requests, scraping, metrics fetches, AI calls, newsletter, comments or public chat.

The 15-minute analytics snapshot is updated on demand. If Umami fails, the most recent persisted snapshot is served and timestamped. If none exists, statistics show an explicit unavailable state. Site images are public immutable uploads even when referenced by a draft. Text previews and source archives remain authenticated.

## Node security correction · 23 October 2026

The original baseline above used Node 24.14.1 and did not cover the October security release. The corrected blog build/runtime and CI pin Node 24.22.1. The minimum is enforced through package engines, strict installation, `.nvmrc`, startup/CLI checks and image checks during deployment/rollback. The separate Umami 3.4.0 image was measured as Node 22.23.2 and is now derived with official Node 22.23.4 for its existing Alpine 3.24 ABI.

With the official Node 24.22.1 archive (SHA-256 checked against nodejs.org), lint, typecheck, all 11 tests, build and full HTTP/MCP/editorial/backup/restore integration pass. Rebuilt containers report v24.22.1 and v22.23.4 and reach healthy state. The real Umami pageview/event smoke and the blog backup pass. The actual old v24.14.1 runtime is rejected by the guard; patched versions are accepted. No CVE exploit payload was executed: remediation evidence is the official fixed release floor, actual runtime inspection and compatibility tests.

The first-upgrade recovery image preserves the previous blog application and replaces its Node binary with 24.22.1 before the current service is stopped. Its runtime and health are checked locally; unsafe historical rollback targets are rejected before stopping a current service. This correction changes no production host or global developer Node installation; operators must rebuild/recreate services and use the corrected host runtime.
