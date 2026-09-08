import { Schema } from "effect"
import { Model } from "effect/unstable/schema"

export const DocumentId = Schema.String.pipe(Schema.brand("DocumentId"))
export type DocumentId = typeof DocumentId.Type

/** Whether a document's object has been uploaded to storage and verified. */
export const DocumentState = Schema.Literals(["pending", "stored"])
export type DocumentState = typeof DocumentState.Type

export class Document extends Model.Class<Document>("scaffold/db/Document")({
  id: Model.UuidV4Insert(DocumentId),
  user_id: Model.GeneratedByApp(Schema.String),
  filename: Schema.NonEmptyString,
  content_type: Schema.String,
  size_bytes: Model.Field({
    select: Schema.NumberFromString,
    insert: Schema.Number,
    json: Schema.Number,
    jsonCreate: Schema.Number,
    jsonUpdate: Schema.Number,
    update: Schema.Number
  }),
  storage_key: Model.GeneratedByApp(Schema.NonEmptyString),
  state: Model.GeneratedByApp(DocumentState),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate
}) {}