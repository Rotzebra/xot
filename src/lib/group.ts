// Grouping ("Agrupar"): rows bucketed by one property, one group per value,
// in the order the view asks for. Tables and lists show collapsible groups; boards
// show one column per group.

import { useLiveQuery } from "dexie-react-hooks";
import type {
  Block,
  Collection,
  CollectionView,
  GroupBy,
  OptionColor,
  PageRef,
  PropertySchema,
  PropertyType,
  PropertyValue,
  SelectOption,
} from "./model";
import {
  cellValue,
  dateDay,
  isComputedType,
  isEmptyValue,
  rollupKind,
  type Computed,
  type ComputedValues,
  type ResultKind,
} from "./query";
import { evaluate } from "./compute";
import { db } from "./db";

/**
 * A related page left out of the relation (cell, menu and groups): one in the trash,
 * or one that isn't in Xot and has no imported name either.
 */
export const isHiddenRef = (ref: PageRef, page: Block | undefined) => (page ? !page.alive : !ref.name);

export const NO_GROUP = "__none__";

/** Types a view can be grouped by. */
export const GROUPABLE_TYPES: PropertyType[] = [
  "select",
  "multi_select",
  "status",
  "person",
  "created_by",
  "last_edited_by",
  "relation",
  "checkbox",
  "date",
  "created_time",
  "last_edited_time",
  "text",
  "url",
  "email",
  "phone_number",
  "number",
  "formula",
  "rollup",
];

/** Computed properties group by their result, which `useGroupValues` works out. */
export const isComputedGroup = (type: PropertyType) => type === "formula" || type === "rollup";

/** The default number grouping: 0 to 1000 in steps of 100. */
export const DEFAULT_NUMBER_RANGE = { start: 0, end: 1000, step: 100 };

export interface RowGroup {
  key: string;
  label: string;
  /** select / multi-select / status option, shown as its tag. */
  option?: SelectOption;
  /** Status group colour (grouped by status group). */
  color?: OptionColor;
  /** The related page (relation groups). */
  ref?: PageRef;
  /** Checkbox groups (and checkbox formulas): drawn with a checkbox. */
  checked?: boolean;
  rows: Block[];
  /** The value a page created in (or moved to) the group gets; undefined when it can't get one (computed values, buckets). */
  value: PropertyValue | undefined;
  /** Sort key for "ascending"/"descending" (dates, numbers). */
  rank: string | number;
}

type Bucket = Omit<RowGroup, "rows">;

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fullDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" });
const numberFormat = new Intl.NumberFormat("es");

