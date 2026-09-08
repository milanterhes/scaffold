import { Crypto, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { timingSafeEqual } from "node:crypto"
import { IdTokenVerifier } from "../jwt.ts"
import type { IdTokenClaims, IdTokenVerificationError } from "../jwt.ts"

/**
 * An OIDC provider (Google, LinkedIn): discovery-driven, so the engine learns
 * the endpoints from the discovery document and verifies the `id_token`
 * against the advertised JWKS. `audience` is always the provider `clientId`.
 */
export interface OidcProvider {
  readonly kind: "oidc"
  readonly clientId: string
  readonly clientSecret: string
  readonly scopes: ReadonlyArray<string>
  readonly redirectUri: string
  readonly discoveryUrl: string
  readonly algorithms: ReadonlyArray<string>
  readonly fetchUserInfo?: boolean
}

/**
 * An OAuth2-only provider (GitHub): fixed endpoints, no `id_token`, profile
 * fetched from a provider API instead.
 */
export interface OAuth2Provider {
  readonly kind: "oauth2"
  readonly clientId: string
  readonly clientSecret: string
  readonly scopes: ReadonlyArray<string>
  readonly redirectUri: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly profileEndpoint: string
  readonly userAgent?: string
}

export type OAuthProvider = OidcProvider | OAuth2Provider

export type ProtocolError =
  | { readonly _tag: "DiscoveryFailed"; readonly message: string }
  | { readonly _tag: "TokenExchangeFailed"; readonly message: string }
  | { readonly _tag: "InvalidTokenResponse"; readonly message: string }
  | { readonly _tag: "InvalidIdToken"; readonly reason: IdTokenVerificationError }
  | { readonly _tag: "InvalidProfileResponse"; readonly message: string }
  | { readonly _tag: "StateMismatch" }

export interface PkcePair {
  readonly verifier: string
  readonly challenge: string
}

export interface CreateAuthorizationURLOptions {
  readonly state: string
  readonly codeChallenge: string
  readonly nonce?: string
}

export interface ValidateAuthorizationCodeOptions {
  readonly verifier: string
  readonly state: string
  readonly receivedState: string
  readonly nonce?: string
}

export interface OAuthTokens {
  readonly accessToken: string
  readonly tokenType?: string
  readonly refreshToken?: string
  readonly expiresIn?: number
  readonly scope?: string
}

export type ValidateAuthorizationCodeResult =
  | {
      readonly kind: "oidc"
      readonly tokens: OAuthTokens
      readonly idToken: string
      readonly claims: IdTokenClaims
      readonly userinfo?: unknown
    }
  | {
      readonly kind: "oauth2"
      readonly tokens: OAuthTokens
      readonly profile: unknown
    }

const PKCE_VERIFIER_BYTES = 32
const STATE_BYTES = 32

/**
 * Default `User-Agent` for profile/userinfo requests. Some providers (GitHub)
 * reject requests without one; the value names the client library so a
 * consumer does not have to, and can override it via the provider config.
 */
export const DEFAULT_OAUTH_USER_AGENT = "@app/auth"

const randomBase64Url = (crypto: Crypto.Crypto, size: number): Effect.Effect<string> =>
  Effect.gen(function*() {
    const bytes = yield* crypto.randomBytes(size).pipe(Effect.orDie)
    return Buffer.from(bytes).toString("base64url")
  })

export const generatePkce = (): Effect.Effect<PkcePair, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    const verifier = yield* randomBase64Url(crypto, PKCE_VERIFIER_BYTES)
    const challengeBytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(Effect.orDie)
    const challenge = Buffer.from(challengeBytes).toString("base64url")
    return { verifier, challenge }
  })

export const generateState = (): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    return yield* randomBase64Url(crypto, STATE_BYTES)
  })

export const generateNonce = (): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    return yield* randomBase64Url(crypto, STATE_BYTES)
  })

const safeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a, "utf8")
  const bBuf = Buffer.from(b, "utf8")
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf)
}

