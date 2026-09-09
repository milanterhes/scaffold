import { beforeAll, expect, it } from "@effect/vitest"
import { Effect, Option, Result, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { setupTestDb, TestDbLayer } from "@app/core"
import { documentsMigrations } from "@app/documents/server"
import { notesMigrations } from "@app/notes/server"
import { Job, JobId } from "../db/models.ts"
import type { JobPayload } from "../db/models.ts"
import { jobsMigrations } from "../db/migrations.ts"
import { claimJobs, completeJob, emitEvent, failJob, listJobs, retryJob } from "./jobs.repo.ts"

// The jobs repo tests run the FULL application migration set so the shared
// scaffold_test DB has every table regardless of test run order.
beforeAll(async () => {
  await Effect.runPromise(setupTestDb({ ...notesMigrations, ...documentsMigrations, ...jobsMigrations }))
})

const decodeJob = (row: unknown): Job => Schema.decodeUnknownSync(Job)(row)

/**
 * Insert a job directly (the outbox→jobs dispatcher is a later ticket). Time
 * columns are given as raw SQL expressions so tests can pin them relative to
 * the database clock.
 */
const insertJob = Effect.fnUntraced(function*(
  jobType: string,
  payload: JobPayload,
  overrides: { readonly run_after?: string; readonly created_at?: string } = {}
): Effect.fn.Return<Job, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const id = randomUUID() as JobId
  const runAfter = overrides.run_after ?? "now()"
  const createdAt = overrides.created_at ?? "now()"
  const rows = yield* sql`
    INSERT INTO jobs (id, job_type, payload, run_after, created_at, updated_at)
    VALUES (${id}, ${jobType}, ${sql.json(payload)}, ${sql.unsafe(runAfter)}, ${sql.unsafe(createdAt)}, ${sql.unsafe(createdAt)})
    RETURNING id, job_type, payload, status, attempts, max_attempts, run_after, last_error, created_at, updated_at
  `
  return decodeJob(rows[0])
})

