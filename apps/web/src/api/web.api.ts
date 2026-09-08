import { HttpApi } from "effect/unstable/httpapi"
import { AuthApi } from "@app/auth/api"
import { NotesApi } from "./notes.api"

/**
 * The app's combined `HttpApi`: the notes group plus the auth group. Merged
 * with `addHttpApi`, which flattens the added groups while preserving their
 * annotation scope. Group keys (`notes`, `auth`) are the identifiers only, so
 * `HttpApiBuilder.group(...)` implementations registered against the source
 * APIs resolve here too.
 */
export const WebApi = HttpApi.make("WebApi").addHttpApi(NotesApi).addHttpApi(AuthApi)