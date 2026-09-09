import { Context, Effect, Layer, Option } from "effect"
import { Job } from "./db/models.ts"

/**
 * A job handler: runs a single job of a given type. Success means the job
 * completed; a failure is recorded against the job via `failJob`. Requirements
 * are `any` so a handler can depend on whatever the worker process provides.
 */
export type JobHandler = (job: Job) => Effect.Effect<unknown, unknown, any>

/**
 * The job registry: maps `job_type` → handler. Consumers register handlers at
 * process startup; the worker looks handlers up when it claims jobs. Follows
 * the `Storage` seam pattern (`app/documents/Storage`).
 */
export class JobRegistry extends Context.Service<JobRegistry, {
  readonly register: (jobType: string, handler: JobHandler) => void
  readonly get: (jobType: string) => Option.Option<JobHandler>
}>()("app/jobs/JobRegistry") {}

/** The live in-memory registry. */
export const JobRegistryLive: Layer.Layer<JobRegistry, never, never> = Layer.effect(
  JobRegistry,
  Effect.gen(function*() {
    const handlers = new Map<string, JobHandler>()
    return JobRegistry.of({
      register: (jobType, handler) => {
        handlers.set(jobType, handler)
      },
      get: (jobType) => {
        const handler = handlers.get(jobType)
        return handler === undefined ? Option.none() : Option.some(handler)
      }
    })
  })
)