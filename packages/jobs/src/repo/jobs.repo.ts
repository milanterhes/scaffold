import { PgClient } from "@effect/sql-pg"
import { randomUUID } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { Job, JobId, JobState, OutboxEvent, OutboxEventId } from "../db/models.ts"
import type { JobPayload } from "../db/models.ts"

const JOB_COLUMNS = "id, job_type, payload, status, attempts, max_attempts, run_after, last_error, created_at, updated_at"

/** How long a claimed job's lease lasts; a `running` job past its lease is reclaimable. */
const JOB_LEASE_SECONDS = 60

/**
 * Decode raw driver rows into `Job` values. Postgres returns `timestamptz`
 * columns as JS `Date`s (converted by the model's `select` variant) and
 * `jsonb` columns as already-parsed JS objects, so the value handed back
 * genuinely satisfies the model's types.
 */
const decodeJob = (row: unknown): Job => Schema.decodeUnknownSync(Job)(row)

/** Decode a raw driver row into an `OutboxEvent` value. */
const decodeOutboxEvent = (row: unknown): OutboxEvent => Schema.decodeUnknownSync(OutboxEvent)(row)

/**
 * Insert an event into the outbox, in the caller's transaction: the domain
 * repo and `emitEvent` share the same client effect, so the event commits
 * atomically with the domain write.
 */
export const emitEvent = Effect.fnUntraced(function*(
  eventType: string,
  payload: JobPayload
): Effect.fn.Return<OutboxEvent, SqlError.SqlError | Schema.SchemaError, PgClient.PgClient> {
  const sql = yield* PgClient.PgClient
  const id = randomUUID() as OutboxEventId
  const rows = yield* sql`
    INSERT INTO outbox (id, event_type, payload)
    VALUES (${id}, ${eventType}, ${sql.json(payload)})
    RETURNING id, event_type, payload, created_at, consumed_at
  `
  return decodeOutboxEvent(rows[0])
})

/**
 * Drain up to `limit` unconsumed outbox events into jobs of `jobType`, marking
 * each event consumed. The claim, inserts, and consumed marks run in one
 * transaction, so a crash cannot turn one event into a duplicate job. Rows are
 * locked with `FOR UPDATE SKIP LOCKED` so concurrent workers each take a
 * disjoint set. Returns the jobs created.
 */
export const drainOutbox = Effect.fnUntraced(function*(
  jobType: string,
  limit: number
): Effect.fn.Return<ReadonlyArray<Job>, SqlError.SqlError | Schema.SchemaError, PgClient.PgClient> {
  const sql = yield* PgClient.PgClient
  return yield* sql.withTransaction(
    Effect.gen(function*(): Effect.gen.Return<
      ReadonlyArray<Job>,
      SqlError.SqlError | Schema.SchemaError,
      PgClient.PgClient
    > {
      const events = yield* sql`
        SELECT id, event_type, payload, created_at, consumed_at
        FROM outbox
        WHERE consumed_at IS NULL
        ORDER BY created_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `
      const jobs: Array<Job> = []
      for (const row of events) {
        const event = decodeOutboxEvent(row)
        const id = randomUUID() as JobId
        const created = yield* sql`
          INSERT INTO jobs (id, job_type, payload)
          VALUES (${id}, ${jobType}, ${sql.json(event.payload)})
          RETURNING ${sql.unsafe(JOB_COLUMNS)}
        `
        yield* sql`UPDATE outbox SET consumed_at = now() WHERE id = ${event.id}`
        jobs.push(decodeJob(created[0]))
      }
      return jobs
    })
  )
})

/**
 * Claim up to `limit` due jobs, flipping them to `running` under a fresh
 * `run_after` lease (`now() + 60s`). Due means a `pending` job past its
 * `run_after`, or a `running` job whose lease has expired — the crash-recovery
 * path: a worker that dies mid-job leaves a `running` row, which another
 * worker reclaims once the lease lapses. Rows are locked with `FOR UPDATE
 * SKIP LOCKED` so concurrent workers each claim a disjoint set; `run_after`
 * is compared against the database clock. The `workerId` identifies the
 * claiming process for observability but is not stored (the schema tracks no
 * owner).
 */
export const claimJobs = Effect.fnUntraced(function*(
  _workerId: string,
  limit: number
): Effect.fn.Return<ReadonlyArray<Job>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    UPDATE jobs
    SET status = 'running',
        run_after = now() + make_interval(secs => ${sql.unsafe(String(JOB_LEASE_SECONDS))}),
        updated_at = now()
    WHERE id IN (
      SELECT id
      FROM jobs
      WHERE (status = 'pending' AND run_after <= now())
         OR (status = 'running' AND run_after <= now())
      ORDER BY run_after, created_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING ${sql.unsafe(JOB_COLUMNS)}
  `
  return rows.map(decodeJob)
})

/**
 * Read `limit` jobs in a given `status` — the dead-job visibility read (no
 * admin UI; surface dead jobs to an operator so `retryJob` can re-run them).
 * Newest first.
 */
export const listJobs = Effect.fnUntraced(function*(
  status: JobState,
  limit: number
): Effect.fn.Return<ReadonlyArray<Job>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    SELECT ${sql.unsafe(JOB_COLUMNS)}
    FROM jobs
    WHERE status = ${status}
    ORDER BY updated_at DESC, id
    LIMIT ${limit}
  `
  return rows.map(decodeJob)
})

/**
 * Mark a `running` job complete, removing it from the queue. `None` when the
 * job is missing or not currently claimed.
 */
export const completeJob = Effect.fnUntraced(function*(
  jobId: JobId
): Effect.fn.Return<Option.Option<Job>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    DELETE FROM jobs
    WHERE id = ${jobId} AND status = 'running'
    RETURNING ${sql.unsafe(JOB_COLUMNS)}
  `
  return rows.length === 0 ? Option.none() : Option.some(decodeJob(rows[0]))
})

/**
 * Record a failure for a `running` job: increment `attempts`; if attempts
 * remain, reschedule with exponential backoff (`30s * 2^(attempts-1)`),
 * otherwise dead-letter it with `last_error`. `None` when the job is missing
 * or not currently claimed.
 */
export const failJob = Effect.fnUntraced(function*(
  jobId: JobId,
  error: string
): Effect.fn.Return<Option.Option<Job>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    UPDATE jobs
    SET
      attempts = attempts + 1,
      status = CASE WHEN attempts + 1 < max_attempts THEN 'pending' ELSE 'dead' END,
      run_after = CASE WHEN attempts + 1 < max_attempts
        THEN now() + make_interval(secs => 30 * power(2::float8, attempts::float8))
        ELSE run_after END,
      last_error = ${error},
      updated_at = now()
    WHERE id = ${jobId} AND status = 'running'
    RETURNING ${sql.unsafe(JOB_COLUMNS)}
  `
  return rows.length === 0 ? Option.none() : Option.some(decodeJob(rows[0]))
})

/**
 * Reset a `dead` job to `pending`, due immediately. `attempts` is left as-is
 * (the ticket's contract: retry grants one more run). `None` when the job is
 * missing or not dead.
 */
export const retryJob = Effect.fnUntraced(function*(
  jobId: JobId
): Effect.fn.Return<Option.Option<Job>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    UPDATE jobs
    SET status = 'pending', run_after = now(), updated_at = now()
    WHERE id = ${jobId} AND status = 'dead'
    RETURNING ${sql.unsafe(JOB_COLUMNS)}
  `
  return rows.length === 0 ? Option.none() : Option.some(decodeJob(rows[0]))
})