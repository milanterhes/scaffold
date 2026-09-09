import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { NotificationsApi } from "./notifications.api"
import type { MarkReadResult, NotificationListItem } from "@app/notifications"

/**
 * The typed client derived from the `NotificationsApi` contract. Built once and
 * reused. The session cookie is HttpOnly and sent automatically on same-origin
 * requests, so authenticated endpoints just work once signed in.
 */
const clientPromise = Effect.runPromise(
  HttpApiClient.make(NotificationsApi, {
    baseUrl: typeof window !== "undefined" ? window.location.origin + "/api" : "http://localhost:3000/api"
  }).pipe(Effect.provide(FetchHttpClient.layer))
)

export const fetchNotifications = async (): Promise<ReadonlyArray<NotificationListItem>> => {
  const client = await clientPromise
  return Effect.runPromise(client.notifications.list({}))
}

export const markReadRequest = async (id: string): Promise<MarkReadResult> => {
  const client = await clientPromise
  return Effect.runPromise(client.notifications.read({ params: { id } }))
}

export const markAllReadRequest = async (): Promise<MarkReadResult> => {
  const client = await clientPromise
  return Effect.runPromise(client.notifications.readAll({}))
}