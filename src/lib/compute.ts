import { db } from "./db";
import type { Block, Collection, FileRef, FormulaSpec, PageRef, PropertySchema, PropertyValue, RollupAggregation, RollupSpec } from "./model";
import { cellValue } from "./query";
import {
  compile,
  display,
  FormulaError,
  isDate,
  pagePropNames,
  parseStoredDate,
  propNames,
  run,
  storedDate,
  type FPage,
  type FValue,
} from "./formula";

const DAY = 86_400_000;

/** Display text of a stored value: option names instead of ids. */
function asText(value: PropertyValue | undefined, prop: PropertySchema): string {
  if (value === undefined || value === null) return "";
  if (prop.type === "select" || prop.type === "status")
    return prop.options?.find((o) => o.id === value)?.value ?? "";
  if (Array.isArray(value))
    return value.map((v) => (typeof v === "string" ? (prop.options?.find((o) => o.id === v)?.value ?? v) : v.name)).join(", ");
  return String(value);
}

/**
 * Value of any property, computing formulas and rollups. Rollups read the
 * related rows, so this runs inside a live query and re-evaluates when they change.
 */
export async function evaluate(
  row: Block,
  propertyId: string,
  collection: Collection,
  depth = 0,
): Promise<PropertyValue> {
  const prop = collection.schema[propertyId];
  if (!prop || depth > 5) return null;

  if (prop.type === "formula" && prop.formula) {
    try {
      return toStored(await formulaRaw(row, propertyId, collection, depth));
    } catch {
      // An invalid formula shows an empty cell.
      return null;
    }
  }

  if (prop.type === "rollup" && prop.rollup) {
    const r = prop.rollup;
    if (r.aggregation === "count" || r.aggregation === "count_all") return (await relatedRows(row, r)).length;
    const { found, total } = await rollupValues(row, r, depth);
    return aggregateRollup(r.aggregation, found, total, r.group_id);
  }

  return cellValue(row, propertyId, prop) ?? null;
}

/** The live (not trashed) rows a rollup's relation links. */
async function relatedRows(row: Block, r: RollupSpec): Promise<Block[]> {
  const refs = (row.properties[r.relation] as PageRef[] | undefined) ?? [];
  return (await db.blocks.bulkGet(refs.map((ref) => ref.id))).filter((b): b is Block => !!b && b.alive);
}

/** A related row's value of a rollup's target property, with that property's schema and the row. */
export interface RollupItem {
  value: PropertyValue;
  schema: PropertySchema;
  row: Block;
}

/** Each related row's value of the rollup's target property (computed ones too). */
async function rollupValues(row: Block, r: RollupSpec, depth: number): Promise<{ found: RollupItem[]; total: number }> {
  const related = await relatedRows(row, r);
  const found: RollupItem[] = [];
  for (const target of related) {
    const targetCollection = await db.collections.get(target.parent_id);
    const schema = targetCollection?.schema[r.target];
    if (!targetCollection || !schema) continue;
    found.push({ value: await evaluate(target, r.target, targetCollection, depth + 1), schema, row: target });
  }
  return { found, total: related.length };
}

/**
 * "Mostrar original" / "Mostrar valores únicos": the related values with their own
 * property types (tags, people, pages…), for the cell to draw them like the original.
 * Unique values split lists into their items and keep the first of each.
 */
export async function rollupOriginal(row: Block, propertyId: string, collection: Collection): Promise<RollupItem[]> {
  const r = collection.schema[propertyId]?.rollup;
  if (!r) return [];
  const { found } = await rollupValues(row, r, 0);
  const shown = found.filter((f) => !isBlank(f.value));
  if (r.aggregation !== "show_unique") return shown;
  const seen = new Set<string>();
  const out: RollupItem[] = [];
  for (const f of shown) {
    const items: PropertyValue[] = Array.isArray(f.value) ? (f.value as (string | PageRef | FileRef)[]).map((v) => [v] as PropertyValue) : [f.value];
    for (const value of items) {
      const key = f.schema.type === "title" ? asText(value, f.schema) : JSON.stringify(value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...f, value });
    }
  }
  return out;
}

/** A formula's result as the formula computes it (lists, pages, styled text), for the cell to draw; null when it fails. */
export async function formulaValue(row: Block, propertyId: string, collection: Collection): Promise<FValue> {
  try {
    return await formulaRaw(row, propertyId, collection, 0);
  } catch {
    return null;
  }
}

const isBlank = (v: PropertyValue | undefined) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** A value's items as text: each option, person, page or file of a list, or the value itself. */
function itemsOf(value: PropertyValue, prop: PropertySchema): string[] {
  if (isBlank(value)) return [];
  if (Array.isArray(value)) return (value as (string | PageRef | FileRef)[]).map((v) => asText([v] as PropertyValue, prop)).filter(Boolean);
  if (typeof value === "boolean") return [value ? "✓" : ""].filter(Boolean);
  return [asText(value, prop)].filter(Boolean);
}

const DAY_MS = 86_400_000;

