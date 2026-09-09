import { existsSync } from "node:fs"
import { PgClient } from "@effect/sql-pg"
import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
  NodeRuntime
} from "@effect/platform-node"
import { listJobs, retryJob } from "@app/jobs/server"
import { JobId } from "@app/jobs"
import { Config, Effect, Layer, Option } from "effect"

if (existsSync(".env")) {
  process.loadEnvFile(".env")
}

const jobId = process.argv[2]
if (jobId === undefined) {
  console.error("usage: pnpm jobs:retry-dead <jobId>")
  process.exit(1)
}

const SqlClientLayer = PgClient.layerConfig({ url: Config.redacted("DATABASE_URL") })

const Live = SqlClientLayer.pipe(
  Layer.provideMerge(NodeChildProcessSpawner.layer),
  Layer.provideMerge(NodeFileSystem.layer),
  Layer.provideMerge(NodePath.layer)
)

const program = Effect.gen(function*() {
  const dead = yield* listJobs("dead", 100)
  const found = dead.find((job) => job.id === jobId)
  if (found === undefined) {
    yield* Effect.logError(`no dead job found with id ${jobId}`)
    yield* Effect.fail(new Error(`no dead job found with id ${jobId}`))
    return
  }
  yield* Effect.log(
    `retrying dead job ${found.id} (job_type=${found.job_type}, attempts=${found.attempts}, last_error=${found.last_error})`
  )
  const retried = yield* retryJob(jobId as JobId)
  if (Option.isSome(retried)) {
    yield* Effect.log(`retried job ${retried.value.id}: status=${retried.value.status}, attempts=${retried.value.attempts}`)
  } else {
    yield* Effect.logError(`job ${jobId} is no longer in the dead state; nothing to retry`)
    yield* Effect.fail(new Error(`job ${jobId} is no longer in the dead state`))
  }
})

NodeRuntime.runMain(program.pipe(Effect.provide(Live)))