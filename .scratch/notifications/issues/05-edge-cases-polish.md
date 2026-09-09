# 05 — notifications: edge cases + polish

Status: ready-for-agent
Type: task
Blocked by: 04

## Summary

A hardening pass over the notifications arc: failure paths, cleanup, and the
small gaps the core tickets deliberately left.

## Requirements

1. **`emitEvent` failure safety** — if the outbox insert succeeds but the
   domain transaction later fails/rolls back, the event must roll back too.
   Verify (and test) that the emit and the domain write commit atomically; the
   ticket-01 repo test for "emit in same tx" should assert a rollback case.
2. **Dead-job visibility** — no admin UI, but a `jobs.repo` read (`deadJobs()`
   or `listJobs(status)`) + a `retryJob` path is enough to recover. Add a
   `pnpm jobs:retry-dead <id>` script (or a small worker flag) to exercise it
   without a UI.
3. **Notification payload hygiene** — `document.uploaded` carries
   `filename`/`sizeBytes`; the deliver handler must NOT trust client-controlled
   strings for rendering (they come from the server's confirm handler, so this
   is low risk — but ensure the title/body render is length-capped and the
   filename is not interpreted as HTML anywhere).
4. **List pagination** — confirm `LIMIT 50` is a hard cap and the page/badge
   never render more; note the cursor/pagination follow-up in a comment or
   ticket if we want it later.
5. **Read-all semantics** — confirm `markAllRead` is user-scoped and
   idempotent under concurrent calls (two tabs), and that the badge's derived
   unread count converges after invalidation.
6. **Worker shutdown/backpressure** — the `Effect.repeat` loop should stop
   cleanly on process signal (no partial claim), and a claimed-but-crashed
   job should eventually be reclaimed (a `run_after` lease: set `run_after =
   now() + lease` on claim, re-claimable when past due and not `dead`). This is
   the one real correctness gap in ticket 01's claim — address it here or fold
   it into 01 if it lands early.

## Tests

- Rollback case: emit + domain write in one tx, force a failure, assert no
  outbox row.
- Concurrent `markAllRead` (two effects interleaved) converges.
- Lease re-claim: a `running` job past its `run_after` lease is claimable
  again.

## Out of scope

Push/SSE, admin jobs UI, pagination cursors, notification preferences.