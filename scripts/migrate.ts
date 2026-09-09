import { existsSync } from "node:fs"
import { PgClient, PgMigrator } from "@effect/sql-pg"
import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
  NodeRuntime
} from "@effect/platform-node"
import { runAuthMigrations } from "@app/auth-postgres"
import { migrations } from "@app/core"
import { notesMigrations } from "@app/notes/server"
import { documentsMigrations } from "@app/documents/server"
import { jobsMigrations } from "@app/jobs/server"
import { Config, Effect, Layer } from "effect"

if (existsSync(".env")) {
  process.loadEnvFile(".env")
}

const SqlClientLayer = PgClient.layerConfig({ url: Config.redacted("DATABASE_URL") })

const MigratorLayer = PgMigrator.layer({
  loader: PgMigrator.fromRecord({ ...migrations, ...notesMigrations, ...documentsMigrations, ...jobsMigrations })
})

const SqlLive = MigratorLayer.pipe(Layer.provideMerge(SqlClientLayer))

const Live = SqlLive.pipe(
  Layer.provideMerge(NodeChildProcessSpawner.layer),
  Layer.provideMerge(NodeFileSystem.layer),
  Layer.provideMerge(NodePath.layer)
)

const program = Effect.gen(function*() {
  yield* Effect.log("Application migrations applied")
  yield* runAuthMigrations.pipe(Effect.tap(() => Effect.log("Auth migrations applied")))
})

NodeRuntime.runMain(program.pipe(Effect.provide(Live)))
