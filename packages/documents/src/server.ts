/**
 * Server-only exports: the Postgres repo and migrations. Kept behind a
 * dedicated subpath so a browser bundle that imports `@app/documents` (the
 * API wire schemas) never pulls in the repo, which imports `node:crypto`
 * and other node-only modules. Mirrors `@app/auth`'s `/api` split.
 */
export * from "./db/migrations.js"
export * from "./repo/documents.repo.js"
export type { CreateDocumentInput } from "./repo/documents.repo.js"