const fetchJob = Effect.fnUntraced(function*(
  jobId: JobId
): Effect.fn.Return<Option.Option<Job>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    SELECT id, job_type, payload, status, attempts, max_attempts, run_after, last_error, created_at, updated_at
    FROM jobs
    WHERE id = ${jobId}
  `
  return rows.length === 0 ? Option.none() : Option.some(decodeJob(rows[0]))
})

/** The scheduled delay until a job's next run, in seconds. */
const backoffSeconds = Effect.fnUntraced(function*(
  jobId: JobId
): Effect.fn.Return<number, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly seconds: number }>`
    SELECT extract(epoch from (run_after - now()))::int AS seconds FROM jobs WHERE id = ${jobId}
  `
  return rows[0].seconds
})

it.effect("emitEvent inserts an outbox event readable through the model", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const documentId = randomUUID()
    const event = yield* emitEvent("document.uploaded", { documentId })
    try {
      expect(event.event_type).toBe("document.uploaded")
      expect(event.payload).toEqual({ documentId })
      expect(event.consumed_at).toBeNull()
    } finally {
      yield* sql`DELETE FROM outbox WHERE id = ${event.id}`
    }
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("emitEvent commits atomically with the domain write and rolls back when it fails", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const committed = randomUUID()
    const rolledBack = randomUUID()
    let jobId: JobId | null = null
    try {
      // Success path: the emit and a domain write in one transaction commit together.
      const job = yield* sql.withTransaction(
        Effect.gen(function*() {
          yield* emitEvent("document.uploaded", { documentId: committed })
          return yield* insertJob("mail", {})
        })
      )
      jobId = job.id
      const kept = yield* sql<{ readonly count: number }>`
        SELECT count(*)::int AS count FROM outbox WHERE payload ->> 'documentId' = ${committed}
      `
      expect(kept[0].count).toBe(1)

      // Failure path: the same transaction failing rolls the outbox row back too.
      const outcome = yield* sql.withTransaction(
        Effect.gen(function*() {
          yield* emitEvent("document.uploaded", { documentId: rolledBack })
          yield* Effect.fail(new Error("simulated domain write failure"))
        })
      ).pipe(Effect.result)
      expect(Result.isFailure(outcome)).toBe(true)
      const gone = yield* sql<{ readonly count: number }>`
        SELECT count(*)::int AS count FROM outbox WHERE payload ->> 'documentId' = ${rolledBack}
      `
      expect(gone[0].count).toBe(0)
    } finally {
      if (jobId !== null) yield* sql`DELETE FROM jobs WHERE id = ${jobId}`
      yield* sql`DELETE FROM outbox WHERE payload ->> 'documentId' IN ${sql.in([committed, rolledBack])}`
    }
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("claimJobs leases a claim and reclaims a running job past its lease", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const job = yield* insertJob("mail", {})
    try {
      const claimed = yield* claimJobs("worker-a", 1)
      expect(claimed.map((j) => j.id)).toEqual([job.id])
      expect(claimed[0].status).toBe("running")

      // A fresh claim carries a `run_after` lease in the future, so it is not
      // immediately reclaimable.
      const fresh = yield* sql<{ readonly status: string; readonly run_after: Date }>`
        SELECT status, run_after FROM jobs WHERE id = ${job.id}
      `
      expect(fresh[0].status).toBe("running")
      expect(fresh[0].run_after.getTime()).toBeGreaterThan(Date.now())
      expect(yield* claimJobs("worker-a", 1)).toEqual([])

      // A worker that died mid-job leaves a `running` row; once its lease
      // lapses another worker reclaims it.
      yield* sql`UPDATE jobs SET run_after = now() - interval '1 second' WHERE id = ${job.id}`
      const reclaimed = yield* claimJobs("worker-b", 1)
      expect(reclaimed.map((j) => j.id)).toEqual([job.id])
      expect(reclaimed[0].status).toBe("running")
    } finally {
      yield* sql`DELETE FROM jobs WHERE id = ${job.id}`
    }
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("listJobs surfaces jobs by status (dead-job visibility)", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const a = yield* insertJob("mail", {})
    const b = yield* insertJob("mail", {})
    const pending = yield* insertJob("mail", {})
    try {
      yield* sql`UPDATE jobs SET status = 'dead' WHERE id IN ${sql.in([a.id, b.id])}`
      const dead = yield* listJobs("dead", 50)
      expect(new Set(dead.map((j) => j.id))).toEqual(new Set([a.id, b.id]))
      expect(dead.every((job) =>
        job.status === "dead"
      )).toBe(true)

      const stillPending = yield* listJobs("pending", 50)
      expect(stillPending.map((j) => j.id)).toEqual([pending.id])
    } finally {
      yield* sql`DELETE FROM jobs WHERE id IN ${sql.in([a.id, b.id, pending.id])}`
    }
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("claimJobs claims due pending jobs oldest-first and skips not-yet-due jobs", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const a = yield* insertJob("mail", { n: 1 }, { created_at: "now() - interval '10 seconds'" })
    const b = yield* insertJob("mail", { n: 2 }, { created_at: "now() - interval '5 seconds'" })
    const c = yield* insertJob("mail", { n: 3 }, { run_after: "now() + interval '1 hour'" })
    try {
      const claimed = yield* claimJobs("worker-a", 2)
      expect(claimed.map((job) => job.id)).toEqual([a.id, b.id])
      expect(claimed.map((job) => job.status)).toEqual(["running", "running"])
      expect(claimed.map((job) => job.payload)).toEqual([{ n: 1 }, { n: 2 }])

      const again = yield* claimJobs("worker-a", 10)
      expect(again).toEqual([])
    } finally {
      yield* sql`DELETE FROM jobs WHERE id IN ${sql.in([a.id, b.id, c.id])}`
    }
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("claimJobs claims each job exactly once under concurrent claiming", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const inserted: Array<Job> = []
    for (let i = 0; i < 5; i++) {
      inserted.push(yield* insertJob("mail", { n: i }))
    }
    try {
      const [first, second] = yield* Effect.all(
        [claimJobs("worker-a", 5), claimJobs("worker-b", 5)],
        { concurrency: 2 }
      )
      const claimed = [...first, ...second]
      expect(claimed).toHaveLength(5)
      expect(new Set(claimed.map((job) => job.id)).size).toBe(5)

      const running = yield* sql<{ readonly count: number }>`
        SELECT count(*)::int AS count FROM jobs WHERE status = 'running'
      `
      expect(running[0].count).toBe(5)
    } finally {
      yield* sql`DELETE FROM jobs WHERE id IN ${sql.in(inserted.map((job) => job.id))}`
    }
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("failJob reschedules with exponential backoff and dead-letters at max_attempts", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const job = yield* insertJob("mail", {})
    try {
      expect(yield* claimJobs("worker-a", 1)).toHaveLength(1)

      const failed1 = yield* failJob(job.id, "boom 1")
      expect(Option.isSome(failed1)).toBe(true)
      if (Option.isSome(failed1)) {
        expect(failed1.value.status).toBe("pending")
        expect(failed1.value.attempts).toBe(1)
        expect(failed1.value.last_error).toBe("boom 1")
      }
      expect(yield* backoffSeconds(job.id)).toBeGreaterThan(25)
      expect(yield* backoffSeconds(job.id)).toBeLessThan(35)

      // Not due yet, so a claim picks nothing up.
      expect(yield* claimJobs("worker-a", 10)).toEqual([])

      yield* sql`UPDATE jobs SET run_after = now() WHERE id = ${job.id}`
      yield* claimJobs("worker-a", 1)
      const failed2 = yield* failJob(job.id, "boom 2")
      expect(Option.isSome(failed2)).toBe(true)
      if (Option.isSome(failed2)) {
        expect(failed2.value.attempts).toBe(2)
        expect(failed2.value.status).toBe("pending")
      }
      expect(yield* backoffSeconds(job.id)).toBeGreaterThan(55)
      expect(yield* backoffSeconds(job.id)).toBeLessThan(65)

      yield* sql`UPDATE jobs SET run_after = now() WHERE id = ${job.id}`
      yield* claimJobs("worker-a", 1)
      const failed3 = yield* failJob(job.id, "boom 3")
      expect(Option.isSome(failed3)).toBe(true)
      if (Option.isSome(failed3)) {
        expect(failed3.value.attempts).toBe(3)
        expect(failed3.value.status).toBe("dead")
        expect(failed3.value.last_error).toBe("boom 3")
      }

      expect(yield* claimJobs("worker-a", 10)).toEqual([])
    } finally {
      yield* sql`DELETE FROM jobs WHERE id = ${job.id}`
    }
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("completeJob removes a running job and retryJob resurrects a dead one", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const done = yield* insertJob("mail", {})
    const dead = yield* insertJob("mail", {})
    try {
      yield* claimJobs("worker-a", 1)
      const completed = yield* completeJob(done.id)
      expect(Option.isSome(completed)).toBe(true)
      const gone = yield* fetchJob(done.id)
      expect(Option.isNone(gone)).toBe(true)

      for (let i = 0; i < 3; i++) {
        yield* sql`UPDATE jobs SET run_after = now() WHERE id = ${dead.id}`
        yield* claimJobs("worker-a", 1)
        yield* failJob(dead.id, "boom")
      }
      const deadJob = yield* fetchJob(dead.id)
      expect(Option.isSome(deadJob)).toBe(true)
      if (Option.isSome(deadJob)) expect(deadJob.value.status).toBe("dead")

      const retried = yield* retryJob(dead.id)
      expect(Option.isSome(retried)).toBe(true)
      if (Option.isSome(retried)) expect(retried.value.status).toBe("pending")

      const claimed = yield* claimJobs("worker-a", 1)
      expect(claimed.map((job) => job.id)).toEqual([dead.id])

      const missing = yield* completeJob((randomUUID() as JobId))
      expect(Option.isNone(missing)).toBe(true)
    } finally {
      yield* sql`DELETE FROM jobs WHERE id IN ${sql.in([done.id, dead.id])}`
    }
  }).pipe(Effect.provide(TestDbLayer)))