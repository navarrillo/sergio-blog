# Deployment runbook

This runbook is for the operator. It has not been executed against any production host. Existing DNS, host Caddy, SSH and restic configuration remain under the operator's control. All commands below run on the intended machine; confirm paths and ports first.

## 1. Prepare storage and configuration

Requirements: Docker Engine + Compose v2, Git, Node 24.22.1 for host-side scripts, the existing host Caddy 2, and fail2ban with systemd support. Do not install another reverse proxy. Reserve loopback ports 8010 (blog) and 8011 (Umami); both are configurable.

Use the established application layout:

```text
/home/deploy/apps/blog/{repo,config,data,uploads,backups,bin}
/home/deploy/apps/umami/{config,pgdata,backups}
```

Clone the public repository into the blog `repo/` directory. The default branch is `development`; deploy reviewed `main` refs only. Run from the checkout:

```sh
bin/setup /home/deploy/apps/blog
bin/setup /home/deploy/apps/umami
```

Setup refuses to overwrite existing config, generates random session/CSRF/Umami/database/2FA secrets, and writes `config/.env` with permissions 600. Keep this file outside Git and include it in encrypted backups. For the blog, set `PUBLIC_ORIGIN=https://blog.sergionavarro.me`, `COOKIE_SECURE=true`, and `DEMO_MODE=false`. Keep `DATA_DIR`, `UPLOADS_DIR`, and `BACKUPS_DIR` as container paths `/app/{data,uploads,backups}`. `BLOG_*_PATH` variables are absolute host bind paths. The second setup also creates unused generic blog directories; only pgdata/config/backups are needed by Umami.

Make blog data/uploads/backups writable by container UID/GID **1000:1000** and the Umami pgdata directory writable by PostgreSQL **999:999**:

The deploy user only needs Docker access; these ownership changes do not require host sudo. Set the two application roots to the directories prepared above (not the repository checkout):

```sh
BLOG_ROOT=/absolute/path/to/blog
UMAMI_ROOT=/absolute/path/to/umami
for directory in data uploads backups; do
  docker run --rm --network none --user 0:0 \
    --mount "type=bind,source=$BLOG_ROOT/$directory,target=/d" \
    alpine:3.24.1 sh -ec 'chown -R 1000:1000 /d; chmod 700 /d'
done
docker run --rm --network none --user 0:0 \
  --mount "type=bind,source=$UMAMI_ROOT/pgdata,target=/d" \
  alpine:3.24.1 sh -ec 'chown -R 999:999 /d; chmod 700 /d'
chmod 600 "$BLOG_ROOT/config/.env" "$UMAMI_ROOT/config/.env"
```

The deploy account must be able to run Docker. Host `bin/` can contain symlinks to the checkout scripts; the operator should run scripts from the checkout or symlink their containing directory consistently. Scripts that determine the repo from their own path should be invoked through the original checkout path.

## 2. Start separate Compose projects

Create the shared analytics network once:

```sh
docker network create blog-analytics
```

Skip creation if the network already exists. PostgreSQL has no published port and stays on the Umami-only default network. Use the independent Umami env file and start Umami:

```sh
docker compose --env-file /home/deploy/apps/umami/config/.env \
  -f deploy/compose.umami.yaml up -d --build --wait
```

Images are pinned: Node 24.22.1 bookworm slim, Umami 3.4.0 with Node 22.23.4 (Alpine 3.24), PostgreSQL 17.9 bookworm. Dependency versions and lockfile are fixed. Changes to versions require an explicit review and a fresh restore drill. Umami's upstream image runs as UID 1001. Its temporary files are written to tmpfs; database files stay in the independent bind mount.

Before publishing analytics, access its loopback port through an operator-managed SSH tunnel. Log in to upstream Umami's initial `admin` / `umami` account and immediately change the default password. Create a website for `blog.sergionavarro.me`. Use a dedicated least-privilege account for backend statistics (without interactive 2FA, because this account uses the login API). Enable 2FA on the human dashboard administrator if desired; `UMAMI_TWO_FACTOR_KEY` is generated for this. Set the blog's `UMAMI_USERNAME`, `UMAMI_PASSWORD`, and `UMAMI_WEBSITE_ID`. `UMAMI_INTERNAL_URL=http://umami:3000` uses the shared internal Docker network. Do not use the external analytics hostname for backend requests. No account credentials are emitted in HTML or JavaScript.

