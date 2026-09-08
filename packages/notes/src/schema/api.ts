import { Schema } from "effect"

export const NoteListItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
  created_at: Schema.DateFromString,
  updated_at: Schema.DateFromString
})
export type NoteListItem = typeof NoteListItem.Type

export const CreateNote = Schema.Struct({
  title: Schema.NonEmptyString,
  body: Schema.String
})
export type CreateNote = typeof CreateNote.Type

export const UpdateNote = Schema.Struct({
  title: Schema.optional(Schema.NonEmptyString),
  body: Schema.optional(Schema.String)
})
export type UpdateNote = typeof UpdateNote.Type

export const NoteDetail = NoteListItem