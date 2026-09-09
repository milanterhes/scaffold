import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { DateTime } from "effect"
import { fetchNotifications, markAllReadRequest, markReadRequest } from "../api/notifications"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"

export const Route = createFileRoute("/notifications")({
  component: NotificationsPage
})

function NotificationsPage() {
  const queryClient = useQueryClient()

  // The same cache key as the bell badge, so mark-read invalidation refreshes
  // both and the shared `refetchInterval` keeps them in sync.
  const { data, isPending, isError } = useQuery({
    queryKey: ["notifications"],
    queryFn: fetchNotifications,
    refetchInterval: 30_000
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["notifications"] })

  const markRead = (id: string) => {
    markReadRequest(id).then(invalidate).catch(() => {})
  }

  const markAllRead = () => {
    markAllReadRequest().then(invalidate).catch(() => {})
  }

  return (
    <div>
      <header>
        <h1 className="text-2xl font-bold">Notifications</h1>
        <p>
          <Link to="/">← Home</Link>
        </p>
      </header>

      {isPending && <p>Loading notifications…</p>}
      {isError && <p>Failed to load notifications.</p>}

      <section>
        <Button onClick={markAllRead}>Mark all read</Button>
      </section>

      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Body</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((notification) => (
              <TableRow key={notification.id}>
                <TableCell className={notification.read_at === null ? "font-medium" : undefined}>
                  {notification.title}
                </TableCell>
                <TableCell>{notification.body}</TableCell>
                <TableCell>{notification.read_at === null ? "unread" : "read"}</TableCell>
                <TableCell>{DateTime.toDateUtc(notification.created_at).toLocaleString()}</TableCell>
                <TableCell>
                  {notification.read_at === null && (
                    <Button onClick={() => markRead(notification.id)}>Mark read</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}