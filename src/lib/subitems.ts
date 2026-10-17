// Sub-items (nested rows): the tree a view draws, and which rows its filter keeps.
import type { Block, CollectionView, PageRef } from "./model";
import { useStoredState } from "./hooks";

/**
 * Which rows of a view show their sub-items: the ones opened by hand, or (with "Mostrar
 * subelementos desplegados") all but the ones closed by hand. Kept per view on this device.
 */
export function useSubitemToggles(view: CollectionView) {
  const all = !!view.format.subitems_expanded;
  // Both lists are kept, so switching the setting goes back to each one's own state.
  const opened = useStoredState<string[]>(`xotion:sub:${view.id}`, []);
  const closed = useStoredState<string[]>(`xotion:subc:${view.id}`, []);
  const [list, setList] = all ? closed : opened;
  const isOpen = (id: string) => (all ? !list.includes(id) : list.includes(id));
  const toggle = (id: string) => setList((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  const open = (id: string) => setList((l) => (all ? l.filter((x) => x !== id) : l.includes(id) ? l : [...l, id]));
  return { isOpen, toggle, open };
}

/** Sub-items: top-level rows (no parent, or one the view doesn't show) and each row's children. */
export function buildTree(rows: Block[], parentProp: string) {
  const ids = new Set(rows.map((r) => r.id));
  const parentOf = (r: Block) =>
    ((r.properties[parentProp] as PageRef[] | undefined) ?? []).map((p) => p.id).find((id) => id !== r.id && ids.has(id));
  const children = new Map<string, Block[]>();
  const parents = new Map<string, string>();
  const roots: Block[] = [];
  for (const r of rows) {
    const p = parentOf(r);
    if (!p) roots.push(r);
    else {
      parents.set(r.id, p);
      children.set(p, [...(children.get(p) ?? []), r]);
    }
  }
  // Rows caught in a parent loop are reachable from no root: they show at the top level.
  const reached = new Set<string>();
  const walk = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    for (const c of children.get(id) ?? []) walk(c.id);
  };
  roots.forEach((r) => walk(r.id));
  for (const r of rows)
    if (!reached.has(r.id)) {
      roots.push(r);
      parents.delete(r.id);
      walk(r.id);
    }
  return { roots: rows.filter((r) => roots.includes(r)), children, parents };
}

/**
 * The sub-item filter: which rows a view's filter applies to. "parents" keeps the
 * top-level rows that match and all their sub-items; "subitems" keeps every top-level row
 * and the sub-items that match; "both" (default) keeps the rows that match. `all` is every
 * row in the view's order, `matched` the ones its filter keeps.
 */
export function filterWithSubitems(
  all: Block[],
  matched: Block[],
  parentProp: string,
  mode: NonNullable<CollectionView["format"]["subitems_filter"]>,
): Block[] {
  if (mode === "both" || all.length === matched.length) return matched;
  const ids = new Set(all.map((r) => r.id));
  const parentOf = new Map<string, string>();
  for (const r of all) {
    const p = ((r.properties[parentProp] as PageRef[] | undefined) ?? []).map((x) => x.id).find((id) => id !== r.id && ids.has(id));
    if (p) parentOf.set(r.id, p);
  }
  const keep = new Set(matched.map((r) => r.id));
  /** The top-level row a row nests under (itself at the top); loops count as top level. */
  const rootOf = (id: string) => {
    const seen = new Set<string>();
    while (parentOf.has(id) && !seen.has(id)) {
      seen.add(id);
      id = parentOf.get(id)!;
    }
    return id;
  };
  return all.filter((r) => {
    const top = !parentOf.has(r.id);
    return mode === "parents" ? keep.has(rootOf(r.id)) : top || keep.has(r.id);
  });
}
