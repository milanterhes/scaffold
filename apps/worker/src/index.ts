import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
  NodeRuntime
} from "@effect/platform-node"
import { PgLive } from "@app/core"
import {
  JobRegistry,
  JobRegistryLive,
  JobWorker,
  JobWorkerLive
} from "@app/jobs/server"
import { Effect } from "effect"
import { loadEnv } from "./env.ts"
import { registerHandlers } from "./handlers.ts"

loadEnv()

const program = Effect.gen(function*() {
  yield* Effect.log("worker starting")
  const registry = yield* JobRegistry
  registerHandlers(registry)
  yield* Effect.log("registered handlers: notification.deliver")
  const worker = yield* JobWorker
  yield* worker.run()
})

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(JobWorkerLive),
    Effect.provide(JobRegistryLive),
    Effect.provide(PgLive),
    Effect.provide(NodeChildProcessSpawner.layer),
    Effect.provide(NodeFileSystem.layer),
    Effect.provide(NodePath.layer)
  )
)