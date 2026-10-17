import Dexie from "dexie";
import { db } from "./db";
import { defaultChart } from "./chart";
import { noteEdit } from "./history";
import { mapGroupRules, pruneGroup, relationLimit, subitemConfig } from "./query";
import { resolveContent, resolveProperties } from "./templates";
import {
  type Block,
  type ChartType,
  type Collection,
  type CollectionView,
  type Filter,
  type FilterGroup,
  type OptionColor,
  type PageRef,
  type ParentTable,
  type PropertySchema,
  type PropertyType,
  type PlaceCoords,
  type PropertyValue,
  type RichRun,
  type SelectOption,
  type TemplateRepeat,
  type ViewType,
  PROPERTY_TYPE_LABELS,
  statusDefault,
} from "./model";

export const uuid = () => crypto.randomUUID();

/** Schema properties are keyed by short ids; "title" is reserved. */
export function shortId() {
  return Math.random().toString(36).slice(2, 6);
}

const now = () => Date.now();

// ---------------------------------------------------------------- pages

export async function createPage(
  parentTable: ParentTable,
  parentId: string,
  init: Partial<Block> = {},
): Promise<string> {
  const t = now();
  const block: Block = {
    id: init.id ?? uuid(),
    type: "page",
    parent_id: parentId,
    parent_table: parentTable,
    properties: { title: "" },
    format: {},
    content: null,
    alive: true,
    order: t,
    created_time: t,
    last_edited_time: t,
    ...init,
  };
  // A new database row takes the next number of each "ID" property (copies and template rows too).
  if (parentTable === "collection" && !block.is_template) block.properties = await withNextIds(parentId, block.properties);
  await db.blocks.add(block);
  return block.id;
}

/**
 * The values with each auto-increment ID set to one past the highest in the database, and each
 * status the page doesn't set starting at its default option ("Predeterminada").
 */
async function withNextIds(collectionId: string, properties: Block["properties"]) {
  const collection = await db.collections.get(collectionId);
  for (const [id, p] of Object.entries(collection?.schema ?? {}))
    if (p.type === "status" && properties[id] === undefined) {
      const first = statusDefault(p);
      if (first) properties = { ...properties, [id]: first };
    }
  const ids = Object.entries(collection?.schema ?? {}).filter(([, p]) => p.type === "auto_increment_id").map(([id]) => id);
  if (!ids.length) return properties;
  const rows = await db.blocks.where("[parent_table+parent_id]").equals(["collection", collectionId]).toArray();
  const next = { ...properties };
  for (const id of ids)
    next[id] = rows.reduce((max, r) => (typeof r.properties[id] === "number" ? Math.max(max, r.properties[id] as number) : max), 0) + 1;
  return next;
}

export async function updateBlock(id: string, patch: Partial<Block>) {
  // "Historial de versiones" follows a page's title, icon, cover, values and body.
  // Changes made inside a larger transaction (imports, schema edits) aren't page edits.
  const tracked =
    !Dexie.currentTransaction && ("properties" in patch || "format" in patch || "content" in patch || "content_markdown" in patch);
  const before = tracked ? await db.blocks.get(id) : undefined;
  await db.blocks.update(id, { ...patch, last_edited_time: now() });
  if (before) noteEdit(before);
}

export async function setTitle(id: string, title: string) {
  const block = await db.blocks.get(id);
  if (!block) return;
  await updateBlock(id, { properties: { ...block.properties, title } });
}

export async function setIcon(id: string, icon: string | undefined) {
  const block = await db.blocks.get(id);
  if (!block) return;
  await updateBlock(id, { format: { ...block.format, icon } });
}

export async function setFormat(id: string, patch: Partial<Block["format"]>) {
  const block = await db.blocks.get(id);
  if (!block) return;
  await updateBlock(id, { format: { ...block.format, ...patch } });
}

// ----------------------------------------------------------------- undo

/**
 * Page-level ⌘Z: trashing and moving pages (outside the editor, which keeps
 * its own history) can be undone and redone.
 */
interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** Edits to the same thing (a cell, a view) within a second are one step, as while typing. */
  merge?: string;
  at?: number;
}
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
// Inside an edit that records itself as a whole, the operations it calls don't record again.
let recording = 0;

export function pushUndo(entry: UndoEntry) {
  if (recording) return;
  const t = now();
  const last = undoStack[undoStack.length - 1];
  redoStack.length = 0;
  if (entry.merge && last?.merge === entry.merge && t - (last.at ?? 0) < 1000) {
    last.redo = entry.redo;
    last.at = t;
    return;
  }
  undoStack.push({ ...entry, at: t });
  if (undoStack.length > 50) undoStack.shift();
}

/** A database's schema, its views and (when asked) its rows' values, as they are now. */
async function databaseState(collectionId: string, rows: boolean) {
  const collection = await db.collections.get(collectionId);
  if (!collection) return null;
  const views = await db.views.where("parent_id").equals(collection.parent_id).toArray();
  const values = rows
    ? (await db.blocks.where("[parent_table+parent_id]").equals(["collection", collectionId]).toArray()).map(
        (r) => [r.id, r.properties] as const,
      )
    : [];
  return { collection, views, values };
}

async function putDatabaseState(state: NonNullable<Awaited<ReturnType<typeof databaseState>>>) {
  await db.transaction("rw", db.collections, db.views, db.blocks, async () => {
    // Automations aren't part of a schema edit: ⌘Z keeps them as they are now.
    const automations = (await db.collections.get(state.collection.id))?.automations;
    await db.collections.put({ ...state.collection, automations });
    for (const view of state.views) await db.views.put(view);
    for (const [id, properties] of state.values) await db.blocks.update(id, { properties });
  });
}

/** Runs a change to a database's properties as one ⌘Z step (schema and views, plus rows when it rewrites values). */
async function undoableSchemaEdit<T>(label: string, collectionId: string, rows: boolean, run: () => Promise<T>): Promise<T> {
  if (recording) return run();
  const before = await databaseState(collectionId, rows);
  recording++;
  let result: T;
  try {
    result = await run();
  } finally {
    recording--;
  }
  const after = await databaseState(collectionId, rows);
  if (before && after)
    pushUndo({ label, undo: () => putDatabaseState(before), redo: () => putDatabaseState(after), merge: `schema:${collectionId}:${label}` });
  return result;
}

/** Undoes the last page operation; returns its label, or null when there is none. */
export async function undoLast(): Promise<string | null> {
  const entry = undoStack.pop();
  if (!entry) return null;
  await entry.undo();
  redoStack.push(entry);
  return entry.label;
}

export async function redoLast(): Promise<string | null> {
  const entry = redoStack.pop();
  if (!entry) return null;
  await entry.redo();
  undoStack.push(entry);
  return entry.label;
}

/**
 * A subpage (or inline database) and its block in the parent page are one thing,
 * so trashing it takes the block out of the parent, restoring puts it
 * back where it was. An open editor of the parent hears it through this event.
 */
export const PAGE_ALIVE_EVENT = "xot:page-alive";
export type PageAliveDetail = { id: string; parentId: string; alive: boolean; at?: LinkPlace };

// Where each trashed subpage's block sat, so restoring it puts it back there.
const trashedPlaces = new Map<string, LinkPlace>();

async function setAlive(id: string, alive: boolean) {
  await updateBlock(id, { alive, trashed_time: alive ? undefined : now() });
  const block = await db.blocks.get(id);
  if (!block || block.parent_table !== "block") return;
  let at: LinkPlace | undefined;
  if (alive) {
    at = trashedPlaces.get(id);
    trashedPlaces.delete(id);
    await insertPageLink(block.parent_id, id, undefined, at);
  } else {
    const parent = await db.blocks.get(block.parent_id);
    const place = parent?.content ? findLink(parent.content as ContentBlock[], id) : null;
    if (place) trashedPlaces.set(id, place);
    await removePageLink(block.parent_id, id);
  }
}

/** Tells an open editor of `parentId` that the page's block comes (back) or goes. */
function announceLink(id: string, parentId: string, alive: boolean, at?: LinkPlace) {
  window.dispatchEvent(new CustomEvent<PageAliveDetail>(PAGE_ALIVE_EVENT, { detail: { id, parentId, alive, at } }));
}

export async function trashBlock(id: string) {
  await setAlive(id, false);
  pushUndo({
    label: "Mover a la papelera",
    undo: () => setAlive(id, true),
    redo: () => setAlive(id, false),
  });
}

export async function restoreBlock(id: string) {
  await setAlive(id, true);
}

/** "Archivar" (beta): the page and its subpages leave the sidebar and search; "Desarchivar" brings them back. */
export async function archivePage(id: string, archived: boolean) {
  await setFormat(id, { archived: archived ? now() : undefined });
  pushUndo({
    label: archived ? "Archivar" : "Desarchivar",
    undo: () => setFormat(id, { archived: archived ? undefined : now() }),
    redo: () => setFormat(id, { archived: archived ? now() : undefined }),
  });
}

/** Whether a page is archived, itself or through a page above it (`ancestors` from getAncestors). */
export const isArchived = (block: Block, ancestors: Block[] = []) =>
  !!block.format.archived || ancestors.some((a) => !!a.format.archived);

