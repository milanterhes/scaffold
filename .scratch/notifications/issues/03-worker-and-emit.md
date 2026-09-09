# 03 — apps/worker + emit document.uploaded

Status: ready-for-agent
Type: task
Blocked by: 01

## Summary

Add the `apps/worker` process (the background job runner) and wire the first
event emission: `document.uploaded` on confirm success, which the worker turns
into a `notification.deliver` job.

## Requirements

1. **`apps/worker` package** — a new app package (mirror `apps/web` shape but
   headless): `package.json` (`@app/jobs`, `@app/notifications`, `@app/core`,
   `effect` deps), `tsconfig.json`. Its `dev` script runs the worker
   (`tsx watch src/index.ts` or a direct runner).
2. **Worker main** (`apps/worker/src/index.ts` / `worker.ts`):
   - A `ManagedRuntime` over a layer providing `PgLive` (from `@app/core`),
     `JobRegistry` (from `@app/jobs`), plus the `NodeChildProcessSpawner` /
     `NodeFileSystem` / `NodePath` platform services (`@effect/platform-node`)
     that `PgLive`/migrations need.
   - Registers handlers: `jobs.register("notification.deliver",
     notificationDeliverHandler)` (from `@app/notifications`).
   - Runs `JobWorker.run()` (the `Effect.repeat` claim loop from ticket 01)
     via `NodeRuntime.runMain` / `Layer.launch`, logging as it goes.
3. **Dev orchestration** — root `package.json`: change `dev` to
   `turbo run dev --filter @app/web --filter @app/worker` so one `pnpm dev`
   runs both long-lived processes (both are `persistent: true` in turbo).
4. **Emit `document.uploaded`** — in `apps/web/src/api/documents.impl.ts`,
   confirm handler: after the `pending → stored` flip (same SQL transaction),
   call `emitEvent("document.uploaded", { userId, documentId, filename,
   sizeBytes })`. The emit and the `UPDATE ... SET state='stored'` must commit
   together (share the repo's `SqlClient` effect; the emit is an extra
   `INSERT` in the same `yield* sql` sequence / transaction).
5. **Event → job** — the dispatcher: `apps/worker` (or a `packages/jobs`
   helper) claims unconsumed outbox rows (`FOR UPDATE SKIP LOCKED`), inserts a
   `notification.deliver` job per row with the event payload, and marks the
   outbox row consumed. Runs in the same worker loop (one pass: drain outbox →
   claim jobs → run handlers).

## Tests

- `apps/worker` test (or a `packages/jobs` integration test): emitting a
  `document.uploaded` event, running the worker loop once, asserts a
  `notification.deliver` job is created, claimed, run, and the inbox row exists
  (depends on ticket 02's `createNotification`; can be a thin integration test).
- Documents test: confirm success now also writes an outbox row (assert via
  repo/SQL); confirm 409 does NOT emit (per spec, failed uploads don't notify).

## Out of scope

Scheduled jobs, the TTL sweep, auth events, the API/UI (tickets 02/04), admin
UI for jobs.