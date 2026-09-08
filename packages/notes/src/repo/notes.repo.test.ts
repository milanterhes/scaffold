import { beforeAll, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { setupTestDb, TestDbLayer } from "@app/core"
import { notesMigrations } from "../db/migrations.ts"
import { createNote, deleteNote, getNote, listNotes, updateNote } from "./notes.repo.ts"

beforeAll(async () => {
  await Effect.runPromise(setupTestDb(notesMigrations))
})

it.effect("creates and lists a user's notes newest-first", () =>
  Effect.gen(function*() {
    const userId = randomUUID()
    const noteA = yield* createNote(userId, { title: "First", body: "hello" })
    const noteB = yield* createNote(userId, { title: "Second", body: "world" })

    const notes = yield* listNotes(userId)
    expect(notes.map((note) => note.title)).toEqual(["Second", "First"])
    expect(notes[0].user_id).toBe(userId)
    expect(noteA.id).toBeTruthy()
    expect(noteB.id).toBeTruthy()
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("scopes notes to the owning user", () =>
  Effect.gen(function*() {
    const alice = randomUUID()
    const bob = randomUUID()
    yield* createNote(alice, { title: "Alice's note", body: "" })
    yield* createNote(bob, { title: "Bob's note", body: "" })

    const aliceNotes = yield* listNotes(alice)
    const bobNotes = yield* listNotes(bob)
    expect(aliceNotes.map((note) => note.title)).toEqual(["Alice's note"])
    expect(bobNotes.map((note) => note.title)).toEqual(["Bob's note"])
  }).pipe(Effect.provide(TestDbLayer)))

it.effect("gets, updates, and deletes an owned note; missing/unowned yields None", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const userId = randomUUID()
    const otherUserId = randomUUID()
    const note = yield* createNote(userId, { title: "Title", body: "body" })
    try {
      const fetched = yield* getNote(userId, note.id)
      expect(Option.isSome(fetched)).toBe(true)
      if (Option.isSome(fetched)) expect(fetched.value.title).toBe("Title")

      const updated = yield* updateNote(userId, note.id, { body: "rewritten" })
      expect(Option.isSome(updated)).toBe(true)
      if (Option.isSome(updated)) expect(updated.value.body).toBe("rewritten")

      const unowned = yield* getNote(otherUserId, note.id)
      expect(Option.isNone(unowned)).toBe(true)
      const unownedUpdate = yield* updateNote(otherUserId, note.id, { title: "nope" })
      expect(Option.isNone(unownedUpdate)).toBe(true)

      const deleted = yield* deleteNote(userId, note.id)
      expect(Option.isSome(deleted)).toBe(true)
      const gone = yield* getNote(userId, note.id)
      expect(Option.isNone(gone)).toBe(true)
    } finally {
      yield* sql`DELETE FROM notes WHERE user_id = ${userId} OR user_id = ${otherUserId}`
    }
  }).pipe(Effect.provide(TestDbLayer)))