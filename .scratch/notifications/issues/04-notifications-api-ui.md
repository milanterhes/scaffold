# 04 — notifications API + bell badge + page

Status: ready-for-agent
Type: task
Blocked by: 02

## Summary

The user-facing half: the `HttpApi` group, the bell badge in the shared root
chrome, and the `/notifications` page — polling via TanStack Query.

## Requirements

1. **HTTP group** (`apps/web/src/api/notifications.api.ts` + `.impl.ts` +
   `.ts` typed client), mirroring notes/documents:
   - `GET /me/notifications` — `Schema.Array(NotificationListItem)`, LIMIT 50
     newest first, user-scoped.
   - `POST /me/notifications/:id/read` — idempotent mark-read; 404 when not
     owned/missing; success `{ ok: true }`.
   - `POST /me/notifications/read-all` — success `{ ok: true }`.
   - All behind `SessionMiddleware`. No unread-count endpoint (derive from the
     list).
   - Wire into `web.api.ts` (addHttpApi) and `mount.ts` (Layer.mergeAll).
2. **Bell badge** (`apps/web/src/components/notifications/bell.tsx`),
   rendered in `apps/web/src/routes/__root.tsx` alongside `<Outlet />` so it
   appears on every page:
   - Polls `useQuery({ queryKey: ["notifications"], queryFn: fetchNotifications,
     refetchInterval: 30_000 })`.
   - Shows the unread count (derived from the list: `filter(n => !n.read_at).length`)
     in a button; clicking opens a small dropdown listing the latest
     notifications with title/body/time.
   - Clicking a notification calls `markRead` then
     `queryClient.invalidateQueries({ queryKey: ["notifications"] })`.
   - "Clear all" calls `markAllRead` + invalidates.
3. **Notifications page** (`apps/web/src/routes/notifications.tsx`,
   `createFileRoute("/notifications")`, nav link in `index.tsx` next to
   "My notes" / "Documents"):
   - Uses the SAME `queryKey: ["notifications"]` (shared cache with the badge).
   - A table/list (shadcn Table) of notifications with unread styling, a
     "mark read" action per row, and a "mark all read" button. Refetch via
     invalidation on action; the shared `refetchInterval` keeps it fresh.
4. **Route registration** — regenerate `routeTree.gen.ts` (build/dev does it);
   add `/notifications` to the nav in `index.tsx`'s `AuthBadge`.

## Tests

- API tests (`apps/web/src/api/notifications.api.test.ts`): sign in, insert a
  notification via the repo (or the deliver handler), assert list/mark-read/
  read-all, 404 for another user's notification, 401 unauthenticated, and the
  derived unread count.

## Out of scope

Push (PubSub/SSE), pagination beyond LIMIT 50, notification preferences, admin
UI.