/**
 * A copy of a page placed right after it, with everything inside it: its
 * subpages and databases (schema, views and rows) are copied too, and links,
 * database blocks and mentions pointing inside the page point at the copies.
 * Only the copy itself is named "<title> (1)". `link: false`
 * leaves the parent page's content alone (the editor places the block itself).
 */
export async function duplicatePage(id: string, opts: { link?: boolean } = {}): Promise<string | null> {
  const block = await db.blocks.get(id);
  if (!block) return null;
  if (block.type === "collection_view_page") return duplicateDatabase(id, opts);
  const ids = new Map<string, string>();
  const copy = await copyPageTree(block, block.parent_table, block.parent_id, ids, true);
  await remapCopiedContent(ids);
  if (opts.link !== false && block.parent_table === "block") await insertPageLink(block.parent_id, copy, id);
  return copy;
}

/** Copies a page and, beneath it, its subpages and databases; `ids` collects old id → new id. */
async function copyPageTree(
  block: Block,
  parentTable: ParentTable,
  parentId: string,
  ids: Map<string, string>,
  top: boolean,
): Promise<string> {
  const t = now();
  const title = typeof block.properties.title === "string" ? block.properties.title : "";
  const copy = await createPage(parentTable, parentId, {
    // The copy is named "<title> (1)".
    properties: { ...structuredClone(block.properties), title: top && title ? `${title} (1)` : title },
    format: structuredClone(block.format),
    content: block.content ? structuredClone(block.content) : null,
    content_markdown: block.content_markdown,
    reminders: block.reminders ? { ...block.reminders } : undefined,
    is_template: block.is_template,
    order: top ? block.order + 0.5 : block.order,
    created_time: t,
    last_edited_time: t,
  });
  ids.set(block.id, copy);
  await copyChildren(block.id, copy, ids);
  return copy;
}

/** The subpages and databases inside `fromId`, copied under `toId`. */
async function copyChildren(fromId: string, toId: string, ids: Map<string, string>) {
  const children = (await db.blocks.where("[parent_table+parent_id]").equals(["block", fromId]).toArray())
    .filter((c) => c.alive)
    .sort((a, b) => a.order - b.order);
  for (const child of children) {
    if (child.type === "page") await copyPageTree(child, "block", toId, ids, false);
    else await duplicateDatabase(child.id, { link: false, parentId: toId, ids });
  }
}

/** Rewrites the copies' links, database blocks and mentions that point inside what was copied. */
async function remapCopiedContent(ids: Map<string, string>) {
  const remap = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(remap);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node))
      out[k] = (k === "pageId" || k === "blockId") && typeof v === "string" ? (ids.get(v) ?? v) : remap(v);
    return out;
  };
  const pattern = ids.size ? new RegExp([...ids.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|"), "g") : null;
  for (const copyId of ids.values()) {
    const copy = await db.blocks.get(copyId);
    if (!copy) continue;
    const patch: Partial<Block> = {};
    if (copy.content?.length) patch.content = remap(copy.content) as unknown[];
    // Pages not opened yet hold Markdown, whose subpage links carry the ids.
    if (copy.content_markdown && pattern) patch.content_markdown = copy.content_markdown.replace(pattern, (m) => ids.get(m) ?? m);
    if (Object.keys(patch).length) await db.blocks.update(copyId, patch);
  }
}

/**
 * A copy of a database placed right after it ("<title> (1)"): its schema (property
 * and option ids kept), its views, its rows with their content, and its templates.
 * Relations to the database itself point at the copies; relations to other
 * databases become one-way, so the other side isn't changed. A linked view
 * copies only its block and views (it keeps showing the same database).
 */
export async function duplicateDatabase(
  id: string,
  opts: {
    link?: boolean;
    /** Copying a whole page: the copy goes under the page's copy, keeps its title and records its ids. */
    parentId?: string;
    ids?: Map<string, string>;
  } = {},
): Promise<string | null> {
  const block = await db.blocks.get(id);
  if (!block || block.type !== "collection_view_page" || !block.collection_id) return null;
  const collection = await db.collections.get(block.collection_id);
  if (!collection) return null;
  const nested = opts.parentId !== undefined;
  const t = now();
  const blockId = uuid();
  const own = collection.parent_id === block.id;
  const collectionId = own ? uuid() : collection.id;
  const views = (await db.views.where("parent_id").equals(block.id).toArray()).filter((v) =>
    (block.view_ids ?? []).includes(v.id),
  );
  const rows = own
    ? await db.blocks.where("[parent_table+parent_id]").equals(["collection", collection.id]).filter((r) => r.alive).toArray()
    : [];
  const rowIds = new Map<string, string>(rows.map((r) => [r.id, uuid()]));
  const viewIds = new Map<string, string>(views.map((v) => [v.id, uuid()]));
  const remapRefs = (refs: PageRef[]) => refs.map((r) => ({ ...r, id: rowIds.get(r.id) ?? r.id }));

  const schema = structuredClone(collection.schema);
  const selfRelations: string[] = [];
  for (const [pid, p] of Object.entries(schema)) {
    if (p.type !== "relation") continue;
    if (p.collection_id === collection.id) {
      p.collection_id = collectionId;
      selfRelations.push(pid);
    } else delete p.synced_property;
  }
  const title = typeof block.properties.title === "string" ? block.properties.title : "";
  const copy: Block = {
    ...structuredClone(block),
    id: blockId,
    properties: { ...structuredClone(block.properties), title: nested ? title : title.trim() ? `${title.trimEnd()} (1)` : "" },
    parent_id: opts.parentId ?? block.parent_id,
    collection_id: collectionId,
    view_ids: (block.view_ids ?? []).flatMap((v) => viewIds.get(v) ?? []),
    order: nested ? block.order : block.order + 0.5,
    created_time: t,
    last_edited_time: t,
  };
  const newViews: CollectionView[] = views.map((v) => {
    const c = structuredClone(v);
    c.id = viewIds.get(v.id)!;
    c.parent_id = blockId;
    if (v.collection_id === collection.id) c.collection_id = collectionId;
    if (c.format.page_sort) c.format.page_sort = c.format.page_sort.map((r) => rowIds.get(r) ?? r);
    if (c.format.default_template) c.format.default_template = rowIds.get(c.format.default_template) ?? c.format.default_template;
    return c;
  });
  const newRows: Block[] = rows.map((r) => {
    const properties = structuredClone(r.properties);
    for (const pid of selfRelations) if (Array.isArray(properties[pid])) properties[pid] = remapRefs(properties[pid] as PageRef[]);
    return {
      ...structuredClone(r),
      id: rowIds.get(r.id)!,
      parent_id: collectionId,
      properties,
      created_time: r.created_time,
      last_edited_time: t,
    };
  });
  await db.transaction("rw", db.blocks, db.collections, db.views, async () => {
    if (own)
      await db.collections.add({
        ...structuredClone(collection),
        id: collectionId,
        parent_id: blockId,
        schema,
        template_ids: collection.template_ids?.map((x) => rowIds.get(x) ?? x),
        default_template: collection.default_template ? (rowIds.get(collection.default_template) ?? collection.default_template) : undefined,
        template_repeats: collection.template_repeats?.map((r) => ({ ...r, template_id: rowIds.get(r.template_id) ?? r.template_id })),
      });
    await db.views.bulkAdd(newViews);
    if (newRows.length) await db.blocks.bulkAdd(newRows);
    await db.blocks.add(copy);
  });
  // Pages inside the rows are copied too, and mentions of the rows from the copied page follow the copies.
  const ids = opts.ids ?? new Map<string, string>();
  ids.set(block.id, blockId);
  for (const [from, to] of rowIds) ids.set(from, to);
  for (const r of rows) await copyChildren(r.id, rowIds.get(r.id)!, ids);
  if (nested) return blockId;
  if (rows.length) await remapCopiedContent(ids);
  // A full-page database inside a page shows as a link in it; an inline one is placed by the editor.
  if (opts.link !== false && block.parent_table === "block" && !block.format.inline) await insertPageLink(block.parent_id, blockId, id);
  pushUndo({
    label: "Duplicar",
    undo: () => setAlive(blockId, false),
    redo: () => setAlive(blockId, true),
  });
  return blockId;
}

// A subpage also shows as a block in its parent's content, as a page block
// (an inline database, as its database block).
type ContentBlock = { id?: string; type?: string; props?: { pageId?: string; blockId?: string }; children?: ContentBlock[] };

/** Where a page's block sat in its parent: after the block `prev`, or first inside `parent` (or the page). */
export type LinkPlace = { prev?: string; parent?: string };

const linksTo = (b: ContentBlock, pageId: string) =>
  (b.type === "pageLink" && b.props?.pageId === pageId) || (b.type === "database" && b.props?.blockId === pageId);

function withoutLink(blocks: ContentBlock[], pageId: string): ContentBlock[] {
  return blocks
    .filter((b) => !linksTo(b, pageId))
    .map((b) => (b.children?.length ? { ...b, children: withoutLink(b.children, pageId) } : b));
}

function findLink(blocks: ContentBlock[], pageId: string, parent?: string): LinkPlace | null {
  for (let i = 0; i < blocks.length; i++) {
    // Imported blocks have no id until their page is saved: no place to point at then.
    if (linksTo(blocks[i], pageId)) return i > 0 && !blocks[i - 1].id ? null : { prev: blocks[i - 1]?.id, parent };
    const inner = blocks[i].children?.length ? findLink(blocks[i].children!, pageId, blocks[i].id) : null;
    if (inner) return inner;
  }
  return null;
}

/** `blocks` with `link` placed at `at`; null when neither the block before it nor its parent is there anymore. */
function withLinkAt(blocks: ContentBlock[], link: ContentBlock, at: LinkPlace): ContentBlock[] | null {
  if (at.prev) {
    const i = blocks.findIndex((b) => b.id === at.prev);
    if (i !== -1) return [...blocks.slice(0, i + 1), link, ...blocks.slice(i + 1)];
  } else if (!at.parent) return [link, ...blocks];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!at.prev && b.id === at.parent) return blocks.map((x, j) => (j === i ? { ...x, children: [link, ...(x.children ?? [])] } : x));
    const inner = b.children?.length ? withLinkAt(b.children, link, at) : null;
    if (inner) return blocks.map((x, j) => (j === i ? { ...x, children: inner } : x));
  }
  return null;
}

