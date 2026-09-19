# Idmon

*Formerly "Operations Portal RAG".*

An AI-powered document Q&A system with a built-in CMS. Upload FAQs, SOPs, and internal policies (or pull them from a URL); get a searchable knowledge base with a conversational assistant that answers questions and cites the source document, plus an editor for non-technical staff to keep that knowledge current. The assistant can be embedded on any website as a chat widget.

**Product:** https://app.idmon.app

Built on Cloudflare Workers, Vectorize, D1, and Gemini. Designed to be genuinely usable by small teams and businesses, not just a tech demo.

## Why this exists

Documentation (verification steps, exception handling, FAQs, compliance notes) usually lives in scattered PDFs, wikis, or tribal knowledge. Agents and customers either can't find the right answer fast enough, or nobody keeps the docs updated because editing them requires going through IT. This project explores a different shape: a RAG-powered assistant *and* a CMS built for the same non-technical staff who own the content, so the knowledge base can realistically stay current.

## Features

**Chat assistant**
- Conversational Q&A: ask a question in plain language, get an answer grounded in the published documents, with a source reference
- Answers come back in whichever language the question was asked in (Greek or English), independent of the UI language
- Streaming responses (SSE): text appears progressively instead of after a long wait
- Full bilingual UI (English / Greek) with a persistent language toggle
- Optional email alert (via [Resend](https://resend.com)) whenever the assistant can't answer a question, rate-limited to at most one email per workspace per hour

**Embeddable widget**
- One script tag puts the assistant on any website; the widget is rendered in a Shadow DOM (not an iframe), so the request `Origin` reflects the customer's real domain
- Every workspace gets a separate public `embed_id`, distinct from the internal workspace ID
- Mandatory domain allow-list: with no allowed domain configured, no script is served
- CORS middleware on the public `/embed/{embedId}/query` endpoints
- AI disclosure label always visible in the widget header (EU AI Act Article 50)
- Human handoff: a persistent contact bar under the header (label, URL, phone) plus a more prominent contact prompt under fallback ("I don't know") answers
- Per-workspace customization: bot name, accent color, and logo, applied live

**Content management (`/editor`)**
- WYSIWYG document editor (TOAST UI Editor): no markdown syntax required from editors
- Draft, Published, Deleted lifecycle: new documents start as private drafts with no embeddings generated until explicitly published
- Soft delete with restore (deleted documents are hidden from the public portal but recoverable)
- Word-level diff view between the current live text and the version being edited
- Auto-generated URL slugs (with Greek-to-Latin transliteration): editors never see or manage IDs
- Instant local filtering across all documents, plus semantic search ("find by description")
- **Add from URL**: read a public web page, strip navigation and boilerplate, create a draft. **Refresh from URL** re-fetches and re-embeds a published document
- **Upload file**: `.txt`, `.md`, and `.pdf` (PDF text is extracted through Gemini's native document understanding)
- Fallback question log: every question the assistant couldn't answer is captured, surfaced in the editor, and can be dismissed once addressed. This is the feedback loop that tells editors what's missing from the knowledge base
- Contradiction checker: select 2-3 documents and run a single LLM call that flags conflicting instructions, numbers, or rules between them
- Analytics panel: daily question and fallback counts with a 7 / 30 / 90 day range toggle (counters only, no question text is stored)
- Embed panel: manage the domain allow-list and get the embed snippet
- Widget settings panel (gear icon): bot name, accent color, logo URL, contact handoff fields, and notification email
- Account section (real accounts only): data export and account deletion
- Usage banner: shown to the workspace owner when the plan's message or document limit is reached

**Plans and usage limits**
- Three plans (Free, Basic, Pro) with monthly message and document limits per workspace, enforced in the backend (see [Plans](#plans-and-usage-limits))
- When the message limit is reached, the end visitor sees only a generic "technical difficulties" message with the workspace's own contact details (no mention of Idmon, plans, or limits), and the workspace owner sees a banner in the editor

**Multi-tenant workspace isolation**
- Every request is scoped by a workspace ID, resolved either from a session or an `X-Workspace-Id` header, in both the KV document registry and the Vectorize index namespace
- One protected, permanent workspace (used for the demo dataset) with no data expiry and no usage limit
- Guest workspaces get a 7-day rolling TTL on document and settings writes: automatic cleanup, no cron jobs or background processes involved
- Account workspaces never expire

## Accounts and sessions

Three ways to get a workspace ID, in increasing order of permanence:

| Path | How you get a workspace ID | Expiry |
|---|---|---|
| Developer | Shared password (`DEVELOPER_PASSWORD` secret) to the one protected demo workspace | Never |
| Guest | Random UUID generated client-side, stored in `localStorage` | 7-day rolling TTL on the workspace's data |
| Account | Email/password signup or login (D1-backed) to a permanent workspace tied to that account | 30-day session, workspace data itself never expires |

Password hashing uses PBKDF2 (SHA-256, 100,000 iterations) via the Worker runtime's native Web Crypto API, with no external dependency. 100,000 is the hard iteration ceiling of the Cloudflare Workers runtime (higher values throw `NotSupportedError`), so it cannot currently be raised to the higher figures OWASP recommends. The iteration count is stored per user (`users.password_iterations`) so it can be raised later without invalidating existing hashes.

Sessions are opaque, cryptographically random 256-bit tokens stored server-side in D1 (`sessions` table); logout deletes the row, invalidating the token immediately. A request carrying a valid `X-Session-Token` always has its workspace resolved from that session, never from a client-supplied `X-Workspace-Id`. This prevents a logged-in client from ever claiming a different workspace by editing a header.

Other account behavior:
- **Email verification** on signup (24-hour token, bilingual email). It is "soft": an unverified account is never blocked from logging in or using the product, it just sees a dismissible banner. Accounts created before this feature were grandfathered in as verified
- **Password reset** via a time-limited token (30 minutes) sent by email in the user's selected UI language. A successful reset invalidates all of that account's sessions
- **Rate limiting** on login, developer login, signup, forgot-password, and reset-password: 5 attempts per 15 minutes per client IP (`CF-Connecting-IP`)
- **Data export** (`GET /account/export`) returns a JSON file with the account info, documents (full content), widget settings, and embed domains
- **Account deletion** (`POST /account/delete`) requires password re-confirmation and removes everything scoped to the workspace: documents and their embeddings, contradictions, fallback questions, settings, analytics and usage counters, third-party connections, embed domains, sessions, and finally the user row

## Plans and usage limits

Limits are defined in `PLAN_LIMITS` in `src/index.js` and stored per account in the `users.plan` D1 column.

| Plan | Messages / month | Documents | Default for |
|---|---|---|---|
| Free | 100 | 5 | New signups |
| Basic | 500 | 20 | Accounts that existed before plans were introduced (migration default) |
| Pro | 2,500 | Unlimited | Set manually |

- Message limits are enforced per workspace per month in `checkAndIncrementUsage()`, called before any model request is made
- Document limits are enforced on every path that creates a document (manual upload, URL sync, file upload, Drive import)
- `GET /usage/status` returns the current plan, limits, and usage, and powers the editor banner
- The protected demo workspace is exempt from the message limit
- For local testing only, `MONTHLY_MESSAGE_LIMIT_OVERRIDE` in `.dev.vars` overrides the message limit (the variable does not exist in production)

## Architecture

```
                 ┌────────────────────┐
  Browser  ───▶  │  Cloudflare Worker  │
 (landing /      │  (src/index.js)     │
  index /        └─────────┬──────────┘
  editor /                 │
  article /                ├──▶ KV (DOCUMENT_REGISTRY)      documents, fallback logs, contradictions, widget settings, analytics counters, usage counters, one-time tokens
  terms /                  ├──▶ D1 (rag-demo-tool-accounts) accounts, sessions, connections
  privacy)                 ├──▶ Vectorize (operations-portal-rag-index)   embeddings for semantic search, per workspace
  Customer sites  ───▶     ├──▶ Gemini API                  gemini-embedding-001 for embeddings, gemini-3.6-flash for answers, PDF extraction, and contradiction detection
  (widget.js)              └──▶ Resend API                  transactional email: fallback alerts, verification, password reset
```

Design decisions worth calling out:

- **Chunking is only ever used to build embeddings.** The full, original document text is stored as-is in KV and is what gets rendered back to a human; chunk boundaries never touch the reconstructed text. Reconstructing prose from chunks destroys paragraph and heading structure, so keeping a single unchunked source of truth avoids that entirely.
- **No background jobs.** Fallback-question logs, guest-workspace documents, and one-time tokens all expire via native KV TTL (`expirationTtl`), not a cron job or scheduled worker. Anything that needs cleanup expires itself.
- **Sessions are server-side, not stateless JWTs.** A session token is meaningless on its own; every request re-checks it against D1. This costs one extra read per authenticated request but means logout and revocation actually work.
- **Streaming with a safety net.** `/query/stream` wraps Gemini's `streamGenerateContent` in a small custom SSE protocol (`chunk`, `done`, `error` events). If a stream yields zero chunks, the non-streaming path is used automatically.
- **Draft-then-publish everywhere.** Manual uploads, URL sync, file upload, and Drive import all create drafts. Nothing is embedded or visible to the public until it is explicitly published.
- **Integrations share one table.** OAuth connections live in a single D1 `connections` table (workspace, provider, encrypted tokens, expiry), so a new provider is an addition, not a rewrite. Tokens are encrypted with AES-GCM (`src/crypto-helpers.js`) before they are stored.

## Tech stack

| Layer | Choice |
|---|---|
| Compute | Cloudflare Workers |
| Vector search | Cloudflare Vectorize (768 dimensions, cosine similarity) |
| Document storage | Cloudflare KV |
| Accounts, sessions, connections | Cloudflare D1 (SQLite) |
| Password hashing | PBKDF2-SHA256 (native Web Crypto, no dependency) |
| Token encryption | AES-GCM (native Web Crypto) |
| Embeddings | Gemini `gemini-embedding-001` |
| Answer generation | Gemini `gemini-3.6-flash` |
| Email | Resend |
| Editor | TOAST UI Editor (WYSIWYG, markdown output) |
| Markdown rendering | marked.js + DOMPurify (fails closed: escaped text if DOMPurify cannot load) |
| Frontend | Vanilla HTML/CSS/JS, no build step |

## API reference

Unless noted otherwise, endpoints resolve the workspace from `X-Session-Token` if present, falling back to `X-Workspace-Id`.

**Health and access**

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `POST` | `/developer-login` | Exchange a password for the protected demo workspace ID (rate limited) |
| `POST` | `/account/signup` | Create an account: `{email, password}` to `{sessionToken, workspaceId}` (rate limited) |
| `POST` | `/account/login` | `{email, password}` to a new `{sessionToken, workspaceId}` (rate limited) |
| `POST` | `/account/logout` | Invalidate the session behind `X-Session-Token` |
| `POST` | `/account/forgot-password` | Send a password reset email (rate limited) |
| `POST` | `/account/reset-password` | Complete a password reset with the token from the email and set a new password (rate limited) |
| `POST` | `/account/verify-email` | Confirm an email verification token |
| `POST` | `/account/resend-verification` | Resend the verification email (session required) |
| `GET` | `/account/export` | Download all account data as JSON (session required) |
| `POST` | `/account/delete` | Delete the account and all workspace data; requires password (session required, rate limited) |

**Documents**

| Method | Path | Description |
|---|---|---|
| `POST` | `/upload` | Create a new document (starts as a draft, no embeddings yet) |
| `POST` | `/upload-file` | Multipart upload of `.txt`, `.md`, or `.pdf` into a new draft |
| `POST` | `/upload-from-url` | Read a public web page into a new draft |
| `POST` | `/document/{id}/refresh-from-url` | Re-fetch the source page and re-embed if already published |
| `GET` | `/documents` | List all documents for the current workspace |
| `GET` | `/document/{id}` | Fetch a single document's full text and metadata |
| `POST` | `/document/{id}/publish` | Chunk, embed, and publish a draft |
| `POST` | `/document/{id}/delete` | Soft-delete: removes vectors, keeps the KV record, hides from the public portal |
| `POST` | `/document/{id}/restore` | Restore a deleted document back to draft status (rejected if the document is not deleted) |
| `POST` | `/search-documents` | Semantic search across documents by description |

**Chat**

| Method | Path | Description |
|---|---|---|
| `POST` | `/query` | Ask a question; returns `{answer, isFallback, primarySource, relatedSections}` |
| `POST` | `/query/stream` | Same, streamed over SSE (`chunk`, `done`, `error` events) |
| `POST` | `/embed/{embedId}/query` | Public widget endpoint (domain allow-list and CORS enforced) |
| `POST` | `/embed/{embedId}/query/stream` | Public widget endpoint, streamed |

**Quality and insights**

| Method | Path | Description |
|---|---|---|
| `GET` | `/fallback-questions` | List questions the assistant couldn't answer |
| `DELETE` | `/fallback-questions/{id}` | Dismiss a fallback question once addressed |
| `POST` | `/compare-documents` | `{documentIds: [2-3], lang}` to LLM-detected contradictions between the given documents |
| `GET` | `/contradictions` | List stored contradiction findings for the workspace |
| `DELETE` | `/contradictions/{id}` | Dismiss a contradiction finding |
| `GET` | `/analytics/summary?days=N` | Daily question and fallback counts for the last N days |
| `GET` | `/usage/status` | Current plan, limits, and usage for the workspace |

**Workspace settings and embed**

| Method | Path | Description |
|---|---|---|
| `GET` | `/workspace/settings` | Get widget settings (bot name, accent color, logo, contact fields, notification email) |
| `PATCH` | `/workspace/settings` | Update widget settings (whitelisted fields, validated; `contactUrl` rejects `javascript:`, `vbscript:`, and `data:` schemes) |
| `GET` | `/embed/domains` | List the domain allow-list for the workspace's embed widget |
| `PATCH` | `/embed/domains` | Update the domain allow-list (there is a maximum number of domains per workspace) |

**Google Drive connector** (implemented, currently hidden in the editor UI, see [Known limitations](#known-limitations))

| Method | Path | Description |
|---|---|---|
| `GET` | `/oauth/google/start` | Begin the OAuth flow (state stored in KV with a 10-minute single-use TTL) |
| `GET` | `/oauth/google/callback` | Complete the flow; refuses to save a connection if `drive.readonly` was not granted |
| `GET` | `/connections/google-drive/files` | List importable Docs and Sheets |
| `POST` | `/connections/google-drive/import` | Import selected files as drafts (Docs as plain text, Sheets as CSV) |
| `DELETE` | `/connections/google-drive` | Revoke the token at Google (best effort) and delete the connection |

## Getting started locally

**Prerequisites:** a Cloudflare account, [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed, a Gemini API key, and (optionally, for email) a [Resend](https://resend.com) account.

```bash
git clone https://github.com/giamarigkos-del/idmon.git
cd idmon
```

Create the required Cloudflare resources (or reuse existing ones and update `wrangler.toml`):

```bash
npx wrangler kv namespace create DOCUMENT_REGISTRY
npx wrangler vectorize create operations-portal-rag-index --dimensions=768 --metric=cosine
npx wrangler d1 create rag-demo-tool-accounts
```

Apply the D1 schema and every migration, **both remote and local**. `wrangler dev` uses its own local copy of D1, so a migration applied only with `--remote` will still be missing locally:

```bash
npx wrangler d1 execute rag-demo-tool-accounts --remote --file=schema.sql
npx wrangler d1 execute rag-demo-tool-accounts --local --file=schema.sql
npx wrangler d1 migrations apply rag-demo-tool-accounts --remote
npx wrangler d1 migrations apply rag-demo-tool-accounts --local
```

> `wrangler d1 execute --remote --file=...` occasionally fails with `Authentication error [code: 10000]`. This is a known intermittent Cloudflare API issue; retrying the same command once normally fixes it.

Set the required secrets:

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put DEVELOPER_PASSWORD
npx wrangler secret put RESEND_API_KEY          # needed for fallback alerts, verification, and password reset emails
npx wrangler secret put TOKEN_ENCRYPTION_KEY    # 32-byte hex key, only needed for the Google Drive connector
npx wrangler secret put GOOGLE_CLIENT_SECRET    # only needed for the Google Drive connector
```

Configure `[vars]` in `wrangler.toml`:
- `NOTIFY_FROM_EMAIL`: the sender address for transactional email. It must belong to a domain you have verified on Resend (or use `onboarding@resend.dev`, Resend's shared test sender, which can only deliver to your own Resend account email)
- `GOOGLE_CLIENT_ID` and `GOOGLE_REDIRECT_URI`: only for the Google Drive connector

For local runs, put overrides such as `MONTHLY_MESSAGE_LIMIT_OVERRIDE` in `.dev.vars`.

Run locally or deploy:

```bash
npx wrangler dev          # local development
npx wrangler deploy       # deploy to Cloudflare
```

Notes on local development:
- Wrangler's KV, Vectorize, and D1 commands default to a local emulated store. Pass `--remote` to any command that should touch production data
- Vectorize cannot be emulated locally, so the `[[vectorize]]` binding uses `remote = true`: **local dev talks to the real Vectorize index.** This is safe because test workspaces use random IDs isolated by namespace, and the tests clean up after themselves
- The app is served from a custom domain (`routes` in `wrangler.toml`) and `workers_dev` is disabled, so the `workers.dev` URL is not available

## Testing

Tests live in `tests/` and run with Node (`node tests/<file>.mjs`). There are two kinds:

- **Backend integration tests** (for example `accounts.mjs`, `account-deletion.mjs`, `email-verification.mjs`, `streaming.mjs`, `url-sync.mjs`, `analytics.mjs`, `embed-query.mjs`, `widget-settings.mjs`): need `npx wrangler dev` running, and make real Gemini and Vectorize calls
- **Headless DOM tests** (`*-headless-check.mjs`): run the real frontend code under jsdom, no network needed

## Project structure

```
idmon/
├── src/
│   ├── index.js            # Worker entry point: all API routes and business logic
│   └── crypto-helpers.js   # AES-GCM encrypt/decrypt for stored OAuth tokens
├── public/
│   ├── landing.html        # Entry point: Guest / Account (signup and login)
│   ├── index.html          # Public document portal + Q&A widget
│   ├── editor.html         # Content management dashboard (CMS), settings, analytics, embed, account
│   ├── article.html        # Single published document, read-only view
│   ├── terms.html          # Terms of Service (bilingual)
│   ├── privacy.html        # Privacy Policy (bilingual)
│   ├── widget.js           # Embeddable chat widget (Shadow DOM)
│   ├── shared.css          # Design tokens, shared component styles, scrollbar styling, i18n toggle
│   └── shared.js           # Shared frontend logic: workspace/session resolution, i18n, markdown rendering, slugs
├── migrations/             # D1 migrations (0002 onward): connections, email verification, password iterations, plans
├── tests/                  # Integration and headless tests, see Testing
├── schema.sql              # Base D1 schema: users, sessions
└── wrangler.toml
```

## Known limitations

- Single embedding/generation provider (Gemini), no fallback if the API is unavailable
- Each `/query` is independent: there is no conversation history, so a follow-up such as "and what colors?" has no context yet
- URL sync does not execute JavaScript: Cloudflare-obfuscated email addresses cannot be read, and pages that require login return the sign-in page as if it were the real content (no login-redirect detection yet)
- Google Drive: the connector is implemented but hidden in the editor UI. `drive.readonly` is a restricted Google scope that needs an annual third-party security assessment before it can be offered outside Google's "Testing" mode. Sheets import reads only the first sheet
- File upload supports `.txt`, `.md`, and `.pdf`; `.docx` is not supported yet
- Guest and Developer access still trust a client-supplied `X-Workspace-Id` header directly (no session backing them). This is acceptable for an anonymous-trial or demo workspace, but a logged-in account is always protected via server-side session lookup
- The rate limiter uses per-IP buckets, so users behind a shared IP share a bucket
- PBKDF2 is capped at 100,000 iterations by the Workers runtime (see [Accounts and sessions](#accounts-and-sessions))
- No version history: publishing overwrites the previous embedded version (the full text is always preserved in KV, but there is no diff-able revision log)
- There is no public pricing or marketing page yet; `idmon.app` currently issues a temporary `302` redirect to `app.idmon.app`
- Internal resource names still use the old branding (Worker `operations-portal-rag`, Vectorize index `operations-portal-rag-index`, D1 database `rag-demo-tool-accounts`); they are not visible to end users
- The Terms of Service and Privacy Policy are templates and do not yet include a legal entity identification

## License

No license file is currently published with this repository.