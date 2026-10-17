import type { Block, ChartConfig, ChartType, Collection, Filter, OptionColor, PageRef, PropertySchema } from "./model";
import { cellValue, isEmptyValue, type ComputedValues } from "./query";

export interface ChartPart {
  key: string;
  label: string;
  value: number;
  color: OptionColor | null;
}

export interface ChartPoint {
  key: string;
  label: string;
  value: number;
  color: OptionColor | null;
  /** How many rows fall in it. */
  count?: number;
  /** With "series_by": the value of each series in this category, in the series' order. */
  parts?: ChartPart[];
}

export const AGGREGATOR_LABELS: Record<ChartConfig["aggregator"], string> = {
  count: "Recuento",
  sum: "Suma",
  average: "Promedio",
  min: "Mínimo",
  max: "Máximo",
};

const MONTH = new Intl.DateTimeFormat("es", { month: "short", year: "numeric" });

/** Category keys of a row for the group-by property (a row can fall in several). */
function groupsOf(row: Block, id: string, prop: PropertySchema): { key: string; label: string; color: OptionColor | null }[] {
  const v = cellValue(row, id, prop);
  if (isEmptyValue(v)) return [];
  switch (prop.type) {
    case "select":
    case "status":
    case "multi_select": {
      const ids = Array.isArray(v) ? (v as string[]) : [v as string];
      return ids
        .map((oid) => prop.options?.find((o) => o.id === oid))
        .filter((o) => !!o)
        .map((o) => ({ key: o!.id, label: o!.value, color: o!.color }));
    }
    case "person":
      return (v as string[]).map((name) => ({ key: name, label: name, color: null }));
    case "relation":
      return (v as PageRef[]).map((ref) => ({ key: ref.id, label: ref.name || "Sin título", color: null }));
    case "checkbox":
      return [{ key: String(!!v), label: v ? "Marcada" : "Sin marcar", color: null }];
    case "date":
    case "created_time":
    case "last_edited_time": {
      const month = String(v).slice(0, 7);
      const label = MONTH.format(new Date(`${month}-01T00:00:00`));
      return [{ key: month, label, color: null }];
    }
    default:
      return [{ key: String(v), label: String(v), color: null }];
  }
}