/** The block that shows a page in its parent: a database block for an inline database, else a page link. */
export function linkBlockFor(page: Pick<Block, "id" | "type" | "format">): ContentBlock {
  return page.type === "collection_view_page" && page.format.inline
    ? { type: "database", props: { blockId: page.id } }
    : { type: "pageLink", props: { pageId: page.id } };
}

/**
 * Adds a link to `pageId` in a page's content: at `place` (where a trashed page's block was) when given,
 * else after the link to `afterId` when it is there, else at the end.
 */
export async function insertPageLink(parentId: string, pageId: string, afterId?: string, place?: LinkPlace) {
  const parent = await db.blocks.get(parentId);
  if (!parent || parent.type !== "page") return;
  // Pages that haven't been opened yet still hold Markdown: the editor adds their subpages' links
  // when it converts it.
  if (!parent.content && parent.content_markdown?.trim()) return;
  const page = await db.blocks.get(pageId);
  let content = withoutLink((parent.content ?? []) as ContentBlock[], pageId);
  const link = page ? linkBlockFor(page) : { type: "pageLink", props: { pageId } };
  const placed = place ? withLinkAt(content, link, place) : null;
  if (placed) content = placed;
  else {
    const at = afterId ? content.findIndex((b) => linksTo(b, afterId)) : -1;
    if (at === -1) content.push(link);
    else content.splice(at + 1, 0, link);
  }
  await db.blocks.update(parentId, { content });
  announceLink(pageId, parentId, true, findLink(content, pageId) ?? undefined);
}

export async function removePageLink(parentId: string, pageId: string) {
  announceLink(pageId, parentId, false);
  const parent = await db.blocks.get(parentId);
  if (!parent?.content) return;
  const content = withoutLink(parent.content as ContentBlock[], pageId);
  if (JSON.stringify(content) !== JSON.stringify(parent.content)) await db.blocks.update(parentId, { content });
}

/** True when `id` is `ancestorId` or sits somewhere beneath it. */
export async function isInside(id: string, ancestorId: string) {
  let current = await db.blocks.get(id);
  for (let guard = 0; current && guard < 50; guard++) {
    if (current.id === ancestorId) return true;
    if (current.parent_table !== "block") return false;
    current = await db.blocks.get(current.parent_id);
  }
  return false;
}

/**
 * Moves a page under another parent (to the end, or at `order`). Moving a
 * page into itself or one of its subpages is ignored.
 */
export async function movePage(id: string, parentTable: ParentTable, parentId: string, order = now()) {
  const block = await db.blocks.get(id);
  if (!block) return;
  if (parentTable === "block" && (await isInside(parentId, id))) return;
  const before = { parent_table: block.parent_table, parent_id: block.parent_id, order: block.order };
  const after = { parent_table: parentTable, parent_id: parentId, order };
  const apply = async (from: typeof before, to: typeof before) => {
    await updateBlock(id, to);
    if (from.parent_id === to.parent_id) return;
    if (from.parent_table === "block") await removePageLink(from.parent_id, id);
    if (to.parent_table === "block") await insertPageLink(to.parent_id, id);
  };
  await apply(before, after);
  pushUndo({ label: "Mover", undo: () => apply(after, before), redo: () => apply(before, after) });
}

/**
 * "Mover a" a database: the page becomes one of its rows (at the end).
 * A row coming from another database keeps the values whose property has the
 * same name and type there.
 */
export async function moveToDatabase(id: string, collectionId: string) {
  const block = await db.blocks.get(id);
  const target = await db.collections.get(collectionId);
  if (!block || !target || block.type !== "page") return;
  const source = block.parent_table === "collection" ? await db.collections.get(block.parent_id) : undefined;
  const properties: Block["properties"] = { title: block.properties.title ?? "" };
  if (source)
    for (const [pid, value] of Object.entries(block.properties)) {
      const from = source.schema[pid];
      if (pid === "title" || !from) continue;
      const match = Object.entries(target.schema).find(([, s]) => s.name === from.name && s.type === from.type);
      if (match && match[0] !== "title") properties[match[0]] = value;
    }
  const before = { parent_table: block.parent_table, parent_id: block.parent_id, order: block.order, properties: block.properties };
  const after = { parent_table: "collection" as const, parent_id: collectionId, order: await nextRowOrder(collectionId), properties };
  const apply = async (from: typeof before, to: typeof before) => {
    await updateBlock(id, to);
    if (from.parent_table === "block") await removePageLink(from.parent_id, id);
    if (to.parent_table === "block") await insertPageLink(to.parent_id, id);
  };
  await apply(before, after);
  pushUndo({ label: "Mover", undo: () => apply(after, before), redo: () => apply(before, after) });
}

/** Permanently delete a block and everything beneath it. */
export async function purgeBlock(id: string) {
  await db.transaction("rw", db.blocks, db.collections, db.views, async () => {
    const purge = async (blockId: string) => {
      const block = await db.blocks.get(blockId);
      if (!block) return;
      const children = await db.blocks
        .where("[parent_table+parent_id]")
        .equals(["block", blockId])
        .primaryKeys();
      for (const child of children) await purge(child);
      if (block.collection_id) {
        const rows = await db.blocks
          .where("[parent_table+parent_id]")
          .equals(["collection", block.collection_id])
          .primaryKeys();
        for (const row of rows) await purge(row);
        await db.collections.delete(block.collection_id);
        await db.views.where("parent_id").equals(blockId).delete();
      }
      await db.blocks.delete(blockId);
    };
    await purge(id);
  });
}

/** Pages leave the trash for good 30 days after they were trashed. */
export const TRASH_DAYS = 30;

/**
 * Deletes for good what has been in the trash for TRASH_DAYS. Pages trashed
 * before Xot kept the date (or imported already trashed) start counting now.
 */
export async function sweepTrash() {
  const t = now();
  const limit = t - TRASH_DAYS * 86_400_000;
  const dead = await db.blocks.filter((b) => !b.alive).toArray();
  for (const b of dead) {
    if (!b.trashed_time) await db.blocks.update(b.id, { trashed_time: t });
    else if (b.trashed_time < limit && (await db.blocks.get(b.id))) await purgeBlock(b.id);
  }
}

/** Ancestors from the workspace root down to (excluding) the block. */
export async function getAncestors(block: Block): Promise<Block[]> {
  const chain: Block[] = [];
  let current: Block | undefined = block;
  for (let guard = 0; current && guard < 50; guard++) {
    let parentId: string | undefined;
    if (current.parent_table === "block") parentId = current.parent_id;
    else if (current.parent_table === "collection")
      parentId = (await db.collections.get(current.parent_id))?.parent_id;
    if (!parentId) break;
    current = await db.blocks.get(parentId);
    if (current) chain.unshift(current);
  }
  return chain;
}

// ------------------------------------------------------------ databases

export const STATUS_GROUPS: [string, OptionColor][] = [
  ["Por hacer", "gray"],
  ["En curso", "blue"],
  ["Completado", "green"],
];

const DEFAULT_STATUS: [string, OptionColor][] = [
  ["Por hacer", "gray"],
  ["En curso", "blue"],
  ["Hecho", "green"],
];

