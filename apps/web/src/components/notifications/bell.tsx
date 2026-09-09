import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { DateTime } from "effect"
import { fetchNotifications, markAllReadRequest, markReadRequest } from "../../api/notifications"
import { Button } from "@/components/ui/button"

/**
 * The bell badge in the shared root chrome. Polls the notifications list (the
 * same `["notifications"]` cache key the `/notifications` page uses) and shows
 * the derived unread count; the dropdown lists the latest notifications and
 * marks them read. Renders nothing until the first fetch lands, and nothing at
 * all when unauthenticated (the list endpoint 401s), so anonymous visitors see
 * no badge and no crash.
 */
export function NotificationBell() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const { data, isPending, isError } = useQuery({
    queryKey: ["notifications"],
    queryFn: fetchNotifications,
    refetchInterval: 30_000,
    retry: false
  })

  if (data === undefined && (isPending || isError)) {
    return null
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["notifications"] })

  const markRead = (id: string) => {
    markReadRequest(id).then(invalidate).catch(() => {})
  }

  const markAllRead = () => {
    markAllReadRequest().then(invalidate).catch(() => {})
  }

  const notifications = data ?? []
  const count = notifications.filter((notification) => notification.read_at === null).length

  return (
    <div className="relative">
      <Button variant="outline" onClick={() => setOpen(!open)} aria-expanded={open}>
        Notifications{count > 0 ? ` (${count})` : ""}
      </Button>
      {open && (
        <ul className="absolute left-0 top-full z-10 mt-1 min-w-72 rounded border bg-background p-2 text-xs shadow">
          {notifications.length === 0 && <li className="text-muted-foreground">No notifications</li>}
          {notifications.slice(0, 5).map((notification) => (
            <li key={notification.id}>
              <button
                type="button"
                className="block w-full text-left px-2 py-1.5 hover:bg-muted"
                onClick={() => {
                  if (notification.read_at === null) markRead(notification.id)
                }}
              >
                <span className="font-medium">{notification.title}</span>{" "}
                <span className="text-muted-foreground">{notification.body}</span>{" "}
                <span className="text-muted-foreground">
                  {DateTime.toDateUtc(notification.created_at).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
          {count > 0 && (
            <li>
              <Button type="button" variant="ghost" onClick={markAllRead}>
                Clear all
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}