function aggregate(rows: Block[], config: ChartConfig, collection: Collection, computed?: ComputedValues): number {
  if (config.aggregator === "count" || !config.property) return rows.length;
  const prop = collection.schema[config.property];
  if (!prop) return 0;
  // Formulas and rollups come from `computed`; their numbers can be written as text.
  const values = rows
    .map((r) => cellValue(r, config.property!, prop, computed))
    .map((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!values.length) return 0;
  switch (config.aggregator) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "average":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
}

/** The rows a chart category counts (its bar or slice), for the list a click on it opens. */
export function chartGroupRows(rows: Block[], collection: Collection, config: ChartConfig, key: string): Block[] {
  const prop = config.group_by ? collection.schema[config.group_by] : undefined;
  if (!prop || !config.group_by) return rows;
  return rows.filter((row) => {
    const groups = groupsOf(row, config.group_by!, prop);
    return key === "__none__" ? !groups.length : groups.some((g) => g.key === key);
  });
}

/** One number for "number" charts, or the categories for the others. */
export function chartData(
  rows: Block[],
  collection: Collection,
  config: ChartConfig,
  /** Formula and rollup results, when the chart's value is one. */
  computed?: ComputedValues,
): number | ChartPoint[] {
  if (config.type === "number" || !config.group_by) return aggregate(rows, config, collection, computed);
  const prop = collection.schema[config.group_by];
  if (!prop) return [];

  const buckets = new Map<string, { label: string; color: OptionColor | null; rows: Block[] }>();
  // Option-based properties start with every option, in their own order.
  if (prop.options && (prop.type === "select" || prop.type === "status" || prop.type === "multi_select"))
    for (const o of prop.options) buckets.set(o.id, { label: o.value, color: o.color, rows: [] });
  const none: Block[] = [];
  for (const row of rows) {
    const groups = groupsOf(row, config.group_by, prop);
    if (!groups.length) none.push(row);
    for (const g of groups) {
      const bucket = buckets.get(g.key) ?? { label: g.label, color: g.color, rows: [] };
      bucket.rows.push(row);
      buckets.set(g.key, bucket);
    }
  }

  // "Series": a second property splits each category; its buckets are the series, in their own order.
  const seriesProp = config.series_by && config.series_by !== config.group_by ? collection.schema[config.series_by] : undefined;
  const series = seriesProp ? chartSeries(rows, config.series_by!, seriesProp) : [];
  const partsOf = (list: Block[]): ChartPart[] | undefined =>
    seriesProp
      ? series.map((sr) => {
          const inSeries = list.filter((row) => {
            const groups = groupsOf(row, config.series_by!, seriesProp);
            return sr.key === "__none__" ? !groups.length : groups.some((g) => g.key === sr.key);
          });
          return { ...sr, value: inSeries.length ? aggregate(inSeries, config, collection, computed) : 0 };
        })
      : undefined;

  let points: ChartPoint[] = [...buckets.entries()].map(([key, b]) => ({
    key,
    label: b.label,
    color: b.color,
    value: b.rows.length ? aggregate(b.rows, config, collection, computed) : 0,
    count: b.rows.length,
    parts: partsOf(b.rows),
  }));
  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time")
    points.sort((a, b) => a.key.localeCompare(b.key));
  if (none.length)
    points.push({
      key: "__none__",
      label: `Sin ${prop.name.toLowerCase()}`,
      color: null,
      value: aggregate(none, config, collection, computed),
      count: none.length,
      parts: partsOf(none),
    });
  // "Ocultar grupos vacíos" drops categories with no rows; "Omitir ceros" those worth 0; hidden ones go too.
  if (config.hide_empty) points = points.filter((p) => (p.count ?? 0) > 0);
  if (config.omit_zero) points = points.filter((p) => p.value !== 0);
  if (config.hidden_groups?.length) points = points.filter((p) => !config.hidden_groups!.includes(p.key));

  const byLabel = (a: ChartPoint, b: ChartPoint) => a.label.localeCompare(b.label, "es", { numeric: true });
  switch (config.sort) {
    case "x-ascending":
      points.sort(byLabel);
      break;
    case "x-descending":
      points.sort((a, b) => byLabel(b, a));
      break;
    case "y-ascending":
      points.sort((a, b) => a.value - b.value);
      break;
    case "y-descending":
      points.sort((a, b) => b.value - a.value);
      break;
  }
  // "Acumulado": running totals, after the order is set.
  if (config.cumulative && config.type !== "donut") {
    let run = 0;
    const runs = series.map(() => 0);
    points = points.map((p) => {
      run += p.value;
      return {
        ...p,
        value: run,
        parts: p.parts?.map((part, i) => {
          runs[i] += part.value;
          return { ...part, value: runs[i] };
        }),
      };
    });
  }
  return points;
}

/** The series a "series_by" property makes: its options in order (or values as found), then "Sin …". */
function chartSeries(rows: Block[], id: string, prop: PropertySchema): Omit<ChartPart, "value">[] {
  const out = new Map<string, Omit<ChartPart, "value">>();
  if (prop.options && (prop.type === "select" || prop.type === "status" || prop.type === "multi_select"))
    for (const o of prop.options) out.set(o.id, { key: o.id, label: o.value, color: o.color });
  let none = false;
  for (const row of rows) {
    const groups = groupsOf(row, id, prop);
    if (!groups.length) none = true;
    for (const g of groups) if (!out.has(g.key)) out.set(g.key, g);
  }
  // Options nobody uses don't make a series.
  const used = new Set(rows.flatMap((row) => groupsOf(row, id, prop).map((g) => g.key)));
  const list = [...out.values()].filter((sr) => used.has(sr.key));
  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") list.sort((a, b) => a.key.localeCompare(b.key));
  if (none) list.push({ key: "__none__", label: `Sin ${prop.name.toLowerCase()}`, color: null });
  return list;
}

/** Every category a chart has before "hidden_groups" leaves some out (for "Ocultar grupos"). */
export function chartGroups(rows: Block[], collection: Collection, config: ChartConfig, computed?: ComputedValues): ChartPoint[] {
  const all = chartData(rows, collection, { ...config, hidden_groups: undefined, cumulative: false }, computed);
  return typeof all === "number" ? [] : all;
}

/** The filter rule that keeps a chart category's pages, for "Guardar como vista" (null when none fits). */
export function chartGroupFilter(collection: Collection, config: ChartConfig, key: string): Filter | null {
  const id = config.group_by;
  const prop = id ? collection.schema[id] : undefined;
  if (!id || !prop) return null;
  const rule = (operator: Filter["operator"], value?: Filter["value"]): Filter => ({
    id: Math.random().toString(36).slice(2, 8),
    property: id,
    operator,
    ...(value === undefined ? {} : { value }),
  });
  if (key === "__none__") return prop.type === "checkbox" ? rule("is", false) : rule("is_empty");
  switch (prop.type) {
    case "select":
    case "status":
      return rule("is", key);
    case "multi_select":
      return rule("contains", [key]);
    case "person":
    case "relation":
      return rule("contains", [key]);
    case "checkbox":
      return rule("is", key === "true");
    case "date":
    case "created_time":
    case "last_edited_time": {
      const [y, m] = key.split("-").map(Number);
      const last = new Date(y, m, 0).getDate();
      return rule("is_between", `${key}-01/${key}-${String(last).padStart(2, "0")}`);
    }
    case "number":
    case "auto_increment_id":
      return rule("eq", Number(key));
    default:
      return rule("is", key);
  }
}

/** The format numbers in a chart use: explicit override, else the aggregated property's. */
export function chartNumberFormat(config: ChartConfig, collection: Collection) {
  if (config.number_format) return config.number_format;
  if (config.aggregator !== "count" && config.property) return collection.schema[config.property]?.number_format;
  return undefined;
}

/** A sensible first chart: rows counted by the first status/select property. */
export function defaultChart(collection: Collection, type: ChartType = "column"): ChartConfig {
  const group = Object.entries(collection.schema).find(([, s]) => s.type === "status" || s.type === "select")?.[0];
  return { type, group_by: type === "number" ? undefined : group, aggregator: "count", sort: "manual" };
}
