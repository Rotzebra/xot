import { resolveDate } from "./format";
import { LOCAL_PERSON } from "./model";
import type {
  PageRef,
  Block,
  Collection,
  Filter,
  FilterGroup,
  FilterOperator,
  PropertySchema,
  PropertyType,
  PropertyValue,
  Query,
} from "./model";

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: "contiene",
  does_not_contain: "no contiene",
  is: "es",
  is_not: "no es",
  starts_with: "empieza por",
  ends_with: "termina en",
  is_empty: "está vacío",
  is_not_empty: "no está vacío",
  eq: "=",
  neq: "≠",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
  before: "es antes de",
  after: "es después de",
  on_or_before: "es el o antes de",
  on_or_after: "es el o después de",
  is_between: "está entre",
  is_within: "está dentro de",
};

/** What a formula or rollup returns, which decides how it filters, sorts and calculates. */
export type ResultKind = "number" | "checkbox" | "date" | "text";

/** Formula and rollup results of a view's rows: row id → property id → value. */
export type ComputedValues = Map<string, Record<string, PropertyValue>>;

/** Computed values and result kinds handed to queries and calculations. */
export interface Computed {
  values?: ComputedValues;
  kinds?: Record<string, ResultKind>;
}

export const isComputedType = (type: PropertyType) => type === "formula" || type === "rollup";

const KIND_TYPE: Record<ResultKind, PropertyType> = { number: "number", checkbox: "checkbox", date: "date", text: "text" };

/**
 * The schema a formula or rollup filters and sorts as: its result type
 * (number, checkbox, date or text). Any other property is returned as is.
 */
export function effectiveSchema(schema: PropertySchema, kind?: ResultKind): PropertySchema {
  if (!isComputedType(schema.type)) return schema;
  return { ...schema, type: KIND_TYPE[kind ?? rollupKind(schema) ?? "text"] };
}

/** A rollup's result kind from its "Calcular" choice; undefined for formulas (they need a sample). */
export function rollupKind(schema: PropertySchema): ResultKind | undefined {
  if (schema.type !== "rollup" || !schema.rollup) return undefined;
  const a = schema.rollup.aggregation;
  if (a === "show_original" || a === "show_unique" || a === "date_range") return "text";
  if (a === "earliest_date" || a === "latest_date") return "date";
  return "number";
}

export const WITHIN_LABELS: Record<string, string> = {
  surrounding_day: "hoy",
  surrounding_week: "esta semana",
  surrounding_month: "este mes",
  surrounding_year: "este año",
};

