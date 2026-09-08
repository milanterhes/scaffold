/**
 * The optional Effect `HttpApi` surface: a session middleware plus an auth
 * endpoint group that an app attaches to its own `HttpApi`. Importing the
 * package core never pulls this module in — it is reachable only through the
 * optional `@app/auth/httpapi` export path.
 *
 * The pure contract (`AuthApi`, schemas, `SessionMiddleware` class) lives in
 * `./api.ts` so a client bundle can import it without the node-only modules
 * below; this module re-exports it and adds the server-side implementations.
 */
import { Clock, Config, Context, Crypto, Duration, Effect, Layer, Option, Redacted } from "effect"
import { HttpClient } from "effect/unstable/http"
import { HttpServerResponse } from "effect/unstable/http"
import {
  HttpApiBuilder,
  HttpApiError
} from "effect/unstable/httpapi"
import { requestEmailCode, verifyEmailCode } from "./email-code.ts"
import type { RequestEmailCodeError, VerifyEmailCodeError } from "./email-code.ts"
import { invalidateSession, validateSession } from "./session.ts"
import { deleteAuthenticatedUser } from "./privacy.ts"
import type { PrivacyError } from "./privacy.ts"
import { linkWithProvider } from "./linking.ts"
import type { LinkingError } from "./linking.ts"
import { AuthStorage } from "./storage.ts"
import { Hasher } from "./hashing.ts"
import {
  createAuthorizationURL,
  generateNonce,
  generatePkce,
  generateState,
  validateAuthorizationCode,
  DEFAULT_OAUTH_USER_AGENT
} from "./oauth/protocol.ts"
import type { OAuth2Provider, OAuthProvider, OidcProvider, ProtocolError, ValidateAuthorizationCodeResult } from "./oauth/protocol.ts"
import { googleIdentity, googleProvider } from "./oauth/providers/google.ts"
import { linkedinIdentity, linkedinProvider } from "./oauth/providers/linkedin.ts"
import { githubIdentity, githubProvider } from "./oauth/providers/github.ts"
import type { ProviderIdentity } from "./oauth/providers/identity.ts"
import type { IdTokenClaims } from "./jwt.ts"
import {
  SESSION_COOKIE_NAME,
  CurrentUser,
  SessionMiddleware,
  sessionCookieSecurity,
  RateLimited,
  InvalidEmailCode,
  OAuthFailed,
  AuthApi
} from "./api.ts"

export * from "./api.ts"

const fromNullable = <A>(value: A | null | undefined): Option.Option<A> =>
  value === null || value === undefined ? Option.none() : Option.some(value)

// -----------------------------------------------------------------------------
// Session middleware
// -----------------------------------------------------------------------------

export const SessionMiddlewareLive: Layer.Layer<
  SessionMiddleware,
  never,
  AuthStorage | Hasher | Clock.Clock | Crypto.Crypto
> = Layer.succeed(
  SessionMiddleware,
  {
    sessionCookie: (httpEffect, options) =>
      Effect.gen(function*() {
        const token = Redacted.value(options.credential)
        const valid = yield* validateSession(token).pipe(
          Effect.mapError(() => new HttpApiError.Unauthorized({}))
        )
        const currentUser = {
          id: valid.user.id,
          email: valid.user.email,
          emailVerified: valid.user.emailVerified
        }
        const handler = Effect.provideService(httpEffect, CurrentUser, currentUser)
        const rotated = valid.token
        if (rotated === undefined) {
          return yield* handler
        }
        return yield* Effect.flatMap(handler, (response) =>
          HttpApiBuilder.securitySetCookie(sessionCookieSecurity, rotated, { path: "/" }).pipe(Effect.as(response))
        )
      })
  }
)

// -----------------------------------------------------------------------------
// OAuth pending state + provider registry
// -----------------------------------------------------------------------------

/** A state awaiting its authorization-code callback. */
export interface OAuthPending {
  readonly state: string
  readonly provider: string
  readonly verifier: string
  readonly nonce?: string
}

/**
 * Keyed by the `state` issued in the authorization URL. The in-memory
 * implementation is adequate for a single process; ticket 14 will harden this
 * (cookie- or storage-backed persistence, real redirect URIs, provider client
 * config via `Config`).
 */
export class OAuthPendingStore extends Context.Service<OAuthPendingStore, {
  readonly set: (state: string, pending: OAuthPending) => Effect.Effect<void>
  readonly get: (state: string) => Effect.Effect<Option.Option<OAuthPending>>
  readonly delete: (state: string) => Effect.Effect<void>
}>()("app/auth/OAuthPendingStore") {}

