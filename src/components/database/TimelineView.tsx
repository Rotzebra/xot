import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Plus,
} from "lucide-react";
import { COMPUTED_TYPES, type Block, type Collection, type CollectionView, type PageRef, type PropertyValue } from "../../lib/model";
import { setRelation, setRowValue, updateView } from "../../lib/ops";
import { cellValue, isEmptyValue, subitemConfig } from "../../lib/query";
import { buildTree, useSubitemToggles } from "../../lib/subitems";
import { db } from "../../lib/db";
import { pageTitle, useStoredState } from "../../lib/hooks";
import { groupRows, splitHidden, useComputed, useGroupValues, viewGrouping, type RowGroup } from "../../lib/group";
import { computeCalc } from "../../lib/calc";
import { CalcMenu } from "./CalcMenu";
import { LoadMore, useLoadLimit } from "./loadLimit";
import { tintClass, useRowColors } from "./ConditionalColor";
import { GroupHeader } from "./GroupHeader";
import { MenuItem, PageIcon, Popover, usePopover } from "../ui";
import { ComputedValue, formatDate, PropertyDisplay, TypeIcon } from "./properties";
import { DatePropPicker, RowSummary } from "./views";

type Zoom = NonNullable<CollectionView["format"]["timeline_zoom"]>;
const ZOOMS: Zoom[] = ["hours", "day", "week", "bi_week", "month", "quarter", "year", "5_years"];
/** The scale (msPerPixel per zoom), as pixels per day. */
const DAY_WIDTH: Record<Zoom, number> = {
  hours: 7000,
  day: 1248,
  week: 180,
  bi_week: 80,
  month: 40,
  quarter: 12,
  year: 5,
  "5_years": 1,
};
const ZOOM_LABELS: Record<Zoom, string> = {
  hours: "Horas",
  day: "Día",
  week: "Semana",
  bi_week: "Dos semanas",
  month: "Mes",
  quarter: "Trimestre",
  year: "Año",
  "5_years": "5 años",
};
/** Days a click on an undated row schedules (the date range placeholder duration). */
const PLACEHOLDER_DAYS: Record<Zoom, number> = {
  hours: 1,
  day: 1,
  week: 1,
  bi_week: 3,
  month: 5,
  quarter: 14,
  year: 30,
  "5_years": 180,
};
/** The unit shown in the control bar and stepped by ‹ ›. */
const SECONDARY: Record<Zoom, "day" | "month" | "year"> = {
  hours: "day",
  day: "day",
  week: "month",
  bi_week: "month",
  month: "month",
  quarter: "year",
  year: "year",
  "5_years": "year",
};
const ROW = 36;
const HEAD = 32;
const ITEM = 28;
const DAY = 86400000;
const TITLE_WIDTH = 220;
const COLUMN_WIDTH = 150;