/** Whether a "YYYY-MM-DD" day falls in the current day/week/month/year. */
function isWithin(day: string, period: string) {
  const today = resolveDate("relative:today");
  switch (period) {
    case "surrounding_day":
      return day === today;
    case "surrounding_month":
      return day.slice(0, 7) === today.slice(0, 7);
    case "surrounding_year":
      return day.slice(0, 4) === today.slice(0, 4);
    case "surrounding_week": {
      const d = new Date(`${today}T00:00:00`);
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const iso = (x: Date) =>
        `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
      return day >= iso(monday) && day <= iso(sunday);
    }
    default:
      return true;
  }
}

/** Text-like types: filtered and sorted by their plain text. */
const TEXT_TYPES: PropertyType[] = [
  "title",
  "text",
  "url",
  "email",
  "phone_number",
  "place",
  "person",
  "created_by",
  "last_edited_by",
  "file",
  "relation",
];
const DATE_TYPES: PropertyType[] = ["date", "created_time", "last_edited_time"];
export const PERSON_TYPES: PropertyType[] = ["person", "created_by", "last_edited_by"];

/** Filter operators of a type, in menu order (formulas and rollups: pass `effectiveSchema(...).type`). */
export function operatorsFor(type: PropertyType): FilterOperator[] {
  if (type === "relation" || PERSON_TYPES.includes(type)) return ["contains", "does_not_contain", "is_empty", "is_not_empty"];
  if (type === "file") return ["is_empty", "is_not_empty"];
  if (TEXT_TYPES.includes(type))
    return ["contains", "does_not_contain", "is", "is_not", "starts_with", "ends_with", "is_empty", "is_not_empty"];
  if (DATE_TYPES.includes(type))
    return ["is", "is_within", "before", "after", "on_or_before", "on_or_after", "is_between", "is_empty", "is_not_empty"];
  switch (type) {
    case "checkbox":
      return ["is", "is_not"];
    case "number":
    case "auto_increment_id":
      return ["eq", "neq", "gt", "lt", "gte", "lte", "is_empty", "is_not_empty"];
    case "select":
    case "status":
      return ["is", "is_not", "is_empty", "is_not_empty"];
    case "multi_select":
      return ["contains", "does_not_contain", "is_empty", "is_not_empty"];
    default:
      return ["is"];
  }
}

const toLocalIso = (time: number) => {
  const d = new Date(time - new Date(time).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

/**
 * The parent/children relation pair that nests rows: the collection's own
 * setting, else a two-way self-relation named like "Parent item".
 */
export function subitemConfig(collection: Collection): { parent: string; children: string } | null {
  const s = collection.subitems;
  if (s && collection.schema[s.parent]?.type === "relation" && collection.schema[s.children]?.type === "relation") return s;
  if (collection.subitems_off) return null;
  for (const [id, p] of Object.entries(collection.schema)) {
    if (p.type !== "relation" || p.collection_id !== collection.id || !p.synced_property) continue;
    if (/^(parent item|parent task|elemento principal|tarea principal)$/i.test(p.name.trim()) && collection.schema[p.synced_property]?.type === "relation")
      return { parent: id, children: p.synced_property };
  }
  return null;
}

/**
 * A relation's page limit: 1 or 0 (no limit). A "Parent item" always
 * links one page, even when it was imported without the setting.
 */
export function relationLimit(collection: Collection, propertyId: string): number {
  const p = collection.schema[propertyId];
  if (p?.type !== "relation") return 0;
  return p.limit ?? (subitemConfig(collection)?.parent === propertyId ? 1 : 0);
}

/**
 * The value a cell shows; created/edited times come from the row itself, and
 * formulas and rollups from `computed` (they are never stored on the row).
 */
export function cellValue(
  row: Block,
  propertyId: string,
  schema: PropertySchema,
  computed?: ComputedValues,
): PropertyValue | undefined {
  if (computed && isComputedType(schema.type)) return computed.get(row.id)?.[propertyId];
  if (schema.type === "created_time") return toLocalIso(row.created_time);
  if (schema.type === "last_edited_time") return toLocalIso(row.last_edited_time);
  if (schema.type === "created_by" || schema.type === "last_edited_by") return [LOCAL_PERSON];
  if (schema.type === "verification") {
    const v = row.format.verified;
    return v ? (v.until !== null && v.until <= Date.now() ? "Caducada" : "Verificada") : null;
  }
  return row.properties[propertyId];
}

/** "YYYY-MM-DD" of a date value, ignoring time and range end. */
export const dateDay = (v: PropertyValue | undefined) => String(v ?? "").split("/")[0].slice(0, 10);

export function plainText(v: PropertyValue | undefined): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : x.name)).join(", ");
  return String(v);
}

export const needsValue = (op: FilterOperator) => op !== "is_empty" && op !== "is_not_empty";

export function isEmptyValue(v: PropertyValue | undefined) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** A formula/rollup value as the text, number or day its result kind compares. */
function asKind(v: PropertyValue | undefined, type: PropertyType): PropertyValue | undefined {
  if (v === undefined || v === null) return v;
  if (type === "number" && typeof v === "string") return v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  if (type === "checkbox") return v === true || v === "true";
  return v;
}

function matches(v: PropertyValue | undefined, filter: Filter, schema: PropertySchema): boolean {
  const op = filter.operator;
  if (op === "is_empty") return schema.type === "checkbox" ? !v : isEmptyValue(v);
  if (op === "is_not_empty") return schema.type === "checkbox" ? !!v : !isEmptyValue(v);
  const target = filter.value;

  if (schema.type === "relation" || PERSON_TYPES.includes(schema.type)) {
    // A checklist of pages (ids) or people (names); imported filters hold one id, name or title.
    const list = Array.isArray(v) ? (v as (string | PageRef)[]) : [];
    const keys = list.map((x) => (typeof x === "string" ? x : x.id));
    let hit: boolean;
    if (Array.isArray(target)) {
      const ids = target as string[];
      if (!ids.length) return true;
      hit = keys.some((k) => ids.includes(k));
    } else {
      const t = String(target ?? "").toLowerCase();
      hit = list.some((x) => (typeof x === "string" ? x.toLowerCase().includes(t) : x.id === target || x.name.toLowerCase().includes(t)));
    }
    if (op === "contains" || op === "is") return hit;
    if (op === "does_not_contain" || op === "is_not") return !hit;
    return true;
  }
  if (TEXT_TYPES.includes(schema.type)) {
    const a = plainText(v).toLowerCase();
    const b = String(target ?? "").toLowerCase();
    if (op === "contains") return a.includes(b);
    if (op === "does_not_contain") return !a.includes(b);
    if (op === "is") return a === b;
    if (op === "is_not") return a !== b;
    if (op === "starts_with") return a.startsWith(b);
    if (op === "ends_with") return a.endsWith(b);
    return true;
  }
  if (DATE_TYPES.includes(schema.type)) {
    if (isEmptyValue(v)) return false;
    const a = dateDay(v);
    if (op === "is_within") return isWithin(a, String(target));
    if (op === "is_between") {
      // "YYYY-MM-DD/YYYY-MM-DD": both ends included.
      const [lo, hi = lo] = String(target).split("/").map((d) => resolveDate(d).slice(0, 10));
      return a >= lo && a <= hi;
    }
    const b = resolveDate(String(target));
    if (op === "is") return a === b;
    if (op === "before") return a < b;
    if (op === "after") return a > b;
    if (op === "on_or_before") return a <= b;
    if (op === "on_or_after") return a >= b;
    return true;
  }

  switch (schema.type) {
    case "number":
    case "auto_increment_id": {
      if (isEmptyValue(v)) return op === "neq";
      const a = Number(v);
      const b = Number(target);
      if (op === "eq") return a === b;
      if (op === "neq") return a !== b;
      if (op === "gt") return a > b;
      if (op === "lt") return a < b;
      if (op === "gte") return a >= b;
      if (op === "lte") return a <= b;
      return true;
    }
    case "select":
    case "status": {
      // Several values (the filter chip's checklist) match any of them.
      // "group:<id>" matches any status option in that group (To-do, In progress, Complete).
      const targets = Array.isArray(target) ? target : [target];
      const inTarget = targets.some((t) =>
        typeof t === "string" && t.startsWith("group:")
          ? !!schema.groups?.find((g) => g.id === t.slice(6))?.option_ids.includes(v as string)
          : v === t,
      );
      if (op === "is") return inTarget;
      if (op === "is_not") return !inTarget;
      return true;
    }
    case "multi_select": {
      const list = Array.isArray(v) ? (v as string[]) : [];
      const targets = (Array.isArray(target) ? target : [target]) as string[];
      const hit = targets.some((t) => list.includes(t));
      if (op === "contains") return hit;
      if (op === "does_not_contain") return !hit;
      return true;
    }
    case "checkbox":
      return op === "is_not" ? !!v !== !!target : !!v === !!target;
    default:
      return true;
  }
}

/**
 * Whether a page meets one rule (conditional colors): like a view's filter, but a rule still
 * waiting for its value (or a formula's result) matches nothing.
 */
export function rowMatches(row: Block, filter: Filter, rawSchema: Record<string, PropertySchema>, computed?: Computed): boolean {
  const raw = rawSchema[filter.property];
  if (!raw) return false;
  const computedType = isComputedType(raw.type);
  if (computedType && !computed?.values) return false;
  const schema = computedType ? effectiveSchema(raw, computed?.kinds?.[filter.property]) : raw;
  if (!isActive(filter, schema)) return false;
  const value = computedType ? asKind(computed?.values?.get(row.id)?.[filter.property], schema.type) : cellValue(row, filter.property, raw);
  return matches(value, filter, schema);
}

/** A filter without a value doesn't narrow anything. */
function isActive(filter: Filter, schema: PropertySchema | undefined) {
  if (!schema) return false;
  if (!needsValue(filter.operator) || schema.type === "checkbox") return true;
  return !isEmptyValue(filter.value);
}

function compare(a: PropertyValue | undefined, b: PropertyValue | undefined, schema: PropertySchema) {
  const ea = isEmptyValue(a);
  const eb = isEmptyValue(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (DATE_TYPES.includes(schema.type)) return String(a).localeCompare(String(b));
  switch (schema.type) {
    case "number":
    case "auto_increment_id":
      return Number(a) - Number(b);
    case "checkbox":
      return Number(!!a) - Number(!!b);
    case "select":
    case "status": {
      const ids = (schema.options ?? []).map((o) => o.id);
      return ids.indexOf(a as string) - ids.indexOf(b as string);
    }
    case "multi_select": {
      const name = (v: PropertyValue | undefined) =>
        (v as string[]).map((id) => schema.options?.find((o) => o.id === id)?.value ?? "").join(",");
      return name(a).localeCompare(name(b), "es");
    }
    default:
      return plainText(a).localeCompare(plainText(b), "es", { numeric: true });
  }
}

/** Every rule in a filter group and the groups nested in it. */
export const groupRules = (g: FilterGroup): Filter[] => [...g.filters, ...(g.groups ?? []).flatMap(groupRules)];

/** A filter group with `fix` applied to each of its rules, nested groups included. */
export const mapGroupRules = (g: FilterGroup, fix: (f: Filter) => Filter): FilterGroup => ({
  ...g,
  filters: g.filters.map(fix),
  ...(g.groups ? { groups: g.groups.map((x) => mapGroupRules(x, fix)) } : {}),
});

/** A filter group without the rules `keep` rejects; groups left with no rules go too. */
export function pruneGroup(g: FilterGroup, keep: (f: Filter) => boolean): FilterGroup | null {
  const groups = (g.groups ?? []).map((x) => pruneGroup(x, keep)).filter((x): x is FilterGroup => !!x);
  const filters = g.filters.filter(keep);
  if (!filters.length && !groups.length) return null;
  return { ...g, filters, ...(g.groups ? { groups } : {}) };
}

/** Property ids of the formulas and rollups a query filters or sorts by. */
export function queryComputedIds(query: Query, schema: Record<string, PropertySchema>): string[] {
  const ids = [
    ...query.filters.map((f) => f.property),
    ...(query.filter_groups ?? []).flatMap((g) => groupRules(g).map((f) => f.property)),
    ...query.sort.map((s) => s.property),
  ];
  return [...new Set(ids)].filter((id) => schema[id] && isComputedType(schema[id].type));
}

export function applyQuery(
  rows: Block[],
  rawSchema: Record<string, PropertySchema>,
  query: Query,
  /** The view's own manual order (page_sort): listed rows first, in its order. */
  pageSort?: string[],
  /** Formula and rollup results (and kinds); rules on them wait until the values arrive. */
  computed?: Computed,
): Block[] {
  // Formulas and rollups filter and sort by their result type; until their values arrive they're left out.
  const schema: Record<string, PropertySchema> = {};
  for (const [id, s] of Object.entries(rawSchema))
    if (!isComputedType(s.type)) schema[id] = s;
    else if (computed?.values) schema[id] = effectiveSchema(s, computed.kinds?.[id]);
  const valueOf = (row: Block, id: string) => {
    const raw = rawSchema[id];
    if (!isComputedType(raw.type)) return cellValue(row, id, raw);
    return asKind(computed?.values?.get(row.id)?.[id], schema[id].type);
  };
  const active = query.filters.filter((f) => isActive(f, schema[f.property]));
  // Groups with no active rule don't narrow anything, like an empty rule.
  const groups = (query.filter_groups ?? [])
    .map((g) => pruneGroup(g, (f) => isActive(f, schema[f.property])))
    .filter((g): g is FilterGroup => !!g);
  const groupMatches = (row: Block, g: FilterGroup): boolean => {
    const inner = [
      ...g.filters.map((f) => matches(valueOf(row, f.property), f, schema[f.property])),
      ...(g.groups ?? []).map((x) => groupMatches(row, x)),
    ];
    return g.operator === "or" ? inner.some(Boolean) : inner.every(Boolean);
  };
  let result = rows;
  if (active.length || groups.length) {
    result = rows.filter((row) => {
      const results = [
        ...active.map((f) => matches(valueOf(row, f.property), f, schema[f.property])),
        ...groups.map((g) => groupMatches(row, g)),
      ];
      return query.filter_operator === "or" ? results.some(Boolean) : results.every(Boolean);
    });
  }
  const sorts = query.sort.filter((s) => schema[s.property]);
  const rank = pageSort?.length ? new Map(pageSort.map((id, i) => [id, i])) : null;
  return [...result].sort((a, b) => {
    for (const s of sorts) {
      const prop = schema[s.property];
      const va = valueOf(a, s.property);
      const vb = valueOf(b, s.property);
      let c = compare(va, vb, prop);
      // empties stay last in both directions
      if (c !== 0 && !isEmptyValue(va) && !isEmptyValue(vb) && s.direction === "descending") c = -c;
      if (c !== 0) return c;
    }
    if (rank) {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra < rb ? -1 : 1;
    }
    return a.order - b.order;
  });
}

export function countActiveFilters(query: Query, schema: Record<string, PropertySchema>) {
  const all = [...query.filters, ...(query.filter_groups ?? []).flatMap(groupRules)];
  return all.filter((f) => isActive(f, schema[f.property])).length;
}
