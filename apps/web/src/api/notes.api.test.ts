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
import { notesMigrations } from "@app/notes/server"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { NotesApi } from "./notes.api"
import { NotesImpl } from "./notes.impl"
import { AuthLive } from "./auth.live"

beforeAll(async () => {
  // The test DB needs both the app schema (notes) and the auth schema (so
  // sign-in can write users/sessions against Postgres).
  await Effect.runPromise(setupTestDb(notesMigrations))
  await Effect.runPromise(runAuthMigrations.pipe(Effect.provide(TestDbLayer)))
})

// The composed API under test: the auth group (for sign-in + the session
// middleware) merged with the notes group, mirroring the production `WebApi`
// composition.
const TestApi = HttpApi.make("TestApi").addHttpApi(AuthApi).addHttpApi(NotesApi)

const TestWebLayer = Layer.mergeAll(
  NotesImpl,
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

const cleanupNotes = Effect.fnUntraced(function*(
  userId: string
): Effect.fn.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM notes WHERE user_id = ${userId}`
})

it.effect("creates, lists, and deletes the caller's notes", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const email = "notes@example.com"
      const token = yield* signInWithEmailCode(run, email)
      const me = yield* call(run, "GET", "/auth/me", { token })
      const userId = (me.body as { id: string }).id
      try {
        const created = yield* call(run, "POST", "/me/notes", {
          token,
          body: { title: "First note", body: "hello" }
        })
        expect(created.status).toBe(200)
        const note = created.body as { id: string; title: string; body: string }
        expect(note.title).toBe("First note")
        expect(note.body).toBe("hello")

        const listed = yield* call(run, "GET", "/me/notes", { token })
        expect(listed.status).toBe(200)
        const notes = listed.body as Array<{ id: string; title: string }>
        expect(notes.map((entry) => entry.title)).toEqual(["First note"])

        const deleted = yield* call(run, "DELETE", `/me/notes/${note.id}`, { token })
        expect(deleted.status).toBe(200)

        const after = yield* call(run, "GET", "/me/notes", { token })
        expect((after.body as Array<unknown>)).toEqual([])
      } finally {
        yield* cleanupNotes(userId)
      }
    }).pipe(Effect.provide(TestDbLayer))
  ))

it.effect("404s for a missing or unowned note", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const token = yield* signInWithEmailCode(run, "notes-404@example.com")
      const missing = yield* call(run, "DELETE", `/me/notes/${randomUUID()}`, { token })
      expect(missing.status).toBe(404)
    }).pipe(Effect.provide(TestDbLayer))
  ))

it.effect("rejects unauthenticated requests to the notes group", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const listed = yield* call(run, "GET", "/me/notes")
      expect(listed.status).toBe(401)
    })
  ))