import { randomUUID } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { Notification, NotificationId, NotificationType } from "../db/models.ts"

const SELECT = `
  SELECT id, user_id, type, title, body, read_at, created_at
  FROM notifications
`

/**
 * Decode raw driver rows into `Notification` values. Postgres returns
 * `timestamptz` columns as JS `Date`s (converted by the model's `select`
 * variant) and a `NULL` `read_at` as `null` (handled by `Schema.NullOr`), so
 * the value handed back genuinely satisfies the model's types.
 */
const decodeNotification = (row: unknown): Notification => Schema.decodeUnknownSync(Notification)(row)

/**
 * Insert an inbox row, used by the `notification.deliver` job handler. The
 * type comes from the event the notification was derived from.
 */
export const createNotification = Effect.fnUntraced(function*(
  userId: string,
  type: NotificationType,
  title: string,
  body: string
): Effect.fn.Return<Notification, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const id = randomUUID() as NotificationId
  const rows = yield* sql`
    INSERT INTO notifications (id, user_id, type, title, body)
    VALUES (${id}, ${userId}, ${type}, ${title}, ${body})
    RETURNING id, user_id, type, title, body, read_at, created_at
  `
  return decodeNotification(rows[0])
})

/** A user's notifications, newest first, up to `limit` rows. */
export const listNotifications = Effect.fnUntraced(function*(
  userId: string,
  limit: number
): Effect.fn.Return<ReadonlyArray<Notification>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    ${sql.unsafe(SELECT)}
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, id
    LIMIT ${limit}
  `
  return rows.map(decodeNotification)
})

/**
 * Mark a notification read. Idempotent: an already-read row keeps its original
 * `read_at`. `None` when the notification is not owned or missing.
 */
export const markRead = Effect.fnUntraced(function*(
  userId: string,
  notificationId: NotificationId
): Effect.fn.Return<Option.Option<Notification>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    UPDATE notifications
    SET read_at = COALESCE(read_at, now())
    WHERE id = ${notificationId} AND user_id = ${userId}
    RETURNING id, user_id, type, title, body, read_at, created_at
  `
  return rows.length === 0 ? Option.none() : Option.some(decodeNotification(rows[0]))
})

/** Mark all of a user's unread notifications read, returning the rows changed. */
export const markAllRead = Effect.fnUntraced(function*(
  userId: string
): Effect.fn.Return<ReadonlyArray<Notification>, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    UPDATE notifications
    SET read_at = now()
    WHERE user_id = ${userId} AND read_at IS NULL
    RETURNING id, user_id, type, title, body, read_at, created_at
  `
  return rows.map(decodeNotification)
})