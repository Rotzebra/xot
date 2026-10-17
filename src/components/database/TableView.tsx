import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  CornerUpRight,
  GripVertical,
  Link,
  Maximize2,
  PanelRight,
  Plus,
  Trash,
  X,
  SquareArrowOutUpRight,
} from "lucide-react";
import {
  COMPUTED_TYPES,
  READ_ONLY_TYPES,
  type Block,
  type CalcType,
  type Collection,
  type CollectionView,
  type PageRef,
  type PropertySchema,
  type PropertyValue,
  type ViewProperty,
} from "../../lib/model";
import {
  addOption,
  addProperty,
  addRow,
  duplicatePage,
  duplicateProperty,
  setRelation,
  setRowValue,
  trashBlock,
  updateBlock,
  updateView,
} from "../../lib/ops";
import { computeCalc } from "../../lib/calc";
import { subitemConfig } from "../../lib/query";
import { buildTree, useSubitemToggles } from "../../lib/subitems";
import { tintClass, useRowColors } from "./ConditionalColor";
import { groupRows, splitHidden, useComputed, useGroupValues, viewGrouping, type RowGroup } from "../../lib/group";
import { HAS_TABS, navigate, openInNewTab, pageTitle, useStoredState } from "../../lib/hooks";
import { copyLink, hasOpenPopover, MenuItem, MenuSeparator, pointerAnchor, Popover, toast, trashWithUndo, usePopover } from "../ui";
import { AddPropertyMenu, formatDate, PropertyCell, PropertyMenu, propertyTooltip, TypeIcon } from "./properties";
import { PropertyCommentButton } from "./PropertyComments";
import { CalcMenu } from "./CalcMenu";
import { GroupHeader, HiddenGroupsToggle } from "./GroupHeader";
import { defaultsFromQuery, viewProperties } from "./DatabaseView";
import { LoadMore, useLoadLimit } from "./loadLimit";
import { useMoveMenu } from "../MovePicker";

const DEFAULT_WIDTH: Record<string, number> = { title: 280 };
const MIN_WIDTH = 80;
const ROW_TYPE = "application/x-xot-row";
const COLUMN_TYPE = "application/x-xot-column";

type Drop = { id: string; side: "before" | "after" };

/**
 * A table line: a row at some depth (sub-items), or the "Nuevo subítem" button
 * under an open row. `key` is unique per line: grouped by a multi-valued
 * property, a row shows in each of its groups.
 */
type RowLine = { key: string; row: Block; depth: number; kids: number; parent?: string; section: number };
type Line = RowLine | { key: string; newUnder: Block; depth: number; section: number };

/** A run of rows: one per group, or the whole table when it isn't grouped. */
interface Section {
  group: RowGroup | null;
  rows: Block[];
  topLevel: Block[];
  lines: Line[];
}

/** A selected cell (blue ring), by line key and property. */
type Cell = { line: string; prop: string };

/** A rectangle of cells, by line and column index (inclusive). */
type Box = { r0: number; r1: number; c0: number; c1: number };

/** Clipboard text as rows of cells: tab-separated lines, with spreadsheet-style quoted cells. */
function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** A cell's text as it reads, without its "Abrir" button or sub-item toggle. */
function cellText(td: HTMLElement | undefined) {
  if (!td) return "";
  const extras = [...td.querySelectorAll<HTMLElement>(".open-btn, .tr__toggle")];
  extras.forEach((el) => (el.style.display = "none"));
  const text = td.innerText.trim();
  extras.forEach((el) => (el.style.display = ""));
  return text;
}

