# Operations Portal RAG

An AI-powered document Q&A system for internal operations teams. Upload SOPs, call-center procedures, and internal policies; get a searchable knowledge base with a conversational assistant that answers questions and cites the source document, plus a full CMS for non-technical staff to keep that knowledge current.

**Live demo:** https://operations-portal-rag.giamarigkos.workers.dev

Built as a self-contained portfolio project, but designed to be genuinely usable inside a real ops team, not just a tech demo.

## Why this exists

Internal operations documentation (verification steps, exception handling, compliance notes) usually lives in scattered PDFs, wikis, or tribal knowledge. Agents either can't find the right procedure fast enough, or nobody keeps the docs updated because editing them requires going through IT. This project explores a different shape: a RAG-powered assistant *and* a CMS built for the same non-technical staff who own the content, so the knowledge base can realistically stay current.

## Features

**Public portal**
- Conversational Q&A widget: ask a question in plain language, get an answer grounded in the uploaded documents, with a source reference
- Answers respond in whichever language the question was asked in (Greek or English), independent of the UI language
- Full bilingual UI (English / Greek) with a persistent language toggle
- Anonymous "guest" access with an isolated sandbox workspace, no login required to try it
- Customer accounts: email/password signup and login for a permanent, personal workspace that persists across devices and browsers (backed by D1, see [Accounts & sessions](#accounts--sessions) below)
- Per-workspace widget customization: bot name, accent color, and logo, applied live to the chat widget
- Optional email alert (via [Resend](https://resend.com)) whenever the assistant can't answer a question, rate-limited to at most one email per workspace per hour

**Content management (`/editor`)**
- WYSIWYG document editor (TOAST UI Editor): no markdown syntax required from editors
- Draft → Published → Deleted lifecycle: new documents start as private drafts with no embeddings generated until explicitly published
- Soft delete with restore (deleted documents are hidden from the public portal but recoverable)
- Word-level diff view between the current live text and the version being edited
- Auto-generated URL slugs (with Greek-to-Latin transliteration): editors never see or manage IDs
- Instant local filtering across all documents, plus semantic search ("find by description") for locating a document by what it's about rather than its title
- Fallback question log: every question the assistant couldn't answer is captured, surfaced in the editor, and can be dismissed once addressed. This is the feedback loop that tells editors what's missing from the knowledge base
- Contradiction checker: select 2-3 documents and run a single LLM call that flags conflicting instructions, numbers, or rules between them
- Widget settings panel (top bar, gear icon): edit bot name, accent color, logo URL, and the notification email address for the current workspace

**Multi-tenant workspace isolation**
- Every request is scoped by a workspace ID, resolved either from a session (see below) or an `X-Workspace-Id` header, in both the KV document registry and the Vectorize index namespace
- One protected, permanent workspace (used for the demo dataset) with no data expiry
- Any other workspace (anonymous visitors trying the tool, or a signed-up account) gets a 7-day rolling TTL on document/settings writes: automatic cleanup, no cron jobs or background processes involved

## Accounts & sessions

Three ways to get a workspace ID, in increasing order of permanence:

| Path | How you get a workspace ID | Expiry |
|---|---|---|
| Developer | Shared password (`DEVELOPER_PASSWORD` secret) → the one protected demo workspace | Never |
| Guest | Random UUID generated client-side, stored in `localStorage` | 7-day rolling TTL on the workspace's data |
| Account | Email/password signup or login (D1-backed) → a permanent workspace tied to that account | 30-day session, workspace data itself never expires |

Password hashing uses PBKDF2 (SHA-256, 100,000 iterations) via the Worker runtime's native Web Crypto API — no external dependency. Sessions are opaque, cryptographically random 256-bit tokens stored server-side in D1 (`sessions` table); logout deletes the row, invalidating the token immediately. A request carrying a valid `X-Session-Token` always has its workspace resolved from that session, never from a client-supplied `X-Workspace-Id` — this prevents a logged-in client from ever claiming a different workspace by editing a header.

**Known limitation:** there's no "forgot password" flow yet, and no rate limiting on `/account/login` (a determined attacker could attempt many passwords in sequence). Both are reasonable next steps before onboarding real customers; Cloudflare's built-in Rate Limiting Rules would cover the second with no code changes.

## Architecture

```
                 ┌────────────────────┐
  Browser  ───▶  │  Cloudflare Worker  │
 (index /        │  (src/index.js)     │
  editor /       └─────────┬──────────┘
  article /                │
  landing)                 ├──▶ KV (DOCUMENT_REGISTRY)      documents, fallback logs, contradictions, widget settings
                            ├──▶ D1 (rag-demo-tool-accounts) user accounts + sessions
                            ├──▶ Vectorize (operations-portal-rag-index)   embeddings for semantic search, per workspace
                            ├──▶ Gemini API                  gemini-embedding-001 for embeddings, gemini-3.6-flash for answers/contradiction detection
                            └──▶ Resend API                  fallback-question email notifications (optional, best-effort)
```

Three design decisions worth calling out:

- **Chunking is only ever used to build embeddings.** The full, original document text is stored as-is in KV and is what gets rendered back to a human; chunk boundaries never touch the reconstructed text. Reconstructing prose from chunks destroys paragraph and heading structure, so keeping a single unchunked source of truth avoids that entirely.
- **No background jobs.** Fallback-question logs and visitor-workspace documents both expire via native KV TTL (`expirationTtl`), not a cron job or scheduled worker. Anything that needs cleanup expires itself.
- **Sessions are server-side, not stateless JWTs.** A session token is meaningless on its own; every request re-checks it against D1. This costs one extra read per authenticated request but means logout, and future revocation, actually work — a stateless signed token can't be un-issued before it expires.

## Tech stack

| Layer | Choice |
|---|---|
| Compute | Cloudflare Workers |
| Vector search | Cloudflare Vectorize (768 dimensions, cosine similarity) |
| Document storage | Cloudflare KV |
| Accounts & sessions | Cloudflare D1 (SQLite) |
| Password hashing | PBKDF2-SHA256 (native Web Crypto, no dependency) |
| Embeddings | Gemini `gemini-embedding-001` |
| Answer generation | Gemini `gemini-3.6-flash` |
| Email notifications | Resend |
| Editor | TOAST UI Editor (WYSIWYG, markdown output) |
| Markdown rendering | marked.js + DOMPurify |
| Frontend | Vanilla HTML/CSS/JS, no build step |

## API reference

Unless noted otherwise, endpoints resolve the workspace from `X-Session-Token` if present, falling back to `X-Workspace-Id`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `POST` | `/developer-login` | Exchange a password for the protected demo workspace ID |
| `POST` | `/account/signup` | Create an account: `{email, password}` → `{sessionToken, workspaceId}` |
| `POST` | `/account/login` | `{email, password}` → new `{sessionToken, workspaceId}` |
| `POST` | `/account/logout` | Invalidate the session behind `X-Session-Token` |
| `POST` | `/upload` | Create a new document (starts as a draft, no embeddings yet) |
| `GET` | `/documents` | List all documents for the current workspace |
| `GET` | `/document/{id}` | Fetch a single document's full text and metadata |
| `POST` | `/document/{id}/publish` | Chunk, embed, and publish a draft |
| `POST` | `/document/{id}/delete` | Soft-delete: removes vectors, keeps the KV record, hides from the public portal |
| `POST` | `/document/{id}/restore` | Restore a deleted document back to draft status |
| `POST` | `/search-documents` | Semantic search across documents by description |
| `POST` | `/query` | Ask a question; returns an answer grounded in the workspace's published documents |
| `GET` | `/fallback-questions` | List questions the assistant couldn't answer |
| `DELETE` | `/fallback-questions/{id}` | Dismiss a fallback question once addressed |
| `POST` | `/compare-documents` | `{documentIds: [2-3], lang}` → LLM-detected contradictions between the given documents |
| `GET` | `/contradictions` | List stored contradiction findings for the workspace |
| `DELETE` | `/contradictions/{id}` | Dismiss a contradiction finding |
| `GET` | `/workspace/settings` | Get widget settings (bot name, accent color, logo, notification email) |
| `PATCH` | `/workspace/settings` | Update widget settings (whitelisted fields, validated) |

## Getting started locally

**Prerequisites:** a Cloudflare account, [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed, a Gemini API key, and (optionally, for email notifications) a [Resend](https://resend.com) account.

```bash
git clone https://github.com/giamarigkos-del/rag-demo-tool.git
cd rag-demo-tool
```

Create the required Cloudflare resources (or reuse existing ones and update `wrangler.toml`):

```bash
npx wrangler kv namespace create DOCUMENT_REGISTRY
npx wrangler vectorize create operations-portal-rag-index --dimensions=768 --metric=cosine
npx wrangler d1 create rag-demo-tool-accounts
```

Apply the D1 schema (both remote and local, so `wrangler dev` has the tables too):

```bash
npx wrangler d1 execute rag-demo-tool-accounts --remote --file=schema.sql
npx wrangler d1 execute rag-demo-tool-accounts --local --file=schema.sql
```

Set the required secrets:

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put DEVELOPER_PASSWORD
npx wrangler secret put RESEND_API_KEY   # optional: only needed for fallback-question email alerts
```

Set `NOTIFY_FROM_EMAIL` in `wrangler.toml` under `[vars]` — use `onboarding@resend.dev` (Resend's shared test sender, which can only deliver to your own Resend account email) until you've verified your own domain on Resend.

Run locally or deploy:

```bash
npx wrangler dev          # local development
npx wrangler deploy       # deploy to Cloudflare
```

> Wrangler's KV/Vectorize/D1 commands default to a local emulated store. Pass `--remote` to any command that should touch production data.

## Project structure

```
rag-demo-tool/
├── src/
│   └── index.js          # Worker entry point: all API routes and business logic
├── public/
│   ├── landing.html       # Entry point: Developer / Guest / Account (signup+login)
│   ├── index.html         # Public document portal + Q&A widget
│   ├── editor.html        # Content management dashboard (CMS) + widget settings panel
│   ├── article.html       # Single published document, read-only view
│   ├── shared.css         # Design tokens, shared component styles, i18n toggle
│   └── shared.js          # Shared frontend logic: workspace/session resolution, i18n, markdown rendering, slugs
├── tests/
│   ├── widget-settings.mjs   # Integration tests: widget settings CRUD + validation
│   └── accounts.mjs          # Integration tests: signup/login/logout + session-based workspace resolution
├── schema.sql             # D1 schema: users, sessions
└── wrangler.toml
```

## Known limitations

- Single embedding/generation provider (Gemini), no fallback if the API is unavailable
- No password-reset ("forgot password") flow for accounts yet
- No rate limiting on `/account/login` yet (Cloudflare Rate Limiting Rules would cover this without code changes)
- Guest and Developer access still trust a client-supplied `X-Workspace-Id` header directly (no session backing them) — acceptable for a demo/anonymous-trial workspace, but a logged-in account is always protected via server-side session lookup regardless of what `X-Workspace-Id` a request also sends
- No version history: publishing overwrites the previous embedded version (the full text itself is always preserved in KV, but there's no diff-able revision log yet)

## License

No license file is currently published with this repository.