Start the blog:

```sh
export BLOG_ENV=/home/deploy/apps/blog/config/.env
export BLOG_ENV_FILE="$BLOG_ENV"
docker compose --env-file "$BLOG_ENV" up -d --build --wait
```

Empty storage is initialized through an explicit migration at startup; no demo command is part of the image entrypoint. `/healthz` executes a SQLite read and does not attempt login. Confirm that restarting the blog preserves data. `read_only`, tmpfs, dropped capabilities, no-new-privileges, memory limits and log rotation are configured for both applications.

## 3. Real client IP and initial administrator

Check proxy trust **after the first start**, using the TCP peer address of a real HTTPS request. The first deployment arrived through the shared `blog-analytics` gateway. Docker may select a different attached network after recreation, so do not infer the peer from a preferred/default network name.

First list the running blog container's attached networks and their current gateways:

```sh
blog_container=$(docker compose --env-file "$BLOG_ENV" ps -q blog)
docker inspect "$blog_container" --format '{{range $name, $network := .NetworkSettings.Networks}}{{printf "%s gateway=%s\n" $name $network.Gateway}}{{end}}'
```

Once the Caddy reverse proxy from section 4 is active, make a real request through it, then observe established connections in that container's network namespace. The diagnostic container shares the network only, mounts no application data, publishes no ports and changes no Caddy configuration:

```sh
curl --fail --silent --output /dev/null https://blog.sergionavarro.me/healthz
docker run --rm --network "container:$blog_container" alpine:3.24.1 netstat -tn
```

For the connection whose **local** port is 8080, the **foreign address** is the peer the Node launcher receives (not the visitor IP carried in forwarding headers). Repeat while making the request if no established connection is visible. Match that peer against the discovered gateway addresses.

Recommended setting: include **both** current gateway addresses for the blog's private bridge and `blog-analytics` in the comma-separated `TRUSTED_PROXIES` list. This covers either network being chosen during container recreation. Generate the candidate list without copying fixed addresses into the runbook:

```sh
docker inspect "$blog_container" --format '{{range .NetworkSettings.Networks}}{{println .Gateway}}{{end}}' \
  | awk 'NF' | sort -u | paste -sd, -
```

Verify that the output contains only the two expected, host-controlled Docker gateways and includes the observed peer; then save it as `TRUSTED_PROXIES` in the private env file. Recheck after network recreation. Do not add visitor addresses, arbitrary subnets, or gateways from unrelated networks. The default is empty and trusts no forwarding headers. Caddy overwrites `X-Forwarded-For` and `X-Real-IP` with its TCP client address. The Node launcher strips forwarding headers from untrusted sockets **before Astro processes them**. Never start `dist/server/entry.mjs` directly. After changing trust or secrets, recreate the blog container.

Use an interactive terminal, without `-T`, to create the administrator:

```sh
docker compose --env-file "$BLOG_ENV" exec blog bin/create-admin
```

The command prompts for a new password, shows the authenticator secret and otpauth URI only on that terminal, and confirms a current TOTP code. There is no default blog password. Wait for the next code before logging in. Re-enroll with `bin/enroll-totp`; recover password + TOTP with `bin/recover-admin`. These commands revoke sessions, require a TTY, make no external requests, and do not write setup secrets to logs or plaintext setup files. The necessary encrypted-at-rest-backup copy of the actual TOTP database secret is private SQLite data.

## 4. Host Caddy and fail2ban

Copy only `deploy/blog.caddy` and `deploy/umami.caddy` into `/etc/caddy/sites/`. Adjust loopback ports if needed. Ensure the existing main Caddyfile already imports this directory. Validate the complete Caddy configuration before reloading the existing `caddy.service`; do not replace unrelated site configuration.

Caddy logs JSON access events to stderr, captured by journald. No `/var/log/caddy` files are introduced. The **blog app owns HSTS, CSP, frame, referrer and content-type headers**. Caddy does not duplicate them. Caddy's 33 MB request ceiling permits 32 MB archive uploads plus multipart overhead; the application enforces an 8 MB decoded image upload input limit and a 40-million-pixel decoder limit. Hashed Astro assets and random immutable image names receive long cache lifetimes.

