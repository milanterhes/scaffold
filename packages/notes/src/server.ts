/**
 * Server-only exports: the Postgres repo and migrations. Kept behind a
 * dedicated subpath so a browser bundle that imports `@app/notes` (the API
 * wire schemas) never pulls in the repo, which imports `node:crypto`.
 * Mirrors `@app/auth`'s `/api` split.
 */
export * from "./db/migrations.js"
export * from "./repo/notes.repo.js"
export type { CreateNoteInput, UpdateNoteInput } from "./repo/notes.repo.js"