/**
 * The browser-safe auth contract: the `AuthApi` endpoints plus the schemas and
 * the `SessionMiddleware` class (a pure service declaration). Kept separate
 * from `httpapi.ts` so a client bundle can import `AuthApi` without pulling in
 * the node-only implementation modules (`hashing.ts`, `session.ts`,
 * `oauth/protocol.ts` import `node:crypto`) — the same split as
 * `@app/core`'s `/schema` subpath.
 */
import { Clock, Context, Crypto, Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity
} from "effect/unstable/httpapi"
import { SESSION_COOKIE_NAME } from "./cookie.ts"
import type { AuthStorage } from "./storage.ts"
import type { Hasher } from "./hashing.ts"
import type { UserId } from "./types.ts"

export { SESSION_COOKIE_NAME }

// -----------------------------------------------------------------------------
// CurrentUser
// -----------------------------------------------------------------------------

/** The authenticated user, provided to handlers behind the session middleware. */
export class CurrentUser extends Context.Service<CurrentUser, {
  readonly id: UserId
  readonly email: string
  readonly emailVerified: boolean
}>()("app/auth/CurrentUser") {}

// -----------------------------------------------------------------------------
// Session middleware
// -----------------------------------------------------------------------------

/** The `HttpApiSecurity.apiKey` reading the session token from its cookie. */
export const sessionCookieSecurity: HttpApiSecurity.ApiKey = HttpApiSecurity.apiKey({
  in: "cookie",
  key: SESSION_COOKIE_NAME
})

/**
 * Attach to an endpoint, group, or API to require a valid session. The handler
 * validates the presented token and provides `CurrentUser`; missing, invalid,
 * or expired sessions fail with a `401 Unauthorized`. A token that was rotated
 * by sliding-expiry refresh is re-issued on the response.
 */
export class SessionMiddleware extends HttpApiMiddleware.Service<SessionMiddleware, {
  readonly requires: AuthStorage | Hasher | Clock.Clock | Crypto.Crypto
  readonly provides: CurrentUser
}>()("app/auth/SessionMiddleware", {
  error: HttpApiError.Unauthorized,
  security: { sessionCookie: sessionCookieSecurity }
}) {}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

export const User = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean
})

export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {}, { httpApiStatus: 429 }) {}

export class InvalidEmailCode extends Schema.TaggedError<InvalidEmailCode>()("InvalidEmailCode", {
  reason: Schema.String
}, { httpApiStatus: 400 }) {}

export class OAuthFailed extends Schema.TaggedError<OAuthFailed>()("OAuthFailed", {
  reason: Schema.String
}, { httpApiStatus: 400 }) {}

// -----------------------------------------------------------------------------
// Auth endpoint group
// -----------------------------------------------------------------------------

const AuthGroup = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.post("emailCode", "/auth/email-code", {
    payload: Schema.Struct({ email: Schema.String }),
    success: Schema.Struct({
      signInSessionId: Schema.String,
      email: Schema.String
    }),
    error: RateLimited
  }),
  HttpApiEndpoint.post("emailCodeVerify", "/auth/email-code/verify", {
    payload: Schema.Struct({
      signInSessionId: Schema.String,
      code: Schema.String
    }),
    success: Schema.Struct({ user: User }),
    error: [InvalidEmailCode, RateLimited]
  }),
  HttpApiEndpoint.get("oauthStart", "/auth/oauth/:provider/start", {
    params: Schema.Struct({ provider: Schema.String }),
    success: Schema.Struct({ authorizationUrl: Schema.String, state: Schema.String }),
    error: [HttpApiError.NotFound, OAuthFailed]
  }),
  HttpApiEndpoint.get("oauthCallback", "/auth/oauth/:provider/callback", {
    params: Schema.Struct({ provider: Schema.String }),
    query: Schema.Struct({ code: Schema.String, state: Schema.String }),
    success: Schema.Struct({ user: User }),
    error: [HttpApiError.NotFound, HttpApiError.Conflict, OAuthFailed]
  }),
  HttpApiEndpoint.post("signout", "/auth/signout", {
    success: Schema.Struct({ ok: Schema.Boolean })
  }),
  HttpApiEndpoint.get("me", "/auth/me", {
    success: User
  }).middleware(SessionMiddleware),
  HttpApiEndpoint.make("DELETE")("deleteMe", "/auth/me", {
    success: Schema.Struct({ ok: Schema.Boolean }),
    error: HttpApiError.Forbidden
  }).middleware(SessionMiddleware)
)

export const AuthApi = HttpApi.make("AuthApi").add(AuthGroup)