export async function createDatabase(
  parentTable: ParentTable,
  parentId: string,
  init: { id?: string; title?: string; icon?: string; inline?: boolean } = {},
): Promise<{ blockId: string; collectionId: string; statusId: string; dateId: string }> {
  const blockId = init.id ?? uuid();
  const collectionId = uuid();
  const statusId = shortId();
  const dateId = shortId();
  const collection: Collection = {
    id: collectionId,
    parent_id: blockId,
    schema: {
      title: { name: "Nombre", type: "title" },
      [statusId]: {
        name: "Estado",
        type: "select",
        options: DEFAULT_STATUS.map(([value, color]) => ({ id: shortId(), value, color })),
      },
      [dateId]: { name: "Fecha", type: "date" },
    },
  };
  const properties = ["title", statusId, dateId].map((property) => ({
    property,
    visible: true,
  }));
  const table: CollectionView = {
    id: uuid(),
    type: "table",
    name: "Tabla",
    parent_id: blockId,
    collection_id: collectionId,
    format: { properties },
    query2: emptyQuery(),
  };
  const board: CollectionView = {
    id: uuid(),
    type: "board",
    name: "Tablero",
    parent_id: blockId,
    collection_id: collectionId,
    format: { properties: properties.map((p) => ({ ...p })), board_group_by: statusId },
    query2: emptyQuery(),
  };
  const t = now();
  await db.transaction("rw", db.blocks, db.collections, db.views, async () => {
    await db.collections.add(collection);
    await db.views.bulkAdd([table, board]);
    await db.blocks.add({
      id: blockId,
      type: "collection_view_page",
      parent_id: parentId,
      parent_table: parentTable,
      properties: { title: init.title ?? "" },
      format: { ...(init.icon ? { icon: init.icon } : {}), ...(init.inline ? { inline: true } : {}) },
      content: null,
      collection_id: collectionId,
      view_ids: [table.id, board.id],
      alive: true,
      order: t,
      created_time: t,
      last_edited_time: t,
    });
  });
  return { blockId, collectionId, statusId, dateId };
}

/** "Vista de tablero", "Vista de calendario"…: a new inline database whose only view is that one. */
export async function createDatabaseView(parentId: string, type: ViewType, id = uuid()) {
  const created = await createDatabase("block", parentId, { id, inline: true });
  const block = await db.blocks.get(id);
  const [table, board] = block?.view_ids ?? [];
  if (type === "table" || type === "board") {
    const keep = type === "table" ? table : board;
    await db.views.delete(type === "table" ? board : table);
    await updateBlock(id, { view_ids: [keep] });
    return created;
  }
  const viewId = await addView(id, type);
  if (viewId) {
    await db.views.bulkDelete([table, board]);
    await updateBlock(id, { view_ids: [viewId] });
  }
  return created;
}

export function emptyQuery() {
  return { filter_operator: "and" as const, filters: [], sort: [] };
}

export async function addRow(
  collectionId: string,
  values: Record<string, PropertyValue> = {},
  order?: number,
) {
  return createPage("collection", collectionId, {
    properties: { title: "", ...values },
    order: order ?? (await nextRowOrder(collectionId)),
  });
}

/** An order past every existing row, so a row added without one lands at the end
 * (imported rows carry their source's orders, which can be larger than Date.now()). */
async function nextRowOrder(collectionId: string) {
  let max = now();
  await db.blocks
    .where("[parent_table+parent_id]")
    .equals(["collection", collectionId])
    .each((row) => {
      if (row.order > max) max = row.order;
    });
  return max + 1;
}

/**
 * A new row that starts as a copy of a database template: its values and content
 * (dynamic dates resolved for `at`), and the subpages and databases inside it.
 * `title` replaces the template's (a repeated page's dated title).
 */
export async function addRowFromTemplate(
  collectionId: string,
  templateId: string,
  values: Record<string, PropertyValue> = {},
  opts: { order?: number; at?: number; title?: (title: string) => string } = {},
) {
  const template = await db.blocks.get(templateId);
  if (!template?.alive) return addRow(collectionId, values, opts.order);
  const at = opts.at ?? now();
  const collection = await db.collections.get(collectionId);
  const properties = { ...resolveProperties(structuredClone(template.properties), collection?.schema, at), ...values };
  if (opts.title) properties.title = opts.title(typeof template.properties.title === "string" ? template.properties.title : "");
  const id = await createPage("collection", collectionId, {
    properties,
    format: structuredClone(template.format),
    content: resolveContent(template.content ? structuredClone(template.content) : null, at),
    content_markdown: template.content_markdown,
    order: opts.order ?? (await nextRowOrder(collectionId)),
    ...(opts.at !== undefined ? { created_time: at } : {}),
  });
  await copyTemplateInside(template.id, id);
  return id;
}

/**
 * A template's subpages and databases, copied into the page made from it; links
 * to them, and to the template itself (a linked view filtered to "Esta página"),
 * then point at the copies and the new page.
 */
async function copyTemplateInside(templateId: string, pageId: string) {
  const ids = new Map<string, string>([[templateId, pageId]]);
  await copyChildren(templateId, pageId, ids);
  await remapCopiedContent(ids);
  await remapCopiedViews(ids);
}

/** The copied databases' views: filter values naming a copied page (or the template) follow the copy. */
async function remapCopiedViews(ids: Map<string, string>) {
  const remap = (v: unknown): unknown =>
    typeof v === "string"
      ? (ids.get(v) ?? v)
      : Array.isArray(v)
        ? v.map((x) => (x && typeof x === "object" && "id" in x ? { ...x, id: ids.get((x as PageRef).id) ?? (x as PageRef).id } : remap(x)))
        : v;
  for (const copyId of ids.values()) {
    const block = await db.blocks.get(copyId);
    if (block?.type !== "collection_view_page") continue;
    for (const view of await db.views.where("parent_id").equals(copyId).toArray()) {
      const fix = (f: Filter) => (f.value === undefined ? f : { ...f, value: remap(f.value) as PropertyValue });
      const query2 = {
        ...view.query2,
        filters: view.query2.filters.map(fix),
        filter_groups: view.query2.filter_groups?.map((g) => mapGroupRules(g, fix)),
      };
      if (JSON.stringify(query2) !== JSON.stringify(view.query2)) await db.views.update(view.id, { query2 });
    }
  }
}

/**
 * Fills an empty row from a template (the empty page's template picker): its
 * content, plus the values, icon and cover the row doesn't have yet.
 */
export async function applyTemplate(rowId: string, templateId: string) {
  const [row, template] = await Promise.all([db.blocks.get(rowId), db.blocks.get(templateId)]);
  if (!row || !template) return;
  const kept = Object.fromEntries(
    Object.entries(row.properties).filter(([, v]) => v !== "" && v != null && !(Array.isArray(v) && !v.length)),
  );
  const collection = row.parent_table === "collection" ? await db.collections.get(row.parent_id) : undefined;
  const t = now();
  await updateBlock(rowId, {
    properties: { ...resolveProperties(structuredClone(template.properties), collection?.schema, t), ...kept },
    format: {
      ...structuredClone(template.format),
      ...Object.fromEntries(Object.entries(row.format).filter(([, v]) => v !== undefined)),
    },
    content: resolveContent(template.content ? structuredClone(template.content) : null, t),
    content_markdown: template.content_markdown,
  });
  await copyTemplateInside(template.id, rowId);
}

/** "Personalizar diseño": the order and visibility of the properties on the database's pages. */
export async function setPageLayout(
  collectionId: string,
  patch: Partial<Pick<Collection, "page_properties" | "property_visibility" | "page_layout">>,
) {
  await db.collections.update(collectionId, patch);
}

/** An empty template page for a database ("+ Nueva plantilla"). */
export async function addTemplate(collectionId: string) {
  return createPage("collection", collectionId, { is_template: true, properties: { title: "" } });
}

/** "Duplicar" in a template's menu: another template with the same values and content. */
export async function duplicateTemplate(templateId: string) {
  const template = await db.blocks.get(templateId);
  if (!template) return null;
  const title = typeof template.properties.title === "string" ? template.properties.title : "";
  const id = await createPage("collection", template.parent_id, {
    is_template: true,
    properties: { ...structuredClone(template.properties), title: title ? `${title} (1)` : "" },
    format: structuredClone(template.format),
    content: template.content ? structuredClone(template.content) : null,
    content_markdown: template.content_markdown,
  });
  await copyTemplateInside(template.id, id);
  return id;
}

/** "Establecer como predeterminada": the template "Nuevo" and "+" start from (none to clear it). */
export async function setDefaultTemplate(collectionId: string, templateId: string | undefined) {
  await db.collections.update(collectionId, { default_template: templateId });
}

/** "Para esta vista": the view's own default template ("" a blank page; undefined follows the database's). */
export async function setViewDefaultTemplate(viewId: string, templateId: string | undefined) {
  const view = await db.views.get(viewId);
  if (!view) return;
  const format = { ...view.format, default_template: templateId };
  if (templateId === undefined) delete format.default_template;
  await db.views.update(viewId, { format });
}

/** The template a view's new pages start from: its own, else the database's ("" or undefined: a blank page). */
export const effectiveTemplate = (collection: Pick<Collection, "default_template">, view?: Pick<CollectionView, "format">) =>
  view?.format.default_template !== undefined ? view.format.default_template : collection.default_template;

/** A template's "Repetir" (null turns it off). */
export async function setTemplateRepeat(collectionId: string, templateId: string, repeat: TemplateRepeat | null) {
  await db.transaction("rw", db.collections, async () => {
    const c = await db.collections.get(collectionId);
    if (!c) return;
    const rest = (c.template_repeats ?? []).filter((r) => r.template_id !== templateId);
    await db.collections.update(collectionId, { template_repeats: repeat ? [...rest, repeat] : rest });
  });
}

export async function setRowValue(rowId: string, propertyId: string, value: PropertyValue) {
  const row = await db.blocks.get(rowId);
  if (!row) return;
  const prev = row.properties[propertyId];
  await writeRowValue(rowId, propertyId, value);
  pushUndo({
    label: "Editar propiedad",
    undo: () => writeRowValue(rowId, propertyId, prev),
    redo: () => writeRowValue(rowId, propertyId, value),
    merge: `cell:${rowId}:${propertyId}`,
  });
}

