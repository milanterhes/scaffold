# 02 — packages/notifications: inbox domain + deliver job

Status: ready-for-agent
Type: task
Blocked by: 01

## Summary

Create `packages/notifications`, the notifications domain package: the inbox
model/repo/migration, the API wire schemas, and the `notification.deliver` job
handler that turns an outbox event into an inbox row.

## Requirements

1. **Migration** (`packages/notifications/src/db/migrations.ts`,
   `"0004_create_notifications"`, merged into `scripts/migrate.ts`):
   - `notifications` table:
     `id uuid PK`, `user_id text NOT NULL`, `type text NOT NULL`,
     `title text NOT NULL`, `body text NOT NULL`, `read_at timestamptz NULL`,
     `created_at timestamptz NOT NULL DEFAULT now()`.
   - Index on `(user_id, created_at DESC)`.
2. **Model** — `Notification` `Model.Class` (branded `NotificationId`),
   following `notes`/`documents` model conventions. `read_at` uses the
   `DateTime`-select variant so rows decode honestly.
3. **Repo** (`src/repo/notifications.repo.ts`, `Effect.fnUntraced`, raw SQL):
   - `listNotifications(userId, limit)` — newest first, LIMIT 50.
   - `markRead(userId, notificationId)` — idempotent; sets `read_at = now()`
     when NULL; `Option.none` when not owned/missing.
   - `markAllRead(userId)`.
   - `createNotification(userId, type, title, body)` — used by the deliver job.
4. **Event → inbox** — the `notification.deliver` handler
   (`src/jobs/notification.deliver.ts`): a `JobRegistry` handler that decodes
   the outbox payload (`document.uploaded`: `{ userId, documentId, filename,
   sizeBytes }`), renders `title`/`body` (e.g. "Upload confirmed" /
   "<filename> was stored"), and calls `createNotification`. Registered in
   `apps/worker` (ticket 03).
5. **API wire schemas** (`src/schema/api.ts`) — `NotificationListItem`
   (= `Notification.json`), `MarkReadResult`. No dedicated unread-count schema
   (derived from the list).
6. **Index/`./server` split** — browser-safe exports (`db/models.js`,
   `schema/api.js`) on the main entry; repo + migrations behind `./server`,
   matching the notes/documents split.

## Tests

- Repo tests: create/list newest-first, markRead idempotent + user-scoped,
  markAllRead, 404-on-other-user via `Option.none`.
- Deliver-handler test: given a `document.uploaded` payload, the handler writes
  the expected title/body row.
- Follow `setupTestDb({ ...all migrations })` + `TestDbLayer`.

## Out of scope

The HTTP API layer (ticket 04), the badge/page UI, polling, emitting the event
from `documents` (ticket 03 wires emit + worker; the emit call itself is ticket
03's concern).