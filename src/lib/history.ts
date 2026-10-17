import Dexie from "dexie";
import { db, type DatabaseState, type PageState, type Snapshot } from "./db";
import type { Block } from "./model";

// "Historial de versiones": a page (title, icon, cover, property values and
// body) is saved as a version at most every 10 minutes while it's edited, and
// once more when it's left. Each page keeps its latest 50 versions.

const INTERVAL = 10 * 60 * 1000;
const MAX_PER_PAGE = 50;

/** The last version time per page, so the 10-minute check doesn't query on each save. */
const lastTime = new Map<string, number>();
/** Pages edited since their last version: leaving them saves one. */
const dirty = new Set<string>();
/** One history step at a time per page, so two quick saves can't both write "the first version". */
const queues = new Map<string, Promise<unknown>>();

function queue<T>(pageId: string, run: () => Promise<T>): Promise<T | undefined> {
  const next = (queues.get(pageId) ?? Promise.resolve()).then(run).catch((error) => {
    console.error("Historial de versiones:", error);
    return undefined;
  });
  queues.set(pageId, next);
  return next;
}

/** What a version keeps of a page. */
export function pageState(block: Block, content: unknown[] = block.content ?? []): PageState {
  return {
    title: String(block.properties.title ?? ""),
    icon: block.format.icon,
    cover: block.format.cover,
    cover_position: block.format.cover_position,
    properties: block.properties,
    content,
    content_markdown: content.length ? undefined : block.content_markdown,
  };
}

/** A full-page database as a version: title, icon and cover, with its description, properties and views. */
export async function databaseState(block: Block): Promise<PageState | null> {
  const collection = block.collection_id ? await db.collections.get(block.collection_id) : undefined;
  if (!collection) return null;
  const order = block.view_ids ?? [];
  const views = (await db.views.where("parent_id").equals(block.id).toArray()).sort(
    (a, b) => (order.indexOf(a.id) + 1 || order.length + 1) - (order.indexOf(b.id) + 1 || order.length + 1),
  );
  const database: DatabaseState = { description: collection.description, schema: collection.schema, views };
  return { ...pageState(block, []), content_markdown: undefined, database };
}

// JSON drops undefined fields, so a missing icon and an absent one compare equal.
const key = (s: PageState) =>
  JSON.stringify([
    s.title,
    s.icon ?? null,
    s.cover ?? null,
    s.cover_position ?? null,
    s.properties ?? null,
    s.content,
    s.content_markdown ?? "",
    ...(s.database ? [s.database] : []),
  ]);

const isEmpty = (s: PageState) => !s.title && !s.icon && !s.cover && !s.content.length && !s.content_markdown?.trim();

function latest(pageId: string): Promise<Snapshot | undefined> {
  return db.snapshots
    .where("[page_id+time]")
    .between([pageId, Dexie.minKey], [pageId, Dexie.maxKey])
    .last();
}

/** Adds a version unless the page is unchanged since the last one; keeps the newest 50. */
async function write(pageId: string, state: PageState, time = Date.now()) {
  if (isEmpty(state)) return;
  const last = await latest(pageId);
  // Nothing changed since the last version (versions written before 5 only compare title and body).
  const same = last && (last.properties ? key(last) === key(state) : JSON.stringify(last.content) === JSON.stringify(state.content) && last.title === state.title);
  if (same) {
    lastTime.set(pageId, Math.max(last.time, lastTime.get(pageId) ?? 0));
    return;
  }
  await db.snapshots.add({ page_id: pageId, time, ...structuredClone(state) });
  lastTime.set(pageId, time);
  // Named versions stay; the oldest of the rest go.
  const count = await db.snapshots.where("page_id").equals(pageId).filter((v) => !v.name).count();
  if (count > MAX_PER_PAGE) {
    const old = await db.snapshots
      .where("[page_id+time]")
      .between([pageId, Dexie.minKey], [pageId, Dexie.maxKey])
      .filter((v) => !v.name)
      .limit(count - MAX_PER_PAGE)
      .primaryKeys();
    await db.snapshots.bulkDelete(old);
  }
}