const OidcDiscoverySchema = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  jwks_uri: Schema.String,
  userinfo_endpoint: Schema.optionalKey(Schema.String)
})

type OidcDiscovery = Schema.Schema.Type<typeof OidcDiscoverySchema>

const resolveOidcMetadata = (
  http: HttpClient.HttpClient,
  discoveryUrl: string
): Effect.Effect<OidcDiscovery, ProtocolError> =>
  Effect.gen(function*() {
    const response = yield* http.execute(HttpClientRequest.get(discoveryUrl).pipe(HttpClientRequest.acceptJson)).pipe(
      Effect.mapError(() => ({ _tag: "DiscoveryFailed" as const, message: "discovery request failed" }))
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail<ProtocolError>({ _tag: "DiscoveryFailed", message: `discovery HTTP ${response.status}` })
    }
    const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
      Effect.mapError(() => ({ _tag: "DiscoveryFailed" as const, message: "unreadable discovery body" }))
    )
    const decoded = yield* Schema.decodeUnknownEffect(OidcDiscoverySchema)(body).pipe(
      Effect.mapError(() => ({ _tag: "DiscoveryFailed" as const, message: "malformed discovery document" }))
    )
    return decoded
  })

const resolveAuthorizationEndpoint = (
  provider: OAuthProvider
): Effect.Effect<string, ProtocolError, HttpClient.HttpClient> =>
  provider.kind === "oidc"
    ? Effect.gen(function*() {
        const http = yield* HttpClient.HttpClient
        const metadata = yield* resolveOidcMetadata(http, provider.discoveryUrl)
        return metadata.authorization_endpoint
      })
    : Effect.succeed(provider.authorizationEndpoint)

export const createAuthorizationURL = (
  provider: OAuthProvider,
  options: CreateAuthorizationURLOptions
): Effect.Effect<URL, ProtocolError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const authorizationEndpoint = yield* resolveAuthorizationEndpoint(provider)
    const url = new URL(authorizationEndpoint)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("client_id", provider.clientId)
    url.searchParams.set("redirect_uri", provider.redirectUri)
    url.searchParams.set("scope", provider.scopes.join(" "))
    url.searchParams.set("state", options.state)
    url.searchParams.set("code_challenge", options.codeChallenge)
    url.searchParams.set("code_challenge_method", "S256")
    if (options.nonce !== undefined) url.searchParams.set("nonce", options.nonce)
    return url
  })

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String)
})

type TokenResponse = Schema.Schema.Type<typeof TokenResponseSchema>

const toTokens = (response: TokenResponse): OAuthTokens => ({
  accessToken: response.access_token,
  ...(response.token_type !== undefined ? { tokenType: response.token_type } : {}),
  ...(response.refresh_token !== undefined ? { refreshToken: response.refresh_token } : {}),
  ...(response.expires_in !== undefined ? { expiresIn: response.expires_in } : {}),
  ...(response.scope !== undefined ? { scope: response.scope } : {})
})

const exchangeCode = (
  provider: OAuthProvider,
  tokenEndpoint: string,
  code: string,
  options: ValidateAuthorizationCodeOptions
): Effect.Effect<TokenResponse, ProtocolError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(tokenEndpoint).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyUrlParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: provider.redirectUri,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: options.verifier
      })
    )
    const response = yield* http.execute(request).pipe(
      Effect.mapError(() => ({ _tag: "TokenExchangeFailed" as const, message: "token request failed" }))
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail<ProtocolError>({
        _tag: "TokenExchangeFailed",
        message: `token endpoint HTTP ${response.status}`
      })
    }
    const body = yield* HttpClientResponse.schemaBodyJson(TokenResponseSchema)(response).pipe(
      Effect.mapError(() => ({ _tag: "InvalidTokenResponse" as const, message: "malformed token response" }))
    )
    return body
  })

const readResponseBody = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<string, never> =>
  Effect.gen(function*() {
    const text = yield* response.text.pipe(Effect.mapError(() => new Error("unreadable body")), Effect.option)
    if (Option.isNone(text)) return ""
    const bodyText = text.value.trim()
    if (bodyText === "") return ""
    try {
      const body: unknown = JSON.parse(bodyText)
      if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
        return body.message
      }
      return bodyText
    } catch {
      return bodyText
    }
  })

