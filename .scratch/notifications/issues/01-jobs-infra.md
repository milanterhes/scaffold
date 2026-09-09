# 01 — packages/jobs: outbox + jobs queue infrastructure

Status: ready-for-agent
Type: task
Blocked by:

## Summary

Create `packages/jobs`, the Postgres-backed outbox → jobs queue that background
work runs on. This is infrastructure only; no consumers yet (tickets 02–04
build on it).

## Requirements

1. **Migrations** (`packages/jobs/src/db/migrations.ts`, `"0003_create_jobs"`,
   merged into `scripts/migrate.ts`):
   - `outbox` table: `id uuid PK`, `event_type text NOT NULL`, `payload jsonb
     NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`,
     `consumed_at timestamptz NULL`.
   - `jobs` table: `id uuid PK`, `job_type text NOT NULL`, `payload jsonb NOT
     NULL`, `status text NOT NULL` (`'pending' | 'running' | 'dead'`),
     `attempts int NOT NULL DEFAULT 0`, `max_attempts int NOT NULL DEFAULT 3`,
     `run_after timestamptz NOT NULL DEFAULT now()`, `last_error text NULL`,
     `created_at`, `updated_at`.
   - Indexes on `outbox (consumed_at)`, `jobs (status, run_after)`.
2. **Transactional emit** — `emitEvent(eventType, payload)` inserts into
   `outbox` in the caller's transaction (the domain repo and the emit share the
   same `SqlClient` effect), mirroring the notes repo style
   (`Effect.fnUntraced`, raw SQL).
3. **Claiming** — `claimJobs(workerId, limit)` claims due `pending` jobs with
   `FOR UPDATE SKIP LOCKED`, sets `status = 'running'`, returns them.
4. **Job lifecycle** — `completeJob(id)`, `failJob(id, error)`:
   - `failJob` increments `attempts`; if `attempts < max_attempts`, reschedules
     (`status = 'pending'`, `run_after = now() + backoff`) with exponential
     backoff (e.g. `30s * 2^(attempts-1)`); else `status = 'dead'` + `last_error`.
   - `retryJob(id)` resets a `dead` job to `pending`/`run_after = now()`.
5. **JobRegistry** — a `Context.Service` (`packages/jobs/src/registry.ts`,
   following the `Storage`/`AuthStorage` seam pattern) mapping `job_type →
   handler` (`Effect<JobResult, JobError, ...>`). `register(jobType, handler)`,
   `get(jobType)`.
6. **Worker runtime core** — `packages/jobs/src/worker.ts`: a `Context.Service`
   (`JobWorker`) exposing `run()` — an `Effect.repeat` loop that claims due
   jobs, looks up the handler in the registry, runs it, and completes/fails.
   Uses `Effect.retry`-style backoff via the `run_after` schedule. Process
   wiring (which layer provides it) lives in `apps/worker` (ticket 03).

## Tests

- Repo tests against `TestDbLayer`: emit/claim ordering (oldest first, `run_after`
  respected), `FOR UPDATE SKIP LOCKED` claims each job once under concurrency,
  fail → backoff reschedule → dead after `max_attempts`, retryJob on dead.
- Registry test: register → get, missing type → None.
- Use the repo's existing patterns: `setupTestDb({ ...all migrations })`,
  `Effect.fnUntraced`, decode through model schemas.

## Files

- `packages/jobs/package.json`, `tsconfig.json` (mirror `packages/notes`)
- `src/db/models.ts`, `src/db/migrations.ts`
- `src/repo/jobs.repo.ts` + `.test.ts`
- `src/registry.ts`, `src/worker.ts`
- `src/index.ts` (browser-safe schemas only; repo behind `./server` subpath per
  the notes/documents split)
- `scripts/migrate.ts` — add `jobsMigrations`

## Out of scope

Consumer jobs, the worker process, notifications (tickets 02–04).