export const OAuthPendingStoreLive: Layer.Layer<OAuthPendingStore> = Layer.effect(
  OAuthPendingStore,
  Effect.gen(function*() {
    const pending = new Map<string, OAuthPending>()
    return OAuthPendingStore.of({
      set: (state, value) =>
        Effect.sync(() => {
          pending.set(state, value)
        }),
      get: (state) => Effect.sync(() => fromNullable(pending.get(state))),
      delete: (state) =>
        Effect.sync(() => {
          pending.delete(state)
        })
    })
  })
)

/** A registered provider: its protocol config plus how to derive identity. */
export interface OAuthProviderRegistration {
  readonly config: OAuthProvider
  readonly identity: (
    result: ValidateAuthorizationCodeResult
  ) => Effect.Effect<ProviderIdentity, ProtocolError, HttpClient.HttpClient>
}

export const oidcProviderRegistration = (
  config: OidcProvider,
  identity: (claims: IdTokenClaims) => ProviderIdentity
): OAuthProviderRegistration => ({
  config,
  identity: (result) =>
    result.kind === "oidc"
      ? Effect.succeed(identity(result.claims))
      : Effect.fail<ProtocolError>({
          _tag: "InvalidIdToken",
          reason: { _tag: "MalformedToken", message: "expected an OIDC result" }
        })
})

export const oauth2ProviderRegistration = (
  config: OAuth2Provider,
  identity: (
    profile: unknown,
    accessToken: string,
    userAgent: string
  ) => Effect.Effect<ProviderIdentity, ProtocolError, HttpClient.HttpClient>
): OAuthProviderRegistration => ({
  config,
  identity: (result) =>
    result.kind === "oauth2"
      ? identity(result.profile, result.tokens.accessToken, config.userAgent ?? DEFAULT_OAUTH_USER_AGENT)
      : Effect.fail<ProtocolError>({
          _tag: "InvalidProfileResponse",
          message: "expected an OAuth2 result"
        })
})

/**
 * Maps a provider name to its registration. The live layer reads provider
 * client config from the environment (`GOOGLE_*`, `LINKEDIN_*`, `GITHUB_*`);
 * ticket 14 will wire real redirect URIs and hardened config.
 */
export class OAuthProviderRegistry extends Context.Service<OAuthProviderRegistry, {
  readonly get: (provider: string) => Effect.Effect<Option.Option<OAuthProviderRegistration>>
}>()("app/auth/OAuthProviderRegistry") {}

const providerEnvConfig = (prefix: string): Config.Config<{
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
}> =>
  Config.all({
    clientId: Config.string(`${prefix}_CLIENT_ID`),
    clientSecret: Config.string(`${prefix}_CLIENT_SECRET`),
    redirectUri: Config.string(`${prefix}_REDIRECT_URI`)
  })

const readProviderConfig = (prefix: string): Config.Config<Option.Option<{
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
}>> =>
  Config.option(providerEnvConfig(prefix)).pipe(
    Config.orElse(() => Config.succeed(Option.none()))
  )

export const OAuthProviderRegistryLive: Layer.Layer<OAuthProviderRegistry> = Layer.effect(
  OAuthProviderRegistry,
  Effect.gen(function*() {
    const registrations = new Map<string, OAuthProviderRegistration>()

    const google = yield* readProviderConfig("GOOGLE")
    if (Option.isSome(google)) {
      registrations.set("google", oidcProviderRegistration(googleProvider(google.value), googleIdentity))
    }

    const linkedin = yield* readProviderConfig("LINKEDIN")
    if (Option.isSome(linkedin)) {
      registrations.set("linkedin", oidcProviderRegistration(linkedinProvider(linkedin.value), linkedinIdentity))
    }

    const github = yield* readProviderConfig("GITHUB")
    if (Option.isSome(github)) {
      const userAgent = yield* Config.option(Config.string("GITHUB_USER_AGENT")).pipe(
        Config.orElse(() => Config.succeed(Option.none()))
      )
      const provider = githubProvider({
        ...github.value,
        ...(Option.isSome(userAgent) ? { userAgent: userAgent.value } : {})
      })
      registrations.set("github", oauth2ProviderRegistration(provider, githubIdentity))
    }

    return OAuthProviderRegistry.of({
      get: (provider) => Effect.sync(() => fromNullable(registrations.get(provider)))
    })
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        OAuthProviderRegistry.of({
          get: () => Effect.succeed(Option.none())
        })
      )
    )
  )
)

// -----------------------------------------------------------------------------
// Auth endpoint group
// -----------------------------------------------------------------------------

const mapRequestEmailCodeError = (_error: RequestEmailCodeError): RateLimited =>
  new RateLimited({})

const mapVerifyEmailCodeError = (error: VerifyEmailCodeError): InvalidEmailCode | RateLimited =>
  error._tag === "RateLimited"
    ? new RateLimited({})
    : new InvalidEmailCode({ reason: error._tag })

