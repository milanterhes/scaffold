import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { MarkReadResult, NotificationListItem } from "@app/notifications"
import { SessionMiddleware } from "@app/auth/api"

const NotificationsGroup = HttpApiGroup.make("notifications").add(
  HttpApiEndpoint.get("list", "/me/notifications", {
    success: Schema.Array(NotificationListItem),
    error: HttpApiError.InternalServerError
  }).middleware(SessionMiddleware),
  HttpApiEndpoint.post("read", "/me/notifications/:id/read", {
    params: Schema.Struct({ id: Schema.String }),
    success: MarkReadResult,
    error: [HttpApiError.NotFound, HttpApiError.InternalServerError]
  }).middleware(SessionMiddleware),
  HttpApiEndpoint.post("readAll", "/me/notifications/read-all", {
    success: MarkReadResult,
    error: HttpApiError.InternalServerError
  }).middleware(SessionMiddleware)
)

export const NotificationsApi = HttpApi.make("NotificationsApi").add(NotificationsGroup)