/**
 * The canonical identity a provider resolves to after a successful login. The
 * account-linking consumer (ticket 09) consumes this contract:
 * `providerAccountId` is the stable external subject key (`sub` / GitHub `id`),
 * `email` + `emailVerified` feed the user record, and `name`/`picture` are
 * display metadata. `email` is `null` whenever the provider did not expose it
 * (e.g. LinkedIn without the email scope, or GitHub without a public email) —
 * a login must never hard-fail on that.
 */
export type ProviderKind = "google" | "linkedin" | "github"

export interface ProviderIdentity {
  readonly provider: ProviderKind
  readonly providerAccountId: string
  readonly email: string | null
  readonly emailVerified: boolean
  readonly name: string | null
  readonly picture: string | null
}