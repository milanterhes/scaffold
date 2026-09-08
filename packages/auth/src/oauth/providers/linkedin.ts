import type { IdTokenClaims } from "../../jwt.ts"
import type { OidcProvider } from "../protocol.ts"
import type { ProviderIdentity } from "./identity.ts"

/**
 * Provisioning gotchas for whoever wires the real provider (documented here,
 * deliberately NOT encoded as logic):
 * - The "Sign in with LinkedIn using OpenID Connect" product must be requested
 *   in the LinkedIn developer portal before these endpoints start responding.
 * - Redirect URIs validate to the trailing slash: register
 *   `https://app.example.com/callback/` and mirror it exactly in `redirectUri`.
 * - LinkedIn test logins burn a 500/day/member rate limit — do not run e2e
 *   suites against the real portal.
 */
export const LINKEDIN_DISCOVERY_URL = "https://www.linkedin.com/oauth/.well-known/openid-configuration"
/** Stable OIDC issuer LinkedIn's discovery document advertises. */
export const LINKEDIN_ISSUER = "https://www.linkedin.com"
/** Reference to LinkedIn's userinfo endpoint (name/picture also arrive in the `id_token`). */
export const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo"
export const LINKEDIN_SCOPES = ["openid", "profile", "email"] as const
/**
 * LinkedIn's discovery document advertises
 * `id_token_signing_alg_values_supported = ["RS256"]`; pin exactly that.
 */
export const LINKEDIN_ALGORITHMS = ["RS256"] as const

export interface LinkedInConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
}

/**
 * Name, picture, and (when granted) email all arrive as `id_token` claims, so
 * no userinfo round-trip is required — `fetchUserInfo` stays off.
 */
export const linkedinProvider = (config: LinkedInConfig): OidcProvider => ({
  kind: "oidc",
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  scopes: [...LINKEDIN_SCOPES],
  redirectUri: config.redirectUri,
  discoveryUrl: LINKEDIN_DISCOVERY_URL,
  algorithms: [...LINKEDIN_ALGORITHMS],
  fetchUserInfo: false
})

/**
 * Maps the verified `id_token` claims to the canonical identity shape. Email is
 * OPTIONAL on LinkedIn: `email` / `email_verified` may be absent even after a
 * successful login (the member never granted the email scope, or LinkedIn does
 * not expose it). The derivation never hard-fails on that — it resolves to
 * `null` and the caller (account linking, ticket 09) decides what to do when
 * there is no email. `sub` and `name` are always present with the `profile`
 * scope, so a subject + name profile always resolves.
 */
export const linkedinIdentity = (claims: IdTokenClaims): ProviderIdentity => ({
  provider: "linkedin",
  providerAccountId: claims.sub,
  email: claims.email ?? null,
  emailVerified: claims.email_verified === true,
  name: claims.name ?? null,
  picture: claims.picture ?? null
})