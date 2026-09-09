import { expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { Job } from "./db/models.ts"
import { JobRegistry, JobRegistryLive } from "./registry.ts"

it.effect("register maps a job type to a handler; get returns it; missing types yield None", () =>
  Effect.gen(function*() {
    const registry = yield* JobRegistry
    const handler = (_job: Job) => Effect.succeed("ok")
    registry.register("test.type", handler)

    const found = registry.get("test.type")
    expect(Option.isSome(found)).toBe(true)
    if (Option.isSome(found)) {
      expect(found.value).toBe(handler)
    }

    const missing = registry.get("no.such.type")
    expect(Option.isNone(missing)).toBe(true)
  }).pipe(Effect.provide(JobRegistryLive)))