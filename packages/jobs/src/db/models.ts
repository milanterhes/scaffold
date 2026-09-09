import { Schema } from "effect"
import { Model } from "effect/unstable/schema"

export const JobId = Schema.String.pipe(Schema.brand("JobId"))
export type JobId = typeof JobId.Type

export const OutboxEventId = Schema.String.pipe(Schema.brand("OutboxEventId"))
export type OutboxEventId = typeof OutboxEventId.Type

/** The JSON object stored in `payload` (`jsonb`). */
export type JobPayload = typeof Schema.JsonObject.Type

/** The lifecycle state of a job. */
export const JobState = Schema.Literals(["pending", "running", "dead"])
export type JobState = typeof JobState.Type

/**
 * A unit of background work. `payload` is a `jsonb` column, represented by the
 * model as an arbitrary JSON object. `attempts`, `max_attempts`, `status`, and
 * `created_at`/`updated_at` are maintained by the repo's raw SQL, so the model
 * only reads them back.
 */
export class Job extends Model.Class<Job>("scaffold/db/Job")({
  id: Model.UuidV4Insert(JobId),
  job_type: Schema.NonEmptyString,
  payload: Schema.JsonObject,
  status: Model.GeneratedByApp(JobState),
  attempts: Model.GeneratedByApp(Schema.Number),
  max_attempts: Model.GeneratedByApp(Schema.Number),
  run_after: Model.DateTimeInsertFromDate,
  last_error: Schema.NullOr(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate
}) {}

/**
 * A domain event written transactionally by the emitting repo, drained into
 * jobs by the worker. `consumed_at` is null until the outbox row has been
 * turned into a job.
 */
export class OutboxEvent extends Model.Class<OutboxEvent>("scaffold/db/OutboxEvent")({
  id: Model.UuidV4Insert(OutboxEventId),
  event_type: Schema.NonEmptyString,
  payload: Schema.JsonObject,
  created_at: Model.DateTimeInsertFromDate,
  consumed_at: Model.Field({
    select: Schema.NullOr(Schema.DateTimeUtcFromDate),
    insert: Schema.NullOr(Schema.DateTimeUtcFromDate),
    json: Schema.NullOr(Schema.DateTimeUtcFromDate)
  })
}) {}