/** A text property's value with its formatting (runs undefined: plain text). One ⌘Z step puts both back. */
export async function setRichText(rowId: string, propertyId: string, text: string, runs: RichRun[] | undefined) {
  const row = await db.blocks.get(rowId);
  if (!row) return;
  const before = { value: row.properties[propertyId], runs: row.rich?.[propertyId] };
  const write = async (value: PropertyValue | undefined, next: RichRun[] | undefined) => {
    const current = await db.blocks.get(rowId);
    if (!current) return;
    const properties = { ...current.properties };
    if (value === undefined) delete properties[propertyId];
    else properties[propertyId] = value;
    const rich = { ...current.rich };
    if (next?.length) rich[propertyId] = next;
    else delete rich[propertyId];
    await updateBlock(rowId, { properties, rich: Object.keys(rich).length ? rich : undefined });
  };
  await write(text, runs);
  pushUndo({
    label: "Editar propiedad",
    undo: () => write(before.value, before.runs),
    redo: () => write(text, runs),
    merge: `cell:${rowId}:${propertyId}`,
  });
}

/** A "Lugar" value: its name and, when known, its coordinates. One ⌘Z step puts both back. */
export async function setPlace(rowId: string, propertyId: string, name: string, coords: { lat: number; lng: number } | undefined) {
  const row = await db.blocks.get(rowId);
  if (!row) return;
  const before = { value: row.properties[propertyId], coords: row.places?.[propertyId] };
  const write = async (value: PropertyValue | undefined, next: PlaceCoords | undefined) => {
    const current = await db.blocks.get(rowId);
    if (!current) return;
    const properties = { ...current.properties };
    if (value === undefined) delete properties[propertyId];
    else properties[propertyId] = value;
    const places = { ...current.places };
    if (next) places[propertyId] = next;
    else delete places[propertyId];
    await updateBlock(rowId, { properties, places: Object.keys(places).length ? places : undefined });
  };
  const after = coords && name ? { name, ...coords } : undefined;
  await write(name || null, after);
  pushUndo({
    label: "Editar propiedad",
    undo: () => write(before.value, before.coords),
    redo: () => write(name || null, after),
    merge: `cell:${rowId}:${propertyId}`,
  });
}

/** A date value's "Zona horaria" (an IANA zone; "" goes back to local time). */
export async function setTimeZone(rowId: string, propertyId: string, tz: string) {
  const row = await db.blocks.get(rowId);
  if (!row || (row.time_zones?.[propertyId] ?? "") === tz) return;
  const zones = { ...row.time_zones };
  if (tz) zones[propertyId] = tz;
  else delete zones[propertyId];
  await updateBlock(rowId, { time_zones: Object.keys(zones).length ? zones : undefined });
}

/** A date property's "Recordatorio" (a lib/reminders.ts code; "" removes it). */
export async function setReminder(rowId: string, propertyId: string, code: string) {
  const row = await db.blocks.get(rowId);
  if (!row || (row.reminders?.[propertyId] ?? "") === code) return;
  const reminders = { ...row.reminders };
  if (code) reminders[propertyId] = code;
  else delete reminders[propertyId];
  await updateBlock(rowId, { reminders: Object.keys(reminders).length ? reminders : undefined });
}

/** Sets one value without recording it (⌘Z and ⌘⇧Z themselves). */
async function writeRowValue(rowId: string, propertyId: string, value: PropertyValue | undefined) {
  const row = await db.blocks.get(rowId);
  if (!row) return;
  const properties = { ...row.properties };
  if (value === undefined) delete properties[propertyId];
  else properties[propertyId] = value;
  await updateBlock(rowId, { properties });
}

export async function updateSchema(
  collectionId: string,
  propertyId: string,
  patch: Partial<PropertySchema>,
) {
  return undoableSchemaEdit("Editar propiedad", collectionId, false, async () => {
    const collection = await db.collections.get(collectionId);
    if (!collection) return;
    const current = collection.schema[propertyId];
    await db.collections.update(collectionId, {
      schema: { ...collection.schema, [propertyId]: { ...current, ...patch } },
    });
  });
}

export async function addProperty(collectionId: string, type: PropertyType) {
  return undoableSchemaEdit("Agregar propiedad", collectionId, false, async () => {
    const collection = await db.collections.get(collectionId);
    if (!collection) return;
    const id = shortId();
    const schema: PropertySchema = { name: PROPERTY_TYPE_LABELS[type], type };
    if (type === "select" || type === "multi_select") schema.options = [];
    if (type === "formula") schema.formula = { kind: "expression", source: "" };
    if (type === "status") {
      schema.options = STATUS_GROUPS.map(([value, color]) => ({ id: shortId(), value, color }));
      schema.groups = STATUS_GROUPS.map(([name, color], i) => ({
        id: shortId(),
        name,
        color,
        option_ids: [schema.options![i].id],
      }));
    }
    await db.transaction("rw", db.collections, db.views, db.blocks, async () => {
      await db.collections.update(collectionId, {
        schema: { ...collection.schema, [id]: schema },
      });
      // A new "ID" numbers the existing rows in the order they were created.
      if (type === "auto_increment_id") {
        const rows = (await db.blocks.where("[parent_table+parent_id]").equals(["collection", collectionId]).toArray())
          .filter((r) => !r.is_template)
          .sort((a, b) => a.created_time - b.created_time || a.order - b.order);
        for (const [i, row] of rows.entries()) await db.blocks.update(row.id, { properties: { ...row.properties, [id]: i + 1 } });
      }
      const views = await db.views.where("parent_id").equals(collection.parent_id).toArray();
      for (const view of views) {
        await db.views.update(view.id, {
          format: {
            ...view.format,
            properties: [...view.format.properties, { property: id, visible: true }],
          },
        });
      }
    });
    return id;
  });
}

export async function deleteProperty(collectionId: string, propertyId: string) {
  return undoableSchemaEdit("Eliminar propiedad", collectionId, false, async () => {
    if (propertyId === "title") return;
    const collection = await db.collections.get(collectionId);
    if (!collection) return;
    const { [propertyId]: _removed, ...schema } = collection.schema;
    await db.transaction("rw", db.collections, db.views, async () => {
      await db.collections.update(collectionId, { schema });
      const views = await db.views.where("parent_id").equals(collection.parent_id).toArray();
      for (const view of views) {
        await db.views.update(view.id, {
          format: {
            ...view.format,
            properties: view.format.properties.filter((p) => p.property !== propertyId),
            board_group_by:
              view.format.board_group_by === propertyId ? undefined : view.format.board_group_by,
          },
          query2: {
            ...view.query2,
            filters: view.query2.filters.filter((f) => f.property !== propertyId),
            filter_groups: view.query2.filter_groups
              ?.map((g) => pruneGroup(g, (f) => f.property !== propertyId))
              .filter((g): g is FilterGroup => !!g),
            sort: view.query2.sort.filter((s) => s.property !== propertyId),
          },
        });
      }
    });
  });
}

/** A copy of a property ("Name (1)") with every row's value, placed right after it in each view. */
export async function duplicateProperty(collectionId: string, propertyId: string) {
  return undoableSchemaEdit("Duplicar propiedad", collectionId, true, async () => {
    if (propertyId === "title") return;
    const collection = await db.collections.get(collectionId);
    const source = collection?.schema[propertyId];
    if (!collection || !source) return;
    const id = shortId();
    // The copy is one-way: the other database keeps pointing at the original only.
    const { synced_property: _synced, ...rest } = structuredClone(source);
    const schema: PropertySchema = { ...rest, name: `${source.name} (1)` };
    await db.transaction("rw", db.collections, db.views, db.blocks, async () => {
      await db.collections.update(collectionId, { schema: { ...collection.schema, [id]: schema } });
      const rows = await db.blocks.where("[parent_table+parent_id]").equals(["collection", collectionId]).toArray();
      for (const row of rows)
        if (row.properties[propertyId] !== undefined)
          await db.blocks.update(row.id, {
            properties: { ...row.properties, [id]: structuredClone(row.properties[propertyId]) },
          });
      const views = await db.views.where("parent_id").equals(collection.parent_id).toArray();
      for (const view of views) {
        const list = view.format.properties.filter((p) => p.property !== id);
        const at = list.findIndex((p) => p.property === propertyId);
        const copy = { ...(at >= 0 ? list[at] : { visible: true }), property: id };
        list.splice(at >= 0 ? at + 1 : list.length, 0, copy);
        await db.views.update(view.id, { format: { ...view.format, properties: list } });
      }
    });
    return id;
  });
}

