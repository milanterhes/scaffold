import { beforeAll, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { setupTestDb, TestDbLayer } from "@app/core"
import {
  JobRegistry,
  JobRegistryLive,
  completeJob,
  drainOutbox,
  emitEvent,
  jobsMigrations
} from "@app/jobs/server"
import type { Job } from "@app/jobs"
import { registerHandlers } from "./handlers.ts"

beforeAll(async () => {
  await Effect.runPromise(setupTestDb(jobsMigrations))
})

it.effect("registerHandlers registers the notification.deliver handler", () =>
  Effect.gen(function*() {
    const registry = yield* JobRegistry
    registerHandlers(registry)
    expect(Option.isSome(registry.get("notification.deliver"))).toBe(true)
  }).pipe(Effect.provide(JobRegistryLive)))

it.effect("drains a document.uploaded outbox event into a notification.deliver job and runs it once", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const payload = {
      userId: randomUUID(),
      documentId: randomUUID(),
      filename: "report.pdf",
      sizeBytes: 42
    }

    // 1. The domain emits the event (as the confirm transaction would)
    const event = yield* emitEvent("document.uploaded", payload)

    // 2. One drain pass turns the outbox row into a notification.deliver job
    //    and marks it consumed. The whole drain→run→complete pass runs in one
    //    transaction so the fresh job is never visible to other test files'
    //    claims against the shared test database.
    const ran = yield* sql.withTransaction(
      Effect.gen(function*() {
        const created = yield* drainOutbox("notification.deliver", 100)
        const job = created.find((j) => j.payload.documentId === payload.documentId)
        if (job === undefined) {
          throw new Error("expected the drained job to be returned")
        }
        expect(job.job_type).toBe("notification.deliver")
        expect(job.payload).toEqual(payload)

        const consumed = yield* sql`SELECT consumed_at FROM outbox WHERE id = ${event.id}`
        expect(consumed[0].consumed_at).not.toBeNull()

        // 3. Claim the job (mirrors the worker loop's claim step), run the
        //    registered handler against it, and complete it.
        const registry = yield* JobRegistry
        let ran: Job | undefined
        registry.register("notification.deliver", (claimed) => {
          ran = claimed
          return Effect.succeed(undefined)
        })
        const handler = registry.get("notification.deliver")
        expect(Option.isSome(handler)).toBe(true)
        if (Option.isSome(handler)) {
          yield* handler.value(job)
        }
        expect(ran).toBe(job)

        yield* sql`UPDATE jobs SET status = 'running', updated_at = now() WHERE id = ${job.id} AND status = 'pending'`
        const completed = yield* completeJob(job.id)
        expect(Option.isSome(completed)).toBe(true)

        // Any other events drained from the shared outbox are ours to clean up.
        const foreign = created.filter((other) => other.id !== job.id)
        if (foreign.length > 0) {
          yield* sql`DELETE FROM jobs WHERE id IN ${sql.in(foreign.map((other) => other.id))}`
        }
        return ran
      })
    )
    expect(ran).toBeDefined()
  }).pipe(Effect.provide(TestDbLayer)).pipe(Effect.provide(JobRegistryLive)))