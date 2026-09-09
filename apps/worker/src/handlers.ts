import { JobRegistry } from "@app/jobs/server"
import { deliverNotification } from "@app/notifications/server"

/** Register every job handler the worker process serves. */
export const registerHandlers = (registry: JobRegistry["Service"]): void => {
  registry.register("notification.deliver", deliverNotification)
}