/** Changing type keeps values that still make sense and drops the rest. */
export async function changePropertyType(
  collectionId: string,
  propertyId: string,
  type: PropertyType,
) {
  return undoableSchemaEdit("Cambiar tipo de propiedad", collectionId, true, async () => {
    const collection = await db.collections.get(collectionId);
    if (!collection) return;
    const prev = collection.schema[propertyId];
    if (!prev || prev.type === type || prev.type === "title") return;
    const isSelect = (t: PropertyType) => t === "select" || t === "multi_select" || t === "status";
    const options = isSelect(type) ? (prev.options ?? []) : undefined;
    const groups =
      type === "status"
        ? STATUS_GROUPS.map(([name, color], i) => ({
            id: shortId(),
            name,
            color,
            option_ids: i === 0 ? (options ?? []).map((o) => o.id) : [],
          }))
        : undefined;
    const formula = type === "formula" ? (prev.formula ?? { kind: "expression" as const, source: "" }) : prev.formula;
    await updateSchema(collectionId, propertyId, { type, options, groups, formula });

    const rows = await db.blocks
      .where("[parent_table+parent_id]")
      .equals(["collection", collectionId])
      .toArray();
    for (const row of rows) {
      const v = row.properties[propertyId];
      if (v === undefined || v === null) continue;
      let next: PropertyValue = null;
      const single = (t: PropertyType) => t === "select" || t === "status";
      if (single(prev.type) && single(type)) next = v;
      else if (single(prev.type) && type === "multi_select") next = [v as string];
      else if (prev.type === "multi_select" && single(type)) next = (v as string[])[0] ?? null;
      else if (["text", "url", "email", "phone_number", "place"].includes(type) && !isSelect(prev.type)) next = String(v);
      else if (type === "number" && !Number.isNaN(Number(v)) && v !== "") next = Number(v);
      await db.blocks.update(row.id, { properties: { ...row.properties, [propertyId]: next } });
    }
  });
}

export async function addOption(
  collectionId: string,
  propertyId: string,
  value: string,
  /** status: the group it joins (the first one when absent). */
  groupId?: string,
): Promise<SelectOption | undefined> {
  return undoableSchemaEdit("Agregar opción", collectionId, false, async () => {
    const collection = await db.collections.get(collectionId);
    const prop = collection?.schema[propertyId];
    if (!prop) return;
    const palette: OptionColor[] = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
    const option: SelectOption = {
      id: shortId(),
      value,
      color: palette[(prop.options?.length ?? 0) % palette.length],
    };
    await updateSchema(collectionId, propertyId, {
      options: [...(prop.options ?? []), option],
      // New status options join the first group (or the group they were added in).
      groups: prop.groups?.map((g, i) =>
        (groupId ? g.id === groupId : i === 0) ? { ...g, option_ids: [...g.option_ids, option.id] } : g,
      ),
    });
    return option;
  });
}

export async function updateOption(
  collectionId: string,
  propertyId: string,
  optionId: string,
  patch: Partial<SelectOption>,
) {
  return undoableSchemaEdit("Editar opción", collectionId, false, async () => {
    const collection = await db.collections.get(collectionId);
    const prop = collection?.schema[propertyId];
    if (!prop) return;
    await updateSchema(collectionId, propertyId, {
      options: (prop.options ?? []).map((o) => (o.id === optionId ? { ...o, ...patch } : o)),
    });
  });
}

export async function deleteOption(collectionId: string, propertyId: string, optionId: string) {
  return undoableSchemaEdit("Eliminar opción", collectionId, true, async () => {
    const collection = await db.collections.get(collectionId);
    const prop = collection?.schema[propertyId];
    if (!prop) return;
    await updateSchema(collectionId, propertyId, {
      options: (prop.options ?? []).filter((o) => o.id !== optionId),
      groups: prop.groups?.map((g) => ({ ...g, option_ids: g.option_ids.filter((id) => id !== optionId) })),
    });
    const rows = await db.blocks
      .where("[parent_table+parent_id]")
      .equals(["collection", collectionId])
      .toArray();
    for (const row of rows) {
      const v = row.properties[propertyId];
      if (v === optionId)
        await db.blocks.update(row.id, { properties: { ...row.properties, [propertyId]: null } });
      else if (Array.isArray(v) && (v as string[]).includes(optionId))
        await db.blocks.update(row.id, {
          properties: { ...row.properties, [propertyId]: (v as string[]).filter((x) => x !== optionId) },
        });
    }
  });
}

// ----------------------------------------------------------- relations

/**
 * Sets the pages a relation points to. Two-way relations also update the
 * matching property on the other pages. `record` false leaves it
 * out of ⌘Z (the value a just-created row starts with).
 */
export async function setRelation(rowId: string, propertyId: string, refs: PageRef[], record = true) {
  const row = await db.blocks.get(rowId);
  const collection = row ? await db.collections.get(row.parent_id) : undefined;
  const prop = collection?.schema[propertyId];
  if (!row || !prop) return;
  const before = new Set(((row.properties[propertyId] as PageRef[] | undefined) ?? []).map((r) => r.id));
  const after = new Set(refs.map((r) => r.id));
  const synced = prop.synced_property;
  // The other side limited to one page ("Parent item"): linking replaces its link.
  const other = synced && prop.collection_id ? await db.collections.get(prop.collection_id) : undefined;
  const single = !!(other && synced && relationLimit(other, synced) === 1);
  // Every page this touches, as it was: one ⌘Z step puts both sides back.
  const previous = new Map<string, Block["properties"]>([[rowId, row.properties]]);
  await db.transaction("rw", db.blocks, async () => {
    await updateBlock(rowId, { properties: { ...row.properties, [propertyId]: refs } });
    if (!synced) return;
    const self: PageRef = { id: rowId, name: String(row.properties.title ?? "") };
    for (const id of new Set([...before, ...after])) {
      if (before.has(id) === after.has(id)) continue;
      const target = await db.blocks.get(id);
      if (!target) continue;
      const current = ((target.properties[synced] as PageRef[] | undefined) ?? []).filter((r) => r.id !== rowId);
      if (after.has(id) && single)
        // The page it was linked to loses it, so both sides stay in sync.
        for (const old of current) {
          const page = await db.blocks.get(old.id);
          const links = (page?.properties[propertyId] as PageRef[] | undefined) ?? [];
          if (page && links.some((r) => r.id === id)) {
            if (!previous.has(old.id)) previous.set(old.id, page.properties);
            await db.blocks.update(old.id, { properties: { ...page.properties, [propertyId]: links.filter((r) => r.id !== id) } });
          }
        }
      if (!previous.has(id)) previous.set(id, target.properties);
      const next = after.has(id) ? (single ? [self] : [...current, self]) : current;
      await db.blocks.update(id, { properties: { ...target.properties, [synced]: next } });
    }
  });
  if (!record) return;
  const ids = [...previous.keys()];
  const changed = new Map((await db.blocks.bulkGet(ids)).flatMap((b) => (b ? [[b.id, b.properties] as const] : [])));
  const put = (state: Map<string, Block["properties"]>) =>
    db.transaction("rw", db.blocks, async () => {
      for (const [id, properties] of state) await db.blocks.update(id, { properties });
    });
  pushUndo({ label: "Editar propiedad", undo: () => put(previous), redo: () => put(changed) });
}

/**
 * New rows at the end of a database, with its schema replaced by `schema` (new
 * properties in `added` join every view): one ⌘Z step that removes the rows again.
 */
export async function appendRows(
  collectionId: string,
  schema: Record<string, PropertySchema>,
  added: string[],
  values: Block["properties"][],
  label: string,
) {
  const before = await databaseState(collectionId, false);
  if (!before) return;
  // Each "ID" property continues from the highest number in the database.
  const existing = await db.blocks.where("[parent_table+parent_id]").equals(["collection", collectionId]).toArray();
  const counters = Object.entries(schema)
    .filter(([, p]) => p.type === "auto_increment_id")
    .map(([id]) => [id, existing.reduce((max, r) => (typeof r.properties[id] === "number" ? Math.max(max, r.properties[id] as number) : max), 0)] as [string, number]);
  const t = now();
  const start = await nextRowOrder(collectionId);
  const rows: Block[] = values.map((properties, i) => ({
    id: uuid(),
    type: "page",
    parent_id: collectionId,
    parent_table: "collection",
    properties: { ...properties, ...Object.fromEntries(counters.map((c) => [c[0], ++c[1]])) },
    format: {},
    content: null,
    alive: true,
    order: start + i,
    created_time: t,
    last_edited_time: t,
  }));
  await db.transaction("rw", db.collections, db.views, db.blocks, async () => {
    await db.collections.update(collectionId, { schema });
    if (added.length) {
      const owners = (await db.blocks.toArray()).filter((b) => b.collection_id === collectionId);
      for (const owner of owners)
        for (const view of await db.views.where("parent_id").equals(owner.id).toArray())
          await db.views.update(view.id, {
            format: { ...view.format, properties: [...view.format.properties, ...added.map((property) => ({ property, visible: true }))] },
          });
    }
    await db.blocks.bulkAdd(rows);
  });
  const after = await databaseState(collectionId, false);
  const ids = rows.map((r) => r.id);
  pushUndo({
    label,
    undo: async () => {
      await db.blocks.bulkDelete(ids);
      await putDatabaseState(before);
    },
    redo: async () => {
      if (after) await putDatabaseState(after);
      await db.blocks.bulkPut(rows);
    },
  });
}

