import { beforeAll, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { setupTestDb, TestDbLayer } from "@app/core"
import { documentsMigrations } from "@app/documents/server"
import { Job } from "@app/jobs"
import { jobsMigrations } from "@app/jobs/server"
import { notesMigrations } from "@app/notes/server"
import { notificationsMigrations } from "../db/migrations.ts"
import { listNotifications } from "../repo/notifications.repo.ts"
import { deliverNotification } from "./notification.deliver.ts"

beforeAll(async () => {
  await Effect.runPromise(
    setupTestDb({ ...notesMigrations, ...documentsMigrations, ...jobsMigrations, ...notificationsMigrations })
  )
})

/** A `notification.deliver` job whose payload is the given outbox event payload. */
const jobWithPayload = (payload: unknown): Job =>
  Schema.decodeUnknownSync(Job)({
    id: randomUUID(),
    job_type: "notification.deliver",
    payload,
    status: "running",
    attempts: 0,
    max_attempts: 3,
    run_after: new Date(),
    last_error: null,
    created_at: new Date(),
    updated_at: new Date()
  })

it.effect("deliverNotification writes an inbox row for a document.uploaded payload", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const userId = randomUUID()
    try {
      yield* deliverNotification(jobWithPayload({
        userId,
        documentId: randomUUID(),
        filename: "report.pdf",
        sizeBytes: 1024
      }))

      const rows = yield* listNotifications(userId, 50)
      expect(rows).toHaveLength(1)
      expect(rows[0].type).toBe("document_uploaded")
      expect(rows[0].title).toBe("Upload confirmed")
      expect(rows[0].body).toBe("report.pdf was stored")
      expect(rows[0].read_at).toBeNull()
    } finally {
      yield* sql`DELETE FROM notifications WHERE user_id = ${userId}`
    }
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("deliverNotification no-ops on a payload that is not a document.uploaded event", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const userId = randomUUID()
    try {
      yield* deliverNotification(jobWithPayload({ some: "other", event: true }))
      const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*)::int AS count FROM notifications WHERE user_id = ${userId}
      `
      expect(rows[0].count).toBe(0)
    } finally {
      yield* sql`DELETE FROM notifications WHERE user_id = ${userId}`
    }
  }).pipe(Effect.provide(TestDbLayer)))