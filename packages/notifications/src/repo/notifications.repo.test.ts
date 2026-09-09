import { beforeAll, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { setupTestDb, TestDbLayer } from "@app/core"
import { documentsMigrations } from "@app/documents/server"
import { jobsMigrations } from "@app/jobs/server"
import { notesMigrations } from "@app/notes/server"
import { NotificationId } from "../db/models.ts"
import { notificationsMigrations } from "../db/migrations.ts"
import {
  createNotification,
  listNotifications,
  markAllRead,
  markRead
} from "./notifications.repo.ts"

// The notifications repo tests run the FULL application migration set so the
// shared scaffold_test DB has every table regardless of test run order.
beforeAll(async () => {
  await Effect.runPromise(
    setupTestDb({ ...notesMigrations, ...documentsMigrations, ...jobsMigrations, ...notificationsMigrations })
  )
})

it.effect("creates notifications and lists a user's newest-first, honoring the limit", () =>
  Effect.gen(function*() {
    const userId = randomUUID()
    const a = yield* createNotification(userId, "document_uploaded", "Upload confirmed", "a.txt was stored")
    const b = yield* createNotification(userId, "document_uploaded", "Upload confirmed", "b.txt was stored")

    expect(a.read_at).toBeNull()
    expect(b.title).toBe("Upload confirmed")

    const all = yield* listNotifications(userId, 50)
    expect(all.map((n) => n.body)).toEqual(["b.txt was stored", "a.txt was stored"])
    expect(all[0].user_id).toBe(userId)

    const limited = yield* listNotifications(userId, 1)
    expect(limited.map((n) => n.body)).toEqual(["b.txt was stored"])
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("markRead is idempotent and user-scoped", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const userId = randomUUID()
    const otherUserId = randomUUID()
    const n = yield* createNotification(userId, "document_uploaded", "Upload confirmed", "a.txt was stored")
    try {
      const first = yield* markRead(userId, n.id)
      expect(Option.isSome(first)).toBe(true)
      if (Option.isSome(first)) expect(first.value.read_at).not.toBeNull()

      const second = yield* markRead(userId, n.id)
      expect(Option.isSome(second)).toBe(true)
      if (Option.isSome(second)) expect(second.value.read_at).not.toBeNull()

      const unowned = yield* markRead(otherUserId, n.id)
      expect(Option.isNone(unowned)).toBe(true)
      const missing = yield* markRead(userId, randomUUID() as NotificationId)
      expect(Option.isNone(missing)).toBe(true)
    } finally {
      yield* sql`DELETE FROM notifications WHERE user_id = ${userId} OR user_id = ${otherUserId}`
    }
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("markAllRead marks only the user's unread notifications", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const userId = randomUUID()
    const otherUserId = randomUUID()
    try {
      const a = yield* createNotification(userId, "document_uploaded", "Upload confirmed", "a.txt was stored")
      const b = yield* createNotification(userId, "document_uploaded", "Upload confirmed", "b.txt was stored")
      yield* createNotification(otherUserId, "document_uploaded", "Upload confirmed", "c.txt was stored")

      const marked = yield* markAllRead(userId)
      expect(new Set(marked.map((n) => n.id))).toEqual(new Set([a.id, b.id]))
      expect(marked.every((n) => n.read_at !== null)).toBe(true)

      const all = yield* listNotifications(userId, 50)
      expect(all.every((n) => n.read_at !== null)).toBe(true)

      const other = yield* listNotifications(otherUserId, 50)
      expect(other.every((n) => n.read_at === null)).toBe(true)
    } finally {
      yield* sql`DELETE FROM notifications WHERE user_id = ${userId} OR user_id = ${otherUserId}`
    }
  }).pipe(Effect.provide(TestDbLayer)))