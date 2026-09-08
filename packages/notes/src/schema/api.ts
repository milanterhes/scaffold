import { Schema } from "effect"
import { Note } from "../db/models.ts"

/**
 * The API wire schemas. The read and create shapes come straight from the
 * `Note` model's generated JSON variants — no hand-written duplication:
 *
 * - `NoteListItem` = `Note.json` — the full read shape (includes `user_id`,
 *   which the server sets; harmless to return).
 * - `CreateNote` = `Note.jsonCreate` — the fields the client may set on
 *   create. `user_id` is `Model.GeneratedByApp`, so it is absent here and
 *   derived from the session server-side.
 *
 * `UpdateNote` cannot come from the model: a partial update needs each field
 * optional, and the model's generated `jsonUpdate` variant is all-required.
 * (Using `Model.Field` with `Schema.optionalKey` would make it partial but
 * widens the other variants' payload types to `Schema.Top`, so it is written
 * out here instead.)
 */
export const NoteListItem = Note.json
export type NoteListItem = typeof NoteListItem.Type

export const CreateNote = Note.jsonCreate
export type CreateNote = typeof CreateNote.Type

export const UpdateNote = Schema.Struct({
  title: Schema.optionalKey(Schema.NonEmptyString),
  body: Schema.optionalKey(Schema.String)
})
export type UpdateNote = typeof UpdateNote.Type

export const NoteDetail = Note.json