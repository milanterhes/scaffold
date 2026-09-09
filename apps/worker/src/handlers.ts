import { Effect } from "effect"
import type { Job } from "@app/jobs"
import { JobRegistry } from "@app/jobs/server"
import type { JobHandler } from "@app/jobs/server"

/**
 * `notification.deliver` writes an inbox row from a `document.uploaded` outbox
 * event. The real handler ships with `@app/notifications` (ticket 02, built in
 * parallel and not yet merged into this worktree).
 *
 * When 02 lands, the ONLY change here is the import and the registered value:
 *
 *   import { notificationDeliverHandler } from "@app/notifications/server"
 *   registry.register("notification.deliver", notificationDeliverHandler)
 *
 * Until then, a stub fails the job so the retry/backoff/dead-letter path runs
 * instead of silently dropping the notification.
 */
const stubDeliverHandler: JobHandler = (_job: Job) =>
  Effect.fail(new Error(
    `notification.deliver: handler unavailable until @app/notifications (ticket 02) merges`
  ))

/** Register every job handler the worker process serves. */
export const registerHandlers = (registry: JobRegistry["Service"]): void => {
  registry.register("notification.deliver", stubDeliverHandler)
}