// Which workspace a page belongs to, shared by the menus that list pages
// (Buscar, the "@" and link-to-page menus): each only lists the pages of the
// workspace the sidebar shows.

import { useSyncExternalStore } from "react";
import { db } from "./db";
import { WORKSPACE_ID, isWorkspaceRoot, type Block, type Collection } from "./model";
import { getAncestors } from "./ops";

/** The local space's name and icon, which have no block to live on (Sidebar and Configuración). */
export const LOCAL_WORKSPACE_KEY = "xotion:local-workspace";
/** Fired after Configuración › General changes them, so the sidebar re-reads them. */
export const LOCAL_WORKSPACE_EVENT = "xot:local-workspace";

/** Fired by the Sidebar after it stores a new workspace. */
export const WORKSPACE_EVENT = "xot:workspace";

/** The stored workspace, re-rendering when the sidebar switches it. */
export function useStoredWorkspace(): string {
  return useSyncExternalStore((onChange) => {
    window.addEventListener(WORKSPACE_EVENT, onChange);
    return () => window.removeEventListener(WORKSPACE_EVENT, onChange);
  }, currentWorkspace);
}

/** The workspace the sidebar shows (Sidebar keeps it in localStorage). */
export function currentWorkspace(): string {
  try {
    const ws = JSON.parse(localStorage.getItem("xotion:workspace") ?? '""');
    return typeof ws === "string" ? ws : "";
  } catch {
    return "";
  }
}

/**
 * The stored workspace, or the one the sidebar falls back to when nothing is
 * stored: the first imported workspace, else the local one. `blocks` is every block.
 */
export function resolveWorkspace(blocks: Block[]): string {
  const stored = currentWorkspace();
  const roots = blocks
    .filter((b) => b.alive && !b.is_template && b.parent_table === "space" && b.parent_id === WORKSPACE_ID)
    .sort((a, b) => a.order - b.order);
  const spaces = roots.filter((b) => isWorkspaceRoot(b.id));
  const hasLocal = spaces.length === 0 || roots.some((b) => !isWorkspaceRoot(b.id));
  const ids = [...spaces.map((b) => b.id), ...(hasLocal ? [WORKSPACE_ID] : [])];
  return ids.includes(stored) ? stored : (ids[0] ?? stored);
}

/** A function that walks a page up to its root (a workspace block, or a loose top-level page). */
export function rootFinder(blocks: Block[], collections: Collection[]) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const colls = new Map(collections.map((c) => [c.id, c]));
  const parentOf = (b: Block) =>
    b.parent_table === "block"
      ? byId.get(b.parent_id)
      : b.parent_table === "collection"
        ? byId.get(colls.get(b.parent_id)?.parent_id ?? "")
        : undefined;
  return (b: Block) => {
    let root = b;
    for (let p = parentOf(b), guard = 0; p && guard < 50; p = parentOf(p), guard++) root = p;
    return root;
  };
}

/** Whether a page whose root is `root` belongs to workspace `ws` ("" lists every page). */
export function inWorkspace(root: Block, ws: string): boolean {
  if (!ws) return true;
  if (isWorkspaceRoot(ws)) return root.id === ws;
  return ws === WORKSPACE_ID && !isWorkspaceRoot(root.id) && root.parent_table === "space";
}

/** resolveWorkspace() read straight from the db: it only needs the top-level blocks. */
export async function loadWorkspace(): Promise<string> {
  return resolveWorkspace(await db.blocks.where("[parent_table+parent_id]").equals(["space", WORKSPACE_ID]).toArray());
}

/** Whether a page (or row) is in workspace `ws`; a page that no longer exists counts as in it. */
export async function pageInWorkspace(id: string, ws: string): Promise<boolean> {
  const b = await db.blocks.get(id);
  if (!b) return true;
  return inWorkspace((await getAncestors(b))[0] ?? b, ws);
}
