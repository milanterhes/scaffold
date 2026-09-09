import { Schema } from "effect"
import { Model } from "effect/unstable/schema"

export const NotificationId = Schema.String.pipe(Schema.brand("NotificationId"))
export type NotificationId = typeof NotificationId.Type

/**
 * The kinds of notification a user can receive. Mirrors the domain event type
 * with dots replaced by underscores. `document_failed` is part of the enum but
 * never emitted (see the notifications spec).
 */
export const NotificationType = Schema.Literals(["document_uploaded", "document_failed"])
export type NotificationType = typeof NotificationType.Type

/**
 * A user's inbox row, denormalized from a domain event by the
 * `notification.deliver` job. `read_at` is null until the user reads it (a
 * timestamp records when, not a boolean); the `json` variant encodes it as a
 * string for the API wire.
 */
export class Notification extends Model.Class<Notification>("scaffold/db/Notification")({
  id: Model.UuidV4Insert(NotificationId),
  user_id: Model.GeneratedByApp(Schema.String),
  type: Model.GeneratedByApp(NotificationType),
  title: Schema.NonEmptyString,
  body: Schema.String,
  read_at: Model.Field({
    select: Schema.NullOr(Schema.DateTimeUtcFromDate),
    insert: Schema.NullOr(Schema.DateTimeUtcFromDate),
    json: Schema.NullOr(Schema.DateTimeUtcFromString)
  }),
  created_at: Model.DateTimeInsertFromDate
}) {}