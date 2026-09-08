import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { NotesApi } from "./notes.api"
import type { CreateNote, NoteListItem, UpdateNote } from "@app/notes"

/**
 * The typed client derived from the `NotesApi` contract. Built once and
 * reused. The session cookie is HttpOnly and sent automatically on same-origin
 * requests, so authenticated endpoints just work once signed in.
 */
const clientPromise = Effect.runPromise(
  HttpApiClient.make(NotesApi, {
    baseUrl: typeof window !== "undefined" ? window.location.origin + "/api" : "http://localhost:3000/api"
  }).pipe(Effect.provide(FetchHttpClient.layer))
)

export const fetchNotes = async (): Promise<ReadonlyArray<NoteListItem>> => {
  const client = await clientPromise
  return Effect.runPromise(client.notes.list({}))
}

export const createNoteRequest = async (payload: CreateNote): Promise<NoteListItem> => {
  const client = await clientPromise
  return Effect.runPromise(client.notes.create({ payload }))
}

export const updateNoteRequest = async (id: string, payload: UpdateNote): Promise<NoteListItem> => {
  const client = await clientPromise
  return Effect.runPromise(client.notes.update({ params: { id }, payload }))
}

export const deleteNoteRequest = async (id: string): Promise<void> => {
  const client = await clientPromise
  await Effect.runPromise(client.notes.delete({ params: { id } }))
}