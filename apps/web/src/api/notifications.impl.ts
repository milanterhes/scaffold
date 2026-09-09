import { listNotifications, markAllRead, markRead } from "@app/notifications/server"
import type { NotificationId } from "@app/notifications"
import { CurrentUser } from "@app/auth/api"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { NotificationsApi } from "./notifications.api"

/**
 * The notifications group handlers. Every endpoint is behind `SessionMiddleware`,
 * so `CurrentUser` is the authenticated caller; all rows are scoped to that user.
 * There is no dedicated unread-count endpoint — the client derives it from the
 * list (`read_at` is null until read).
 */
export const NotificationsImpl = HttpApiBuilder.group(NotificationsApi, "notifications", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const notifications = yield* listNotifications(user.id, 50).pipe(Effect.orDie)
        return notifications
      })
    )
    .handle("read", ({ params }) =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        const updated = yield* markRead(user.id, params.id as NotificationId).pipe(Effect.orDie)
        if (Option.isNone(updated)) {
          return yield* new HttpApiError.NotFound({})
        }
        return { ok: true }
      })
    )
    .handle("readAll", () =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        yield* markAllRead(user.id).pipe(Effect.orDie)
        return { ok: true }
      })
    )
)