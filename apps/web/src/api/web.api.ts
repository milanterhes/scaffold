import { HttpApi } from "effect/unstable/httpapi"
import { AuthApi } from "@app/auth/api"
import { NotesApi } from "./notes.api"
import { DocumentsApi } from "./documents.api"
import { NotificationsApi } from "./notifications.api"

/**
 * The app's combined `HttpApi`: the notes, documents, and notifications groups
 * plus the auth group. Merged with `addHttpApi`, which flattens the added
 * groups while preserving their annotation scope. Group keys (`notes`,
 * `documents`, `notifications`, `auth`) are the identifiers only, so
 * `HttpApiBuilder.group(...)` implementations registered against the source
 * APIs resolve here too.
 */
export const WebApi = HttpApi.make("WebApi")
  .addHttpApi(NotesApi)
  .addHttpApi(DocumentsApi)
  .addHttpApi(NotificationsApi)
  .addHttpApi(AuthApi)