/** Date bucket of a "YYYY-MM-DD" day: key, label and sortable rank. */
function dateBucket(day: string, by: NonNullable<GroupBy["date_by"]>) {
  const d = new Date(`${day}T00:00:00`);
  const month = `${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
  if (by === "day") return { key: day, label: fullDate.format(d), rank: day, value: day };
  if (by === "year") return { key: day.slice(0, 4), label: day.slice(0, 4), rank: day.slice(0, 4) };
  if (by === "month") return { key: day.slice(0, 7), label: month, rank: day.slice(0, 7) };
  if (by === "week") {
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = isoDay(monday);
    return { key, label: `Semana del ${fullDate.format(monday)}`, rank: key };
  }
  // Relative: today, yesterday, the last 7 and 30 days (and the next ones), then months.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  const near: [boolean, string, string][] = [
    [diff === 0, "today", "Hoy"],
    [diff === -1, "yesterday", "Ayer"],
    [diff === 1, "tomorrow", "Mañana"],
    [diff < 0 && diff >= -7, "last7", "Últimos 7 días"],
    [diff < 0 && diff >= -30, "last30", "Últimos 30 días"],
    [diff > 0 && diff <= 7, "next7", "Próximos 7 días"],
    [diff > 0 && diff <= 30, "next30", "Próximos 30 días"],
  ];
  const hit = near.find(([on]) => on);
  // Buckets rank by their nearest day to today, so they sort among the months.
  const rankDay = (offset: number) => {
    const r = new Date(today);
    r.setDate(today.getDate() + offset);
    return isoDay(r);
  };
  if (hit) {
    const offset = { today: 0, yesterday: -1, tomorrow: 1, last7: -2, last30: -8, next7: 2, next30: 8 }[hit[1]] ?? 0;
    return { key: hit[1], label: hit[2], rank: rankDay(offset) };
  }
  return { key: day.slice(0, 7), label: month, rank: day.slice(0, 7) };
}

/** A usable number range (a bad step falls back to the default). */
export function numberRange(groupBy: Pick<GroupBy, "number_range">) {
  const r = { ...DEFAULT_NUMBER_RANGE, ...groupBy.number_range };
  if (!(r.step > 0) || !(r.end > r.start)) return DEFAULT_NUMBER_RANGE;
  // Too many ranges would bury the view: cap them at 100.
  if ((r.end - r.start) / r.step > 100) r.step = (r.end - r.start) / 100;
  return r;
}

/** Number bucket: "0 – 100", "100 – 200"…, plus "Menos de 0" and "1000 o más" outside the range. */
function numberBucket(n: number, range: { start: number; end: number; step: number }): Bucket {
  if (n < range.start)
    return { key: "n:below", label: `Menos de ${numberFormat.format(range.start)}`, value: undefined, rank: -Infinity };
  if (n >= range.end)
    return { key: "n:above", label: `${numberFormat.format(range.end)} o más`, value: undefined, rank: Infinity };
  const lo = range.start + Math.floor((n - range.start) / range.step) * range.step;
  const hi = Math.min(lo + range.step, range.end);
  return { key: `n:${lo}`, label: `${numberFormat.format(lo)} – ${numberFormat.format(hi)}`, value: undefined, rank: lo };
}

const checkboxBucket = (on: boolean, settable: boolean): Bucket => ({
  key: String(on),
  label: on ? "Marcado" : "Sin marcar",
  checked: on,
  value: settable ? on : undefined,
  rank: on ? 0 : 1,
});

/** First letter of a text, accents dropped ("Árbol" → "A"); "#" for anything else. */
function initial(text: string) {
  const c = text.trim().charAt(0).normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
  return /\p{L}/u.test(c) ? c : "#";
}

/** The groups of a view's rows, in display order (rows keep their order inside each group). */
export function groupRows(
  rows: Block[],
  groupBy: GroupBy,
  schema: PropertySchema,
  /** Values of a computed property by row id (see `useGroupValues`). */
  values?: Map<string, PropertyValue>,
): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  const add = (g: Bucket, row?: Block) => {
    let group = groups.get(g.key);
    if (!group) groups.set(g.key, (group = { ...g, rows: [] }));
    if (row && !group.rows.includes(row)) group.rows.push(row);
  };
  const type = schema.type;
  const computed = isComputedGroup(type);
  const none: Bucket = {
    key: NO_GROUP,
    label: `Sin ${schema.name}`,
    value: computed ? undefined : type === "checkbox" ? false : null,
    rank: "",
  };
  const byStatusGroup = type === "status" && groupBy.mode === "group";
  const options = schema.options ?? [];
  const range = numberRange(groupBy);
  const dateBy = groupBy.date_by ?? "relative";
  const alphabetical = groupBy.text_by === "alphabetical";
  // Option groups exist even when empty, in the property's order (status: by status group).
  let manual: string[] = [];
  if (byStatusGroup) {
    for (const g of schema.groups ?? [])
      add({ key: g.id, label: g.name, color: g.color, value: g.option_ids[0] ?? null, rank: g.name });
    manual = (schema.groups ?? []).map((g) => g.id);
  } else if (type === "select" || type === "multi_select" || type === "status") {
    const order = (schema.groups ?? []).flatMap((g) => g.option_ids);
    const sorted =
      type === "status" ? [...options].sort((a, b) => rankIn(order, a.id) - rankIn(order, b.id)) : options;
    for (const o of sorted) add({ key: o.id, label: o.value, option: o, value: type === "multi_select" ? [o.id] : o.id, rank: o.value });
    manual = sorted.map((o) => o.id);
  } else if (type === "checkbox") {
    add(checkboxBucket(true, true));
    add(checkboxBucket(false, true));
    manual = ["true", "false"];
  } else if (type === "number") {
    // Every range shows, even empty.
    for (let lo = range.start; lo < range.end; lo += range.step) add(numberBucket(lo, range));
  }

  /** The bucket of a plain value; `settable` when moving a card there can write it back. */
  const bucketOf = (v: PropertyValue, settable: boolean): Bucket | null => {
    if (typeof v === "boolean") return checkboxBucket(v, settable);
    if (typeof v === "number") return Number.isFinite(v) ? numberBucket(v, range) : null;
    const text = String(v);
    if (type === "date" || type === "created_time" || type === "last_edited_time" || (computed && /^\d{4}-\d{2}-\d{2}/.test(text))) {
      const day = dateDay(text);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
      const b = dateBucket(day, dateBy);
      return { key: b.key, label: b.label, rank: b.rank, value: settable && "value" in b ? b.value : undefined };
    }
    if (alphabetical) {
      const letter = initial(text);
      return { key: `a:${letter}`, label: letter, value: undefined, rank: letter === "#" ? "~" : letter };
    }
    return { key: `t:${text}`, label: text, value: settable ? text : undefined, rank: text.toLowerCase() };
  };

  for (const row of rows) {
    // Relations: the visible refs (see `useGroupValues`) once they're known.
    const v = computed
      ? values?.get(row.id)
      : type === "relation" && values?.has(row.id)
        ? values.get(row.id)
        : cellValue(row, groupBy.property, schema);
    if (type === "checkbox") {
      add(checkboxBucket(!!v, true), row);
      continue;
    }
    if (v === undefined || isEmptyValue(v)) {
      add(none, row);
      continue;
    }
    if (byStatusGroup) {
      const g = (schema.groups ?? []).find((x) => x.option_ids.includes(String(v)));
      if (g) add({ key: g.id, label: g.name, color: g.color, value: g.option_ids[0] ?? null, rank: g.name }, row);
      else add(none, row);
    } else if (type === "select" || type === "status" || type === "multi_select") {
      const ids = Array.isArray(v) ? (v as string[]) : [String(v)];
      const known = ids.filter((id) => groups.has(id));
      if (!known.length) add(none, row);
      for (const id of known) add(groups.get(id)!, row);
    } else if (type === "person" || type === "created_by" || type === "last_edited_by") {
      for (const name of v as string[]) add({ key: `p:${name}`, label: name, value: [name], rank: name.toLowerCase() }, row);
    } else if (type === "relation") {
      for (const ref of v as PageRef[])
        add({ key: `r:${ref.id}`, label: ref.name || "Sin título", ref, value: [ref], rank: (ref.name || "").toLowerCase() }, row);
    } else if (Array.isArray(v)) {
      add(none, row);
    } else {
      const raw = type === "number" && typeof v === "string" ? Number(v) : v;
      const b = bucketOf(raw, !computed && type !== "created_time" && type !== "last_edited_time");
      add(b ?? none, row);
    }
  }

  let list = [...groups.values()].filter((g) => g.key !== NO_GROUP);
  const sort = groupBy.sort ?? "manual";
  const cmp = (a: RowGroup, b: RowGroup) =>
    typeof a.rank === "number" && typeof b.rank === "number"
      ? a.rank === b.rank
        ? 0
        : a.rank < b.rank
          ? -1
          : 1
      : String(a.rank).localeCompare(String(b.rank), "es", { numeric: true });
  if (sort === "manual" && manual.length) list.sort((a, b) => rankIn(manual, a.key) - rankIn(manual, b.key));
  else if (sort === "descending") list.sort((a, b) => cmp(b, a));
  else list.sort(cmp);
  const empty = groups.get(NO_GROUP);
  // "Sin …" leads in the property's order and closes a sorted list.
  if (empty?.rows.length) list = sort === "manual" ? [empty, ...list] : [...list, empty];
  // Groups dragged into place in "Agrupar" keep that order (new ones follow).
  const order = groupBy.order;
  if (sort === "manual" && order?.length) list.sort((a, b) => rankIn(order, a.key) - rankIn(order, b.key));
  if (groupBy.hide_empty) list = list.filter((g) => g.rows.length);
  return list;
}

/** The groups a view shows, and those hidden in "Agrupar" (listed under "N grupos ocultos"). */
export function splitHidden(groups: RowGroup[], groupBy: GroupBy) {
  const hidden = new Set(groupBy.hidden ?? []);
  return { shown: groups.filter((g) => !hidden.has(g.key)), hidden: groups.filter((g) => hidden.has(g.key)) };
}

const rankIn = (order: string[], id: string) => {
  const i = order.indexOf(id);
  return i === -1 ? order.length : i;
};

/** The view's grouping when its property still exists and can group. */
export function viewGrouping(view: CollectionView, schema: Record<string, PropertySchema>) {
  const g = view.type === "board" ? boardGroupBy(view) : view.format.group_by;
  const prop = g ? schema[g.property] : undefined;
  return g && prop && GROUPABLE_TYPES.includes(prop.type) ? { groupBy: g, schema: prop } : null;
}

/** A board's grouping in the shape tables and lists use (boards keep it in their own fields). */
export function boardGroupBy(view: CollectionView): GroupBy | undefined {
  const f = view.format;
  if (!f.board_group_by) return undefined;
  return {
    ...f.board_group,
    property: f.board_group_by,
    mode: f.board_group_mode,
    hide_empty: f.board_hide_empty,
  };
}

/**
 * Values of a computed property (formula, rollup) for each row, so its results can
 * group the rows; for a relation, the related pages that still show (trashed ones don't).
 * Undefined while they're worked out, and for any other property.
 */
export function useGroupValues(rows: Block[], propertyId: string | undefined, collection: Collection) {
  const schema = propertyId ? collection.schema[propertyId] : undefined;
  const computed = !!schema && isComputedGroup(schema.type);
  const relation = schema?.type === "relation";
  // Views hand over a new rows array on every render: the query reruns only when a row or the property changes.
  const rowsKey = computed || relation ? rows.map((r) => `${r.id}:${r.last_edited_time}`).join() : "";
  const schemaKey = computed ? JSON.stringify(collection.schema) : "";
  return useLiveQuery(async () => {
    if (relation && propertyId && schema) {
      const refsOf = rows.map((row) => [row.id, (cellValue(row, propertyId, schema) as PageRef[] | null) ?? []] as const);
      const ids = [...new Set(refsOf.flatMap(([, refs]) => refs.map((r) => r.id)))];
      const pages = new Map(ids.map((id, i) => [id, i] as const));
      const found = await db.blocks.bulkGet(ids);
      const values = new Map<string, PropertyValue>();
      for (const [rowId, refs] of refsOf)
        values.set(rowId, refs.filter((ref) => !isHiddenRef(ref, found[pages.get(ref.id)!])));
      return values;
    }
    if (!computed || !propertyId) return undefined;
    const values = new Map<string, PropertyValue>();
    for (const row of rows) values.set(row.id, await evaluate(row, propertyId, collection));
    return values;
  }, [rowsKey, schemaKey, propertyId, computed, relation]);
}

/** The result kind a computed value has (numbers, checkboxes, dates, else text). */
function kindOf(v: PropertyValue): ResultKind | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "checkbox";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return "date";
  return "text";
}

/**
 * Formula and rollup results for the computed properties in `ids` (what a view
 * filters, sorts, calculates or charts), plus the result kind of every computed
 * property: rollups by their "Calcular", formulas by their shape or a sample row.
 */
export function useComputed(rows: Block[] | undefined, collection: Collection | undefined, ids: (string | undefined)[]): Computed {
  const schema = collection?.schema;
  const wanted = schema ? [...new Set(ids)].filter((id): id is string => !!id && !!schema[id] && isComputedType(schema[id].type)) : [];
  const hasComputed = !!schema && Object.values(schema).some((s) => isComputedType(s.type));
  const rowsKey = hasComputed && rows ? rows.map((r) => `${r.id}:${r.last_edited_time}`).join() : "";
  const schemaKey = hasComputed ? JSON.stringify(schema) : "";
  const result = useLiveQuery(async () => {
    if (!hasComputed || !rows || !collection) return undefined;
    const kinds: Record<string, ResultKind> = {};
    for (const [id, s] of Object.entries(collection.schema)) {
      if (!isComputedType(s.type)) continue;
      const fixed =
        rollupKind(s) ??
        (s.formula?.kind === "equals"
          ? "checkbox"
          : s.formula?.kind === "template"
            ? "text"
            : s.formula?.kind === "days_until_end"
              ? "number"
              : undefined);
      if (fixed) {
        kinds[id] = fixed;
        continue;
      }
      // A formula's type shows in its results: the first row with a value tells.
      for (const row of rows.slice(0, 25)) {
        const k = kindOf(await evaluate(row, id, collection));
        if (k) {
          kinds[id] = k;
          break;
        }
      }
    }
    const values: ComputedValues = new Map();
    if (wanted.length)
      for (const row of rows) {
        const record: Record<string, PropertyValue> = {};
        for (const id of wanted) record[id] = await evaluate(row, id, collection);
        values.set(row.id, record);
      }
    return { kinds, values: wanted.length ? values : undefined };
  }, [rowsKey, schemaKey, wanted.join()]);
  return result ?? {};
}
