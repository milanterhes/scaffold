import { Config, Context, Effect, Layer, Option, Result, Schedule, Schema } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { Job } from "./db/models.ts"
import { claimJobs, completeJob, drainOutbox, failJob } from "./repo/jobs.repo.ts"
import { JobRegistry } from "./registry.ts"

/** How long the worker waits between polls when there is nothing to do. */
const POLL_INTERVAL = Schedule.spaced("5 seconds")

/** How many due jobs a single claim may pick up per poll. */
const CLAIM_LIMIT = 10

/** How many unconsumed outbox events a single drain may turn into jobs per poll. */
const DRAIN_LIMIT = 100

const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * The job worker: a `run()` loop that drains the outbox into jobs, claims due
 * jobs, dispatches each to its registered handler, and completes or fails the
 * job accordingly. Backoff for failed jobs is handled by the database's
 * `run_after` schedule, not by this loop.
 */
export class JobWorker extends Context.Service<JobWorker, {
  readonly run: () => Effect.Effect<void, never, SqlClient.SqlClient | JobRegistry>
}>()("app/jobs/JobWorker") {}

/** The live worker loop, requiring a `SqlClient` and a `JobRegistry`. */
export const JobWorkerLive: Layer.Layer<JobWorker, Config.ConfigError, never> = Layer.effect(
  JobWorker,
  Effect.gen(function*() {
    const workerId = yield* Config.string("JOB_WORKER_ID").pipe(Config.withDefault("worker"))
    const outboxJobType = yield* Config.string("OUTBOX_JOB_TYPE").pipe(Config.withDefault("notification.deliver"))

    const processJob = Effect.fnUntraced(function*(
      job: Job
    ): Effect.fn.Return<void, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient | JobRegistry> {
      const registry = yield* JobRegistry
      const handler = registry.get(job.job_type)
      if (Option.isNone(handler)) {
        yield* failJob(job.id, `no handler registered for job type: ${job.job_type}`)
        return
      }
      const outcome = yield* handler.value(job).pipe(Effect.result)
      if (Result.isSuccess(outcome)) {
        yield* completeJob(job.id)
      } else {
        yield* failJob(job.id, describeFailure(outcome.failure))
      }
    })

    const iteration = Effect.gen(function*(): Effect.gen.Return<
      void,
      SqlError.SqlError | Schema.SchemaError,
      SqlClient.SqlClient | JobRegistry
    > {
      yield* drainOutbox(outboxJobType, DRAIN_LIMIT)
      const jobs = yield* claimJobs(workerId, CLAIM_LIMIT)
      for (const job of jobs) {
        yield* processJob(job)
      }
    })

    const run = iteration.pipe(
      Effect.repeat({ schedule: POLL_INTERVAL }),
      Effect.result,
      Effect.flatMap((outcome) => {
        if (Result.isFailure(outcome)) {
          return Effect.logError(`job worker iteration failed: ${describeFailure(outcome.failure)}`)
        }
        return Effect.void
      })
    )

    return JobWorker.of({ run: () => run })
  })
)