/** A rollup's result from the related rows' values ("Calcular"). */
export function aggregateRollup(
  aggregation: RollupAggregation,
  found: { value: PropertyValue; schema: PropertySchema }[],
  total: number,
  /** "Recuento por grupo" / "Porcentaje por grupo": the status group whose options count. */
  groupId?: string,
): PropertyValue {
  const values = found.map((f) => f.value);
  const items = found.flatMap((f) => itemsOf(f.value, f.schema));
  const numbers = values
    .map((v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN))
    .filter((n) => Number.isFinite(n));
  const days = values
    .flatMap((v) => (typeof v === "string" ? v.split("/") : []))
    .map((d) => d.slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const empty = values.filter(isBlank).length + (total - found.length);
  const checked = values.filter((v) => v === true).length;
  const share = (n: number) => (total ? n / total : 0);
  switch (aggregation) {
    case "show_original":
      return items.join(", ") || null;
    case "show_unique":
      return [...new Set(items)].join(", ") || null;
    case "count":
    case "count_all":
      return total;
    case "count_values":
      return items.length;
    case "count_unique":
      return new Set(items).size;
    case "count_empty":
      return empty;
    case "count_not_empty":
      return total - empty;
    case "percent_empty":
      return share(empty);
    case "percent_not_empty":
      return share(total - empty);
    case "sum":
      return numbers.reduce((a, b) => a + b, 0);
    case "average":
      return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
    case "median": {
      if (!numbers.length) return null;
      const sorted = [...numbers].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    case "min":
      return numbers.length ? Math.min(...numbers) : null;
    case "max":
      return numbers.length ? Math.max(...numbers) : null;
    case "range":
      return numbers.length ? Math.max(...numbers) - Math.min(...numbers) : null;
    case "earliest_date":
      return days[0] ?? null;
    case "latest_date":
      return days[days.length - 1] ?? null;
    case "date_range": {
      if (!days.length) return null;
      const n = Math.round(
        (new Date(`${days[days.length - 1]}T00:00:00`).getTime() - new Date(`${days[0]}T00:00:00`).getTime()) / DAY_MS,
      );
      return `${n} ${n === 1 ? "día" : "días"}`;
    }
    case "checked":
      return checked;
    case "unchecked":
      return total - checked;
    case "percent_checked":
      return share(checked);
    case "percent_unchecked":
      return share(total - checked);
    case "count_per_group":
    case "percent_per_group": {
      // Without a group (an import that didn't keep it), the last one: Complete.
      const groupOf = (schema: PropertySchema) =>
        groupId ? schema.groups?.find((g) => g.id === groupId) : schema.groups?.[schema.groups.length - 1];
      const inGroup = found.filter((f) => typeof f.value === "string" && !!groupOf(f.schema)?.option_ids.includes(f.value)).length;
      return aggregation === "count_per_group" ? inGroup : share(inGroup);
    }
  }
}

/** Rollup results that are a share of the related rows (shown as a percentage). */
export const PERCENT_AGGREGATIONS: RollupAggregation[] = [
  "percent_empty",
  "percent_not_empty",
  "percent_checked",
  "percent_unchecked",
  "percent_per_group",
];

/** A formula result as a cell stores it: dates in the date property format, lists as text. */
function toStored(v: FValue): PropertyValue {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (isDate(v)) return storedDate(v);
  // Lists, pages and styled text are stored as their text.
  return display(v);
}

/** A property's value as formulas see it: option names, dates, lists, pages. `pageNames` are the
 *  properties the formula reads from related pages (page.prop("…")), loaded with each page. */
async function formulaInput(
  row: Block,
  propertyId: string,
  collection: Collection,
  depth: number,
  pageNames?: Set<string>,
): Promise<FValue> {
  const prop = collection.schema[propertyId];
  if (prop.type === "relation") return relatedPages(row.properties[propertyId], depth, pageNames);
  if (prop.type === "formula") {
    try {
      return await formulaRaw(row, propertyId, collection, depth + 1);
    } catch {
      return null;
    }
  }
  const v = await evaluate(row, propertyId, collection, depth + 1);
  switch (prop.type) {
    case "checkbox":
      return v === true;
    case "select":
    case "status":
      return asText(v, prop) || null;
    case "multi_select":
      return Array.isArray(v) ? (v as string[]).map((id) => prop.options?.find((o) => o.id === id)?.value ?? id) : [];
    case "person":
    case "created_by":
    case "last_edited_by":
      return Array.isArray(v) ? (v as string[]) : [];
    case "file":
      return Array.isArray(v) ? (v as FileRef[]).map((f) => f.name) : [];
    case "date":
    case "created_time":
    case "last_edited_time":
      return typeof v === "string" && v ? parseStoredDate(v) : null;
    default:
      if (v === undefined || v === null) return null;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
      return asText(v, prop);
  }
}

/** A property's id from the name a formula uses (or its id). */
function propertyByName(collection: Collection, name: string): string | undefined {
  for (const [id, s] of Object.entries(collection.schema)) if (s.name === name) return id;
  return collection.schema[name] ? name : undefined;
}

/** A relation's pages for a formula, each with the properties it reads from them (see pagePropNames). */
async function relatedPages(value: PropertyValue | undefined, depth: number, pageNames?: Set<string>): Promise<FPage[]> {
  const refs = Array.isArray(value) ? (value as PageRef[]).filter((r) => r && typeof r === "object" && "id" in r) : [];
  const blocks = await db.blocks.bulkGet(refs.map((r) => r.id));
  const pages: FPage[] = [];
  for (const [i, ref] of refs.entries()) {
    const block = blocks[i];
    // Trashed pages aren't linked any more.
    if (block && !block.alive) continue;
    const title = block ? String(block.properties.title ?? "") : ref.name;
    const page: FPage = { kind: "page", id: ref.id, name: title };
    if (pageNames?.size) {
      page.props = new Map();
      const c = block ? await db.collections.get(block.parent_id) : undefined;
      for (const name of pageNames) {
        const id = c && propertyByName(c, name);
        if (block && c && id) page.props.set(name, depth > 4 ? null : await formulaInput(block, id, c, depth + 1, pageNames));
        // Pages that aren't in Xot have no values to read.
        else if (!block) page.props.set(name, null);
      }
    }
    pages.push(page);
  }
  return pages;
}

/** A page as formulas see it (FPage), with the properties `pageNames` reads from it; null when it's gone. */
export async function pageForFormula(id: string, pageNames?: Set<string>): Promise<FPage | null> {
  const block = await db.blocks.get(id);
  if (!block?.alive) return null;
  return (await relatedPages([{ id, name: String(block.properties.title ?? "") }], 0, pageNames))[0] ?? null;
}

/** Runs a formula source against a row; throws FormulaError when it's invalid. */
export async function runFormula(
  row: Block,
  source: string,
  collection: Collection,
  depth = 0,
  /** Named values (automation and button variables), read by name in the source. */
  vars?: Map<string, FValue>,
): Promise<FValue> {
  if (!source.trim()) return null;
  const tree = compile(source);
  const pageNames = pagePropNames(tree);
  const values = new Map<string, FValue>();
  for (const name of propNames(tree)) {
    const id = propertyByName(collection, name);
    if (!id) throw new FormulaError(`No existe la propiedad «${name}»`, ...propertyAt(source, name));
    values.set(name, depth > 5 ? null : await formulaInput(row, id, collection, depth, pageNames));
  }
  return run(tree, {
    id: row.id,
    vars,
    prop: (name) => {
      if (!values.has(name)) throw new FormulaError("prop() necesita el nombre de la propiedad entre comillas");
      return values.get(name)!;
    },
  });
}

/** Where prop("name") is in the source, for the editor to mark a missing property. */
function propertyAt(source: string, name: string): [number?, number?] {
  const m = new RegExp(`prop\\(\\s*["“']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["”']\\s*\\)`).exec(source);
  return m ? [m.index, m.index + m[0].length] : [];
}

/** A formula property's raw result; legacy imported shapes keep their behaviour. */
async function formulaRaw(row: Block, propertyId: string, collection: Collection, depth: number): Promise<FValue> {
  const f = collection.schema[propertyId]?.formula;
  if (!f || depth > 5) return null;
  switch (f.kind) {
    case "expression":
    case "unsupported":
      return runFormula(row, f.source, collection, depth);
    case "equals": {
      const source = collection.schema[f.property];
      if (!source) return null;
      return asText(await evaluate(row, f.property, collection, depth + 1), source) === f.value;
    }
    case "template": {
      const parts = await Promise.all(
        f.parts.map(async (part) => {
          if (typeof part === "string") return part;
          const source = collection.schema[part.property];
          return source ? asText(await evaluate(row, part.property, collection, depth + 1), source) : "";
        }),
      );
      return parts.join("");
    }
    case "days_until_end": {
      const value = row.properties[f.property];
      if (typeof value !== "string" || !value) return null;
      const [start, end] = value.split("/");
      const due = new Date(`${(end ?? start).slice(0, 10)}T00:00:00`).getTime();
      const now = Date.now();
      return now > due ? "0" : String(Math.floor((due - now) / DAY));
    }
  }
}

/** A formula as editable source; older imported shapes are written out as formula text. */
export function formulaSource(f: FormulaSpec | undefined, collection: Collection | undefined): string {
  if (!f) return "";
  const ref = (id: string) => `prop("${collection?.schema[id]?.name ?? id}")`;
  switch (f.kind) {
    case "expression":
    case "unsupported":
      return f.source;
    case "equals":
      return `if(${ref(f.property)} == ${JSON.stringify(f.value)}, true, false)`;
    case "template":
      return f.parts.map((p) => (typeof p === "string" ? JSON.stringify(p) : ref(p.property))).join(" + ");
    case "days_until_end":
      return `if(now() > ${ref(f.property)}.dateEnd(), "0", format(dateBetween(${ref(f.property)}.dateEnd(), now(), "days")))`;
  }
}
