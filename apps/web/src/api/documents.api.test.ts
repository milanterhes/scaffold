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
import { documentsMigrations } from "@app/documents/server"
import { MemoryStorageStore, MemoryStorageTest } from "@app/documents/storage"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { randomUUID } from "node:crypto"
import { DocumentsApi } from "./documents.api"
import { DocumentsImpl } from "./documents.impl"
import { NotesApi } from "./notes.api"
import { NotesImpl } from "./notes.impl"
import { AuthLive } from "./auth.live"

beforeAll(async () => {
  await Effect.runPromise(setupTestDb({ ...notesMigrations, ...documentsMigrations }))
  await Effect.runPromise(runAuthMigrations.pipe(Effect.provide(TestDbLayer)))
})

const TestApi = HttpApi.make("TestApi").addHttpApi(AuthApi).addHttpApi(NotesApi).addHttpApi(DocumentsApi)

const TestWebLayer = Layer.mergeAll(
  NotesImpl,
  DocumentsImpl,
  AuthLive,
  NodeHttpClient.layerUndici
).pipe(
  Layer.provideMerge(MemoryStorageTest),
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

const cleanupDocuments = Effect.fnUntraced(function*(
  userId: string
): Effect.fn.Return<void, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM documents WHERE user_id = ${userId}`
})

const getUserId = (run: Run, token: string): Effect.Effect<string, unknown, any> =>
  Effect.gen(function*() {
    const me = yield* call(run, "GET", "/auth/me", { token })
    return (me.body as { id: string }).id
  })

it.effect("creates a pending document, uploads bytes, confirms, lists, downloads, deletes", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const email = "docs@example.com"
      const token = yield* signInWithEmailCode(run, email)
      const userId = yield* getUserId(run, token)
      try {
        // 1. Create a pending document → presigned PUT URL
        const created = yield* call(run, "POST", "/me/documents", {
          token,
          body: { filename: "manual.pdf", content_type: "application/pdf", size_bytes: 11 }
        })
        expect(created.status).toBe(200)
        const createdBody = created.body as {
          document: { id: string; state: string; storage_key: string }
          uploadUrl: string
        }
        expect(createdBody.document.state).toBe("pending")
        expect(createdBody.uploadUrl).toContain("/put/")

        // 2. Client PUTs the bytes to the presigned URL (simulated via the store)
        const key = createdBody.document.storage_key
        const store = yield* MemoryStorageStore
        yield* store.put(key, new TextEncoder().encode("hello world"), "application/pdf")

        // 3. Confirm → server HEAD-verifies and flips to stored
        const confirmed = yield* call(run, "POST", `/me/documents/${createdBody.document.id}/confirm`, { token })
        expect(confirmed.status).toBe(200)
        expect((confirmed.body as { state: string }).state).toBe("stored")

        // 4. List shows the stored document
        const listed = yield* call(run, "GET", "/me/documents", { token })
        const docs = listed.body as Array<{ id: string; state: string; filename: string }>
        expect(docs.map((doc) => doc.filename)).toEqual(["manual.pdf"])
        expect(docs[0].state).toBe("stored")

        // 5. Get returns a download URL
        const fetched = yield* call(run, "GET", `/me/documents/${createdBody.document.id}`, { token })
        expect(fetched.status).toBe(200)
        const fetchedBody = fetched.body as { upload: { kind: string; url: string } }
        expect(fetchedBody.upload.kind).toBe("download")
        expect(fetchedBody.upload.url).toContain("/get/")

        // 6. Delete removes the row and the object
        const deleted = yield* call(run, "DELETE", `/me/documents/${createdBody.document.id}`, { token })
        expect(deleted.status).toBe(200)
        const after = yield* call(run, "GET", "/me/documents", { token })
        expect((after.body as Array<unknown>)).toEqual([])
      } finally {
        yield* cleanupDocuments(userId)
      }
    }).pipe(Effect.provide(TestDbLayer))
  ))

it.effect("confirm 409s when the object was never uploaded", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const token = yield* signInWithEmailCode(run, "docs-409@example.com")
      const userId = yield* getUserId(run, token)
      try {
        const created = yield* call(run, "POST", "/me/documents", {
          token,
          body: { filename: "ghost.txt", content_type: "text/plain", size_bytes: 5 }
        })
        const id = (created.body as { document: { id: string } }).document.id
        const confirmed = yield* call(run, "POST", `/me/documents/${id}/confirm`, { token })
        expect(confirmed.status).toBe(409)
      } finally {
        yield* cleanupDocuments(userId)
      }
    }).pipe(Effect.provide(TestDbLayer))
  ))

it.effect("confirm 409s when upload size mismatches the row", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const token = yield* signInWithEmailCode(run, "docs-mismatch@example.com")
      const userId = yield* getUserId(run, token)
      try {
        const created = yield* call(run, "POST", "/me/documents", {
          token,
          body: { filename: "lied.txt", content_type: "text/plain", size_bytes: 5 }
        })
        const createdBody = created.body as { document: { id: string; storage_key: string } }
        const store = yield* MemoryStorageStore
        yield* store.put(createdBody.document.storage_key, new TextEncoder().encode("too long!!"), "text/plain")
        const confirmed = yield* call(run, "POST", `/me/documents/${createdBody.document.id}/confirm`, { token })
        expect(confirmed.status).toBe(409)
      } finally {
        yield* cleanupDocuments(userId)
      }
    }).pipe(Effect.provide(TestDbLayer))
  ))

it.effect("404s for a missing document", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const token = yield* signInWithEmailCode(run, "docs-404@example.com")
      const missing = yield* call(run, "DELETE", `/me/documents/${randomUUID()}`, { token })
      expect(missing.status).toBe(404)
    })
  ))

it.effect("rejects an oversized document at create with a clear message", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const token = yield* signInWithEmailCode(run, "docs-large@example.com")
      const created = yield* call(run, "POST", "/me/documents", {
        token,
        body: { filename: "huge.bin", content_type: "application/octet-stream", size_bytes: 6 * 1024 ** 3 }
      })
      expect(created.status).toBe(409)
      const body = created.body as { message?: string }
      expect(body.message).toContain("upload limit")
    })
  ))

it.effect("scopes documents to the owning user", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const alice = yield* signInWithEmailCode(run, "docs-alice@example.com")
      const bob = yield* signInWithEmailCode(run, "docs-bob@example.com")
      const aliceId = yield* getUserId(run, alice)
      const bobId = yield* getUserId(run, bob)
      try {
        const created = yield* call(run, "POST", "/me/documents", {
          token: alice,
          body: { filename: "alice.pdf", content_type: "application/pdf", size_bytes: 4 }
        })
        const id = (created.body as { document: { id: string } }).document.id

        const asBob = yield* call(run, "GET", `/me/documents/${id}`, { token: bob })
        expect(asBob.status).toBe(404)
        const deleteAsBob = yield* call(run, "DELETE", `/me/documents/${id}`, { token: bob })
        expect(deleteAsBob.status).toBe(404)
        const confirmAsBob = yield* call(run, "POST", `/me/documents/${id}/confirm`, { token: bob })
        expect(confirmAsBob.status).toBe(404)
        const listAsBob = yield* call(run, "GET", "/me/documents", { token: bob })
        expect((listAsBob.body as Array<unknown>)).toEqual([])
      } finally {
        yield* Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM documents WHERE user_id = ${aliceId} OR user_id = ${bobId}`
        }).pipe(Effect.provide(TestDbLayer))
      }
    }).pipe(Effect.provide(TestDbLayer))
  ))

it.effect("get returns a fresh presigned PUT url for a pending document (retry without a new row)", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const token = yield* signInWithEmailCode(run, "docs-resume@example.com")
      const userId = yield* getUserId(run, token)
      try {
        const created = yield* call(run, "POST", "/me/documents", {
          token,
          body: { filename: "resume.txt", content_type: "text/plain", size_bytes: 5 }
        })
        const id = (created.body as { document: { id: string } }).document.id
        const fetched = yield* call(run, "GET", `/me/documents/${id}`, { token })
        expect(fetched.status).toBe(200)
        const body = fetched.body as { upload: { kind: string; url: string } }
        expect(body.upload.kind).toBe("upload")
        expect(body.upload.url).toContain("/put/")
      } finally {
        yield* cleanupDocuments(userId)
      }
    }).pipe(Effect.provide(TestDbLayer))
  ))

it.effect("rejects unauthenticated requests to the documents group", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const listed = yield* call(run, "GET", "/me/documents")
      expect(listed.status).toBe(401)
    })
  ))