Install the two filters under `/etc/fail2ban/filter.d/` and `blog.local` under `/etc/fail2ban/jail.d/`. Both jails use `backend=systemd`, `_SYSTEMD_UNIT=caddy.service`, 6 failures in 10 minutes, and a 1-hour ban. The filters match failed POSTs (401/429); they deliberately have no `^` anchor because journald can prefix the JSON message.

```sh
fail2ban-regex deploy/fail2ban/examples.log deploy/fail2ban/blog.conf
fail2ban-regex deploy/fail2ban/examples.log deploy/fail2ban/umami.conf
```

Each fixture should match exactly one failure and ignore the successful 303 response. Confirm with actual host journal samples before enabling the jails.

## 5. Backups before existing nightly restic

The existing encrypted restic backup runs at **03:45 Europe/Stockholm**. Schedule `bin/backup-dump` at **03:15 Europe/Stockholm**, using the host cron timezone or a systemd calendar with that timezone. No cron is installed by the repository.

Supply absolute env locations and the Umami backup destination, then run:

```sh
BLOG_ENV=/home/deploy/apps/blog/config/.env \
UMAMI_ENV=/home/deploy/apps/umami/config/.env \
UMAMI_BACKUPS_PATH=/home/deploy/apps/umami/backups \
  bin/backup-dump
```

The script fails on a PostgreSQL dump or SQLite/media backup failure, uses restrictive permissions, finalizes successful artifacts atomically, and retains seven days locally. Pinned rollback snapshots are retained until superseded. It never copies live PostgreSQL files or an open SQLite database with ordinary file copying. Add these paths to the existing restic selection:

- Blog `config/`, `backups/`, and `uploads/` (SQLite comes from the consistent dumps in backups).
- Umami `config/` and `backups/` (PostgreSQL comes from pg_dump, not pgdata).

Treat backups and exports as sensitive: they contain draft text, original imported posts and administrator authentication state. Do not add archives or runtime storage to the public repository.

## 6. Full restore drill in disposable directories

Download/decrypt the selected restic snapshot using the existing operator-managed process. Keep production services untouched. With Node dependencies installed, restore a blog dump into a new empty directory:

```sh
bin/restore /path/to/snapshot/blog/backups/TIMESTAMP /tmp/blog-restore-drill
DATA_DIR=/tmp/blog-restore-drill/data \
UPLOADS_DIR=/tmp/blog-restore-drill/uploads \
BACKUPS_DIR=/tmp/blog-restore-drill/backups \
COOKIE_SECURE=false PUBLIC_ORIGIN=http://127.0.0.1:4321 \
HOST=127.0.0.1 PORT=4321 npm start
```

Stop the normal local preview if that port is occupied. Confirm `/healthz`, published articles, private sign-in and image reads. Restoration refuses a nonempty target and checks SQLite integrity first. For a production restore, stop the serving container before replacing its bind directories, restore UID/GID ownership, then recreate it. Restore the saved config separately from restic; never print its contents.

For Umami, create a **separate** restore env file with fresh, empty `UMAMI_PGDATA_PATH` and `UMAMI_BACKUPS_PATH` directories, copy the backed-up secret values privately, and keep production paths out of that file. Ensure UID/GID 999 owns the empty pgdata directory. Then:

```sh
UMAMI_ENV=/absolute/path/to/restore-config/.env \
RESTORE_PROJECT=umami-restore-drill \
  bin/restore-umami /path/to/selected.dump
```

The restore helper starts only PostgreSQL, requires a project name beginning `umami-restore`, checks that public tables are absent, and uses `pg_restore --exit-on-error`. Inspect restored website/event counts with `psql`. To review the UI, set `UMAMI_PORT` to a free loopback port and start the Umami service with the same project name/env file. Stop and remove only the restore project after inspection. Keep the restored artifacts until the drill is recorded as successful.

## 7. Manual deployment and rollback

No automatic deploy job, self-hosted runner, server connection, or scheduled deployment exists. After reviewing and merging the `development` → `main` pull request, use:

```sh
BLOG_ENV=/home/deploy/apps/blog/config/.env bin/deploy main
```