const fetchWithBearerToken = (
  http: HttpClient.HttpClient,
  endpoint: string,
  accessToken: string,
  userAgent: string = DEFAULT_OAUTH_USER_AGENT
): Effect.Effect<unknown, ProtocolError> =>
  Effect.gen(function*() {
    const response = yield* http.execute(
      HttpClientRequest.get(endpoint).pipe(
        HttpClientRequest.bearerToken(accessToken),
        HttpClientRequest.setHeader("User-Agent", userAgent)
      )
    ).pipe(
      Effect.mapError(() => ({ _tag: "InvalidProfileResponse" as const, message: "profile request failed" }))
    )
    if (response.status < 200 || response.status >= 300) {
      const detail = yield* readResponseBody(response)
      return yield* Effect.fail<ProtocolError>({
        _tag: "InvalidProfileResponse",
        message: `profile HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`
      })
    }
    const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
      Effect.mapError(() => ({ _tag: "InvalidProfileResponse" as const, message: "malformed profile body" }))
    )
    return body
  })

const validateOidcCode = (
  provider: OidcProvider,
  code: string,
  options: ValidateAuthorizationCodeOptions
): Effect.Effect<
  Extract<ValidateAuthorizationCodeResult, { readonly kind: "oidc" }>,
  ProtocolError,
  HttpClient.HttpClient | IdTokenVerifier
> =>
  Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const metadata = yield* resolveOidcMetadata(http, provider.discoveryUrl)
    const tokens = yield* exchangeCode(provider, metadata.token_endpoint, code, options)
    const idToken = tokens.id_token
    if (idToken === undefined) {
      return yield* Effect.fail<ProtocolError>({ _tag: "InvalidTokenResponse", message: "token response missing id_token" })
    }
    const verifier = yield* IdTokenVerifier
    const claims = yield* verifier.verifyIdToken(
      {
        jwksUri: metadata.jwks_uri,
        issuer: metadata.issuer,
        audience: provider.clientId,
        algorithms: provider.algorithms,
        ...(options.nonce !== undefined ? { nonce: options.nonce } : {})
      },
      idToken
    ).pipe(Effect.mapError((reason) => ({ _tag: "InvalidIdToken" as const, reason })))
    let userinfo: unknown
    if (provider.fetchUserInfo === true && metadata.userinfo_endpoint !== undefined) {
      userinfo = yield* fetchWithBearerToken(http, metadata.userinfo_endpoint, tokens.access_token)
    }
    return {
      kind: "oidc",
      tokens: toTokens(tokens),
      idToken,
      claims,
      ...(userinfo !== undefined ? { userinfo } : {})
    }
  })

const validateOAuth2Code = (
  provider: OAuth2Provider,
  code: string,
  options: ValidateAuthorizationCodeOptions
): Effect.Effect<
  Extract<ValidateAuthorizationCodeResult, { readonly kind: "oauth2" }>,
  ProtocolError,
  HttpClient.HttpClient
> =>
  Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const tokens = yield* exchangeCode(provider, provider.tokenEndpoint, code, options)
    const profile = yield* fetchWithBearerToken(http, provider.profileEndpoint, tokens.access_token, provider.userAgent)
    return { kind: "oauth2", tokens: toTokens(tokens), profile }
  })

export const validateAuthorizationCode = (
  provider: OAuthProvider,
  code: string,
  options: ValidateAuthorizationCodeOptions
): Effect.Effect<ValidateAuthorizationCodeResult, ProtocolError, HttpClient.HttpClient | IdTokenVerifier> => {
  if (!safeEqual(options.receivedState, options.state)) {
    return Effect.fail<ProtocolError>({ _tag: "StateMismatch" })
  }
  return provider.kind === "oidc"
    ? validateOidcCode(provider, code, options)
    : validateOAuth2Code(provider, code, options)
}