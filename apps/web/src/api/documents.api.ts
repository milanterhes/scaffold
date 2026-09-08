import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { CreateDocument, CreateDocumentResult, DocumentListItem, GetDocumentResult } from "@app/documents"
import { SessionMiddleware } from "@app/auth/api"

/**
 * The object exceeds the configured size limit. Carries a human-readable
 * message (including the limit) so the client can show the real reason
 * instead of a generic upload/confirm failure.
 */
export class DocumentTooLarge extends Schema.TaggedError<DocumentTooLarge>()("DocumentTooLarge", {
  message: Schema.String
}, { httpApiStatus: 409 }) {}

const DocumentsGroup = HttpApiGroup.make("documents").add(
  HttpApiEndpoint.post("create", "/me/documents", {
    payload: CreateDocument,
    success: CreateDocumentResult,
    error: [HttpApiError.BadRequest, DocumentTooLarge, HttpApiError.InternalServerError]
  }).middleware(SessionMiddleware),
  HttpApiEndpoint.post("confirm", "/me/documents/:id/confirm", {
    params: Schema.Struct({ id: Schema.String }),
    success: DocumentListItem,
    error: [HttpApiError.NotFound, HttpApiError.Conflict, DocumentTooLarge, HttpApiError.InternalServerError]
  }).middleware(SessionMiddleware),
  HttpApiEndpoint.get("list", "/me/documents", {
    success: Schema.Array(DocumentListItem),
    error: HttpApiError.InternalServerError
  }).middleware(SessionMiddleware),
  HttpApiEndpoint.get("get", "/me/documents/:id", {
    params: Schema.Struct({ id: Schema.String }),
    success: GetDocumentResult,
    error: [HttpApiError.NotFound, HttpApiError.InternalServerError]
  }).middleware(SessionMiddleware),
  HttpApiEndpoint.delete("delete", "/me/documents/:id", {
    params: Schema.Struct({ id: Schema.String }),
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: [HttpApiError.NotFound, HttpApiError.InternalServerError]
  }).middleware(SessionMiddleware)
)

export const DocumentsApi = HttpApi.make("DocumentsApi").add(DocumentsGroup)