const mapProtocolError = (error: ProtocolError): OAuthFailed =>
  new OAuthFailed({ reason: error._tag === "InvalidIdToken"
    ? `${error._tag}: ${error.reason}`
    : error._tag === "StateMismatch"
      ? error._tag
      : `${error._tag}: ${error.message}` })

const mapLinkingError = (_error: LinkingError): HttpApiError.Conflict =>
  new HttpApiError.Conflict({})

const mapPrivacyError = (error: PrivacyError): HttpApiError.Unauthorized | HttpApiError.Forbidden =>
  error._tag === "Unauthenticated"
    ? new HttpApiError.Unauthorized({})
    : new HttpApiError.Forbidden({})

export const AuthImpl = HttpApiBuilder.group(AuthApi, "auth", (handlers) =>
  handlers
    .handle("emailCode", ({ payload }) =>
      Effect.gen(function*() {
        const result = yield* requestEmailCode(payload.email).pipe(
          Effect.mapError(mapRequestEmailCodeError)
        )
        return { signInSessionId: result.id, email: result.email }
      })
    )
    .handle("emailCodeVerify", ({ payload }) =>
      Effect.gen(function*() {
        const result = yield* verifyEmailCode(payload.signInSessionId, payload.code).pipe(
          Effect.mapError(mapVerifyEmailCodeError)
        )
        yield* HttpApiBuilder.securitySetCookie(sessionCookieSecurity, result.token, { path: "/" })
        return { user: result.user }
      })
    )
    .handle("oauthStart", ({ params }) =>
      Effect.gen(function*() {
        const registry = yield* OAuthProviderRegistry
        const registration = yield* registry.get(params.provider)
        if (Option.isNone(registration)) {
          return yield* new HttpApiError.NotFound({})
        }
        const state = yield* generateState()
        const pkce = yield* generatePkce()
        const nonce = registration.value.config.kind === "oidc" ? yield* generateNonce() : undefined
        const store = yield* OAuthPendingStore
        yield* store.set(state, {
          state,
          provider: params.provider,
          verifier: pkce.verifier,
          ...(nonce !== undefined ? { nonce } : {})
        })
        const url = yield* createAuthorizationURL(registration.value.config, {
          state,
          codeChallenge: pkce.challenge,
          ...(nonce !== undefined ? { nonce } : {})
        }).pipe(Effect.mapError(mapProtocolError))
        return { authorizationUrl: url.toString(), state }
      })
    )
    .handle("oauthCallback", ({ params, query }) =>
      Effect.gen(function*() {
        const registry = yield* OAuthProviderRegistry
        const registration = yield* registry.get(params.provider)
        if (Option.isNone(registration)) {
          return yield* new HttpApiError.NotFound({})
        }
        const store = yield* OAuthPendingStore
        const pending = yield* store.get(query.state)
        if (Option.isNone(pending) || pending.value.provider !== params.provider) {
          return yield* new OAuthFailed({ reason: "unknown or mismatched state" })
        }
        const result = yield* validateAuthorizationCode(registration.value.config, query.code, {
          verifier: pending.value.verifier,
          state: pending.value.state,
          receivedState: query.state,
          ...(pending.value.nonce !== undefined ? { nonce: pending.value.nonce } : {})
        }).pipe(Effect.mapError(mapProtocolError))
        yield* store.delete(query.state)
        const identity = yield* registration.value.identity(result).pipe(
          Effect.mapError(mapProtocolError)
        )
        const linked = yield* linkWithProvider(identity).pipe(Effect.mapError(mapLinkingError))
        yield* HttpApiBuilder.securitySetCookie(sessionCookieSecurity, linked.token, { path: "/" })
        return HttpServerResponse.redirect("/")
      })
    )
    .handle("signout", ({ request }) =>
      Effect.gen(function*() {
        const token = request.cookies[SESSION_COOKIE_NAME]
        if (token !== undefined) {
          yield* invalidateSession(token)
        }
        yield* HttpApiBuilder.securitySetCookie(sessionCookieSecurity, "", { path: "/", maxAge: Duration.seconds(0) })
        return { ok: true }
      })
    )
    .handle("me", () =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        return { id: user.id, email: user.email, emailVerified: user.emailVerified }
      })
    )
    .handle("deleteMe", () =>
      Effect.gen(function*() {
        const user = yield* CurrentUser
        yield* deleteAuthenticatedUser(Option.some(user.id), user.id).pipe(
          Effect.mapError(mapPrivacyError)
        )
        yield* HttpApiBuilder.securitySetCookie(sessionCookieSecurity, "", { path: "/", maxAge: Duration.seconds(0) })
        return { ok: true }
      })
    )
)