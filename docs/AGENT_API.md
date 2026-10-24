# Private agent drafts API

Sergio can give a trusted writing assistant a bearer token to prepare drafts. Sergio alone reviews and publishes through the existing password + TOTP admin. Writes use one JSON HTTP request with Markdown input and a small metadata response. Listing returns metadata; reading one eligible draft includes its Markdown. It is disabled by default and is absent from public OpenAPI, llms.txt and MCP.

## Enable and manage tokens

Set `AGENT_API_ENABLED=true` and a private `AGENT_TOKEN_SECRET` in the blog env file, then recreate the container during the manual deployment. `bin/setup` generates the secret for new installations; see [DEPLOY.md](DEPLOY.md) for existing installations. Run migrations before token commands. Host commands must use the same data directory and secret as the server; with Docker, run from the checkout:

```sh
docker compose exec blog bin/agent-token create writer-v1
docker compose exec blog bin/agent-token list
docker compose exec blog bin/agent-token revoke writer-v1
# A numeric ID from list also works:
docker compose exec blog bin/agent-token revoke 1
```

Pass the same `--env-file` as the deployment when Compose needs a nondefault configuration path. Without Docker, the equivalent commands are `bin/agent-token create <name>`, `bin/agent-token list`, and `bin/agent-token revoke <name|id>` with the server environment loaded privately.

Create requires interactive stdin and stdout; it refuses pipes or redirects before creating a token. It prints the `sbd_` token exactly once in that terminal. Each token contains 32 cryptographically random bytes encoded as base64url. Keep it in the assistant's secret store. Do not record the terminal session, paste it into chats, commit it, put it in a URL, or enable verbose HTTP logging. The database stores only a keyed HMAC-SHA256, checked with a constant-time comparison. List shows ID, name, creation date, last successful use and revocation date; it never shows hashes. Names are unique (1–64 ASCII letters/digits/spaces/`._-`, starting with a letter or digit). Revocation takes effect on the next call, including writes whose body was still being read.

To rotate, create `writer-v2`, privately replace the assistant's credential, and revoke `writer-v1` immediately. Ownership belongs to the original token ID: the new token creates new drafts and cannot take over old ones. Sergio can finish old drafts in the admin. Changing `AGENT_TOKEN_SECRET` invalidates all tokens; create replacement tokens afterward. Keep revoked rows to preserve the author label.

## Contract and scope

All routes below require `Authorization: Bearer <token>`:

| Method | Path                        | Result                                           |
| ------ | --------------------------- | ------------------------------------------------ |
| POST   | `/api/agent/v1/drafts`      | Create an owned draft, 201                       |
| GET    | `/api/agent/v1/drafts`      | List eligible owned drafts, 200                  |
| GET    | `/api/agent/v1/drafts/<id>` | Read owned draft content, 200                    |
| PATCH  | `/api/agent/v1/drafts/<id>` | Update supplied fields, snapshot a revision, 200 |

Successful POST and PATCH responses contain only these metadata fields:

```json
{
  "id": 42,
  "slug": "my-draft",
  "status": "draft",
  "preview_url": "/admin/edit?id=42",
  "updated_at": "2026-10-24T12:00:00.000Z"
}
```

`GET /api/agent/v1/drafts` returns only this token's eligible drafts, ordered by `updated_at` descending, then `id` descending:

```json
{
  "items": [
    {
      "id": 42,
      "title": "My draft",
      "slug": "my-draft",
      "updated_at": "2026-10-24T12:00:00.000Z",
      "preview_url": "/admin/edit?id=42"
    }
  ],
  "next_cursor": null
}
```

Each item contains exactly those five fields, with no Markdown body. `?limit=` defaults to 20 and accepts integers from 1 to 50. Pass the opaque `next_cursor` unchanged as `?cursor=` for the next page; null marks the end. Invalid/empty cursors, invalid limits, duplicate parameters and query parameters other than `limit` and `cursor` return 400. Pagination uses a keyset, so ties in update time are resolved by descending ID. Updating a draft changes its position; this is a live list, not a snapshot across requests.

`GET /api/agent/v1/drafts/<id>` returns exactly the writable fields plus metadata:

```json
{
  "id": 42,
  "title": "My draft",
  "slug": "my-draft",
  "summary": "A short introduction",
  "body": "# Markdown draft",
  "tags": ["writing"],
  "type": "article",
  "status": "draft",
  "preview_url": "/admin/edit?id=42",
  "updated_at": "2026-10-24T12:00:00.000Z"
}
```

Reading never exposes featured/image/source URL/publication date, token ownership, lock metadata or revisions. A PATCH is immediately visible in subsequent reads. Both GET routes share the same ownership and permanent-lock restrictions: publishing, trashing or locking a draft removes it from the list and makes an individual read return 404. Odd/noncanonical IDs also return 404.

Open `preview_url` on the blog origin in Sergio's browser; it requires his admin session. The drafts list and editor show `Created by <token name>`. A token can only access its own drafts while their status remains draft. Another token's draft, an admin-created post, a published post, or a trashed post all return the same 404. Any status change permanently removes agent access, including if Sergio later restores the post to draft. Sergio's text edits without a status change keep agent access. Ownership and status checks run inside the editorial write transaction.