async function appendToViews(collection: Collection, propertyId: string, visible = true) {
  const blocks = (await db.blocks.toArray()).filter((b) => b.collection_id === collection.id);
  for (const block of blocks)
    for (const view of await db.views.where("parent_id").equals(block.id).toArray())
      await db.views.update(view.id, {
        format: { ...view.format, properties: [...view.format.properties, { property: propertyId, visible }] },
      });
}

/** A relation to another database; two-way adds the matching property over there. */
export async function addRelationProperty(collectionId: string, targetCollectionId: string, twoWay: boolean) {
  const source = await db.collections.get(collectionId);
  const target = await db.collections.get(targetCollectionId);
  if (!source || !target) return;
  const titleOf = async (c: Collection) => String((await db.blocks.get(c.parent_id))?.properties.title || "Relación");
  const id = shortId();
  const reverseId = twoWay && targetCollectionId !== collectionId ? shortId() : undefined;
  await db.transaction("rw", db.collections, db.views, db.blocks, async () => {
    await db.collections.update(collectionId, {
      schema: {
        ...source.schema,
        [id]: { name: await titleOf(target), type: "relation", collection_id: targetCollectionId, synced_property: reverseId },
      },
    });
    await appendToViews(source, id);
    if (reverseId) {
      await db.collections.update(targetCollectionId, {
        schema: {
          ...target.schema,
          [reverseId]: { name: await titleOf(source), type: "relation", collection_id: collectionId, synced_property: id },
        },
      });
      await appendToViews(target, reverseId);
    }
  });
  return id;
}

/**
 * "Mostrar en <base de datos>" on an existing relation: on adds the matching property in the
 * other database (filled from the links there are), off deletes it. One ⌘Z step puts both back.
 */
export async function setRelationTwoWay(collectionId: string, propertyId: string, on: boolean) {
  const source = await db.collections.get(collectionId);
  const prop = source?.schema[propertyId];
  const targetId = prop?.collection_id;
  if (!source || !prop || prop.type !== "relation" || !targetId || !!prop.synced_property === on) return;
  if (!(await db.collections.get(targetId))) return;
  const ids = [...new Set([collectionId, targetId])];
  const before = await Promise.all(ids.map((id) => databaseState(id, true)));
  recording++;
  try {
    if (on) {
      const reverseId = shortId();
      let title = String((await db.blocks.get(source.parent_id))?.properties.title || "Relación");
      // A database related to itself: the pair are two properties side by side, so they can't share a name.
      if (targetId === collectionId) {
        const names = new Set(Object.values(source.schema).map((p) => p.name));
        let n = 1;
        while (names.has(`${title} (${n})`)) n++;
        title = names.has(title) ? `${title} (${n})` : title;
      }
      await db.transaction("rw", db.collections, db.views, db.blocks, async () => {
        await db.collections.update(collectionId, {
          schema: { ...source.schema, [propertyId]: { ...prop, synced_property: reverseId } },
        });
        const target = (await db.collections.get(targetId))!;
        await db.collections.update(targetId, {
          schema: {
            ...target.schema,
            [reverseId]: { name: title, type: "relation", collection_id: collectionId, synced_property: propertyId },
          },
        });
        await appendToViews(target, reverseId);
        // The pages linked so far link back.
        const back = new Map<string, PageRef[]>();
        const rows = await db.blocks.where("[parent_table+parent_id]").equals(["collection", collectionId]).toArray();
        for (const row of rows)
          for (const ref of (row.properties[propertyId] as PageRef[] | undefined) ?? [])
            back.set(ref.id, [...(back.get(ref.id) ?? []), { id: row.id, name: String(row.properties.title ?? "") }]);
        for (const [id, refs] of back) {
          const page = await db.blocks.get(id);
          if (page?.parent_table === "collection" && page.parent_id === targetId)
            await db.blocks.update(id, { properties: { ...page.properties, [reverseId]: refs } });
        }
      });
    } else {
      const reverseId = prop.synced_property!;
      await db.collections.update(collectionId, {
        schema: { ...source.schema, [propertyId]: { ...prop, synced_property: undefined } },
      });
      const target = await db.collections.get(targetId);
      if (target?.schema[reverseId]?.synced_property === propertyId) await deleteProperty(targetId, reverseId);
    }
  } finally {
    recording--;
  }
  const after = await Promise.all(ids.map((id) => databaseState(id, true)));
  if (before.every(Boolean) && after.every(Boolean))
    pushUndo({
      label: "Editar propiedad",
      undo: async () => void (await Promise.all(before.map((s) => putDatabaseState(s!)))),
      redo: async () => void (await Promise.all(after.map((s) => putDatabaseState(s!)))),
    });
}

/**
 * The timeline's dependencies ("Bloqueado por" / "Bloqueando"): a two-way relation of the
 * database to itself. An existing pair with those names is reused.
 */
export async function addDependencyProperties(collectionId: string) {
  const collection = await db.collections.get(collectionId);
  if (!collection) return;
  const existing = Object.entries(collection.schema).find(
    ([, s]) =>
      s.type === "relation" &&
      s.name === "Bloqueado por" &&
      s.collection_id === collectionId &&
      !!s.synced_property &&
      collection.schema[s.synced_property]?.type === "relation",
  );
  if (existing) return { blocked_by: existing[0], blocking: existing[1].synced_property! };
  const blockedBy = shortId();
  const blocking = shortId();
  await db.transaction("rw", db.collections, db.views, db.blocks, async () => {
    await db.collections.update(collectionId, {
      schema: {
        ...collection.schema,
        [blockedBy]: { name: "Bloqueado por", type: "relation", collection_id: collectionId, synced_property: blocking },
        [blocking]: { name: "Bloqueando", type: "relation", collection_id: collectionId, synced_property: blockedBy },
      },
    });
    // Hidden at first, so the bars' labels don't repeat what the arrows show.
    await appendToViews(collection, blockedBy, false);
    const fresh = await db.collections.get(collectionId);
    if (fresh) await appendToViews(fresh, blocking, false);
  });
  return { blocked_by: blockedBy, blocking };
}

/**
 * "Activar subelementos": a two-way relation of the database to itself
 * ("Elemento principal", limited to one page, and "Subelemento") that nests rows.
 * An existing pair is reused.
 */
export async function enableSubitems(collectionId: string, viewId?: string) {
  return undoableSchemaEdit("Activar subelementos", collectionId, false, async () => {
    const collection = await db.collections.get(collectionId);
    if (!collection) return;
    const found = subitemConfig({ ...collection, subitems_off: false });
    const parent = found?.parent ?? shortId();
    const children = found?.children ?? shortId();
    await db.transaction("rw", db.collections, db.views, db.blocks, async () => {
      const schema = { ...collection.schema };
      if (!found) {
        schema[parent] = { name: "Elemento principal", type: "relation", collection_id: collectionId, synced_property: children, limit: 1 };
        schema[children] = { name: "Subelemento", type: "relation", collection_id: collectionId, synced_property: parent };
      }
      await db.collections.update(collectionId, { schema, subitems: { parent, children }, subitems_off: false });
      if (!found) {
        const fresh = await db.collections.get(collectionId);
        if (fresh) await appendToViews(fresh, parent);
        const fresher = await db.collections.get(collectionId);
        if (fresher) await appendToViews(fresher, children);
      }
      const view = viewId ? await db.views.get(viewId) : undefined;
      if (view) await db.views.update(view.id, { format: { ...view.format, subitems_display: "nested" } });
    });
    return { parent, children };
  });
}

/** "Desactivar subelementos": rows stop nesting; `removeProperties` also deletes the relation pair. */
export async function disableSubitems(collectionId: string, removeProperties: boolean) {
  return undoableSchemaEdit("Desactivar subelementos", collectionId, true, async () => {
    const collection = await db.collections.get(collectionId);
    if (!collection) return;
    const pair = subitemConfig(collection);
    await db.collections.update(collectionId, { subitems: undefined, subitems_off: true });
    if (removeProperties && pair) {
      await deleteProperty(collectionId, pair.parent);
      await deleteProperty(collectionId, pair.children);
    }
  });
}

/** A rollup over the first relation, counting related pages until configured. */
export async function addRollupProperty(collectionId: string) {
  const collection = await db.collections.get(collectionId);
  if (!collection) return;
  const relation = Object.entries(collection.schema).find(([, s]) => s.type === "relation")?.[0];
  const id = shortId();
  await db.transaction("rw", db.collections, db.views, db.blocks, async () => {
    await db.collections.update(collectionId, {
      schema: {
        ...collection.schema,
        [id]: {
          name: "Rollup",
          type: "rollup",
          rollup: { relation: relation ?? "", target: "title", aggregation: "count" },
        },
      },
    });
    await appendToViews(collection, id);
  });
  return id;
}

/** Another view of an existing database, shown inside a page. */
export async function createLinkedView(collectionId: string, parentPageId: string, id = uuid()) {
  const collection = await db.collections.get(collectionId);
  const source = collection ? await db.blocks.get(collection.parent_id) : undefined;
  if (!collection) return;
  const t = now();
  const view: CollectionView = {
    id: uuid(),
    type: "table",
    name: "Tabla",
    parent_id: id,
    collection_id: collectionId,
    format: { properties: Object.keys(collection.schema).map((property) => ({ property, visible: true })) },
    query2: emptyQuery(),
  };
  await db.transaction("rw", db.blocks, db.views, async () => {
    await db.views.add(view);
    await db.blocks.add({
      id,
      type: "collection_view_page",
      parent_id: parentPageId,
      parent_table: "block",
      properties: { title: String(source?.properties.title ?? "") },
      format: { ...(source?.format.icon ? { icon: source.format.icon } : {}), inline: true },
      content: null,
      collection_id: collectionId,
      view_ids: [view.id],
      alive: true,
      order: t,
      created_time: t,
      last_edited_time: t,
    });
  });
  return id;
}

