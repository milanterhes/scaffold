import { createNote, deleteNote, listNotes, updateNote } from "@app/notes"
import type { Note, NoteId } from "@app/notes"
import { CurrentUser } from "@app/auth/api"
import { DateTime, Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { NotesApi } from "./notes.api"

const toListItem = (note: Note) => ({
  id: note.id,
  user_id: note.user_id,
  title: note.title,
  body: note.body,
  created_at: DateTime.fromDateUnsafe(note.created_at as unknown as Date),
  updated_at: DateTime.fromDateUnsafe(note.updated_at as unknown as Date)
})

/**
 * The notes group handlers. Every endpoint is behind `SessionMiddleware`, so
 * `CurrentUser` is the authenticated caller; all rows are scoped to that user.
 */
export const NotesImpl = HttpApiBuilder.group(NotesApi, "notes", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const notes = yield* listNotes(user.id)
        return notes.map(toListItem)
      }).pipe(Effect.orDie))
    .handle("create", ({ payload }) =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const note = yield* createNote(user.id, payload)
        return toListItem(note)
      }).pipe(Effect.orDie))
    .handle("update", ({ params, payload }) =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const updated = yield* updateNote(user.id, params.id as NoteId, payload).pipe(Effect.orDie)
        if (Option.isNone(updated)) {
          return yield* new HttpApiError.NotFound({})
        }
        return toListItem(updated.value)
      })
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const deleted = yield* deleteNote(user.id, params.id as NoteId).pipe(Effect.orDie)
        if (Option.isNone(deleted)) {
          return yield* new HttpApiError.NotFound({})
        }
        return { ok: true }
      })
    )
)