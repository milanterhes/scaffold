import { randomUUID } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { Document, DocumentId } from "../db/models.ts"

export interface CreateDocumentInput {
  readonly filename: string
  readonly content_type: string
  readonly size_bytes: number
  readonly storage_key: string
}

const SELECT = `
  SELECT id, user_id, filename, content_type, size_bytes, storage_key, state, created_at, updated_at
  FROM documents
`

/**
 * Decode raw driver rows into `Document` values. Postgres returns `timestamptz`
 * columns as JS `Date`s (converted by the model's `select` variant) and
 * `bigint` as JS strings (converted by `NumberFromString`), so the value handed
 * back genuinely satisfies the model's types.
 */
const decodeDocument = (row: unknown): Document => Schema.decodeUnknownSync(Document)(row)

/** Create a document row in the `pending` state, owned by the given user. */
export const createDocument = Effect.fnUntraced(function*(
  userId: string,
  input: CreateDocumentInput
): Effect.fn.Return<Document, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const id = randomUUID() as DocumentId
  const rows = yield* sql`
    INSERT INTO documents (id, user_id, filename, content_type, size_bytes, storage_key, state)
    VALUES (${id}, ${userId}, ${input.filename}, ${input.content_type}, ${input.size_bytes}, ${input.storage_key}, 'pending')
    RETURNING id, user_id, filename, content_type, size_bytes, storage_key, state, created_at, updated_at
  `
  return decodeDocument(rows[0])
})

/** All of a user's documents, newest first. */
export const listDocuments = Effect.fnUntraced(function*(
  userId: string
): Effect.fn.Return<ReadonlyArray<Document>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    ${sql.unsafe(SELECT)}
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, id
  `
  return rows.map(decodeDocument)
})

/** One of a user's documents by id; `None` when not owned or missing. */
export const getDocument = Effect.fnUntraced(function*(
  userId: string,
  documentId: DocumentId
): Effect.fn.Return<Option.Option<Document>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    ${sql.unsafe(SELECT)}
    WHERE id = ${documentId} AND user_id = ${userId}
    LIMIT 1
  `
  return rows.length === 0 ? Option.none() : Option.some(decodeDocument(rows[0]))
})

/**
 * Flip a `pending` document to `stored` once its object has been uploaded and
 * verified against storage. `None` when not owned or missing.
 */
export const confirmDocument = Effect.fnUntraced(function*(
  userId: string,
  documentId: DocumentId
): Effect.fn.Return<Option.Option<Document>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    UPDATE documents
    SET state = 'stored', updated_at = now()
    WHERE id = ${documentId} AND user_id = ${userId}
    RETURNING id, user_id, filename, content_type, size_bytes, storage_key, state, created_at, updated_at
  `
  return rows.length === 0 ? Option.none() : Option.some(decodeDocument(rows[0]))
})

/** Delete a document row; `None` when not owned or missing. */
export const deleteDocument = Effect.fnUntraced(function*(
  userId: string,
  documentId: DocumentId
): Effect.fn.Return<Option.Option<void>, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    DELETE FROM documents
    WHERE id = ${documentId} AND user_id = ${userId}
    RETURNING id
  `
  return rows.length === 0 ? Option.none() : Option.some(undefined)
})