POST/PATCH accept only `application/json` (optional charset). Unknown fields are rejected, including `status`, `published_at`, `featured`, `image`, `source_url` and ownership fields.

| Field     | Limits and defaults                                                                                |
| --------- | -------------------------------------------------------------------------------------------------- |
| `title`   | Required on creation; nonblank, at most 200 characters                                             |
| `summary` | At most 500 characters; default empty                                                              |
| `body`    | Markdown, at most 200,000 UTF-8 bytes; default empty                                               |
| `tags`    | At most 10 tags, each 1–40 lowercase letters/digits/hyphens, as in the editor; default empty array |
| `type`    | `article` or `note`; default `article`                                                             |
| `slug`    | Optional lowercase kebab slug, at most 180 characters                                              |

PATCH preserves omitted fields and requires at least one supplied field. Omitted slugs on creation use the editor's accent-stripping normalization of the title (fallback `draft`); collisions with posts or old redirects receive `-2`, `-3`, etc. A title-only PATCH keeps the current slug. Each PATCH passes through the existing editorial service and stores the previous version in revisions. Created drafts remain invisible on public pages, RSS, sitemap, public API and MCP.

Malformed JSON, unknown fields or invalid values return generic 400; unsupported content type returns 415. Requests larger than 1,250,000 encoded JSON bytes return 413 (the separate Markdown limit still applies, allowing JSON escaping overhead). No auth, malformed/unknown/revoked bearer values and admin-cookie-only requests return generic 401. Failed-auth IP throttling can return 429. Bearer tokens are ignored by `/admin` and `/api/admin`; those routes retain their existing authentication. There are no agent cookies, CSRF tokens or browser CORS permissions.

Each token has three independent persisted hourly budgets:

- **30 successful writes**: only committed POST/PATCH operations returning 201/200 consume this allowance. The reservation and editorial save share one transaction, including revisions, so rejected writes roll the reservation back. Concurrent requests cannot exceed the allowance.
- **120 reads**: listing and individual content reads share this budget, including rejected list queries. They consume neither write budget.
- **60 rejected writes**: validation/content-type/size failures (400/413/415) and ownership/not-found rejections on recognized draft-write routes (404) use this separate allowance. Further rejected writes return 429; a valid write can still succeed if its successful-write budget remains available. Quota 429 responses do not consume another budget.

All three budgets survive restarts and are per token. A 429 response includes `Retry-After` in seconds for the exhausted bucket. A 401 continues to use only the failed-auth budget per real client IP, respecting the existing trusted-proxy boundary. Successful calls log only token name, method, path, draft ID (null for listing) and status. No tokens or Markdown are logged. Responses use `Cache-Control: no-store`.

There is no listing of other drafts, publish/schedule/trash/delete, upload, import/export, settings, projects, or private admin access. Sergio adds images during review. Published content remains readable through the existing public API. The feature flag off returns 404 for the whole agent namespace.

## Copy-paste requests

Requires curl and jq. Set `BLOG_ORIGIN` to your HTTPS origin. Read the credential into an unexported shell variable without putting it in history; disable shell tracing and keep this terminal unrecorded:

```sh
set +x
BLOG_ORIGIN=https://blog.sergionavarro.me
printf 'Bearer token: '
# stty works in both bash and zsh; neither input nor token is printed.
stty -echo
IFS= read -r AGENT_TOKEN
stty echo
printf '\n'
```

Create from `draft.md` (replace the sample title). The Authorization header is piped to curl, so it does not appear in the curl process arguments:

```sh
jq -n --rawfile body draft.md \
  --arg title 'My next article' \
  '{title: $title, summary: "A short introduction", body: $body, tags: ["writing"], type: "article"}' |
  curl --silent --show-error --fail-with-body \
    --header @<(printf 'Authorization: Bearer %s\n' "$AGENT_TOKEN") \
    --header 'Content-Type: application/json' \
    --data-binary @- "$BLOG_ORIGIN/api/agent/v1/drafts"
```

Patch from `draft.md`, using the numeric ID returned above:

```sh
DRAFT_ID=42
jq -n --rawfile body draft.md '{body: $body}' |
  curl --silent --show-error --fail-with-body --request PATCH \
    --header @<(printf 'Authorization: Bearer %s\n' "$AGENT_TOKEN") \
    --header 'Content-Type: application/json' \
    --data-binary @- "$BLOG_ORIGIN/api/agent/v1/drafts/$DRAFT_ID"
```

List the caller's eligible drafts (read budget only):

```sh
curl --silent --show-error --fail-with-body \
  --header @<(printf 'Authorization: Bearer %s\n' "$AGENT_TOKEN") \
  "$BLOG_ORIGIN/api/agent/v1/drafts?limit=20"
```

For another page, pass the returned `next_cursor` URL-encoded as `cursor`, with the same limit. Never substitute a draft ID for the opaque cursor.

Read one eligible draft, including its Markdown and latest edits:

```sh
curl --silent --show-error --fail-with-body \
  --header @<(printf 'Authorization: Bearer %s\n' "$AGENT_TOKEN") \
  "$BLOG_ORIGIN/api/agent/v1/drafts/$DRAFT_ID"
unset AGENT_TOKEN
```

The examples use process substitution supported by bash and zsh. Create, patch and list responses stay small; an individual read returns the draft content. Send the preview link to Sergio for review; no API call can publish it.
