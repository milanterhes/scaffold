import { randomUUID } from "node:crypto"
import { createDocument, confirmDocument, deleteDocument, getDocument, listDocuments } from "@app/documents/server"
import type { Document, DocumentId } from "@app/documents"
import type { StorageObject } from "@app/documents/storage"
import { Storage } from "@app/documents/storage"
import { emitEvent } from "@app/jobs/server"
import { CurrentUser } from "@app/auth/api"
import { Config, Effect, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { DocumentsApi, DocumentTooLarge } from "./documents.api"

/**
 * The largest object accepted for upload. Single PUT uploads are capped at
 * 5 GiB by S3/Garage, so the default matches that ceiling. Override with
 * `MAX_DOCUMENT_SIZE_BYTES` (in bytes).
 */
const maxDocumentSizeBytes: Effect.Effect<number, never, never> = Config.number(
  "MAX_DOCUMENT_SIZE_BYTES"
).pipe(
  Config.withDefault(5 * 1024 * 1024 * 1024),
  Effect.map((value) => value),
  Effect.catch(() => Effect.succeed(5 * 1024 * 1024 * 1024))
)

const toListItem = (document: Document) => ({
  id: document.id,
  user_id: document.user_id,
  filename: document.filename,
  content_type: document.content_type,
  size_bytes: document.size_bytes,
  storage_key: document.storage_key,
  state: document.state,
  created_at: document.created_at,
  updated_at: document.updated_at
})

const objectMatchesRow = (head: StorageObject, document: Document): boolean =>
  head.size_bytes === document.size_bytes && head.content_type === document.content_type

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MiB`

/**
 * The documents group handlers. Every endpoint is behind `SessionMiddleware`,
 * so `CurrentUser` is the authenticated caller; all rows and storage keys are
 * scoped to that user. Storage failures (a real outage, not an app condition)
 * are treated as defects (`orDie`) like repo failures in the notes group.
 */
export const DocumentsImpl = HttpApiBuilder.group(DocumentsApi, "documents", (handlers) =>
  handlers
    .handle("create", ({ payload }) =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const storage = yield* Storage
        const maxBytes = yield* maxDocumentSizeBytes
        if (payload.size_bytes < 0) {
          return yield* new HttpApiError.BadRequest({})
        }
        if (payload.size_bytes > maxBytes) {
          return yield* new DocumentTooLarge({
            message: `${payload.filename} is ${formatBytes(payload.size_bytes)}, over the ${formatBytes(maxBytes)} upload limit`
          })
        }
        const storageKey = `${user.id}/${randomUUID()}`
        const document = yield* createDocument(user.id, { ...payload, storage_key: storageKey }).pipe(Effect.orDie)
        const presigned = yield* storage.presignPut(storageKey, payload.content_type, payload.size_bytes).pipe(
          Effect.orDie
        )
        return { document: toListItem(document), uploadUrl: presigned.url }
      })
    )
    .handle("confirm", ({ params }) =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const storage = yield* Storage
        const maxBytes = yield* maxDocumentSizeBytes
        const existing = yield* getDocument(user.id, params.id as DocumentId).pipe(Effect.orDie)
        if (Option.isNone(existing)) {
          return yield* new HttpApiError.NotFound({})
        }
        const document = existing.value
        const head = yield* storage.headObject(document.storage_key).pipe(Effect.orDie)
        if (head === null) {
          return yield* new HttpApiError.Conflict({})
        }
        if (!objectMatchesRow(head, document)) {
          return yield* new HttpApiError.Conflict({})
        }
        if (head.size_bytes > maxBytes) {
          return yield* new DocumentTooLarge({
            message: `${document.filename} is ${formatBytes(head.size_bytes)}, over the ${formatBytes(maxBytes)} upload limit`
          })
        }
        if (document.state === "stored") {
          return toListItem(document)
        }
        // The `pending → stored` flip and the outbox emit commit together: both
        // run inside one transaction, so a confirmed upload always emits and a
        // rolled-back confirm never does.
        const sql = yield* SqlClient.SqlClient
        const confirmed = yield* sql.withTransaction(
          Effect.gen(function*() {
            const confirmed = yield* confirmDocument(user.id, params.id as DocumentId).pipe(Effect.orDie)
            if (Option.isNone(confirmed)) {
              return Option.none<Document>()
            }
            const value = confirmed.value
            yield* emitEvent("document.uploaded", {
              userId: user.id,
              documentId: value.id,
              filename: value.filename,
              sizeBytes: value.size_bytes
            })
            return confirmed
          })
        ).pipe(Effect.orDie)
        if (Option.isNone(confirmed)) {
          return yield* new HttpApiError.NotFound({})
        }
        return toListItem(confirmed.value)
      })
    )
    .handle("list", () =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const documents = yield* listDocuments(user.id).pipe(Effect.orDie)
        return documents.map(toListItem)
      })
    )
    .handle("get", ({ params }) =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const storage = yield* Storage
        const existing = yield* getDocument(user.id, params.id as DocumentId).pipe(Effect.orDie)
        if (Option.isNone(existing)) {
          return yield* new HttpApiError.NotFound({})
        }
        const document = existing.value
        const presigned = document.state === "stored"
          ? yield* storage.presignGet(document.storage_key).pipe(Effect.orDie)
          : yield* storage.presignPut(document.storage_key, document.content_type, document.size_bytes).pipe(Effect.orDie)
        return {
          document: toListItem(document),
          upload: document.state === "stored"
            ? { kind: "download" as const, url: presigned.url }
            : { kind: "upload" as const, url: presigned.url }
        }
      })
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const storage = yield* Storage
        const existing = yield* getDocument(user.id, params.id as DocumentId).pipe(Effect.orDie)
        if (Option.isNone(existing)) {
          return yield* new HttpApiError.NotFound({})
        }
        yield* storage.deleteObject(existing.value.storage_key).pipe(Effect.orDie)
        yield* deleteDocument(user.id, params.id as DocumentId).pipe(Effect.orDie)
        return { ok: true }
      })
    )
)