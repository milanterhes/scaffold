import { expect, it } from "@effect/vitest"
import { NodeCrypto } from "@effect/platform-node"
import { Effect, Layer, Option, Scope } from "effect"
import {
  HttpClient,
  HttpClientResponse,
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { IdTokenVerifier } from "./jwt.ts"
import type { IdTokenClaims } from "./jwt.ts"
import { MemoryMailer, MemoryMailerLayer } from "./mailer.ts"
import { MemoryStorageLayer } from "./storage/memory.ts"
import { HasherTest } from "./hashing.ts"
import { TokenBucketLive } from "./email-code.ts"
import { googleIdentity, googleProvider } from "./oauth/providers/google.ts"
import {
  AuthApi,
  AuthImpl,
  OAuthPendingStoreLive,
  OAuthProviderRegistry,
  SessionMiddlewareLive,
  oidcProviderRegistration
} from "./httpapi.ts"
import type { OAuthProviderRegistration } from "./httpapi.ts"

const BASE_URL = "http://localhost"

const DISCOVERY_PATH = "/.well-known/openid-configuration"
const TOKEN_PATH = "/oauth/token"
const USERINFO_PATH = "/oauth/userinfo"

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const makeFakeHttp = (): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    const url = new URL(request.url)
    let response: Response
    if (request.method === "GET" && url.pathname === DISCOVERY_PATH) {
      response = json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://fake.example.com/oauth/authorize",
        token_endpoint: `https://fake.example.com${TOKEN_PATH}`,
        userinfo_endpoint: `https://fake.example.com${USERINFO_PATH}`,
        jwks_uri: "https://fake.example.com/oauth/jwks"
      }, 200)
    } else if (request.method === "POST" && url.pathname === TOKEN_PATH) {
      response = json({
        access_token: "access-token-123",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: "fake-id-token"
      }, 200)
    } else if (request.method === "GET" && url.pathname === USERINFO_PATH) {
      response = json({ sub: "oauth-user-1", email: "alice@example.com", email_verified: true }, 200)
    } else {
      response = json({ error: "not found" }, 404)
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, response))
  })

const FakeIdTokenVerifier: Layer.Layer<IdTokenVerifier> = Layer.succeed(
  IdTokenVerifier,
  IdTokenVerifier.of({
    verifyIdToken: (options, _idToken) =>
      Effect.succeed<IdTokenClaims>({
        sub: "oauth-user-1",
        email: "alice@example.com",
        email_verified: true,
        ...(options.nonce !== undefined ? { nonce: options.nonce } : {})
      })
  })
)

const googleRegistration: OAuthProviderRegistration = oidcProviderRegistration(
  googleProvider({
    clientId: "google-client",
    clientSecret: "google-secret",
    redirectUri: `${BASE_URL}/auth/oauth/google/callback`
  }),
  googleIdentity
)

const TestRegistry: Layer.Layer<OAuthProviderRegistry> = Layer.succeed(
  OAuthProviderRegistry,
  OAuthProviderRegistry.of({
    get: (provider) =>
      Effect.sync(() => (provider === "google" ? Option.some(googleRegistration) : Option.none()))
  })
)

const TestApiLayer = Layer.mergeAll(
  AuthImpl,
  TestRegistry,
  OAuthPendingStoreLive
).pipe(
  Layer.provide(SessionMiddlewareLive),
  Layer.provideMerge(MemoryStorageLayer),
  Layer.provideMerge(MemoryMailerLayer),
  Layer.provideMerge(HasherTest),
  Layer.provideMerge(TokenBucketLive),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FakeIdTokenVerifier),
  Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, makeFakeHttp())),
  Layer.provideMerge(HttpServer.layerServices)
) as unknown as Layer.Layer<never, never, never>

type Run = (request: Request) => Effect.Effect<Response, unknown, never>

/**
 * Builds the full mounted API once and exposes a fetch-style `run` plus the
 * test services (memory storage/mailer) from the same context.
 */
const withApi = <A>(use: (run: Run) => Effect.Effect<A, unknown, any>): Effect.Effect<A, unknown, any> =>
  Effect.gen(function*() {
    const context = yield* Layer.build(TestApiLayer).pipe(Effect.scoped)
    const router = (yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(AuthApi)).pipe(
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
  readonly location: string | null
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
      setCookie: response.headers.get("set-cookie"),
      location: response.headers.get("location")
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

it.effect("signs in via email code and resolves /auth/me from the session cookie", () =>
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

it.effect("signs out: clears the session cookie and invalidates the session server-side", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const email = "bob@example.com"

      const token = yield* signInWithEmailCode(run, email)

      const signedOut = yield* call(run, "POST", "/auth/signout", { token })
      expect(signedOut.status).toBe(200)
      expect(signedOut.body).toEqual({ ok: true })
      expect(signedOut.setCookie).toContain("session=")
      expect(signedOut.setCookie).toContain("Max-Age=0")

      const me = yield* call(run, "GET", "/auth/me", { token })
      expect(me.status).toBe(401)
    })
  ))

it.effect("oauth start returns an authorization URL and the callback links a user and sets the cookie", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const started = yield* call(run, "GET", "/auth/oauth/google/start")
      expect(started.status).toBe(200)
      const startBody = started.body as { authorizationUrl: string; state: string }
      const url = new URL(startBody.authorizationUrl)
      expect(url.searchParams.get("client_id")).toBe("google-client")
      expect(url.searchParams.get("response_type")).toBe("code")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("code_challenge")).toBeTruthy()
      expect(url.searchParams.get("state")).toBe(startBody.state)
      expect(url.searchParams.get("nonce")).toBeTruthy()

      const callback = yield* call(
        run,
        "GET",
        `/auth/oauth/google/callback?code=auth-code&state=${encodeURIComponent(startBody.state)}`
      )
      expect(callback.status).toBe(302)
      expect(callback.location).toBe("/")
      expect(callback.setCookie).toContain("session=")
      const token = sessionCookie(callback)

      const me = yield* call(run, "GET", "/auth/me", { token })
      expect(me.status).toBe(200)
      expect(me.body).toMatchObject({ email: "alice@example.com", emailVerified: true })
    })
  ))

it.effect("oauth callback rejects an unknown state", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const callback = yield* call(
        run,
        "GET",
        "/auth/oauth/google/callback?code=auth-code&state=forged-state"
      )
      expect(callback.status).toBe(400)
    })
  ))

it.effect("oauth start returns 404 for an unregistered provider", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const started = yield* call(run, "GET", "/auth/oauth/github/start")
      expect(started.status).toBe(404)
    })
  ))

it.effect("DELETE /auth/me deletes the authenticated user", () =>
  withApi((run) =>
    Effect.gen(function*() {
      const email = "carol@example.com"

      const token = yield* signInWithEmailCode(run, email)

      const deleted = yield* call(run, "DELETE", "/auth/me", { token })
      expect(deleted.status).toBe(200)
      expect(deleted.body).toEqual({ ok: true })

      const me = yield* call(run, "GET", "/auth/me", { token })
      expect(me.status).toBe(401)
    })
  ))