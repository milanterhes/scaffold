import { Schema } from "effect"
import { Document } from "../db/models.ts"

/**
 * The API wire schemas. The read and create shapes come from the `Document`
 * model's generated JSON variants — no hand-written duplication:
 *
 * - `DocumentListItem` = `Document.json` — the full read shape. `storage_key`
 *   and `user_id` are included (server-set, harmless to return).
 * - `CreateDocument` = `Document.jsonCreate` — the fields the client may set
 *   on create (`filename`, `content_type`, `size_bytes`). `storage_key`,
 *   `state`, `id`, and `user_id` are generated server-side, so are absent.
 */
export const DocumentListItem = Document.json
export type DocumentListItem = typeof DocumentListItem.Type

export const CreateDocument = Document.jsonCreate
export type CreateDocument = typeof CreateDocument.Type

/**
 * The result of creating a document: the row plus a short-lived presigned PUT
 * URL the client uploads the bytes to. The row is `pending` until a success
 * confirm flips it to `stored`.
 */
export const CreateDocumentResult = Schema.Struct({
  document: DocumentListItem,
  uploadUrl: Schema.String
})
export type CreateDocumentResult = typeof CreateDocumentResult.Type

/**
 * A download (presigned GET) URL for a stored document.
 */
export const DocumentDownload = Schema.Struct({
  kind: Schema.Literal("download"),
  url: Schema.String
})

/**
 * A resume (presigned PUT) URL for a pending document, so a client can retry an
 * upload that failed part-way without creating a new row.
 */
export const DocumentUploadResume = Schema.Struct({
  kind: Schema.Literal("upload"),
  url: Schema.String
})

/** The result of fetching a document: the row plus a URL to fetch or resume. */
export const GetDocumentResult = Schema.Struct({
  document: DocumentListItem,
  upload: Schema.Union([DocumentDownload, DocumentUploadResume])
})
export type GetDocumentResult = typeof GetDocumentResult.Type