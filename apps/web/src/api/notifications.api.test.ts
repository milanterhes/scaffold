import { beforeAll, expect, it } from "@effect/vitest"
import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer, Scope } from "effect"
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpApi } from "effect/unstable/httpapi"
import { MemoryMailer } from "@app/auth"
import { AuthApi } from "@app/auth/api"
import { SessionMiddlewareLive } from "@app/auth/httpapi"
import { runAuthMigrations } from "@app/auth-postgres"
import { setupTestDb, TestDbLayer } from "@app/core"
import { createNotification, notificationsMigrations } from "@app/notifications/server"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { NotificationsApi } from "./notifications.api"
import { NotificationsImpl } from "./notifications.impl"
import { AuthLive } from "./auth.live"

beforeAll(async () => {
  // The test DB needs both the notifications schema and the auth schema (so
  // sign-in can write users/sessions against Postgres).
  await Effect.runPromise(setupTestDb(notificationsMigrations))
  await Effect.runPromise(runAuthMigrations.pipe(Effect.provide(TestDbLayer)))
})

// The composed API under test: the auth group (for sign-in + the session
// middleware) merged with the notifications group, mirroring the production
// `WebApi` composition.
const TestApi = HttpApi.make("TestApi").addHttpApi(AuthApi).addHttpApi(NotificationsApi)

const TestWebLayer = Layer.mergeAll(
  NotificationsImpl,
  AuthLive,
  NodeHttpClient.layerUndici
).pipe(
  Layer.provide(TestDbLayer),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provideMerge(SessionMiddlewareLive)
) as unknown as Layer.Layer<never, never, never>

type Run = (request: Request) => Effect.Effect<Response, unknown, never>

const withApi = <A>(use: (run: Run) => Effect.Effect<A, unknown, any>): Effect.Effect<A, unknown, any> =>
  Effect.gen(function*() {
    const context = yield* Layer.build(TestWebLayer)
    const router = (yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(TestApi)).pipe(
      Effect.provideContext(context)
    )) as unknown as Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      unknown,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >
    const handler = HttpEffect.toWebHandlerWith(context)(
      router as unknown as Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, never>
    )
    const run: Run = (request) => Effect.promise(() => handler(request))
    return yield* use(run).pipe(Effect.provideContext(context))
  }).pipe(Effect.scoped)

interface CallResult {
  readonly status: number
  readonly body: unknown
  readonly setCookie: string | null
}

const call = (
  run: Run,
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown } = {}
): Effect.Effect<CallResult, unknown, any> =>
  Effect.gen(function*() {
    const headers: Record<string, string> = {}
    if (options.token !== undefined) headers["cookie"] = `session=${options.token}`
    const init: RequestInit = { method, headers }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json"
      init.body = JSON.stringify(options.body)
    }
    const response = yield* run(new Request(`http://localhost${path}`, init))
    const text = yield* Effect.promise(() => response.text())
    return {
      status: response.status,
      body: text === "" ? null : JSON.parse(text),
      setCookie: response.headers.get("set-cookie")
    }
  })

const sessionCookie = (result: CallResult): string => {
  const match = /(?:^|;\s*)session=([^;]+)/.exec(result.setCookie ?? "")
  if (match === null) throw new Error("expected a session cookie")
  return match[1]
}

const signInWithEmailCode = (run: Run, email: string): Effect.Effect<string, unknown, any> =>
  Effect.gen(function*() {
    const requested = yield* call(run, "POST", "/auth/email-code", { body: { email } })
    expect(requested.status).toBe(200)
    const signInSessionId = (requested.body as { signInSessionId: string }).signInSessionId

    const mailer = yield* MemoryMailer
    const sent = yield* mailer.sent
    const message = sent.find((entry) => entry.to === email)
    expect(message).toBeDefined()

    const verified = yield* call(run, "POST", "/auth/email-code/verify", {
      body: { signInSessionId, code: message!.code }
    })
    expect(verified.status).toBe(200)
    expect(verified.setCookie).toContain("session=")
    return sessionCookie(verified)
  })

const getUserId = (run: Run, token: string): Effect.Effect<string, unknown, any> =>
  Effect.gen(function*() {
    const me = yield* call(run, "GET", "/auth/me", { token })
    return (me.body as { id: string }).id
  })

