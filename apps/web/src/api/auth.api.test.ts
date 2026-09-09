import { expect, it } from "@effect/vitest"
import { NodeHttpClient } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer, Redacted, Scope } from "effect"
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MemoryMailer } from "@app/auth"
import { SessionMiddlewareLive } from "@app/auth/httpapi"
import { MemoryStorageTest } from "@app/documents/storage"
import { AuthLive } from "./auth.live"
import { WebApi } from "./web.api"
import { NotesImpl } from "./notes.impl"
import { DocumentsImpl } from "./documents.impl"
import { NotificationsImpl } from "./notifications.impl"

const BASE_URL = "http://localhost"

// The notes, documents, and notifications groups need a `SqlClient`; a lazy
// `PgClient` layer satisfies the requirement without connecting (pool creation
// is lazy). The auth groups run on the memory `AuthStorage` and documents on
// the in-memory storage — there is no `DATABASE_URL` in the test process, so
// `AuthLive` falls back to the in-memory seam.
const LazyDb = PgClient.layer({
  url: Redacted.make("postgres://postgres:postgres@localhost:5432/scaffold_test")
})

const TestWebLayer = Layer.mergeAll(
  NotesImpl,
  DocumentsImpl,
  NotificationsImpl,
  AuthLive,
  NodeHttpClient.layerUndici
).pipe(
  Layer.provide(LazyDb),
  Layer.provideMerge(MemoryStorageTest),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provideMerge(SessionMiddlewareLive)
) as unknown as Layer.Layer<never, never, never>

type Run = (request: Request) => Effect.Effect<Response, unknown, never>

/**
 * Builds the composed `WebApi` router (notes + auth) once and exposes a
 * fetch-style `run`, mirroring `packages/auth/src/httpapi.test.ts`.
 */
const withApi = <A>(use: (run: Run) => Effect.Effect<A, unknown, any>): Effect.Effect<A, unknown, any> =>
  Effect.gen(function*() {
    const context = yield* Layer.build(TestWebLayer).pipe(Effect.scoped)
    const router = (yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(WebApi)).pipe(
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
  })

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
    const response = yield* run(new Request(`${BASE_URL}${path}`, init))
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

it.effect("signs in via email code and resolves /auth/me through the composed web router", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const email = "alice@example.com"

      const token = yield* signInWithEmailCode(run, email)

      const me = yield* call(run, "GET", "/auth/me", { token })
      expect(me.status).toBe(200)
      expect(me.body).toMatchObject({ email, emailVerified: true })
      expect(me.body).toHaveProperty("id")
    })
  ))

it.effect("rejects /auth/me with 401 when the session cookie is absent", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const me = yield* call(run, "GET", "/auth/me")
      expect(me.status).toBe(401)
    })
  ))

it.effect("an unknown path 404s, proving the composed router is mounted", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const missing = yield* call(run, "GET", "/auth/does-not-exist")
      expect(missing.status).toBe(404)
    })
  ))