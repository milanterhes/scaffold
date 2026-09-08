import { Schema } from "effect"
import { Model } from "effect/unstable/schema"

export const NoteId = Schema.String.pipe(Schema.brand("NoteId"))
export type NoteId = typeof NoteId.Type

export class Note extends Model.Class<Note>("scaffold/db/Note")({
  id: Model.UuidV4Insert(NoteId),
  user_id: Schema.String,
  title: Schema.NonEmptyString,
  body: Schema.String,
  created_at: Model.DateTimeInsert,
  updated_at: Model.DateTimeUpdate
}) {}