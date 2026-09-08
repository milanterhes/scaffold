import { PgMigrator } from "@effect/sql-pg"
import { Effect } from "effect"
import { Migrator, SqlClient, SqlError } from "effect/unstable/sql"
import { migrations } from "./migrations.ts"

/**
 * The auth migrator's journal table, distinct from the application migrator's
 * default `effect_sql_migrations` journal so the two migrators coexist without
 * sharing migration state.
 */
export const migrationsTable = "auth_migrations"

/**
 * Run the `auth`-schema migrations against a bound `SqlClient`. Uses
 * `PgMigrator.make` with the default no-op schema dump so only a `SqlClient`
 * is required. The `pnpm migrate` pipeline (`apps/worker/src/migrate.ts`)
 * invokes this after the application migrations.
 */
export const runAuthMigrations: Effect.Effect<
  ReadonlyArray<readonly [number, string]>,
  Migrator.MigrationError | SqlError.SqlError,
  SqlClient.SqlClient
> = PgMigrator.make({})({
  loader: PgMigrator.fromRecord(migrations),
  table: migrationsTable
})