import { Effect, Option, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import type { Job } from "@app/jobs"
import { createNotification } from "../repo/notifications.repo.ts"

/** The `document.uploaded` outbox payload, as emitted by the documents domain. */
const DocumentUploadedPayload = Schema.Struct({
  userId: Schema.String,
  documentId: Schema.String,
  filename: Schema.String,
  sizeBytes: Schema.Number
})

/** Inbox rows are rendered as plain text; cap client-visible strings before rendering. */
const MAX_FILENAME_LENGTH = 200

/** Truncate a rendered value to `max` chars (ellipsis included) so untrusted strings cannot flood the inbox. */
const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 3)}...` : value

/**
 * The `notification.deliver` job handler: turns an outbox event payload into an
 * inbox row. Only `document.uploaded` events produce a notification today;
 * anything else is a no-op success so the job completes cleanly. Registered in
 * `apps/worker` under the `notification.deliver` job type.
 */
export const deliverNotification = Effect.fnUntraced(function*(
  job: Job
): Effect.fn.Return<void, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const payload = Schema.decodeUnknownOption(DocumentUploadedPayload)(job.payload)
  if (Option.isNone(payload)) {
    return
  }
  yield* createNotification(
    payload.value.userId,
    "document_uploaded",
    "Upload confirmed",
    `${truncate(payload.value.filename, MAX_FILENAME_LENGTH)} was stored`
  )
})