const cleanupNotifications = Effect.fnUntraced(function*(
  userId: string
): Effect.fn.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM notifications WHERE user_id = ${userId}`
})

it.effect("lists the caller's notifications newest first with a derived unread count", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const email = "notifs@example.com"
      const token = yield* signInWithEmailCode(run, email)
      const userId = yield* getUserId(run, token)
      try {
        yield* createNotification(userId, "document_uploaded", "Upload confirmed", "a.txt was stored")
        yield* createNotification(userId, "document_uploaded", "Upload confirmed", "b.txt was stored")

        const listed = yield* call(run, "GET", "/me/notifications", { token })
        expect(listed.status).toBe(200)
        const notifications = listed.body as Array<{
          id: string
          title: string
          body: string
          read_at: string | null
        }>
        expect(notifications.map((entry) => entry.body)).toEqual(["b.txt was stored", "a.txt was stored"])
        expect(notifications.filter((entry) => entry.read_at === null)).toHaveLength(2)
      } finally {
        yield* cleanupNotifications(userId)
      }
    }).pipe(Effect.provide(TestDbLayer))
  ))

it.effect("mark-read is idempotent and read-all clears the rest", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const token = yield* signInWithEmailCode(run, "notifs-read@example.com")
      const userId = yield* getUserId(run, token)
      try {
        yield* createNotification(userId, "document_uploaded", "Upload confirmed", "a.txt was stored")
        yield* createNotification(userId, "document_uploaded", "Upload confirmed", "b.txt was stored")
        const listed = yield* call(run, "GET", "/me/notifications", { token })
        const [a] = listed.body as Array<{ id: string }>

        const first = yield* call(run, "POST", `/me/notifications/${a.id}/read`, { token })
        expect(first.status).toBe(200)
        expect((first.body as { ok: boolean }).ok).toBe(true)
        const second = yield* call(run, "POST", `/me/notifications/${a.id}/read`, { token })
        expect(second.status).toBe(200)
        expect((second.body as { ok: boolean }).ok).toBe(true)

        const afterRead = yield* call(run, "GET", "/me/notifications", { token })
        const afterReadBody = afterRead.body as Array<{ id: string; read_at: string | null }>
        expect(afterReadBody.find((entry) => entry.id === a.id)?.read_at).not.toBeNull()
        expect(afterReadBody.filter((entry) => entry.read_at === null)).toHaveLength(1)

        const all = yield* call(run, "POST", "/me/notifications/read-all", { token })
        expect(all.status).toBe(200)
        expect((all.body as { ok: boolean }).ok).toBe(true)

        const finalList = yield* call(run, "GET", "/me/notifications", { token })
        expect((finalList.body as Array<{ read_at: string | null }>).every((entry) => entry.read_at !== null)).toBe(
          true
        )
      } finally {
        yield* cleanupNotifications(userId)
      }
    }).pipe(Effect.provide(TestDbLayer))
  ))

it.effect("404s for another user's notification", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const alice = yield* signInWithEmailCode(run, "notifs-alice@example.com")
      const bob = yield* signInWithEmailCode(run, "notifs-bob@example.com")
      const aliceId = yield* getUserId(run, alice)
      const bobId = yield* getUserId(run, bob)
      try {
        const created = yield* createNotification(
          aliceId,
          "document_uploaded",
          "Upload confirmed",
          "alice.txt was stored"
        )

        const asBob = yield* call(run, "POST", `/me/notifications/${created.id}/read`, { token: bob })
        expect(asBob.status).toBe(404)
        const missing = yield* call(run, "POST", `/me/notifications/${randomUUID()}/read`, { token: bob })
        expect(missing.status).toBe(404)

        const listAsBob = yield* call(run, "GET", "/me/notifications", { token: bob })
        expect((listAsBob.body as Array<unknown>)).toEqual([])
      } finally {
        yield* cleanupNotifications(aliceId)
        yield* cleanupNotifications(bobId)
      }
    }).pipe(Effect.provide(TestDbLayer))
  ))

it.effect("rejects unauthenticated requests to the notifications group", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const listed = yield* call(run, "GET", "/me/notifications")
      expect(listed.status).toBe(401)
      const readAll = yield* call(run, "POST", "/me/notifications/read-all")
      expect(readAll.status).toBe(401)
    })
  ))