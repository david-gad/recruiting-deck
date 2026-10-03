# Recruiting Command Deck

A browser-only, read-only recruiting dashboard for Gmail and Outlook.

## Deploy

Publish `index.html`, `mail-store.js`, and `mail-sync.js` together in the root of the existing GitHub Pages site. No server or build step is required. Keep the existing OAuth client IDs and registered site URL. No additional mail permissions are needed.

The separately supplied single-file `index.html` has both JavaScript files embedded and can replace the original page by itself. Use either deployment format, not a mixture of versions.

## What changed

- The first sync indexes full message text in the selected time window, including sent mail, instead of relying on capped keyword searches or short previews. This first pass can take time for a large mailbox; each completed page is saved and can resume after an interruption.
- Gmail uses a saved history ID for subsequent updates. Outlook uses a delta link per folder, including nested folders. Outlook IDs stay stable when messages move, and folder membership prevents a move from accidentally deleting the new copy.
- Messages and their checkpoint are written in one IndexedDB transaction. A failed request or storage write does not advance past unsaved work. An expired provider checkpoint keeps saved results visible and prompts a recovery sync.
- Reopening the page restores saved results, even if OAuth access has expired. Reconnect is needed to retrieve changes, not to read already saved results. Explicit sign-out hides the workspace until an account is connected again.
- The inbox searches saved message text and offers “Show more.” No fresh retrieval is required just to view a different tab.
- Unknown recruiter domains can appear as “Needs review.” Quoted replies are removed before extracting evidence. Multiple fund mentions and conflicting event language are marked for review. Attendance is never inferred merely because an event date passed.
- Fund status shows supporting excerpts and source email links. A later inbound follow-up in the same fund conversation is required for the highest automatic status. Manual corrections, notes, dismissals, and the chosen time window persist.

## Local storage and privacy

IndexedDB `rcd-mail-v1` holds normalized email text, message metadata, and per-account sync checkpoints. Notes and corrections remain in the existing workspace localStorage namespace. Access tokens remain in tab sessionStorage and never enter the mail database. The app sends mail API requests only to the corresponding provider and does not send message content to an AI service or an application backend. HTML mail is parsed inside inert templates; remote images are not displayed.

The widest time window previously synced remains cached when the view is narrowed. Trash, spam/junk, and drafts are excluded. Outlook's first pass enumerates folder delta pages and applies the date window locally to avoid the provider's filtered-delta result limit. File attachments, online archive mailboxes, and shared/delegated mailboxes are not indexed.

“Erase saved data” removes mail, checkpoints, notes, and corrections for the current workspace from this browser, including previously linked accounts in that workspace. It does not delete provider emails. Browser data clearing or eviction can remove this local cache; it is not a cross-device backup. The app page itself still needs to load; no offline service worker is installed.

## Tests

Install development dependencies with `pnpm install --frozen-lockfile` and run `pnpm test` (or `node --test tests/mail.test.cjs`). Production does not load these dependencies.

Tests cover full bodies, MIME/UTF-8 decoding, quoted replies, unknown recruiters, evidence attribution, manual corrections, account isolation, deduplication, Gmail and Outlook pagination, incremental updates, interrupted syncs, deleted messages, expired history, transaction rollback, quota failures, and cancellation.

The saved dashboard, expired-session access, inbox view, and correction persistence were also checked in a browser using synthetic mail. Live OAuth/mailbox integration still needs validation with the owner's accounts after deployment.
