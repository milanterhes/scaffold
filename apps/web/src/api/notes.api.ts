import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { CreateNote, NoteListItem, UpdateNote } from "@app/notes"
import { SessionMiddleware } from "@app/auth/api"

const NotesGroup = HttpApiGroup.make("notes").add(
  HttpApiEndpoint.get("list", "/me/notes", {
    success: Schema.Array(NoteListItem),
    error: HttpApiError.InternalServerError
  }).middleware(SessionMiddleware),
  HttpApiEndpoint.post("create", "/me/notes", {
    payload: CreateNote,
    success: NoteListItem,
    error: HttpApiError.InternalServerError
  }).middleware(SessionMiddleware),
  HttpApiEndpoint.patch("update", "/me/notes/:id", {
    params: Schema.Struct({ id: Schema.String }),
    payload: UpdateNote,
    success: NoteListItem,
    error: [HttpApiError.NotFound, HttpApiError.InternalServerError]
  }).middleware(SessionMiddleware),
  HttpApiEndpoint.delete("delete", "/me/notes/:id", {
    params: Schema.Struct({ id: Schema.String }),
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: [HttpApiError.NotFound, HttpApiError.InternalServerError]
  }).middleware(SessionMiddleware)
)

export const NotesApi = HttpApi.make("NotesApi").add(NotesGroup)