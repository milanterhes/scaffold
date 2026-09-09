# Notifications — spec

Status: ready-for-agent

## Summary

Add a notifications feature: a Postgres-backed inbox that users read through a
bell badge and a `/notifications` page. This is the first consumer of a new
event-driven background-job infrastructure (`packages/jobs` + `apps/worker`):
when a document upload confirms, the domain emits an event transactionally, a
background worker picks it up, and a job writes a notification row.

## Design decisions (grilled, 2026-09-09)

- **Jobs infra + notifications both ship.** `packages/jobs` is a Postgres-backed
  outbox → jobs queue with an in-process registry; `apps/worker` is a separate
  process that runs the jobs.
- **Event-triggered job only.** One job type: `notification.deliver`. No
  time-triggered/scheduled jobs (the pending-doc TTL sweep is explicitly
  dropped).
- **Notifications from document lifecycle only, and only on success.**
  `document.uploaded` is emitted when a confirm succeeds. `document_failed`
  stays in the type enum but is NOT emitted for confirm 409s (the user already
  sees that error inline in the upload UI). Auth/notes events are future adds
  via the enum.
- **Explicit transactional emit.** The domain calls `emitEvent(...)` in the same
  SQL transaction as the domain write, so the event commits atomically with the
  change.
- **Retry with backoff, then dead-letter.** `attempts`, `max_attempts` (3),
  `run_after` (now + backoff), `last_error`. Dead jobs can be retried via a
  repo fn; no admin UI.
- **`packages/notifications` is its own domain package.** Inbox model, repo,
  migration, API schemas, and the `notification.deliver` job handler.
- **Inbox rows are denormalized.** `id, user_id, type, title, body,
  read_at timestamptz NULL, created_at`. Read is a timestamp (records when),
  not a boolean.
- **API:** `GET /me/notifications` (LIMIT 50, newest first), `POST
  /me/notifications/:id/read` (idempotent), `POST /me/notifications/read-all`.
  All behind `SessionMiddleware`, user-scoped. No dedicated unread-count
  endpoint — the badge derives unread from the list.
- **Badge lives in `__root.tsx`** (shared chrome around `<Outlet />`), so it
  appears on every page. Polls with TanStack Query
  `useQuery({ queryKey: ["notifications"], refetchInterval: 30_000 })`.
- **The `/notifications` page shares the same query key** as the badge, so
  mark-read invalidation refreshes both. Refetch on action / poll; no
  PubSub/SSE push.

## Notifications wire model

```
id         uuid PK
user_id    text NOT NULL
type       text NOT NULL            -- 'document_uploaded' | 'document_failed' | ...
title      text NOT NULL
body       text NOT NULL
read_at    timestamptz NULL         -- NULL = unread
created_at timestamptz NOT NULL DEFAULT now()
```

## Events

- `document.uploaded` — payload `{ userId, documentId, filename, sizeBytes }`.
  Emitted in `documents.impl.ts` confirm handler, same transaction as the
  `pending → stored` flip.
- Outbox → jobs: a dispatcher (in the worker) claims outbox rows
  (`FOR UPDATE SKIP LOCKED`), inserts a `notification.deliver` job per row, and
  marks the outbox row consumed. The deliver job writes the inbox row from the
  event payload + type → title/body mapping.

## Out of scope

- Scheduled/cron jobs (TTL sweep dropped).
- Failed-upload notifications.
- PubSub/SSE push; polling only.
- Admin/ops UI for jobs; a repo fn for manual dead-job retry is enough.
- Pagination beyond `LIMIT 50`.

## Tickets

See `issues/` in this directory (01..04).