/**
 * Full-page databases: their properties and views change through many paths, so a version is
 * saved when the database is opened (what it had) and when it's left (what it ended up with),
 * whenever it differs from the last one.
 */
export function recordDatabase(pageId: string) {
  return queue(pageId, async () => {
    const block = await db.blocks.get(pageId);
    if (block?.type !== "collection_view_page" || !block.alive) return;
    const state = await databaseState(block);
    if (state) await write(pageId, state);
  });
}

/** "Nombrar versión": names a version (an empty name clears it). */
export function nameVersion(id: number, name: string) {
  return db.snapshots.update(id, { name: name.trim() || undefined });
}

/**
 * Called after each change to a page (lib/ops updateBlock) with the page as it
 * was before. The first edit keeps that earlier page, so there is always a
 * version to go back to; later edits save one every 10 minutes.
 */
export function noteEdit(before: Block) {
  if (before.type !== "page") return;
  const pageId = before.id;
  void queue(pageId, async () => {
    const after = await db.blocks.get(pageId);
    if (!after) return;
    const prev = pageState(before);
    const next = pageState(after);
    // Layout switches, moves and the like aren't part of a version.
    if (key(prev) === key(next)) return;
    dirty.add(pageId);
    flushWhenIdle(pageId);
    let last = lastTime.get(pageId);
    if (last === undefined) {
      const saved = await latest(pageId);
      last = saved?.time ?? 0;
      lastTime.set(pageId, last);
      if (!saved) {
        await write(pageId, prev, Date.now() - 1);
        return;
      }
      // The first edit of a session: what the page had (the end of an earlier session that
      // closed before its last version was written) is a version too, at the time it was edited.
      const differs = saved.properties ? key(saved) !== key(prev) : saved.title !== prev.title || JSON.stringify(saved.content) !== JSON.stringify(prev.content);
      if (differs) {
        const time = Math.min(Date.now() - 1, Math.max(saved.time + 1, before.last_edited_time));
        await write(pageId, prev, time);
        last = lastTime.get(pageId) ?? last;
      }
    }
    if (Date.now() - last >= INTERVAL) {
      await write(pageId, next);
      dirty.delete(pageId);
    }
  });
}

/** A page left alone for a while after an edit gets its version then, not only when it's left. */
const IDLE = 2 * 60 * 1000;
const idleTimers = new Map<string, number>();
function flushWhenIdle(pageId: string) {
  window.clearTimeout(idleTimers.get(pageId));
  idleTimers.set(
    pageId,
    window.setTimeout(() => {
      idleTimers.delete(pageId);
      void queue(pageId, async () => {
        if (!dirty.delete(pageId)) return;
        const block = await db.blocks.get(pageId);
        if (block) await write(pageId, pageState(block));
      });
    }, IDLE),
  );
}

/** Leaving a page saves a version of what it ended up with, when it was edited. */
export function leavePage(pageId: string) {
  if (!dirty.has(pageId)) {
    void recordDatabase(pageId);
    return;
  }
  // After the editor's own last save, which it flushes as it unmounts.
  window.setTimeout(() => {
    void queue(pageId, async () => {
      if (!dirty.delete(pageId)) return;
      const block = await db.blocks.get(pageId);
      if (block) await write(pageId, pageState(block));
    });
  }, 50);
}

/** Saves the page as it is now (before a restore, so the restore can be undone from the history too). */
export function saveVersionNow(block: Block, content?: unknown[]) {
  return queue(block.id, async () => {
    dirty.delete(block.id);
    const state = block.type === "collection_view_page" ? await databaseState(block) : pageState(block, content ?? block.content ?? []);
    if (state) await write(block.id, state);
  });
}

export function listSnapshots(pageId: string) {
  return db.snapshots
    .where("[page_id+time]")
    .between([pageId, Dexie.minKey], [pageId, Dexie.maxKey])
    .reverse()
    .toArray();
}

// Closing the window counts as leaving the pages edited in it.
window.addEventListener("pagehide", () => {
  for (const pageId of [...dirty]) {
    dirty.delete(pageId);
    void db.blocks.get(pageId).then((block) => block && write(pageId, pageState(block)));
  }
});
