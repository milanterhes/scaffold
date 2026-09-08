import { randomUUID } from "node:crypto"
import { createDocument, confirmDocument, deleteDocument, getDocument, listDocuments } from "@app/documents/server"
import type { Document, DocumentId } from "@app/documents"
import type { StorageObject } from "@app/documents/storage"
import { Storage } from "@app/documents/storage"
import { CurrentUser } from "@app/auth/api"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { DocumentsApi } from "./documents.api"

/** The largest object accepted at confirm; HEAD'd size must be at most this. */
export const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024

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
        if (payload.size_bytes < 0) {
          return yield* new HttpApiError.BadRequest({})
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
        const existing = yield* getDocument(user.id, params.id as DocumentId).pipe(Effect.orDie)
        if (Option.isNone(existing)) {
          return yield* new HttpApiError.NotFound({})
        }
        const document = existing.value
        const head = yield* storage.headObject(document.storage_key).pipe(Effect.orDie)
        if (head === null) {
          return yield* new HttpApiError.Conflict({})
        }
        if (!objectMatchesRow(head, document) || head.size_bytes > MAX_DOCUMENT_SIZE_BYTES) {
          return yield* new HttpApiError.Conflict({})
        }
        if (document.state === "stored") {
          return toListItem(document)
        }
        const confirmed = yield* confirmDocument(user.id, params.id as DocumentId).pipe(Effect.orDie)
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