import { Effect, Option } from "effect"
import { AuthStorage } from "./storage.ts"
import type { UserExport, UserId } from "./types.ts"

export type PrivacyError =
  | { readonly _tag: "Unauthenticated" }
  | { readonly _tag: "Forbidden" }

/**
 * Unguarded cascade delete, idempotent for an already-deleted user. The memory
 * and postgres implementations are already idempotent (a missing user is a
 * no-op), so real storage failures surface as errors instead of being masked.
 */
export const deleteUser = (userId: UserId): Effect.Effect<void, never, AuthStorage> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    yield* storage.deleteUser(userId)
  })

/** Everything the auth package holds about a user, or `None` if they never existed. */
export const exportUser = (userId: UserId): Effect.Effect<Option.Option<UserExport>, never, AuthStorage> =>
  Effect.gen(function*() {
    const storage = yield* AuthStorage
    return yield* storage.exportUser(userId)
  })

/**
 * Identity-verification guard for deletion: the caller must be authenticated
 * (a validated session's user id) and that user must be the deletion target.
 * `None` models an unauthenticated context — deletion cannot proceed from one.
 */
export const deleteAuthenticatedUser = (
  authenticatedUserId: Option.Option<UserId>,
  targetUserId: UserId
): Effect.Effect<void, PrivacyError, AuthStorage> => {
  if (Option.isNone(authenticatedUserId)) {
    return Effect.fail<PrivacyError>({ _tag: "Unauthenticated" })
  }
  if (authenticatedUserId.value !== targetUserId) {
    return Effect.fail<PrivacyError>({ _tag: "Forbidden" })
  }
  return deleteUser(targetUserId)
}