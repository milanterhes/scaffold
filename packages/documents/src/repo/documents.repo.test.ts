import { beforeAll, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { setupTestDb, TestDbLayer } from "@app/core"
import { notesMigrations } from "@app/notes"
import { DocumentId } from "../db/models.ts"
import { documentsMigrations } from "../db/migrations.ts"
import {
  confirmDocument,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments
} from "./documents.repo.ts"

beforeAll(async () => {
  await Effect.runPromise(setupTestDb({ ...notesMigrations, ...documentsMigrations }))
})

const input = (overrides: Partial<{ filename: string; content_type: string; size_bytes: number }> = {}) => ({
  filename: "report.pdf",
  content_type: "application/pdf",
  size_bytes: 42,
  storage_key: "key",
  ...overrides
})

it.effect("creates a pending document and lists a user's documents newest-first", () =>
  Effect.gen(function*() {
    const userId = randomUUID()
    const docA = yield* createDocument(userId, input({ filename: "a.txt" }))
    const docB = yield* createDocument(userId, input({ filename: "b.txt" }))

    expect(docA.state).toBe("pending")
    expect(docA.filename).toBe("a.txt")

    const docs = yield* listDocuments(userId)
    expect(docs.map((doc) => doc.filename)).toEqual(["b.txt", "a.txt"])
    expect(docs[0].user_id).toBe(userId)
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("scopes documents to the owning user", () =>
  Effect.gen(function*() {
    const alice = randomUUID()
    const bob = randomUUID()
    yield* createDocument(alice, input())
    yield* createDocument(bob, input())

    const aliceDocs = yield* listDocuments(alice)
    const bobDocs = yield* listDocuments(bob)
    expect(aliceDocs.map((doc) => doc.filename)).toEqual(["report.pdf"])
    expect(bobDocs.map((doc) => doc.filename)).toEqual(["report.pdf"])
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("confirm flips a pending document to stored; missing/unowned yields None", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const userId = randomUUID()
    const otherUserId = randomUUID()
    const doc = yield* createDocument(userId, input())
    try {
      expect(doc.state).toBe("pending")

      const confirmed = yield* confirmDocument(userId, doc.id)
      expect(Option.isSome(confirmed)).toBe(true)
      if (Option.isSome(confirmed)) {
        expect(confirmed.value.state).toBe("stored")
        expect(confirmed.value.storage_key).toBe("key")
      }

      const unowned = yield* confirmDocument(otherUserId, doc.id)
      expect(Option.isNone(unowned)).toBe(true)
      const missing = yield* confirmDocument(userId, (randomUUID() as DocumentId))
      expect(Option.isNone(missing)).toBe(true)
    } finally {
      yield* sql`DELETE FROM documents WHERE user_id = ${userId} OR user_id = ${otherUserId}`
    }
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("gets and deletes an owned document; missing/unowned yields None", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const userId = randomUUID()
    const otherUserId = randomUUID()
    const doc = yield* createDocument(userId, input())
    try {
      const fetched = yield* getDocument(userId, doc.id)
      expect(Option.isSome(fetched)).toBe(true)
      if (Option.isSome(fetched)) expect(fetched.value.state).toBe("pending")

      const unowned = yield* getDocument(otherUserId, doc.id)
      expect(Option.isNone(unowned)).toBe(true)
      const missing = yield* getDocument(userId, (randomUUID() as DocumentId))
      expect(Option.isNone(missing)).toBe(true)

      const deleted = yield* deleteDocument(userId, doc.id)
      expect(Option.isSome(deleted)).toBe(true)
      const gone = yield* getDocument(userId, doc.id)
      expect(Option.isNone(gone)).toBe(true)

      const unownedDelete = yield* deleteDocument(otherUserId, doc.id)
      expect(Option.isNone(unownedDelete)).toBe(true)
    } finally {
      yield* sql`DELETE FROM documents WHERE user_id = ${userId} OR user_id = ${otherUserId}`
    }
  }).pipe(Effect.provide(TestDbLayer)))