The checkout must be clean. The helper locks releases, fetches the requested ref, builds `blog:<12-character-sha>`, retains the previous image as `blog:prev`, stops the writer, snapshots SQLite/uploads, applies forward migrations, tags `blog:live`, recreates the container and waits for an HTTP health check. Failure restores the old image and SQLite snapshot when a previous deployment exists. The first deployment has no previous release and requires resolving the failed bootstrap directly.

Manual rollback:

```sh
BLOG_ENV=/home/deploy/apps/blog/config/.env bin/rollback
```

The previous immutable image ID and snapshot path are retained in private `config/release-state.json`. Rollback first backs up current content, then restores the previous SQLite snapshot and executable. **Edits since that snapshot will no longer appear after rollback**, but remain recoverable in the fresh dump. Existing uploads remain on disk. Review the fresh dump when reconciling later edits. Do not prune the previous image or remove the pinned snapshot until the next successful release. Stop and investigate if a schema change cannot be rolled back with the saved snapshot.

## 8. Before launch

Replace demonstration biography/photo/content with approved material; production has no seeds by default. Confirm HTTPS, proxy IP trust, TOTP, redirects, search, RSS, OpenAPI and a real MCP client. Verify named Umami events and 30-day counts against the dashboard, admin/preview/test exclusions, public/private data separation, full recovery and journal filter matches. Re-run Lighthouse on the real HTTPS origin; local scores are baseline evidence only.

## October 2026 Node security update

The blog requires Node >=24.22.1 <25, including host-side setup/deploy/backup tools. Use `.nvmrc` with your existing version manager; installing dependencies with an older Node is rejected. The launcher and CLI helpers also check the runtime before serving or opening storage. The machine-wide Node installation is not changed by repository updates.

Umami 3.4.0 upstream embeds Node 22.23.2. `deploy/Dockerfile.umami` preserves that application and its dependencies while copying the official Node 22.23.4 binary for the same Alpine 3.24 ABI. Build with `--build` to use the corrected image. Verify both running versions with `docker compose exec -T blog node --version` and the equivalent Umami command.

The release helper validates newly built and rollback images against the corrected Node 24 minimum. An old vulnerable release is refused before rollback stops the current service. Before the first security upgrade stops the service, it prepares a patched recovery image from the previous Node 24/bookworm application, replacing only Node. If that preparation fails, deployment stops while the existing service remains running. The recorded rollback target is this patched baseline, preserving the previous application and schema. Historical state files that still reference vulnerable images are rejected by manual rollback. Rebuild existing images and recreate containers explicitly during the operator-managed deployment. Do not deploy old Git refs that predate these checks.

Official advisory: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases

## Uploaded media and browser CSP checks

Images are served by the app at `/uploads/<hex-or-hyphen-name>.webp`, from the uploads bind mount, with WebP content type, nosniff and immutable caching. The Node launcher rejects noncanonical/traversal upload targets before URL normalization; the file route rejects symlinks, directories and other extensions. Caddy needs no uploads filesystem access. The root `.gitignore` uploads entry deliberately does not ignore the source route.

Builds emit JavaScript and stylesheets as external assets. Inline JSON-LD retains its original JSON value, escapes `<` to `\u003c`, and receives an exact per-response SHA-256 CSP hash. No unsafe-inline is permitted. Run `npm run test:browser` after installing Chromium with `npx playwright install chromium` to verify the editor and events under the production CSP. GitHub CI runs the browser smoke too. Blog security headers stay in the application; Umami HSTS/nosniff/referrer/frame headers belong to `deploy/umami.caddy`, with a frame-ancestors-only CSP that does not interfere with its application scripts.

## User-local Node for host helpers

Host helpers still require Node >=24.22.1 <25. If Node is installed in a user-local directory, a small wrapper can select it without sudo or global installation changes:

```sh
#!/bin/sh
set -eu
: "${BLOG_NODE_BIN:?Set this to the directory containing your user-local Node 24 executables}"
export PATH="$BLOG_NODE_BIN:$PATH"
exec "$@"
```

Save the wrapper outside the checkout, make it executable, and invoke it with the original checkout helper path, for example `node24-wrapper /path/to/checkout/bin/deploy main`. Set `BLOG_ENV` as usual. The wrapper adds no deployment automation and does not weaken the repository's runtime check.