/** Cells as TSV, quoting the ones that hold tabs, line breaks or quotes. */
const toTsv = (grid: string[][]) =>
  grid.map((r) => r.map((c) => (/[\t\n\r"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join("\t")).join("\n");

/** A pasted text as a value of the property, or undefined when it doesn't fit. */
async function pastedValue(text: string, schema: PropertySchema, collectionId: string, propertyId: string): Promise<PropertyValue | undefined> {
  const t = text.trim();
  switch (schema.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone_number":
    case "place":
      return schema.type === "text" ? text : t;
    case "number":
      return t === "" ? null : Number.isNaN(Number(t.replace(",", "."))) ? undefined : Number(t.replace(",", "."));
    case "checkbox":
      return /^(true|s[ií]|yes|1|x|✓|marcada)$/i.test(t);
    case "date":
      return /^\d{4}-\d{2}-\d{2}/.test(t) ? t : undefined;
    case "select":
    case "status": {
      const found = schema.options?.find((o) => o.value.toLowerCase() === t.toLowerCase());
      if (found || !t || schema.type === "status") return found?.id ?? (t ? undefined : null);
      return (await addOption(collectionId, propertyId, t))?.id;
    }
    case "multi_select": {
      const ids: string[] = [];
      for (const part of t.split(",").map((x) => x.trim()).filter(Boolean)) {
        const found = schema.options?.find((o) => o.value.toLowerCase() === part.toLowerCase());
        const id = found?.id ?? (await addOption(collectionId, propertyId, part))?.id;
        if (id) ids.push(id);
      }
      return ids;
    }
    default:
      return undefined;
  }
}

export function TableView({
  view,
  collection,
  rows,
  onOpen,
  onPeek,
  onFilter,
  locked = false,
}: {
  view: CollectionView;
  collection: Collection;
  rows: Block[];
  onOpen: (id: string) => void;
  /** Opens a row in the side peek, whatever the view's "open pages in" setting. */
  onPeek?: (id: string) => void;
  /** Adds a filter on a property and opens its chip (header menu "Filtrar"). */
  onFilter?: (propertyId: string) => void;
  /** "Bloquear base de datos": columns and properties stay as they are; rows remain editable. */
  locked?: boolean;
}) {
  const props = viewProperties(view, collection);
  const visible = props.filter((p) => p.visible);
  const [limit, more] = useLoadLimit(view);
  // Sub-items nest under their parent row ("Alojados en menús desplegables").
  const sub = (view.format.subitems_display ?? "nested") === "nested" ? subitemConfig(collection) : null;
  const subOpen = useSubitemToggles(view);
  // "Color condicional": rows and cells tinted by the view's rules.
  const colors = useRowColors(view, collection, rows);
  const grouping = viewGrouping(view, collection.schema);
  const [collapsed, setCollapsed] = useStoredState<string[]>(`xotion:grp:${view.id}`, []);
  // Formula and rollup results, worked out for grouping by them.
  const groupValues = useGroupValues(rows, grouping?.groupBy.property, collection);
  // Groups hidden in "Agrupar" follow the others under "N grupos ocultos", when it's open.
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const split = useMemo(
    () => (grouping ? splitHidden(groupRows(rows, grouping.groupBy, grouping.schema, groupValues), grouping.groupBy) : null),
    [rows, grouping?.groupBy, grouping?.schema, groupValues],
  );
  const groups = useMemo(
    () => (split ? [...split.shown, ...(hiddenOpen ? split.hidden : [])] : null),
    [split, hiddenOpen],
  );
  const trees = useMemo(
    () => (groups ?? [null]).map((g) => (sub ? buildTree(g ? g.rows : rows, sub.parent) : null)),
    [groups, rows, sub?.parent],
  );
  const sections: Section[] = (groups ?? [null]).map((group, section) => {
    const sectionRows = group ? group.rows : rows;
    const tree = trees[section];
    const topLevel = tree ? tree.roots : sectionRows;
    const lines: Line[] = [];
    const prefix = group ? `${group.key}\u0001` : "";
    const visit = (row: Block, depth: number, parent?: string) => {
      const kids = tree?.children.get(row.id) ?? [];
      lines.push({ key: prefix + row.id, row, depth, kids: kids.length, parent, section });
      if (!tree || !subOpen.isOpen(row.id)) return;
      for (const k of kids) visit(k, depth + 1, row.id);
      if (!kids.length) lines.push({ key: `${prefix}new:${row.id}`, newUnder: row, depth: depth + 1, section });
    };
    if (!group || !collapsed.includes(group.key)) for (const r of topLevel.slice(0, limit)) visit(r, 0);
    return { group, rows: sectionRows, topLevel, lines };
  });
  const rowLines = sections.flatMap((s) => s.lines).filter((l): l is RowLine => "row" in l);
  const shown = [...new Set(rowLines.map((l) => l.row))];
  const toggleOpen = subOpen.toggle;
  const toggleGroup = (key: string) =>
    setCollapsed((list) => (list.includes(key) ? list.filter((x) => x !== key) : [...list, key]));
  const [resizing, setResizing] = useState<{ id: string; width: number } | null>(null);
  const headerPop = usePopover();
  const [headerId, setHeaderId] = useState<string | null>(null);
  const [pendingHeader, setPendingHeader] = useState<string | null>(null);
  const addPop = usePopover();
  const rowPop = usePopover();
  const moveMenu = useMoveMenu();
  const [rowId, setRowId] = useState<string | null>(null);
  const calcPop = usePopover();
  const [calcId, setCalcId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editTitleId, setEditTitleId] = useState<string | null>(null);
  const [active, setActive] = useState<Cell | null>(null);
  // A rectangle of cells from `active` (the anchor) to `rangeEnd`: Shift+arrows, Shift+click or a drag across cells.
  const [rangeEnd, setRangeEnd] = useState<Cell | null>(null);
  const selecting = useRef(false);
  const skipClick = useRef(false);
  const [openCell, setOpenCell] = useState<(Cell & { n: number; text?: string }) | null>(null);
  const drag = useRef<{ kind: "row" | "column"; id: string; line?: string } | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const calcs = view.format.table_calcs ?? {};
  // Formula and rollup results for their footer calculations (Suma, Promedio…).
  const computed = useComputed(rows, collection, Object.keys(calcs));
  const sorted = view.query2.sort.length > 0;
  const frozen = Math.min(view.format.table_frozen_column_index ?? 0, visible.length);
  const openIn = view.format.open_pages_in ?? "side";
  const setCalc = (id: string, calc: CalcType | null) => {
    const next = { ...calcs };
    if (calc) next[id] = calc;
    else delete next[id];
    void updateView(view.id, { format: { ...view.format, table_calcs: next } });
  };
  const saveProps = (properties: ViewProperty[]) =>
    updateView(view.id, { format: { ...view.format, properties } });

  const widthOf = (id: string) =>
    resizing?.id === id
      ? resizing.width
      : (props.find((p) => p.property === id)?.width ?? DEFAULT_WIDTH[id] ?? 180);
  const wrapOf = (p: ViewProperty) => p.wrap ?? view.format.table_wrap !== false;

  // Frozen columns stick at their own place: --sticky-base is the table's
  // offset in the scroller (page padding, plus 8px on full-page databases).
  const stickyStyle = (index: number): React.CSSProperties | undefined => {
    if (index >= frozen) return undefined;
    const offset = visible.slice(0, index).reduce((sum, p) => sum + widthOf(p.property), 0);
    return { position: "sticky", left: `calc(var(--sticky-base) + ${offset}px)`, zIndex: 2 };
  };

  const latest = useRef(resizing);
  latest.current = resizing;
  const startResize = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = widthOf(id);
    const move = (ev: MouseEvent) =>
      setResizing({ id, width: Math.max(MIN_WIDTH, startWidth + ev.clientX - startX) });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const final = latest.current;
      if (final) void saveProps(props.map((p) => (p.property === id ? { ...p, width: final.width } : p)));
      setResizing(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // A column inserted from the header menu opens its own menu, ready to be named.
  useEffect(() => {
    if (!pendingHeader) return;
    const btn = rootRef.current?.querySelector<HTMLElement>(`.th[data-prop="${pendingHeader}"] .th__btn`);
    if (!btn) return;
    setPendingHeader(null);
    setHeaderId(pendingHeader);
    headerPop.open(btn);
  });

  // Escape clears the row selection (after any open menu).
  useEffect(() => {
    if (!selected.length) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !hasOpenPopover() && setSelected([]);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected.length]);
  // Rows that left the view (deleted, filtered out) leave the selection too.
  const selectedShown = selected.filter((id) => shown.some((r) => r.id === id));

  const toggleRow = (id: string) =>
    setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  // ------------------------------------------------------------ groups
  const groupProp = grouping?.groupBy.property;
  /** Values a page created in a group gets; relations are set apart (two-way sync). */
  const groupPreset = (group: RowGroup | null) => {
    const values = defaultsFromQuery(view.query2, collection.schema);
    if (!grouping || !group || group.value === undefined || grouping.schema.type === "relation") return values;
    return { ...values, [grouping.groupBy.property]: group.value };
  };
  /** A new row (in a group, under a parent for sub-items), with its title open for typing. */
  const createRow = async (group: RowGroup | null, order?: number, parent?: Block) => {
    const id = await addRow(collection.id, groupPreset(group), order);
    if (grouping?.schema.type === "relation" && group?.ref) await setRelation(id, grouping.groupBy.property, [group.ref], false);
    if (sub && parent) await setRelation(id, sub.parent, [{ id: parent.id, name: pageTitle(parent) }], false);
    setEditTitleId(id);
    // The new row's title cell is the selected one, its editor open ("+ Nueva página").
    setActive({ line: `${group ? `${group.key}\u0001` : ""}${id}`, prop: "title" });
    return id;
  };
  /** A row dragged to another group takes that group's value (and leaves the old one). */
  const moveToGroup = async (row: Block, from: RowGroup | null, to: RowGroup | null) => {
    if (!grouping || !groupProp || !from || !to || from.key === to.key || to.value === undefined) return;
    const type = grouping.schema.type;
    const current = row.properties[groupProp];
    if (type === "relation") {
      const refs = ((current as PageRef[] | null) ?? []).filter((r) => r.id !== from.ref?.id);
      await setRelation(row.id, groupProp, to.ref && !refs.some((r) => r.id === to.ref!.id) ? [...refs, to.ref] : refs);
    } else if (type === "multi_select" || type === "person") {
      const own = type === "person" ? from.label : from.key;
      const list = ((current as string[] | null) ?? []).filter((x) => x !== own);
      const add = (to.value as string[] | null) ?? [];
      await setRowValue(row.id, groupProp, [...new Set([...list, ...add])]);
    } else await setRowValue(row.id, groupProp, to.value);
  };

  /** "Nuevo subítem": a row whose parent is `parent`, with its title open for typing. */
  const addSubitem = async (parent: Block, group: RowGroup | null) => {
    if (!sub) return;
    await createRow(group, undefined, parent);
    subOpen.open(parent.id);
  };

  /** A new row right below a line (a sibling, for sub-items), with its title open for typing. */
  const insertBelow = async (key: string) => {
    const i = rowLines.findIndex((l) => l.key === key);
    const line = rowLines[i];
    if (!line) return;
    const next = rowLines[i + 1]?.section === line.section ? rowLines[i + 1] : undefined;
    const order = next ? (line.row.order + next.row.order) / 2 : line.row.order + 1;
    const parent = sub && line.parent ? shown.find((r) => r.id === line.parent) : undefined;
    await createRow(sections[line.section].group, order, parent);
  };

  const insertProperty = async (side: "left" | "right") => {
    if (!headerId) return;
    const id = await addProperty(collection.id, "text");
    if (!id) return;
    const next = props.filter((p) => p.property !== id);
    const at = next.findIndex((p) => p.property === headerId);
    next.splice(side === "left" ? at : at + 1, 0, { property: id, visible: true });
    await saveProps(next);
    setPendingHeader(id);
  };

  // ------------------------------------------------------------ drag and drop
  const sideOf = (e: React.DragEvent, axis: "x" | "y"): Drop["side"] => {
    const r = e.currentTarget.getBoundingClientRect();
    return (axis === "x" ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) ? "before" : "after";
  };
  const endDrag = () => {
    drag.current = null;
    setDrop(null);
  };
  const dropRow = (targetKey: string, side: Drop["side"]) => {
    const from = rowLines.find((l) => l.key === drag.current?.line);
    const target = rowLines.find((l) => l.key === targetKey);
    if (!from || !target || from.key === target.key) return;
    const list = rowLines.filter((l) => l.section === target.section && l.row.id !== from.row.id).map((l) => l.row);
    const t = list.indexOf(target.row);
    if (t < 0) return;
    const prev = side === "before" ? list[t - 1] : list[t];
    const next = side === "before" ? list[t] : list[t + 1];
    const order = prev && next ? (prev.order + next.order) / 2 : prev ? prev.order + 1 : next.order - 1;
    if (!sorted) void updateBlock(from.row.id, { order });
    void moveToGroup(from.row, sections[from.section].group, sections[target.section].group);
  };
  const dropColumn = (targetId: string, side: Drop["side"]) => {
    const dragged = drag.current?.id;
    if (!dragged || dragged === targetId) return;
    const moving = props.find((p) => p.property === dragged);
    if (!moving) return;
    const next = props.filter((p) => p.property !== dragged);
    const t = next.findIndex((p) => p.property === targetId);
    next.splice(side === "before" ? t : t + 1, 0, moving);
    // The title can move too; from here on its place in the list counts.
    void updateView(view.id, { format: { ...view.format, properties: next, table_title_moved: true } });
  };
  const dropClass = (id: string) => (drop?.id === id ? ` is-drop-${drop.side}` : "");

  // ------------------------------------------------------- cell selection
  // A clicked cell stays selected (blue ring) once its editor
  // closes; arrows and Tab move it, Enter or typing edits it, Delete clears it,
  // and ⌘C / ⌘V copy and paste its value.
  const lineOf = (key: string) => rowLines.find((l) => l.key === key);
  const cellEl = (c: Cell) =>
    [...(rootRef.current?.querySelectorAll<HTMLElement>(".td[data-prop]") ?? [])].find(
      (td) => td.dataset.line === c.line && td.dataset.prop === c.prop,
    );
  const busy = () => hasOpenPopover() || !!document.querySelector(".cell-editor");
  const isField = (t: EventTarget | null) =>
    t instanceof HTMLElement && !!t.closest("input, textarea, select, .popover, .cell-editor");
  const latestNav = useRef({ rowLines, visible, active, rangeEnd, sections, groupPreset });
  latestNav.current = { rowLines, visible, active, rangeEnd, sections, groupPreset };
  /** The selected rectangle (anchor to range end), or null with a single cell. */
  const boxOf = (lines: RowLine[], cols: ViewProperty[], a: Cell | null, b: Cell | null): Box | null => {
    if (!a || !b) return null;
    const ra = lines.findIndex((l) => l.key === a.line);
    const rb = lines.findIndex((l) => l.key === b.line);
    const ca = cols.findIndex((p) => p.property === a.prop);
    const cb = cols.findIndex((p) => p.property === b.prop);
    if (ra < 0 || rb < 0 || ca < 0 || cb < 0 || (ra === rb && ca === cb)) return null;
    return { r0: Math.min(ra, rb), r1: Math.max(ra, rb), c0: Math.min(ca, cb), c1: Math.max(ca, cb) };
  };
  // The range goes with the selection.
  useEffect(() => {
    if (!active) setRangeEnd(null);
  }, [active]);
  useEffect(() => {
    const up = () => (selecting.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // Drag-and-fill (the corner handle on the selected cell): dragging it up or down the
  // column copies the cell's value into every row it passes, with a dashed preview meanwhile.
  const [fill, setFill] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const startFill = (e: React.MouseEvent, cell: Cell) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const schema = collection.schema[cell.prop];
    if (!schema || COMPUTED_TYPES.includes(schema.type) || READ_ONLY_TYPES.includes(schema.type)) return;
    const keyOf = (i: number) => latestNav.current.rowLines[i]?.key;
    const from = latestNav.current.rowLines.findIndex((l) => l.key === cell.line);
    if (from < 0) return;
    let to = from;
    const draw = () => {
      const a = cellEl(cell)?.getBoundingClientRect();
      const b = cellEl({ line: keyOf(to) ?? cell.line, prop: cell.prop })?.getBoundingClientRect();
      if (!a || !b) return;
      const top = Math.min(a.top, b.top);
      setFill({ left: a.left, top, width: a.width, height: Math.max(a.bottom, b.bottom) - top });
    };
    const move = (ev: MouseEvent) => {
      const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".td[data-line]");
      if (!td || !rootRef.current?.contains(td)) return;
      const i = latestNav.current.rowLines.findIndex((l) => l.key === td.dataset.line);
      if (i >= 0 && i !== to) {
        to = i;
        draw();
      }
    };
    const up = async () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setFill(null);
      const lines = latestNav.current.rowLines;
      const source = lines[from];
      if (to === from || !source) return;
      const value = source.row.properties[cell.prop] ?? null;
      const ids = new Set<string>();
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++)
        if (i !== from && lines[i] && lines[i].row.id !== source.row.id) ids.add(lines[i].row.id);
      for (const id of ids)
        if (schema.type === "relation") await setRelation(id, cell.prop, (value as PageRef[] | null) ?? []);
        else await setRowValue(id, cell.prop, value);
      // The filled cells stay selected.
      const end = lines[to];
      if (end) setRangeEnd({ line: end.key, prop: cell.prop });
    };
    draw();
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  useEffect(() => {
    if (!active) return;
    const clear = async (c: Cell) => {
      const line = lineOf(c.line);
      const schema = collection.schema[c.prop];
      if (!line || !schema || COMPUTED_TYPES.includes(schema.type) || READ_ONLY_TYPES.includes(schema.type)) return;
      if (schema.type === "relation") await setRelation(line.row.id, c.prop, []);
      else await setRowValue(line.row.id, c.prop, schema.type === "checkbox" ? false : schema.type === "multi_select" ? [] : null);
    };
    const onKey = (e: KeyboardEvent) => {
      const { rowLines: lines, visible: cols, active: cur, rangeEnd: end } = latestNav.current;
      if (!cur || busy() || isField(e.target) || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      let r = lines.findIndex((l) => l.key === cur.line);
      let c = cols.findIndex((p) => p.property === cur.prop);
      if (r < 0 || c < 0) return setActive(null);
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      // Shift+arrows grow or shrink the range from the anchor.
      if (e.shiftKey && e.key.startsWith("Arrow")) {
        let er = end ? lines.findIndex((l) => l.key === end.line) : r;
        let ec = end ? cols.findIndex((p) => p.property === end.prop) : c;
        if (er < 0 || ec < 0) [er, ec] = [r, c];
        if (e.key === "ArrowUp") er--;
        else if (e.key === "ArrowDown") er++;
        else if (e.key === "ArrowLeft") ec--;
        else if (e.key === "ArrowRight") ec++;
        stop();
        er = Math.max(0, Math.min(er, lines.length - 1));
        ec = Math.max(0, Math.min(ec, cols.length - 1));
        return setRangeEnd({ line: lines[er].key, prop: cols[ec].property });
      }
      const box = boxOf(lines, cols, cur, end);
      switch (e.key) {
        case "ArrowUp":
          r--;
          break;
        case "ArrowDown":
          r++;
          break;
        case "ArrowLeft":
          c--;
          break;
        case "ArrowRight":
          c++;
          break;
        case "Tab":
          c += e.shiftKey ? -1 : 1;
          if (c >= cols.length && r < lines.length - 1) [c, r] = [0, r + 1];
          if (c < 0 && r > 0) [c, r] = [cols.length - 1, r - 1];
          break;
        case "Escape":
          stop();
          return setActive(null);
        case "Enter":
          stop();
          setRangeEnd(null);
          return setOpenCell((o) => ({ ...cur, n: (o?.n ?? 0) + 1 }));
        case "Backspace":
        case "Delete":
          stop();
          if (box)
            return void (async () => {
              for (let i = box.r0; i <= box.r1; i++)
                for (let j = box.c0; j <= box.c1; j++) await clear({ line: lines[i].key, prop: cols[j].property });
            })();
          return void clear(cur);
        default:
          // A printable key starts editing with that text, as in a spreadsheet.
          if (e.key.length === 1) {
            stop();
            setRangeEnd(null);
            setOpenCell((o) => ({ ...cur, n: (o?.n ?? 0) + 1, text: e.key }));
          }
          return;
      }
      stop();
      setRangeEnd(null);
      r = Math.max(0, Math.min(r, lines.length - 1));
      c = Math.max(0, Math.min(c, cols.length - 1));
      setActive({ line: lines[r].key, prop: cols[c].property });
    };
    const onCopy = (e: ClipboardEvent) => {
      const { rowLines: lines, visible: cols, active: cur, rangeEnd: end } = latestNav.current;
      if (!cur || busy() || isField(e.target) || !window.getSelection()?.isCollapsed) return;
      // A range copies as TSV, ready for a spreadsheet (or another table).
      const box = boxOf(lines, cols, cur, end);
      if (box && e.clipboardData) {
        e.preventDefault();
        const grid: string[][] = [];
        for (let i = box.r0; i <= box.r1; i++) {
          const line: string[] = [];
          for (let j = box.c0; j <= box.c1; j++)
            line.push(cellText(cellEl({ line: lines[i].key, prop: cols[j].property })));
          grid.push(line);
        }
        e.clipboardData.setData("text/plain", toTsv(grid));
        return;
      }
      const td = cellEl(cur);
      if (!td || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", cellText(td));
    };
    const onPaste = (e: ClipboardEvent) => {
      const { rowLines: lines, visible: cols, active: cur, rangeEnd: end } = latestNav.current;
      if (!cur || busy() || isField(e.target)) return;
      const text = e.clipboardData?.getData("text/plain");
      const line = lineOf(cur.line);
      const schema = collection.schema[cur.prop];
      if (text === undefined || !line || !schema) return;
      e.preventDefault();
      e.stopPropagation();
      const box = boxOf(lines, cols, cur, end);
      const grid = /[\t\n\r]/.test(text.replace(/[\r\n]+$/, "")) ? parseTsv(text) : [[text.replace(/[\r\n]+$/, "")]];
      if (grid.length === 1 && grid[0].length === 1 && !box)
        return void pastedValue(text, schema, collection.id, cur.prop).then((value) => {
          if (value !== undefined) void setRowValue(line.row.id, cur.prop, value);
        });
      void pasteGrid(grid, box);
    };
    /**
     * A block of cells (from a spreadsheet, or copied here) pasted from the selection's
     * top-left cell: one value fills the whole range; rows past the last one are added.
     */
    const pasteGrid = async (grid: string[][], box: Box | null) => {
      const { rowLines: lines, visible: cols, active: cur, sections: secs, groupPreset: preset } = latestNav.current;
      if (!cur) return;
      const r0 = box ? box.r0 : lines.findIndex((l) => l.key === cur.line);
      const c0 = box ? box.c0 : cols.findIndex((p) => p.property === cur.prop);
      if (r0 < 0 || c0 < 0) return;
      const cells =
        box && grid.length === 1 && grid[0].length === 1
          ? Array.from({ length: box.r1 - box.r0 + 1 }, () => Array<string>(box.c1 - box.c0 + 1).fill(grid[0][0]))
          : grid;
      const last = lines[lines.length - 1];
      const ids: string[] = [];
      for (let i = 0; i < cells.length; i++)
        ids.push(lines[r0 + i]?.row.id ?? (await addRow(collection.id, preset(last ? secs[last.section].group : null))));
      for (let i = 0; i < cells.length; i++)
        for (let j = 0; j < cells[i].length; j++) {
          const prop = cols[c0 + j]?.property;
          const target = prop ? collection.schema[prop] : undefined;
          if (!prop || !target || COMPUTED_TYPES.includes(target.type) || READ_ONLY_TYPES.includes(target.type)) continue;
          const value = await pastedValue(cells[i][j], target, collection.id, prop);
          if (value !== undefined) await setRowValue(ids[i], prop, value);
        }
      // The pasted block stays selected.
      const rows = latestNav.current.rowLines;
      const endLine = rows[Math.min(r0 + cells.length - 1, rows.length - 1)];
      const endCol = cols[Math.min(c0 + Math.max(...cells.map((x) => x.length)) - 1, cols.length - 1)];
      if (endLine && endCol && (cells.length > 1 || cells[0].length > 1)) setRangeEnd({ line: endLine.key, prop: endCol.property });
    };
    // Clicking anywhere but a cell (or the cell's own editor) ends the selection.
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.(".popover, .cell-editor, [role='dialog']")) return;
      if (rootRef.current?.contains(t) && t.closest(".td[data-prop]")) return;
      setActive(null);
    };
    // Capture: an inline table sits in the page editor, which would take the keys first.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [active !== null, collection]);

  // The selected cell scrolls into view as it moves.
  useEffect(() => {
    if (active) cellEl(active)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.line, active?.prop]);

  const box = boxOf(rowLines, visible, active, rangeEnd);
  const lineIndex = new Map(rowLines.map((l, i) => [l.key, i]));
  /** A cell inside the range: a blue tint, with a 1px ring around the whole rectangle. */
  const rangeStyle = (key: string, col: number): React.CSSProperties | undefined => {
    const row = lineIndex.get(key);
    if (!box || row === undefined || row < box.r0 || row > box.r1 || col < box.c0 || col > box.c1) return undefined;
    const ring = [
      row === box.r0 && "inset 0 1px 0 #2383e2",
      row === box.r1 && "inset 0 -1px 0 #2383e2",
      col === box.c0 && "inset 1px 0 0 #2383e2",
      col === box.c1 && "inset -1px 0 0 #2383e2",
    ].filter(Boolean);
    return { background: "rgba(35, 131, 226, 0.14)", boxShadow: ring.join(", ") || undefined };
  };
  const headerSchema = headerId ? collection.schema[headerId] : undefined;
  const headerIndex = visible.findIndex((p) => p.property === headerId);
  const headerProp = props.find((p) => p.property === headerId);
  const allSelected = shown.length > 0 && selectedShown.length === shown.length;

  // ------------------------------------------------------------ rendering
  const headRow = () => (
    <div className="tr tr--head">
      <div className="tr__gutter tr__gutter--head">
        <span className="row-check-slot">
          <button
            type="button"
            role="checkbox"
            aria-checked={allSelected}
            aria-label="Seleccionar todas las filas"
            className={`row-check${allSelected ? " is-checked" : ""}`}
            onClick={() => setSelected(allSelected ? [] : shown.map((r) => r.id))}
          >
            {allSelected && <Check size={12} strokeWidth={3} />}
          </button>
        </span>
      </div>
      {visible.map((p, index) => {
        const s = collection.schema[p.property];
        return (
          <div
            className={`th${index < frozen ? " is-frozen" : ""}${index === 0 && frozen ? " is-frozen-first" : ""}${index === frozen - 1 ? " is-frozen-last" : ""}${dropClass(p.property)}`}
            key={p.property}
            data-prop={p.property}
            style={{ width: widthOf(p.property), ...stickyStyle(index) }}
            draggable={!locked}
            onDragStart={(e) => {
              if ((e.target as HTMLElement).closest(".th__resizer")) return e.preventDefault();
              drag.current = { kind: "column", id: p.property };
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData(COLUMN_TYPE, p.property);
            }}
            onDragOver={(e) => {
              if (drag.current?.kind !== "column" || drag.current.id === p.property) return;
              e.preventDefault();
              const side = sideOf(e, "x");
              if (drop?.id !== p.property || drop.side !== side) setDrop({ id: p.property, side });
            }}
            onDragLeave={() => drop?.id === p.property && setDrop(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (drop) dropColumn(p.property, drop.side);
              endDrag();
            }}
            onDragEnd={endDrag}
          >
            <button
              type="button"
              className="th__btn"
              data-tooltip={propertyTooltip(s)}
              onClick={(e) => {
                setHeaderId(p.property);
                headerPop.open(e.currentTarget);
              }}
            >
              <span className="th__icon">
                <TypeIcon type={s.type} size={16} />
              </span>
              <span className="th__name">{s.name}</span>
            </button>
            {!locked && <span className="th__resizer" onMouseDown={(e) => startResize(p.property, e)} aria-hidden />}
          </div>
        );
      })}
      <div className="th th--add">
        {!locked && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Agregar propiedad"
            onClick={(e) => addPop.toggle(e.currentTarget)}
          >
            <Plus size={16} />
          </button>
        )}
      </div>
    </div>
  );

  const lineRow = (line: Line) => {
    const group = sections[line.section].group;
    if (!("row" in line))
      return (
        <div className="tr tr--subnew" key={line.key}>
          <button
            type="button"
            className="table-subnew"
            style={{ paddingLeft: 8 + line.depth * 24 }}
            onClick={() => void addSubitem(line.newUnder, group)}
          >
            <Plus size={16} /> Nuevo subítem
          </button>
        </div>
      );
    const { row, depth, kids } = line;
    const isSelected = selected.includes(row.id);
    const isOpen = subOpen.isOpen(row.id);
    return (
      <div
        className={`tr${isSelected ? " is-selected" : ""}${dropClass(line.key)}${tintClass(colors.get(row.id)?.row)}`}
        key={line.key}
        onContextMenu={(e) => {
          // Not over a field being edited: its own text menu stays.
          if ((e.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) return;
          e.preventDefault();
          setRowId(row.id);
          rowPop.open(pointerAnchor(e));
        }}
        onDragOver={(e) => {
          if (drag.current?.kind !== "row" || drag.current.line === line.key) return;
          e.preventDefault();
          const side = sideOf(e, "y");
          if (drop?.id !== line.key || drop.side !== side) setDrop({ id: line.key, side });
        }}
        onDrop={(e) => {
          if (drag.current?.kind !== "row") return;
          e.preventDefault();
          if (drop) dropRow(line.key, drop.side);
          endDrag();
        }}
      >
        <div className="tr__gutter">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Insertar una fila debajo"
            data-tooltip="Haz clic para agregar abajo"
            onClick={() => void insertBelow(line.key)}
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm tr__grip"
            aria-label="Acciones de la fila"
            data-tooltip={sorted && !grouping ? "Haz clic para abrir el menú" : "Arrastra para mover · Haz clic para abrir el menú"}
            draggable={!sorted || !!grouping}
            onDragStart={(e) => {
              drag.current = { kind: "row", id: row.id, line: line.key };
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData(ROW_TYPE, row.id);
              const tr = e.currentTarget.closest(".tr");
              if (tr) e.dataTransfer.setDragImage(tr, 60, 18);
            }}
            onDragEnd={endDrag}
            onClick={(e) => {
              setRowId(row.id);
              rowPop.open(e.currentTarget);
            }}
          >
            <GripVertical size={16} />
          </button>
          <span className="row-check-slot">
            <button
              type="button"
              role="checkbox"
              aria-checked={isSelected}
              aria-label="Seleccionar fila"
              className={`row-check${isSelected ? " is-checked" : ""}`}
              onClick={() => toggleRow(row.id)}
            >
              {isSelected && <Check size={12} strokeWidth={3} />}
            </button>
          </span>
        </div>
        {visible.map((p, index) => {
          const isActive = !box && active?.line === line.key && active.prop === p.property;
          const cell = { line: line.key, prop: p.property };
          return (
            <div
              className={`td${wrapOf(p) ? "" : " td--nowrap"}${index < frozen ? " is-frozen" : ""}${index === 0 && frozen ? " is-frozen-first" : ""}${index === frozen - 1 ? " is-frozen-last" : ""}${sub && p.property === "title" ? " td--tree" : ""}${isActive ? " is-active" : ""}${tintClass(colors.get(row.id)?.cells[p.property])}`}
              key={p.property}
              data-line={line.key}
              data-prop={p.property}
              style={{
                width: widthOf(p.property),
                ...stickyStyle(index),
                ...(sub && p.property === "title" ? ({ "--indent": `${depth * 24}px` } as React.CSSProperties) : {}),
                ...rangeStyle(line.key, index),
              }}
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest(".open-btn, .tr__toggle")) return;
                // Shift+click spans a range from the selected cell, without opening this one.
                if (e.shiftKey && active) {
                  e.preventDefault();
                  skipClick.current = true;
                  return setRangeEnd(cell);
                }
                setActive(cell);
                setRangeEnd(null);
                selecting.current = e.button === 0;
              }}
              onMouseEnter={(e) => {
                // Dragging across cells selects the rectangle they span.
                if (!selecting.current || !(e.buttons & 1) || !active) return;
                window.getSelection()?.removeAllRanges();
                setRangeEnd(cell);
              }}
              onClickCapture={(e) => {
                if (!skipClick.current) return;
                skipClick.current = false;
                e.stopPropagation();
              }}
            >
              {isActive && (
                <span className="td__fill-handle" aria-hidden onMouseDown={(e) => startFill(e, cell)} />
              )}
              {sub && p.property === "title" && (
                <button
                  type="button"
                  className={`tr__toggle${kids ? "" : " is-empty"}${isOpen ? " is-open" : ""}`}
                  aria-label={isOpen ? "Ocultar subelementos" : "Mostrar subelementos"}
                  aria-expanded={isOpen}
                  onClick={() => toggleOpen(row.id)}
                >
                  <ChevronRight size={12} strokeWidth={2.4} />
                </button>
              )}
              <PropertyCell
                row={row}
                propertyId={p.property}
                schema={collection.schema[p.property]}
                collectionId={collection.id}
                variant="table"
                autoEdit={p.property === "title" && row.id === editTitleId}
                openSignal={openCell?.line === line.key && openCell.prop === p.property ? openCell : undefined}
              >
                {p.property === "title" && (
                  <button
                    type="button"
                    className="open-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(row.id);
                    }}
                  >
                    {openIn === "full" ? <Maximize2 size={14} /> : <PanelRight size={14} />} Abrir
                  </button>
                )}
              </PropertyCell>
              {p.property !== "title" && <PropertyCommentButton pageId={row.id} propertyId={p.property} readOnly={locked} />}
            </div>
          );
        })}
        <div className="td td--fill" />
      </div>
    );
  };

  const calcRow = (calcRows: Block[]) => (
    <div className="table-calc">
      {visible.map((p, index) => {
        const calc = calcs[p.property];
        const schema = collection.schema[p.property];
        const result = calc
          ? computeCalc(calcRows, p.property, schema, calc, computed.values, (day) => formatDate(day, schema))
          : null;
        return (
          <button
            type="button"
            key={p.property}
            className={`table-calc__cell${result ? "" : " table-calc__cell--empty"}`}
            style={{ width: widthOf(p.property), ...stickyStyle(index) }}
            onClick={(e) => {
              setCalcId(p.property);
              calcPop.open(e.currentTarget);
            }}
          >
            {result ? (
              <>
                <span className="table-calc__label">{result.label}</span>
                {result.value}
              </>
            ) : (
              <span className="table-calc__label">
                Calcular <ChevronDown size={12} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  // Header and body scroll sideways together, whichever one moved (the header
  // can scroll too, when something in it is focused or scrolled into view).
  const syncScroll = (to: React.RefObject<HTMLDivElement | null>) => (e: React.UIEvent<HTMLDivElement>) => {
    const el = to.current;
    if (el && el.scrollLeft !== e.currentTarget.scrollLeft) el.scrollLeft = e.currentTarget.scrollLeft;
  };

  return (
    <>
      {selectedShown.length > 0 && (
        <div className="table-bulk-anchor">
          <div className="table-bulk" role="toolbar" aria-label="Filas seleccionadas">
            <span className="table-bulk__count">
              {selectedShown.length} {selectedShown.length === 1 ? "seleccionada" : "seleccionadas"}
            </span>
            <button
              type="button"
              className="table-bulk__btn"
              onClick={async () => {
                for (const id of selectedShown) await duplicatePage(id);
                setSelected([]);
              }}
            >
              <Copy size={14} /> Duplicar
            </button>
            <button
              type="button"
              className="table-bulk__btn table-bulk__btn--danger"
              onClick={async () => {
                for (const id of selectedShown) await trashBlock(id);
                toast(selectedShown.length === 1 ? "Página movida a la papelera" : `${selectedShown.length} páginas movidas a la papelera`);
                setSelected([]);
              }}
            >
              <Trash size={14} /> Eliminar
            </button>
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Quitar selección" onClick={() => setSelected([])}>
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      {fill && <div className="table-fill-preview" style={fill} aria-hidden />}
      <div
        ref={rootRef}
        className={`table-view${resizing ? " is-resizing" : ""}${selectedShown.length ? " has-selection" : ""}${groups ? " table-view--grouped" : ""}${view.format.table_vertical_lines === false ? " table-view--no-vlines" : ""}${view.format.show_page_icon === false ? " table-view--no-icons" : ""}`}
      >
        {/* Ungrouped tables keep their header in its own strip: it sticks to the top of a full page
            (the body scrolls sideways, so it can't stick inside it) and follows the body's scroll. */}
        {!groups && (
          <div className="table-wrap table-wrap--head" ref={headRef} onScroll={syncScroll(bodyRef)}>
            <div className="table">{headRow()}</div>
          </div>
        )}
        <div className="table-wrap table-wrap--body" ref={bodyRef} onScroll={syncScroll(headRef)}>
          <div className="table">
            {groups ? (
              sections.map(({ group, rows: groupRowsList, topLevel, lines }, index) => {
                const g = group!;
                const toggle =
                  split && split.hidden.length > 0 && index === split.shown.length ? (
                    <HiddenGroupsToggle count={split.hidden.length} open={hiddenOpen} onToggle={() => setHiddenOpen((o) => !o)} />
                  ) : null;
                const open = !collapsed.includes(g.key);
                return (
                  <Fragment key={g.key}>
                    {toggle}
                    <GroupHeader
                      group={g}
                      schema={grouping!.schema}
                      open={open}
                      onToggle={() => toggleGroup(g.key)}
                      view={view}
                      onAdd={
                        g.value === undefined
                          ? undefined
                          : () => {
                              if (!open) toggleGroup(g.key);
                              const first = groupRowsList.length && !sorted ? Math.min(...groupRowsList.map((r) => r.order)) - 1 : undefined;
                              void createRow(g, first);
                            }
                      }
                    />
                    {open && (
                      <>
                        {headRow()}
                        {lines.map(lineRow)}
                        <LoadMore hidden={topLevel.length - limit} onMore={more} />
                        {g.value !== undefined && (
                          <button type="button" className="table-new" onClick={() => void createRow(g)}>
                            <Plus size={16} /> Nueva página
                          </button>
                        )}
                        {calcRow(groupRowsList)}
                      </>
                    )}
                  </Fragment>
                );
              }).concat(
                split && split.hidden.length > 0 && !hiddenOpen
                  ? [<HiddenGroupsToggle key="__hidden" count={split.hidden.length} open={false} onToggle={() => setHiddenOpen(true)} />]
                  : [],
              )
            ) : (
              <>
                {sections[0].lines.map(lineRow)}
                <LoadMore hidden={sections[0].topLevel.length - limit} onMore={more} />
                <button type="button" className="table-new" onClick={() => void createRow(null)}>
                  <Plus size={16} /> Nueva página
                </button>
                {calcRow(rows)}
              </>
            )}
          </div>
        </div>

        {headerPop.anchor && headerId && headerSchema && headerProp && (
          <Popover anchor={headerPop.anchor} onClose={headerPop.close} width={256}>
            <PropertyMenu
              key={headerId}
              collectionId={collection.id}
              propertyId={headerId}
              schema={headerSchema}
              onClose={headerPop.close}
              onFilter={onFilter ? () => onFilter(headerId) : undefined}
              onSort={(direction) =>
                updateView(view.id, {
                  query2: { ...view.query2, sort: [{ id: headerId, property: headerId, direction }] },
                })
              }
              onHide={locked ? undefined : () => saveProps(props.map((p) => (p.property === headerId ? { ...p, visible: false } : p)))}
              calc={calcs[headerId] ?? null}
              onCalc={(c) => setCalc(headerId, c)}
              frozen={headerIndex >= 0 && headerIndex === frozen - 1}
              onFreeze={
                locked
                  ? undefined
                  : () =>
                      updateView(view.id, {
                        format: {
                          ...view.format,
                          table_frozen_column_index: headerIndex === frozen - 1 ? 0 : headerIndex + 1,
                        },
                      })
              }
              wrap={wrapOf(headerProp)}
              onWrap={
                locked ? undefined : () => saveProps(props.map((p) => (p.property === headerId ? { ...p, wrap: !wrapOf(p) } : p)))
              }
              onInsert={(side) => void insertProperty(side)}
              onDuplicate={() => void duplicateProperty(collection.id, headerId)}
              locked={locked}
            />
          </Popover>
        )}
        {addPop.anchor && (
          <Popover anchor={addPop.anchor} onClose={addPop.close} width={256} align="end">
            <AddPropertyMenu collectionId={collection.id} onDone={addPop.close} />
          </Popover>
        )}
        {calcPop.anchor && calcId && collection.schema[calcId] && (
          <Popover anchor={calcPop.anchor} onClose={calcPop.close} width={220} align="end">
            <CalcMenu
              schema={collection.schema[calcId]}
              kind={computed.kinds?.[calcId]}
              current={calcs[calcId]}
              onPick={(c) => {
                calcPop.close();
                setCalc(calcId, c);
              }}
            />
          </Popover>
        )}
        {rowPop.anchor && rowId && (
          <Popover anchor={rowPop.anchor} onClose={rowPop.close} width={256}>
            <div className="menu">
              <MenuItem
                icon={<PanelRight size={16} />}
                onClick={() => {
                  rowPop.close();
                  (onPeek ?? onOpen)(rowId);
                }}
              >
                Abrir en vista lateral
              </MenuItem>
              <MenuItem
                icon={<Maximize2 size={16} />}
                onClick={() => {
                  rowPop.close();
                  navigate(rowId);
                }}
              >
                Abrir en página completa
              </MenuItem>
              {HAS_TABS && (
                <MenuItem
                  icon={<SquareArrowOutUpRight size={16} />}
                  right="⌘↵"
                  onClick={() => {
                    rowPop.close();
                    openInNewTab(rowId);
                  }}
                >
                  Abrir en una pestaña nueva
                </MenuItem>
              )}
              <MenuSeparator />
              {sub && (
                <MenuItem
                  icon={<CornerDownRight size={16} />}
                  onClick={() => {
                    rowPop.close();
                    const line = rowLines.find((l) => l.row.id === rowId);
                    if (line) void addSubitem(line.row, sections[line.section].group);
                  }}
                >
                  Nuevo subítem
                </MenuItem>
              )}
              <MenuItem
                icon={<Link size={16} />}
                onClick={() => {
                  rowPop.close();
                  void copyLink(rowId);
                }}
              >
                Copiar enlace
              </MenuItem>
              <MenuItem
                icon={<Copy size={16} />}
                right="⌘D"
                onClick={() => {
                  rowPop.close();
                  void duplicatePage(rowId);
                }}
              >
                Duplicar
              </MenuItem>
              <MenuItem
                icon={<CornerUpRight size={16} />}
                right="⌘⇧P"
                onClick={() => {
                  const anchor = rowPop.anchor!;
                  rowPop.close();
                  moveMenu.open(rowId, anchor);
                }}
              >
                Mover a
              </MenuItem>
              <MenuItem
                danger
                icon={<Trash size={16} />}
                right="Supr"
                onClick={() => {
                  rowPop.close();
                  void trashWithUndo(rowId);
                }}
              >
                Eliminar
              </MenuItem>
            </div>
          </Popover>
        )}
        {moveMenu.element}
      </div>
    </>
  );
}
