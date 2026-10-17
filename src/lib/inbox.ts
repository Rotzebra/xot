import { useLiveQuery } from "dexie-react-hooks";
import { db, type InboxEntry } from "./db";
import { loadWorkspace, pageInWorkspace, useStoredWorkspace } from "./workspace";

// "Bandeja de entrada": every reminder that fires lands here (also one
// that came due while Xot was closed), linked to its page or row, until it is
// archived. Opening an entry marks it read.

/** What a fired reminder brings (lib/reminders.ts Reminder). */
type Fired = { id: string; pageId: string; title: string; body: string; at: number; kind?: "automation"; source?: string };

export async function addToInbox(list: Fired[]) {
  await db.transaction("rw", db.inbox, async () => {
    for (const r of list) {
      if (await db.inbox.get(r.id)) continue;
      await db.inbox.add({
        id: r.id,
        page_id: r.pageId,
        title: r.title,
        body: r.body,
        time: r.at,
        read: false,
        ...(r.kind ? { kind: r.kind, source: r.source } : {}),
      });
    }
  });
}

/** The inbox filter: everything not archived, only the unread, or the archive. */
export type InboxFilter = "all" | "unread" | "archived";

/** The entries of the open workspace only (an entry whose page is gone stays, so it can be archived). */
async function ofWorkspace(entries: InboxEntry[]): Promise<InboxEntry[]> {
  const ws = await loadWorkspace();
  const out: InboxEntry[] = [];
  for (const e of entries) if (await pageInWorkspace(e.page_id, ws)) out.push(e);
  return out;
}

/** The entries the filter shows, newest first. */
export function useInbox(filter: InboxFilter = "all"): InboxEntry[] | undefined {
  const stored = useStoredWorkspace();
  return useLiveQuery(
    async () =>
      ofWorkspace(
        (await db.inbox.orderBy("time").reverse().toArray()).filter((e) =>
          filter === "archived" ? e.archived : !e.archived && (filter === "all" || !e.read),
        ),
      ),
    [filter, stored],
  );
}

export function useUnreadCount(): number {
  const stored = useStoredWorkspace();
  return (
    useLiveQuery(
      async () => (await ofWorkspace((await db.inbox.toArray()).filter((e) => !e.read && !e.archived))).length,
      [stored],
    ) ?? 0
  );
}

export const markRead = (id: string) => db.inbox.update(id, { read: true });

export const markUnread = (id: string) => db.inbox.update(id, { read: false });

export const archiveEntry = (id: string) => db.inbox.update(id, { archived: true, read: true });

export const unarchiveEntry = (id: string) => db.inbox.update(id, { archived: false });

export async function markAllRead() {
  const unread = (await ofWorkspace((await db.inbox.toArray()).filter((e) => !e.read))).map((e) => e.id);
  await db.transaction("rw", db.inbox, async () => {
    for (const id of unread) await db.inbox.update(id, { read: true });
  });
}

/** "Archivar todo" / "Archivar leídos". */
export async function archiveAll(onlyRead: boolean) {
  const ids = (await ofWorkspace((await db.inbox.toArray()).filter((e) => !e.archived && (!onlyRead || e.read)))).map(
    (e) => e.id,
  );
  await db.transaction("rw", db.inbox, async () => {
    for (const id of ids) await db.inbox.update(id, { archived: true, read: true });
  });
}
