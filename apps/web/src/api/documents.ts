import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { DocumentsApi } from "./documents.api"
import type { CreateDocument, CreateDocumentResult, DocumentListItem, GetDocumentResult } from "@app/documents"

/**
 * The typed client derived from the `DocumentsApi` contract. Built once and
 * reused. The session cookie is HttpOnly and sent automatically on same-origin
 * requests, so authenticated endpoints just work once signed in.
 */
const clientPromise = Effect.runPromise(
  HttpApiClient.make(DocumentsApi, {
    baseUrl: typeof window !== "undefined" ? window.location.origin + "/api" : "http://localhost:3000/api"
  }).pipe(Effect.provide(FetchHttpClient.layer))
)

export const createDocumentRequest = async (payload: CreateDocument): Promise<CreateDocumentResult> => {
  const client = await clientPromise
  return Effect.runPromise(client.documents.create({ payload }))
}

export const confirmDocumentRequest = async (id: string): Promise<DocumentListItem> => {
  const client = await clientPromise
  return Effect.runPromise(client.documents.confirm({ params: { id } }))
}

export const fetchDocuments = async (): Promise<ReadonlyArray<DocumentListItem>> => {
  const client = await clientPromise
  return Effect.runPromise(client.documents.list({}))
}

export const fetchDocument = async (id: string): Promise<GetDocumentResult> => {
  const client = await clientPromise
  return Effect.runPromise(client.documents.get({ params: { id } }))
}

export const deleteDocumentRequest = async (id: string): Promise<void> => {
  const client = await clientPromise
  await Effect.runPromise(client.documents.delete({ params: { id } }))
}