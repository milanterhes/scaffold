import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { OAuth2Provider, ProtocolError } from "../protocol.ts"
import type { ProviderIdentity } from "./identity.ts"

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
export const GITHUB_PROFILE_URL = "https://api.github.com/user"
export const GITHUB_EMAILS_URL = "https://api.github.com/user/emails"
/**
 * `read:user` exposes the public profile on `/user`; `user:email` additionally
 * grants access to `/user/emails`, from which the primary verified email is
 * resolved (the `email` field on `/user` is frequently `null`).
 */
export const GITHUB_SCOPES = ["read:user", "user:email"] as const

export interface GitHubConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  /**
   * `User-Agent` for GitHub API requests. GitHub rejects requests without one.
   * Defaults to the library's user agent when omitted; set it to your app's
   * name so GitHub can identify your integration.
   */
  readonly userAgent?: string
}

/**
 * GitHub is the OAuth2-only case: fixed endpoints, no discovery document, no
 * `id_token` — nothing cryptographic to verify, identity comes from the API
 * over TLS. PKCE (S256) is used; GitHub has supported it since July 2025.
 *
 * Integration note: GitHub's token endpoint only returns JSON when the request
 * carries `Accept: application/json`; the protocol engine decodes a JSON token
 * response, so the wired `HttpClient` must add that header for real traffic.
 */
export const githubProvider = (config: GitHubConfig): OAuth2Provider => ({
  kind: "oauth2",
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  scopes: [...GITHUB_SCOPES],
  redirectUri: config.redirectUri,
  authorizationEndpoint: GITHUB_AUTHORIZE_URL,
  tokenEndpoint: GITHUB_TOKEN_URL,
  profileEndpoint: GITHUB_PROFILE_URL,
  ...(config.userAgent !== undefined ? { userAgent: config.userAgent } : {})
})

const GitHubProfileSchema = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  login: Schema.String,
  email: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String))
})

const GitHubEmailSchema = Schema.Struct({
  email: Schema.String,
  primary: Schema.Boolean,
  verified: Schema.Boolean
})

type GitHubEmail = Schema.Schema.Type<typeof GitHubEmailSchema>

const GitHubEmailsSchema = Schema.Array(GitHubEmailSchema)

const fetchEmails = (
  http: HttpClient.HttpClient,
  accessToken: string,
  userAgent: string
): Effect.Effect<ReadonlyArray<GitHubEmail>, ProtocolError> =>
  Effect.gen(function*() {
    const response = yield* http.execute(
      HttpClientRequest.get(GITHUB_EMAILS_URL).pipe(
        HttpClientRequest.bearerToken(accessToken),
        HttpClientRequest.setHeader("User-Agent", userAgent)
      )
    ).pipe(
      Effect.mapError(() => ({ _tag: "InvalidProfileResponse" as const, message: "email list request failed" }))
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail<ProtocolError>({
        _tag: "InvalidProfileResponse",
        message: `email list HTTP ${response.status}`
      })
    }
    const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
      Effect.mapError(() => ({ _tag: "InvalidProfileResponse" as const, message: "malformed email list body" }))
    )
    const emails = yield* Schema.decodeUnknownEffect(GitHubEmailsSchema)(body).pipe(
      Effect.mapError(() => ({ _tag: "InvalidProfileResponse" as const, message: "malformed email list" }))
    )
    return emails
  })

/**
 * Derives the canonical identity from the `/user` profile (returned by the
 * engine's OAuth2 path) plus a follow-up `/user/emails` fetch. The `email`
 * field on `/user` is frequently `null` (GitHub only fills it when a public
 * email is set), so the primary verified email is resolved from `/user/emails`
 * when the `user:email` scope is granted. A missing email never breaks the
 * flow — it resolves to `null`. A GitHub public profile email is always a
 * verified one, so the verified flag is also set for that fallback.
 */
export const githubIdentity = (
  profile: unknown,
  accessToken: string,
  userAgent: string
): Effect.Effect<ProviderIdentity, ProtocolError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const user = yield* Schema.decodeUnknownEffect(GitHubProfileSchema)(profile).pipe(
      Effect.mapError(() => ({ _tag: "InvalidProfileResponse" as const, message: "malformed GitHub profile" }))
    )
    const emails = yield* fetchEmails(http, accessToken, userAgent)
    const primaryVerified = emails.find((entry) => entry.primary === true && entry.verified === true)
    const email = primaryVerified?.email ?? user.email ?? null
    return {
      provider: "github",
      providerAccountId: String(user.id),
      email,
      emailVerified: primaryVerified !== undefined || email !== null,
      name: user.name ?? null,
      picture: user.avatar_url ?? null
    }
  })