// ---------------------------------------------------------------- views

export async function updateView(id: string, patch: Partial<CollectionView>) {
  const before = await db.views.get(id);
  await db.views.update(id, patch);
  const after = await db.views.get(id);
  if (before && after)
    pushUndo({
      label: "Editar vista",
      undo: async () => void (await db.views.put(before)),
      redo: async () => void (await db.views.put(after)),
      merge: `view:${id}`,
    });
}

/**
 * Moves a row in a view's own manual order (page_sort): right before `before`, else right
 * after `after`, else to the end. `shown` is the view's rows as laid out; the ones the order
 * doesn't list yet are added in that order, so nothing else moves.
 */
export async function placeInViewOrder(
  viewId: string,
  shown: string[],
  rowId: string,
  { before, after }: { before?: string; after?: string },
) {
  const view = await db.views.get(viewId);
  if (!view?.format.page_sort) return;
  const ids = [...view.format.page_sort];
  const listed = new Set(ids);
  for (const id of shown) if (!listed.has(id)) ids.push(id);
  const from = ids.indexOf(rowId);
  if (from !== -1) ids.splice(from, 1);
  const target = before ?? after;
  const i = target ? ids.indexOf(target) : -1;
  ids.splice(i === -1 ? ids.length : before ? i : i + 1, 0, rowId);
  await db.views.update(viewId, { format: { ...view.format, page_sort: ids } });
}

const VIEW_NAMES: Record<ViewType, string> = {
  table: "Tabla",
  board: "Tablero",
  list: "Lista",
  gallery: "Galería",
  calendar: "Calendario",
  timeline: "Cronograma",
  chart: "Gráfico",
  feed: "Feed",
  form: "Formulario",
  dashboard: "Panel de control",
  map: "Mapa",
};

export async function addView(databaseId: string, type: ViewType) {
  const block = await db.blocks.get(databaseId);
  const collection = block?.collection_id
    ? await db.collections.get(block.collection_id)
    : undefined;
  if (!block || !collection) return;
  let groupBy: string | undefined;
  if (type === "board") {
    groupBy = Object.entries(collection.schema).find(([, s]) => s.type === "status" || s.type === "select")?.[0];
    if (!groupBy) {
      groupBy = await addProperty(collection.id, "select");
      if (groupBy) await updateSchema(collection.id, groupBy, { name: "Estado" });
      for (const [value] of DEFAULT_STATUS) if (groupBy) await addOption(collection.id, groupBy, value);
    }
  }
  // A map needs a "Lugar" to place its pins: one is added when the database has none.
  if (type === "map" && !Object.values(collection.schema).some((s) => s.type === "place")) await addProperty(collection.id, "place");
  const fresh = (await db.collections.get(collection.id))!;
  const ordered = ["title", ...Object.keys(fresh.schema).filter((k) => k !== "title")];
  const view: CollectionView = {
    id: uuid(),
    type,
    name: VIEW_NAMES[type],
    parent_id: databaseId,
    collection_id: collection.id,
    format: {
      // Cards (board, gallery) start with only the title.
      properties: ordered.map((property) => ({
        property,
        visible: property === "title" || type === "table" || type === "list",
      })),
      board_group_by: groupBy,
    },
    query2: emptyQuery(),
  };
  if (type === "chart") view.format.chart = defaultChart(fresh);
  if (type === "calendar")
    view.format.calendar_by = Object.entries(fresh.schema).find(([, s]) => s.type === "date")?.[0];
  if (type === "gallery") view.format.gallery_cover = { type: "page_content" };
  if (type === "timeline") {
    view.format.timeline_by = Object.entries(fresh.schema).find(([, s]) => s.type === "date")?.[0];
    view.format.timeline_zoom = "month";
  }
  if (type === "dashboard") view.format.dashboard = { rows: [] };
  if (type === "map") view.format.map_by = Object.entries(fresh.schema).find(([, s]) => s.type === "place")?.[0];
  await db.views.add(view);
  await updateBlock(databaseId, { view_ids: [...(block.view_ids ?? []), view.id] });
  return view.id;
}

// ------------------------------------------------------------- widgets

export type WidgetKind = "number" | "column" | "bar" | "line" | "donut" | "table" | "list" | "board" | "calendar" | "timeline" | "gallery";

/** Adds a widget (a view of any collection) to a dashboard, filling rows four at a time. */
export async function addWidget(dashboardId: string, collectionId: string, kind: WidgetKind) {
  const dashboard = await db.views.get(dashboardId);
  const collection = await db.collections.get(collectionId);
  if (!dashboard || !collection) return;
  const isChart = kind === "number" || kind === "column" || kind === "bar" || kind === "line" || kind === "donut";
  const ordered = ["title", ...Object.keys(collection.schema).filter((k) => k !== "title")];
  const firstOf = (...types: PropertyType[]) => Object.entries(collection.schema).find(([, s]) => types.includes(s.type))?.[0];
  const cards = kind === "board" || kind === "gallery" || kind === "calendar" || kind === "timeline";
  const widget: CollectionView = {
    id: uuid(),
    type: isChart ? "chart" : (kind as ViewType),
    name: isChart ? (kind === "number" ? "Total" : "Gráfico") : VIEW_NAMES[kind as ViewType],
    parent_id: dashboardId,
    collection_id: collectionId,
    format: {
      // Cards start with only the title; a table widget's columns start narrow.
      properties: ordered.map((property) => ({
        property,
        visible: !cards || property === "title",
        ...(kind === "table" ? { width: property === "title" ? 180 : 120 } : {}),
      })),
      ...(isChart ? { chart: defaultChart(collection, kind as ChartType) } : kind === "table" || kind === "list" ? { table_wrap: false } : {}),
      ...(kind === "board" ? { board_group_by: firstOf("status", "select") } : {}),
      ...(kind === "calendar" ? { calendar_by: firstOf("date") } : {}),
      ...(kind === "timeline" ? { timeline_by: firstOf("date"), timeline_zoom: "month" as const } : {}),
      ...(kind === "gallery" ? { gallery_cover: { type: "page_content" as const } } : {}),
    },
    query2: emptyQuery(),
  };
  const rows = [...(dashboard.format.dashboard?.rows ?? [])];
  const last = rows[rows.length - 1];
  if (last && last.widgets.length < 4) rows[rows.length - 1] = { ...last, widgets: [...last.widgets, widget.id] };
  else rows.push({ id: shortId(), height: kind === "number" ? 200 : 360, widgets: [widget.id] });
  await db.transaction("rw", db.views, async () => {
    await db.views.add(widget);
    await db.views.update(dashboardId, { format: { ...dashboard.format, dashboard: { ...dashboard.format.dashboard, rows } } });
  });
  return widget.id;
}

export async function removeWidget(dashboardId: string, widgetId: string) {
  const dashboard = await db.views.get(dashboardId);
  if (!dashboard) return;
  const rows = (dashboard.format.dashboard?.rows ?? [])
    .map((r) => ({ ...r, widgets: r.widgets.filter((w) => w !== widgetId) }))
    .filter((r) => r.widgets.length);
  await db.transaction("rw", db.views, async () => {
    await db.views.update(dashboardId, { format: { ...dashboard.format, dashboard: { ...dashboard.format.dashboard, rows } } });
    await db.views.delete(widgetId);
  });
}

export async function setDashboardRowHeight(dashboardId: string, rowId: string, height: number) {
  const dashboard = await db.views.get(dashboardId);
  if (!dashboard?.format.dashboard) return;
  const rows = dashboard.format.dashboard.rows.map((r) => (r.id === rowId ? { ...r, height } : r));
  await db.views.update(dashboardId, { format: { ...dashboard.format, dashboard: { ...dashboard.format.dashboard, rows } } });
}

/** "Duplicar vista": a copy of the view (format, filters, sorts) right after it. */
export async function duplicateView(databaseId: string, viewId: string) {
  const block = await db.blocks.get(databaseId);
  const view = await db.views.get(viewId);
  if (!block || !view) return;
  const copy: CollectionView = {
    ...structuredClone(view),
    id: uuid(),
    name: `${view.name} (copia)`,
  };
  const ids = [...(block.view_ids ?? [])];
  const at = ids.indexOf(viewId);
  ids.splice(at === -1 ? ids.length : at + 1, 0, copy.id);
  await db.views.add(copy);
  await updateBlock(databaseId, { view_ids: ids });
  return copy.id;
}

export async function deleteView(databaseId: string, viewId: string) {
  const block = await db.blocks.get(databaseId);
  if (!block || (block.view_ids?.length ?? 0) <= 1) return;
  await db.views.delete(viewId);
  await updateBlock(databaseId, { view_ids: block.view_ids!.filter((v) => v !== viewId) });
}

