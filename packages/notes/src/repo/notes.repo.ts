import { randomUUID } from "node:crypto"
import { Effect, Option } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import type { Note, NoteId } from "../db/models.ts"

export interface CreateNoteInput {
  readonly title: string
  readonly body: string
}

export interface UpdateNoteInput {
  readonly title?: string | undefined
  readonly body?: string | undefined
}

const SELECT = `
  SELECT id, user_id, title, body, created_at, updated_at
  FROM notes
`

/**
 * Create a note owned by the given user. `body` is bound as a parameter so it
 * round-trips correctly regardless of its contents.
 */
export const createNote = Effect.fnUntraced(function*(
  userId: string,
  input: CreateNoteInput
): Effect.fn.Return<Note, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const id = randomUUID() as NoteId
  const rows = yield* sql<Note>`
    INSERT INTO notes (id, user_id, title, body)
    VALUES (${id}, ${userId}, ${input.title}, ${input.body})
    RETURNING id, user_id, title, body, created_at, updated_at
  `
  return rows[0]
})

/** All of a user's notes, newest first. */
export const listNotes = Effect.fnUntraced(function*(
  userId: string
): Effect.fn.Return<ReadonlyArray<Note>, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<Note>`
    ${sql.unsafe(SELECT)}
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, id
  `
  return rows
})

/** One of a user's notes by id; `None` when not owned or missing. */
export const getNote = Effect.fnUntraced(function*(
  userId: string,
  noteId: NoteId
): Effect.fn.Return<Option.Option<Note>, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<Note>`
    ${sql.unsafe(SELECT)}
    WHERE id = ${noteId} AND user_id = ${userId}
    LIMIT 1
  `
  return rows.length === 0 ? Option.none() : Option.some(rows[0])
})

/** Update a note's title/body; `None` when not owned or missing. */
export const updateNote = Effect.fnUntraced(function*(
  userId: string,
  noteId: NoteId,
  input: UpdateNoteInput
): Effect.fn.Return<Option.Option<Note>, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<Note>`
    UPDATE notes
    SET
      title = COALESCE(${input.title}, title),
      body = COALESCE(${input.body}, body),
      updated_at = now()
    WHERE id = ${noteId} AND user_id = ${userId}
    RETURNING id, user_id, title, body, created_at, updated_at
  `
  return rows.length === 0 ? Option.none() : Option.some(rows[0])
})

/** Delete a note; `None` when not owned or missing. */
export const deleteNote = Effect.fnUntraced(function*(
  userId: string,
  noteId: NoteId
): Effect.fn.Return<Option.Option<void>, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    DELETE FROM notes
    WHERE id = ${noteId} AND user_id = ${userId}
    RETURNING id
  `
  return rows.length === 0 ? Option.none() : Option.some(undefined)
})