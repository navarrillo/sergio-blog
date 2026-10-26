# Admin workspace

The admin uses a visual editor with a Markdown source mode. Markdown remains the stored article format and the bot API format. Tiptap and its extensions are bundled locally; the editor makes no cloud or paid API calls. Its code loads only when opening a post editor.

## Writing and saving

Changes save privately two seconds after typing stops. **Save draft** and **Cmd/Ctrl+S** save immediately. The action bar shows whether changes are unsaved, saving, saved, or failed. A blank title pauses autosave until a title is supplied. Invalid input stays in the form with field errors.

Published posts have a separate working copy. Saving never changes the live title, body, tags, slug, publication date, public search results, or modification date. **Update live post** publishes the working copy in one transaction and preserves the original publication date. Changes to a live slug create redirects only when published.

**Publish** makes a private draft visible now. **Schedule post** is available for initial publication, takes a date in the displayed browser timezone, and stores UTC. Scheduled posts remain private until their publication time. Updating an already live article takes effect immediately.

**Unpublish** explicitly hides an article and keeps its latest working text as a draft. **Move to trash** hides it recoverably; **Restore to drafts** keeps it private. Published bot drafts remain permanently inaccessible to their original bot, including after unpublishing or restoration.

Private preview uses the public Markdown renderer and article typography. HTML or formatting that cannot safely survive Markdown/visual conversion stays in source mode with an explanation. Merely opening, previewing, changing modes, or saving unchanged text does not reserialize it. Textarea initialization and JSON-encoded text fields preserve leading newlines, LF/CRLF, intentional code indentation, and literal HTML delimiters.

For text damaged by the old editor, **Fix old accidental indentation** previews removal of the exact historical template wrapper. It never dedents the body or trims arbitrary whitespace. Review before applying; the correction can be undone before subsequent edits. Saved revisions retain previous text.

## Conflicts, failures, and history

Saves are serialized and guarded by an edit version, including bot changes and other browser tabs. A stale save/action returns HTTP 409 and retains local text. Copy or download that text, reload the post, and reconcile the changes. New draft creation has a request key so retrying a lost response does not create duplicate posts.

Failed requests and expired sessions keep text in the editor and enable a download of unsaved content. Sign in in another tab, then retry; authenticated CSRF refresh permits recovery without reloading the draft. Navigating away with unsaved changes prompts the browser's warning.

Automatic history checkpoints are limited to five-minute intervals. Explicit saves, publication, and restoration checkpoint changed content. Identical checkpoints are skipped. History shows the latest 100 revisions; private exports retain all revisions. Preview shows both versions' metadata and Markdown before restoration. Restoring stages private content and leaves the live article available.

## Posts and other pages

The posts list searches private working text as well as drafts and provides status/type/tag/pin/bot filters, sorting, and 20-post pages. Editor return links preserve the list filters. Row actions operate on the saved version. Bulk pin/unpin, trash, and restore are limited to the selected page; publishing remains individual.

All pinned public posts appear on the homepage, newest publication first, including posts older than the latest 100. Pin preferences can be set before publishing. Pin updates are independent of working content and cannot be reverted by publishing an older working copy. The chronological archive remains available.

Image controls support uploads with progress, reuse through thumbnails, cover/photo selection and removal, and body insertion with editable alt text. Uploaded images remain public assets; removal only removes the reference and does not delete the file. Existing upload format, size, decoding, and re-encoding limits are retained.

Settings use labelled profile links and direct photo selection. Projects use the same image and validation controls. Tag management shows actual published and private usage, including pending tags; total counts also include trash. Renaming into an existing tag merges it, and an empty replacement removes it. Global tag changes intentionally update live and pending metadata together. X inbox searches and paginates imports, reports issues in readable form, counts page selection, and links converted entries to their resulting drafts.

Projects have a thumbnail overview with status totals, text search, status filters and newest/name sorting. Add or edit opens a dedicated form with a live public-card preview, description counter, image selection/removal and Cmd/Ctrl+S saving. Filters are retained when returning from editing or deletion. Changes become public only after **Save project**; failed saves keep the form intact, and leaving with unsaved changes triggers the browser warning. Permanent deletion is under **More** and confirms the project name. Covers retain their full original proportions (including 1200 × 628 images); active status text and its dot share the same green.

## Migration and release

Schema version 3 adds private working copies, edit versions, draft creation request keys, revision labels, and a pin lookup index. The existing post schema and publication boundary remain authoritative. The migration takes a consistent pre-migration backup and runs only through the existing explicit migration/deployment flow.

Private ZIP export version 2 includes `working_copies` in `content.json` and one Markdown file per working copy under `working-copies/`. Live content remains under `posts/`. SQLite backups already include all working-copy and request-key state; backup/restore verification covers a published article with pending private content.

Run lint, typecheck, unit tests, build, integration, and browser tests before release. Browser tests use a disposable server/database and synthetic content, exercise the production CSP, and save desktop/tablet/mobile screenshots under ignored `output/playwright/`. Deploy reviewed changes through `BLOG_ENV=/absolute/config/.env bin/deploy main`, as documented in `DEPLOY.md`. The helper requires a clean release checkout and creates the database-aware rollback snapshot before migration. A rollback restores the pre-release database; retain the helper's fresh backup to recover edits made after release.
