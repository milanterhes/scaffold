import { Schema } from "effect"
import { Notification } from "../db/models.ts"

/**
 * The API wire schemas. The read shape comes straight from the `Notification`
 * model's generated JSON variant — no hand-written duplication. `user_id` and
 * `type` are server-set (harmless to return); `read_at` is null until read.
 */
export const NotificationListItem = Notification.json
export type NotificationListItem = typeof NotificationListItem.Type

/** The result of a mark-read or read-all call. */
export const MarkReadResult = Schema.Struct({
  ok: Schema.Boolean
})
export type MarkReadResult = typeof MarkReadResult.Type