const parse = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00`);
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Start and end day of a row: a date range, or separate start/end properties. */
function spanOf(row: Block, view: CollectionView, collection: Collection): [Date, Date] | null {
  const by = view.format.timeline_by;
  if (!by || !collection.schema[by]) return null;
  const v = cellValue(row, by, collection.schema[by]);
  if (typeof v !== "string" || !v) return null;
  const [start, end] = v.split("/");
  let finish = end;
  const endProp = view.format.timeline_by_end;
  if (!finish && endProp && collection.schema[endProp]) {
    const e = cellValue(row, endProp, collection.schema[endProp]);
    if (typeof e === "string" && e) finish = e.split("/")[0];
  }
  const a = parse(start);
  const b = finish ? parse(finish) : a;
  return b < a ? [b, a] : [a, b];
}

const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
const nextWorkday = (d: Date) => {
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
};
/** Days from a span's start to its end; only weekdays when weekends are skipped. */
function lengthOf(a: Date, b: Date, skip: boolean) {
  if (!skip) return days(a, b);
  let n = 0;
  for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (!isWeekend(d)) n++;
  return n;
}
/** The end of a span `n` days long from `a` (weekdays only when weekends are skipped). */
function endFrom(a: Date, n: number, skip: boolean) {
  if (!skip) return addDays(a, n);
  let d = a;
  while (n > 0) {
    d = addDays(d, 1);
    if (!isWeekend(d)) n--;
  }
  return d;
}

/**
 * Dependency date shifting: after a bar's dates change, the bars it blocks (and the ones
 * they block, and so on) move with it: only when they would start before it ends ("overlap"), or by
 * as much as its end moved ("gap"). Each keeps its length; `write` saves the new range.
 */
export async function shiftDependents(
  view: CollectionView,
  collection: Collection,
  rowId: string,
  before: [Date, Date],
  after: [Date, Date],
  write: (row: Block, a: Date, b: Date) => void,
) {
  const deps = view.format.timeline_dependencies;
  const mode = deps?.shift ?? "overlap";
  if (!deps || mode === "none" || collection.schema[deps.blocked_by]?.type !== "relation") return;
  const skip = !!deps.skip_weekends;
  const rows = (await db.blocks.where("[parent_table+parent_id]").equals(["collection", collection.id]).toArray()).filter(
    (r) => r.alive && !r.is_template,
  );
  const spans = new Map(rows.map((r) => [r.id, spanOf(r, view, collection)]));
  const seen = new Set([rowId]);
  const queue: [string, Date, Date][] = [[rowId, before[1], after[1]]];
  while (queue.length) {
    const [id, oldEnd, newEnd] = queue.shift()!;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      if (!((row.properties[deps.blocked_by] as PageRef[] | undefined) ?? []).some((r) => r.id === id)) continue;
      const span = spans.get(row.id);
      if (!span) continue;
      let start: Date;
      if (mode === "gap") {
        const delta = days(oldEnd, newEnd);
        if (!delta) continue;
        start = addDays(span[0], delta);
      } else {
        if (span[0] > newEnd) continue;
        start = addDays(newEnd, 1);
      }
      if (skip) start = nextWorkday(start);
      if (start.getTime() === span[0].getTime()) continue;
      const end = endFrom(start, lengthOf(span[0], span[1], skip), skip);
      seen.add(row.id);
      spans.set(row.id, [start, end]);
      write(row, start, end);
      queue.push([row.id, span[1], end]);
    }
  }
}

/** Text width at the bar's 14px/500 UI font, to tell whether a title fits inside its bar. */
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
    if (measureCtx) measureCtx.font = `500 14px ${getComputedStyle(document.body).fontFamily}`;
  }
  return measureCtx ? measureCtx.measureText(text).width : text.length * 7.5;
}

/** An arrow with right-angle turns from a blocking bar's end to a blocked bar's start. */
function elbow(x1: number, y1: number, x2: number, y2: number): string {
  const gap = 8;
  if (x2 - x1 >= gap * 2) return `M${x1},${y1} H${x1 + gap} V${y2} H${x2}`;
  // The blocked bar starts first: go around, through the gap between the two rows.
  const mid = y1 + (y2 > y1 ? ROW / 2 : -ROW / 2);
  return `M${x1},${y1} H${x1 + gap} V${mid} H${x2 - gap} V${y2} H${x2}`;
}

/** A dependency being drawn from a bar's edge dot: its start, and where the pointer is. */
type Link = { id: string; side: "start" | "end"; x0: number; y0: number; x: number; y: number };

/** A line of the timeline: a group's header ("Agrupar"), or a row and its span. */
type Line = { key: string; group: RowGroup } | { key: string; row: Block; span: [Date, Date] | null; depth?: number; kids?: number };

/** A pointer gesture on a bar (move or resize) or on an undated row (drawing a new range). */
type Drag = { id: string; mode: "move" | "start" | "end" | "draw"; x0: number; from: Date; to: Date; delta: number; moved: boolean };

export function TimelineView({
  view,
  collection,
  rows,
  onOpen,
  onNew,
}: {
  view: CollectionView;
  collection: Collection;
  rows: Block[];
  onOpen: (id: string) => void;
  onNew: (values?: Record<string, PropertyValue>) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomPop = usePopover();
  const [vp, setVp] = useState({ left: 0, width: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<{ id: string; day: Date } | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  // "Agrupar": each group's header in the table and the canvas, its rows under it.
  const grouping = viewGrouping(view, collection.schema);
  const groupValues = useGroupValues(rows, grouping?.groupBy.property, collection);
  const [collapsed, setCollapsed] = useStoredState<string[]>(`xotion:grp:${view.id}`, []);
  /** The day kept in the middle when the zoom changes. */
  const keepCenter = useRef<Date | null>(null);
  const zoom: Zoom = ZOOMS.includes(view.format.timeline_zoom as Zoom) ? view.format.timeline_zoom! : "month";
  const dayWidth = DAY_WIDTH[zoom];
  const by = view.format.timeline_by;
  const schema = by ? collection.schema[by] : undefined;
  const editable = schema?.type === "date";
  const endProp =
    view.format.timeline_by_end && collection.schema[view.format.timeline_by_end]?.type === "date"
      ? view.format.timeline_by_end
      : undefined;
  const dateProps = Object.entries(collection.schema).filter(([, s]) => s.type === "date");
  const showTable = view.format.timeline_show_table !== false;
  const setFormat = (patch: Partial<CollectionView["format"]>) =>
    updateView(view.id, { format: { ...view.format, ...patch } });
  // "Calcular" under the table's columns (the view's own, as a table's).
  // Sub-items nest under their parent in the table, behind a toggle.
  const sub = (view.format.subitems_display ?? "nested") === "nested" ? subitemConfig(collection) : null;
  const subOpen = useSubitemToggles(view);
  const colors = useRowColors(view, collection, rows);
  const [limit, more] = useLoadLimit(view);
  const calcs = view.format.table_calcs ?? {};
  const computed = useComputed(rows, collection, Object.keys(calcs));
  const calcPop = usePopover();
  const [calcId, setCalcId] = useState<string | null>(null);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const spans = rows.map((row) => [row, spanOf(row, view, collection)] as const);
  const dated = spans.filter(([, s]) => s).map(([, s]) => s!);
  const spanById = new Map(spans.map(([row, span]) => [row.id, span]));
  // "Cargar": the first N top-level rows (per group), the rest behind "Cargar más".
  let hiddenRows = 0;
  /** A list of rows as lines: nested under their parents (sub-items, open ones only) or flat. */
  const rowLines = (list: Block[], prefix: string): Line[] => {
    if (!sub) {
      hiddenRows += Math.max(0, list.length - limit);
      return list.slice(0, limit).map((row) => ({ key: prefix + row.id, row, span: spanById.get(row.id) ?? null }));
    }
    const tree = buildTree(list, sub.parent);
    const out: Line[] = [];
    const visit = (row: Block, depth: number) => {
      const kids = tree.children.get(row.id) ?? [];
      out.push({ key: prefix + row.id, row, span: spanById.get(row.id) ?? null, depth, kids: kids.length });
      if (subOpen.isOpen(row.id)) for (const k of kids) visit(k, depth + 1);
    };
    hiddenRows += Math.max(0, tree.roots.length - limit);
    tree.roots.slice(0, limit).forEach((r) => visit(r, 0));
    return out;
  };
  let lines: Line[] = rowLines(rows, "");
  if (grouping) {
    const { shown: groups } = splitHidden(groupRows(rows, grouping.groupBy, grouping.schema, groupValues), grouping.groupBy);
    lines = groups.flatMap((g): Line[] => [
      { key: `g:${g.key}`, group: g },
      ...(collapsed.includes(g.key) ? [] : rowLines(g.rows, `${g.key}:`)),
    ]);
  }
  const toggleGroup = (key: string) =>
    setCollapsed((list) => (list.includes(key) ? list.filter((x) => x !== key) : [...list, key]));
  /** A group header, in the table (or over the canvas when the table is hidden). */
  const groupHead = (g: RowGroup) => (
    <GroupHeader
      group={g}
      schema={grouping!.schema}
      open={!collapsed.includes(g.key)}
      onToggle={() => toggleGroup(g.key)}
      onAdd={
        g.value === undefined || grouping!.schema.type === "relation" || !by
          ? undefined
          : () => onNew({ [by]: iso(today), [grouping!.groupBy.property]: g.value ?? null })
      }
    />
  );
  const anchor = view.format.timeline_center ?? today.getTime();
  const first = new Date(Math.min(today.getTime(), anchor, ...dated.map(([a]) => a.getTime())));
  const last = new Date(Math.max(today.getTime(), anchor, ...dated.map(([, b]) => b.getTime())));
  const pad0 = Math.max(14, Math.ceil(1400 / dayWidth));
  const origin = new Date(first.getFullYear(), first.getMonth(), 1 - pad0);
  const total = days(origin, addDays(last, pad0 * 2));
  const width = total * dayWidth;
  const x = (d: Date) => days(origin, d) * dayWidth;
  const dateAt = (px: number) => addDays(origin, Math.floor(px / dayWidth));
  const centerDate = () => dateAt(vp.left + vp.width / 2);

  const measure = () => {
    const el = scroller.current;
    if (el) setVp({ left: el.scrollLeft, width: el.clientWidth });
  };

  // Open on the day the view was last left on, else today; a zoom change keeps the middle day.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const center = keepCenter.current ?? (view.format.timeline_center ? new Date(view.format.timeline_center) : new Date(today));
    keepCenter.current = null;
    center.setHours(0, 0, 0, 0);
    el.scrollLeft = Math.max(0, x(center) - el.clientWidth / 2);
    measure();
  }, [view.id, zoom]);

  // The canvas starts a month before the earliest bar: when that moves, keep the same days in view.
  const lastOrigin = useRef(origin.getTime());
  useLayoutEffect(() => {
    const el = scroller.current;
    const shift = (lastOrigin.current - origin.getTime()) / DAY;
    lastOrigin.current = origin.getTime();
    if (el && shift) {
      el.scrollLeft += Math.round(shift) * dayWidth;
      measure();
    }
  }, [origin.getTime()]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [by]);

  if (!by || !schema)
    return (
      <div className="board-empty">
        <p>La cronología coloca cada fila según una propiedad de fecha.</p>
        {dateProps.length ? (
          <DatePropPicker label="Mostrar cronología por…" schema={collection.schema} onPick={(id) => setFormat({ timeline_by: id })} />
        ) : (
          <p className="muted">Añade una propiedad de tipo «Fecha» desde Propiedades.</p>
        )}
      </div>
    );

  const scrollBy = (px: number) => {
    const el = scroller.current;
    if (el) el.scrollLeft += px;
  };
  /** ‹ › step one month (a day or a year at the extreme zooms). */
  const step = (n: number) => {
    const c = centerDate();
    const unit = SECONDARY[zoom];
    const target =
      unit === "day"
        ? addDays(c, n)
        : unit === "month"
          ? new Date(c.getFullYear(), c.getMonth() + n, c.getDate())
          : new Date(c.getFullYear() + n, c.getMonth(), c.getDate());
    scrollBy(x(target) - x(c));
  };
  const scrollToDay = (d: Date) => {
    const el = scroller.current;
    if (el) el.scrollLeft = x(d) - el.clientWidth / 3;
  };

  /** Writes a new range: a start/end pair when the view has an end property, else one date (range) value. */
  const commit = (row: Block, a: Date, b: Date) => {
    const raw = cellValue(row, by, schema);
    const [rs, re] = typeof raw === "string" && raw ? raw.split("/") : [];
    const ts = rs?.slice(10) ?? "";
    if (endProp && !re) {
      const rawEnd = cellValue(row, endProp, collection.schema[endProp]);
      const te = typeof rawEnd === "string" ? rawEnd.split("/")[0].slice(10) : "";
      void setRowValue(row.id, by, iso(a) + ts);
      void setRowValue(row.id, endProp, iso(b) + te);
      return;
    }
    const te = re?.slice(10) ?? ts;
    void setRowValue(row.id, by, !re && days(a, b) === 0 ? iso(a) + ts : `${iso(a)}${ts}/${iso(b)}${te}`);
  };
  /** The span a row shows, with an ongoing drag applied. */
  const shown = (row: Block, span: [Date, Date] | null): [Date, Date] | null => {
    if (!drag || drag.id !== row.id) return span;
    const { mode, from, to, delta } = drag;
    if (mode === "move") return [addDays(from, delta), addDays(to, delta)];
    if (mode === "start") {
      const a = addDays(from, delta);
      return a > to ? [to, to] : [a, to];
    }
    if (mode === "end") {
      const b = addDays(to, delta);
      return b < from ? [from, from] : [from, b];
    }
    const b = addDays(from, delta);
    return b < from ? [b, from] : [from, b];
  };
  const canvasX = (clientX: number) => clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0);
  const startDrag = (e: React.PointerEvent<HTMLElement>, next: Drag) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(next);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const delta = Math.round(dx / dayWidth);
    const moved = drag.moved || Math.abs(dx) > 3;
    if (delta !== drag.delta || moved !== drag.moved) setDrag({ ...drag, delta, moved });
  };
  const endDrag = (row: Block, span: [Date, Date] | null) => {
    if (!drag) return;
    const next = shown(row, span);
    setDrag(null);
    setHover(null);
    if (drag.mode === "draw") {
      const range: [Date, Date] = drag.moved && next ? next : [drag.from, addDays(drag.from, PLACEHOLDER_DAYS[zoom] - 1)];
      commit(row, ...range);
    } else if (!drag.moved) onOpen(row.id);
    else if (next && drag.delta) {
      commit(row, ...next);
      if (span) void shiftDependents(view, collection, row.id, span, next, commit);
    }
  };

  // Only what is near the viewport is drawn: header ticks, weekend shading and dividers.
  const from = dateAt(Math.max(0, vp.left - 400));
  const to = dateAt(vp.left + vp.width + 400);
  const visibleDays: Date[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) visibleDays.push(d);
  const perDay = zoom === "week" || zoom === "bi_week" || zoom === "month";
  const hourly = zoom === "hours" || zoom === "day";
  const ticks: { left: number; width?: number; label: string; today?: boolean; start?: boolean }[] = [];
  const weekends: number[] = [];
  const dividers: number[] = [];
  for (const d of visibleDays) {
    const left = x(d);
    if (perDay) {
      ticks.push({ left, width: dayWidth, label: String(d.getDate()), today: d.getTime() === today.getTime() });
      if (d.getDay() === 6) weekends.push(left);
      if (zoom === "week") dividers.push(left);
    } else if (hourly) {
      for (let h = 0; h < 24; h++) ticks.push({ left: left + (h * dayWidth) / 24, label: `${h}:00`, start: true });
      dividers.push(left);
    } else {
      if (d.getDate() === 1) dividers.push(left);
      if (zoom === "5_years" ? d.getDate() === 1 : d.getDay() === 1)
        ticks.push({
          left,
          label: zoom === "5_years" ? d.toLocaleDateString("es", { month: "short" }).replace(".", "") : String(d.getDate()),
          start: true,
        });
    }
  }
  const center = vp.width ? centerDate() : today;
  const unit = SECONDARY[zoom];
  const label =
    unit === "day"
      ? center.toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric" })
      : unit === "month"
        ? capitalize(center.toLocaleDateString("es", { month: "long", year: "numeric" }))
        : String(center.getFullYear());
  const now = new Date();
  const todayX = hourly ? x(today) + ((now.getTime() - today.getTime()) / DAY) * dayWidth : x(today) + dayWidth / 2;

  // The table has its own columns (timeline_table_properties): just the title unless some are listed.
  const columns = (view.format.timeline_table_properties ?? [])
    .filter((id) => id !== "title" && collection.schema[id])
    .map((property) => ({ property }));
  const tableWidth = TITLE_WIDTH + columns.length * COLUMN_WIDTH;

  // Dependencies: "Bloqueado por" links drawn as arrows, and new ones dragged from a bar's edge dot.
  const deps = view.format.timeline_dependencies;
  const blockedBy = deps && collection.schema[deps.blocked_by]?.type === "relation" ? deps.blocked_by : undefined;
  const bars = new Map<string, { left: number; right: number; y: number }>();
  lines.forEach((line, i) => {
    if ("group" in line) return;
    const { row, span } = line;
    const s = span && shown(row, span);
    if (!s) return;
    const left = x(s[0]);
    bars.set(row.id, { left, right: left + Math.max(dayWidth, (days(s[0], s[1]) + 1) * dayWidth), y: HEAD + i * ROW + ROW / 2 });
  });
  const arrows: { key: string; d: string }[] = [];
  if (blockedBy)
    for (const [row] of spans) {
      const to = bars.get(row.id);
      if (!to) continue;
      for (const ref of (row.properties[blockedBy] as PageRef[] | undefined) ?? []) {
        const from = bars.get(ref.id);
        if (from && ref.id !== row.id) arrows.push({ key: `${ref.id}>${row.id}`, d: elbow(from.right, from.y, to.left, to.y) });
      }
    }
  const canvasY = (clientY: number) => clientY - (canvasRef.current?.getBoundingClientRect().top ?? 0);
  const startLink = (e: React.PointerEvent<HTMLElement>, row: Block, side: Link["side"]) => {
    const bar = bars.get(row.id);
    if (e.button !== 0 || !bar) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const x0 = side === "end" ? bar.right : bar.left;
    setLink({ id: row.id, side, x0, y0: bar.y, x: x0, y: bar.y });
  };
  const moveLink = (e: React.PointerEvent) => {
    if (link) setLink({ ...link, x: canvasX(e.clientX), y: canvasY(e.clientY) });
  };
  const endLink = (e: React.PointerEvent) => {
    if (!link || !blockedBy) return setLink(null);
    e.stopPropagation();
    setLink(null);
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".timeline__item[data-row]");
    const other = el?.dataset.row;
    if (!other || other === link.id) return;
    // From the end dot: the other bar waits for this one; from the start dot, the other way round.
    const [blockedId, blockerId] = link.side === "end" ? [other, link.id] : [link.id, other];
    const blocked = rows.find((r) => r.id === blockedId);
    const blocker = rows.find((r) => r.id === blockerId);
    if (!blocked || !blocker) return;
    const refs = (blocked.properties[blockedBy] as PageRef[] | undefined) ?? [];
    if (refs.some((r) => r.id === blockerId)) return;
    void setRelation(blockedId, blockedBy, [...refs, { id: blockerId, name: String(blocker.properties.title ?? "") }]);
  };
  const cell = (row: Block, property: string) => {
    const s = collection.schema[property];
    if (COMPUTED_TYPES.includes(s.type))
      return <ComputedValue row={row} propertyId={property} schema={s} collectionId={collection.id} />;
    const v = cellValue(row, property, s);
    return isEmptyValue(v) ? null : <PropertyDisplay value={v} schema={s} />;
  };

  return (
    <div className="timeline">
      <div className="timeline__bar">
        <div className="timeline__bar-left">
          {!showTable && (
            <button
              type="button"
              className="icon-btn icon-btn--sm timeline__table-toggle"
              aria-label="Mostrar tabla"
              data-tooltip="Mostrar tabla"
              onClick={() => setFormat({ timeline_show_table: true })}
            >
              <ChevronsRight size={16} />
            </button>
          )}
          <span className="timeline__label" style={{ paddingInlineStart: showTable ? tableWidth + 2 : 2 }}>
            {label}
          </span>
        </div>
        <div className="timeline__controls">
          <button type="button" className="text-btn timeline__zoom" onClick={(e) => zoomPop.toggle(e.currentTarget)}>
            {ZOOM_LABELS[zoom]}
            <ChevronDown size={12} />
          </button>
          <span className="timeline__nav">
            <button type="button" className="icon-btn timeline__arrow" aria-label="Anterior" onClick={() => step(-1)}>
              <ChevronLeft size={16} />
            </button>
            <button type="button" className="text-btn timeline__today-btn" onClick={() => scrollToDay(today)}>
              Hoy
            </button>
            <button type="button" className="icon-btn timeline__arrow" aria-label="Siguiente" onClick={() => step(1)}>
              <ChevronRight size={16} />
            </button>
          </span>
        </div>
      </div>
      {zoomPop.anchor && (
        <Popover anchor={zoomPop.anchor} onClose={zoomPop.close} width={180} align="end">
          <div className="menu">
            {ZOOMS.map((z) => (
              <MenuItem
                key={z}
                right={z === zoom ? <Check size={14} /> : null}
                onClick={() => {
                  zoomPop.close();
                  if (z === zoom) return;
                  keepCenter.current = centerDate();
                  setFormat({ timeline_zoom: z });
                }}
              >
                {ZOOM_LABELS[z]}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
      <div className="timeline__body">
        {showTable && (
          <div className="timeline__names">
            <div className="timeline__table" style={{ width: tableWidth }}>
              <div className="timeline__names-head">
                <span className="timeline__th" style={{ width: TITLE_WIDTH }}>
                  <span className="th__icon">
                    <TypeIcon type="title" />
                  </span>
                  <span className="th__name">{collection.schema.title?.name ?? "Nombre"}</span>
                </span>
                {columns.map((p) => (
                  <span key={p.property} className="timeline__th" style={{ width: COLUMN_WIDTH }}>
                    <span className="th__icon">
                      <TypeIcon type={collection.schema[p.property].type} />
                    </span>
                    <span className="th__name">{collection.schema[p.property].name}</span>
                  </span>
                ))}
                <button
                  type="button"
                  className="timeline__hide-table"
                  aria-label="Ocultar tabla"
                  data-tooltip="Ocultar tabla"
                  onClick={() => setFormat({ timeline_show_table: false })}
                >
                  <ChevronsLeft size={16} />
                </button>
              </div>
              {lines.map((line) => {
                if ("group" in line)
                  return (
                    <div key={line.key} className="timeline__group">
                      {groupHead(line.group)}
                    </div>
                  );
                const { row } = line;
                const open = subOpen.isOpen(row.id);
                return (
                  <div
                    role="button"
                    tabIndex={0}
                    key={line.key}
                    className="timeline__name"
                    onClick={() => onOpen(row.id)}
                    onKeyDown={(e) => e.key === "Enter" && onOpen(row.id)}
                  >
                    <span className="timeline__td timeline__td--title" style={{ width: TITLE_WIDTH }}>
                      {sub && (
                        <span
                          role="button"
                          className={`list-row__toggle timeline__toggle${line.kids ? "" : " is-empty"}${open ? " is-open" : ""}`}
                          style={{ marginLeft: (line.depth ?? 0) * 20 }}
                          aria-label={open ? "Ocultar subelementos" : "Mostrar subelementos"}
                          aria-expanded={open}
                          onClick={(e) => {
                            e.stopPropagation();
                            subOpen.toggle(row.id);
                          }}
                        >
                          <ChevronRight size={12} strokeWidth={2.4} />
                        </span>
                      )}
                      {row.format.icon && <PageIcon block={row} size={16} />}
                      <span className={isEmptyValue(row.properties.title) ? "muted" : ""}>{pageTitle(row)}</span>
                    </span>
                    {columns.map((p) => (
                      <span key={p.property} className="timeline__td" style={{ width: COLUMN_WIDTH }}>
                        {cell(row, p.property)}
                      </span>
                    ))}
                  </div>
                );
              })}
              <button type="button" className="timeline__new" onClick={() => onNew({ [by]: iso(today) })}>
                <Plus size={16} /> Nuevo ítem
              </button>
              {/* "Calcular" under each column of the table, over every row of the view. */}
              <div className="timeline__calc">
                {[{ property: "title" }, ...columns].map((p) => {
                  const s = collection.schema[p.property];
                  const calc = calcs[p.property];
                  const result = calc && s ? computeCalc(rows, p.property, s, calc, computed.values, (day) => formatDate(day, s)) : null;
                  return (
                    <button
                      type="button"
                      key={p.property}
                      className={`table-calc__cell${result ? "" : " table-calc__cell--empty"}`}
                      style={{ width: p.property === "title" ? TITLE_WIDTH : COLUMN_WIDTH }}
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
              {calcPop.anchor && calcId && collection.schema[calcId] && (
                <Popover anchor={calcPop.anchor} onClose={calcPop.close} width={220}>
                  <CalcMenu
                    schema={collection.schema[calcId]}
                    kind={computed.kinds?.[calcId]}
                    current={calcs[calcId]}
                    onPick={(calc) => {
                      calcPop.close();
                      const next = { ...calcs };
                      if (calc) next[calcId] = calc;
                      else delete next[calcId];
                      setFormat({ table_calcs: next });
                    }}
                  />
                </Popover>
              )}
            </div>
          </div>
        )}
        <div className="timeline__scroll" ref={scroller} onScroll={measure}>
          <div
            className={`timeline__canvas${drag ? " is-dragging" : ""}`}
            ref={canvasRef}
            style={{ width, height: HEAD + lines.length * ROW + ROW + (showTable ? 32 : 0) }}
          >
            {weekends.map((left) => (
              <div key={`w${left}`} className="timeline__weekend" style={{ left, width: 2 * dayWidth }} />
            ))}
            {dividers.map((left) => (
              <div key={`d${left}`} className="timeline__divider" style={{ left }} />
            ))}
            <div className="timeline__days">
              {ticks.map((t) => (
                <span
                  key={t.left}
                  className={t.start ? "is-start" : ""}
                  style={t.width ? { left: t.left, width: t.width } : { left: t.left }}
                >
                  {t.today ? <b className="timeline__today-num">{t.label}</b> : t.label}
                </span>
              ))}
            </div>
            <div className="timeline__today" style={{ left: todayX }} />
            {(arrows.length > 0 || link) && (
              <svg className="timeline__deps" width={width} height={HEAD + lines.length * ROW + ROW} aria-hidden>
                <defs>
                  <marker id={`tl-arrow-${view.id}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
                    <path d="M1,1 L7,4 L1,7 Z" className="timeline__deps-head" />
                  </marker>
                </defs>
                {arrows.map((a) => (
                  <path key={a.key} d={a.d} className="timeline__dep" markerEnd={`url(#tl-arrow-${view.id})`} />
                ))}
                {link && <path d={`M${link.x0},${link.y0} L${link.x},${link.y}`} className="timeline__dep timeline__dep--draft" />}
              </svg>
            )}
            {lines.map((line, i) => {
              const top = HEAD + i * ROW;
              if ("group" in line)
                return (
                  <div key={line.key} className="timeline__group-band" style={{ top, height: ROW }}>
                    {!showTable && (
                      <div className="timeline__group-float" style={{ left: vp.left + 8 }}>
                        {groupHead(line.group)}
                      </div>
                    )}
                  </div>
                );
              const { row, span } = line;
              const s = span && shown(row, span);
              if (!s) {
                if (!editable) return null;
                // The range being drawn, else where a click would put it; the track keeps the pointer meanwhile.
                const ghost =
                  drag?.id === row.id
                    ? shown(row, null)
                    : hover?.id === row.id && !drag
                      ? ([hover.day, addDays(hover.day, PLACEHOLDER_DAYS[zoom] - 1)] as const)
                      : null;
                return (
                  <div
                    key={line.key}
                    className="timeline__track"
                    style={{ top, height: ROW }}
                    onPointerDown={(e) => {
                      const day = dateAt(canvasX(e.clientX));
                      startDrag(e, { id: row.id, mode: "draw", x0: e.clientX, from: day, to: day, delta: 0, moved: false });
                    }}
                    onPointerMove={(e) => {
                      if (drag) return moveDrag(e);
                      const day = dateAt(canvasX(e.clientX));
                      if (hover?.id !== row.id || hover.day.getTime() !== day.getTime()) setHover({ id: row.id, day });
                    }}
                    onPointerUp={() => endDrag(row, null)}
                    onPointerCancel={() => setDrag(null)}
                    onPointerLeave={() => !drag && setHover(null)}
                  >
                    {ghost && (
                      <div
                        className="timeline__ghost"
                        data-tooltip="Haz clic para agregarla al cronograma"
                        style={{ left: x(ghost[0]), width: (days(ghost[0], ghost[1]) + 1) * dayWidth }}
                      />
                    )}
                  </div>
                );
              }
              const left = x(s[0]);
              const barWidth = Math.max(dayWidth, (days(s[0], s[1]) + 1) * dayWidth);
              const title = pageTitle(row);
              const inside = barWidth >= textWidth(title) + (row.format.icon ? 22 : 0) + 20;
              const props = <RowSummary row={row} collection={collection} view={view} exclude={[by, endProp ?? ""]} inline />;
              // Bars fully out of view leave an arrow at the edge that scrolls to them.
              const offLeft = vp.width > 0 && left + barWidth < vp.left;
              const offRight = vp.width > 0 && left > vp.left + vp.width;
              const offDate = s[0].toLocaleDateString("es", {
                day: "numeric",
                month: "short",
                ...(s[0].getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}),
              });
              return (
                <div key={line.key}>
                  <div
                    role="button"
                    tabIndex={0}
                    data-row={row.id}
                    className={`timeline__item${drag?.id === row.id ? " is-dragging" : ""}${editable ? "" : " is-static"}${link ? " is-linking" : ""}${tintClass(colors.get(row.id)?.row)}`}
                    style={{ top: top + (ROW - ITEM) / 2, left, width: barWidth }}
                    onPointerDown={(e) => {
                      if (!span) return;
                      const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset.handle;
                      if (!editable) return;
                      startDrag(e, {
                        id: row.id,
                        mode: handle === "start" ? "start" : handle === "end" ? "end" : "move",
                        x0: e.clientX,
                        from: span[0],
                        to: span[1],
                        delta: 0,
                        moved: false,
                      });
                    }}
                    onPointerMove={moveDrag}
                    onPointerUp={() => endDrag(row, span)}
                    onPointerCancel={() => setDrag(null)}
                    onClick={() => !editable && onOpen(row.id)}
                    onKeyDown={(e) => e.key === "Enter" && onOpen(row.id)}
                  >
                    {inside && (
                      <span className="timeline__item-title">
                        {row.format.icon && <PageIcon block={row} size={16} />}
                        <span>{title}</span>
                      </span>
                    )}
                    {editable && (
                      <>
                        <span className="timeline__handle timeline__handle--start" data-handle="start" />
                        <span className="timeline__handle timeline__handle--end" data-handle="end" />
                      </>
                    )}
                    {blockedBy &&
                      (["start", "end"] as const).map((side) => (
                        <span
                          key={side}
                          className={`timeline__dot timeline__dot--${side}${link?.id === row.id && link.side === side ? " is-active" : ""}`}
                          data-tooltip="Arrastra para crear una dependencia"
                          onPointerDown={(e) => startLink(e, row, side)}
                          onPointerMove={moveLink}
                          onPointerUp={endLink}
                          onPointerCancel={() => setLink(null)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ))}
                  </div>
                  <span className="timeline__item-label" style={{ left: left + barWidth + 6, top: top + (ROW - ITEM) / 2 }}>
                    {!inside && (
                      <span className="timeline__item-title">
                        {row.format.icon && <PageIcon block={row} size={16} />}
                        <span>{title}</span>
                      </span>
                    )}
                    {props}
                  </span>
                  {(offLeft || offRight) && (
                    <button
                      type="button"
                      className={`timeline__offscreen timeline__offscreen--${offLeft ? "left" : "right"}`}
                      style={
                        offLeft
                          ? { top: top + 3, left: vp.left + 4 }
                          : { top: top + 3, right: width - vp.left - vp.width + 4 }
                      }
                      onClick={() => scrollToDay(s[0])}
                    >
                      {offLeft && <ArrowLeft size={14} />}
                      <span className="timeline__offscreen-date">{offDate}</span>
                      {offRight && <ArrowRight size={14} />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <LoadMore hidden={hiddenRows} onMore={more} />
    </div>
  );
}
