import { formatNumber } from "./format";
import type { Block, CalcType, PropertySchema } from "./model";
import { cellValue, dateDay, isComputedType, isEmptyValue, type ComputedValues, type ResultKind } from "./query";

/** A calculation as its menu lists it; the per-group ones then take a status group ("count_per_group:<group>"). */
export type CalcName = Exclude<CalcType, `${string}:${string}`> | "count_per_group" | "percent_per_group";

/** Menu labels, in menu order. */
export const CALC_LABELS: Record<CalcName, string> = {
  count_all: "Contar todo",
  count_values: "Contar valores",
  count_unique: "Contar valores únicos",
  empty: "Contar celdas vacías",
  not_empty: "Contar celdas no vacías",
  percent_empty: "% de celdas vacías",
  percent_not_empty: "% de celdas no vacías",
  sum: "Suma",
  average: "Promedio",
  median: "Mediana",
  min: "Mín.",
  max: "Máx.",
  range: "Rango",
  checked: "Marcado",
  unchecked: "Sin marcar",
  percent_checked: "% de elementos marcados",
  percent_unchecked: "% de elementos sin marcar",
  earliest_date: "Fecha más antigua",
  latest_date: "Fecha más reciente",
  date_range: "Intervalo de fechas",
  count_per_group: "Recuento por grupo",
  percent_per_group: "Porcentaje por grupo",
};

/** Short label shown before the value under the column. */
const SHORT: Record<CalcName, string> = {
  count_all: "Recuento",
  count_values: "Valores",
  count_unique: "Únicos",
  empty: "Vacías",
  not_empty: "No vacías",
  percent_empty: "Vacías",
  percent_not_empty: "No vacías",
  sum: "Suma",
  average: "Promedio",
  median: "Mediana",
  min: "Mín.",
  max: "Máx.",
  range: "Intervalo",
  checked: "Marcadas",
  unchecked: "Sin marcar",
  percent_checked: "Marcadas",
  percent_unchecked: "Sin marcar",
  earliest_date: "Más antiguas",
  latest_date: "Más recientes",
  date_range: "Intervalo",
  count_per_group: "Recuento",
  percent_per_group: "Porcentaje",
};

/** Status calculations that read one status group (To-do / In progress / Complete). */
export const isPerGroup = (name: CalcName): name is "count_per_group" | "percent_per_group" =>
  name === "count_per_group" || name === "percent_per_group";

/** A calculation's menu name and, for the per-group ones, its status group. */
export function splitCalc(calc: CalcType): { name: CalcName; group?: string } {
  const at = calc.indexOf(":");
  return at < 0 ? { name: calc as CalcName } : { name: calc.slice(0, at) as CalcName, group: calc.slice(at + 1) };
}

/** A calculation's full name, with its status group: "Porcentaje por grupo: Complete". */
export function calcLabel(calc: CalcType, schema?: PropertySchema) {
  const { name, group } = splitCalc(calc);
  const groupName = group && schema?.groups?.find((g) => g.id === group)?.name;
  return groupName ? `${CALC_LABELS[name]}: ${groupName}` : CALC_LABELS[name];
}

/** Calculations offered for a property type, grouped as in the menu (formulas and rollups by their result kind). */
export function calcsFor(schema: PropertySchema, kind?: ResultKind): CalcName[][] {
  const computed = isComputedType(schema.type);
  if (schema.type === "checkbox" || (computed && kind === "checkbox"))
    return [["count_all"], ["checked", "unchecked", "percent_checked", "percent_unchecked"]];
  const groups: CalcName[][] = [
    ["count_all", "count_values", "count_unique", "empty", "not_empty"],
    ["percent_empty", "percent_not_empty"],
  ];
  if (schema.type === "number" || (computed && (kind === "number" || !kind))) groups.push(["sum", "average", "median", "min", "max", "range"]);
  if (["date", "created_time", "last_edited_time"].includes(schema.type) || (computed && kind === "date"))
    groups.push(["earliest_date", "latest_date", "date_range"]);
  if (schema.type === "status" && schema.groups?.length) groups.push(["count_per_group", "percent_per_group"]);
  return groups;
}

/** A span of days in words: "5 días", "3 meses", "2 años". */
function spanText(from: string, to: string) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  const months = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() - (b.getDate() < a.getDate() ? 1 : 0);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (months >= 12) return plural(Math.floor(months / 12), "año", "años");
  if (months >= 1) return plural(months, "mes", "meses");
  if (days >= 7) return plural(Math.floor(days / 7), "semana", "semanas");
  return plural(days, "día", "días");
}

const percent = (n: number, total: number) => `${total ? Math.round((n / total) * 1000) / 10 : 0} %`;

/** The label and value a calculation shows for the rows of a view. */
export function computeCalc(
  rows: Block[],
  propertyId: string,
  schema: PropertySchema,
  calc: CalcType,
  /** Formula and rollup results by row (see `useComputed`). */
  computed?: ComputedValues,
  /** How a "YYYY-MM-DD" day shows (the column's date format). */
  formatDay: (day: string) => string = (day) => day,
) {
  const values = rows.map((r) => cellValue(r, propertyId, schema, computed));
  const total = rows.length;
  const filled = values.filter((v) => (schema.type === "checkbox" ? true : !isEmptyValue(v)));
  // Computed results can be numbers written as text ("12"), like imported formulas.
  const numbers = values
    .map((v) => (isComputedType(schema.type) && typeof v === "string" && v.trim() !== "" ? Number(v) : v))
    .filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  const days = values
    .map((v) => dateDay(v))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const num = (n: number) =>
    schema.decimals === undefined
      ? formatNumber(Math.round(n * 100) / 100, schema.number_format)
      : formatNumber(n, schema.number_format, false, schema.decimals);
  const checked = values.filter(Boolean).length;
  const { name, group } = splitCalc(calc);
  let value = "—";
  switch (name) {
    case "count_all":
      value = String(total);
      break;
    case "count_values":
      value = String(values.reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : isEmptyValue(v) ? 0 : 1), 0));
      break;
    case "count_unique": {
      const seen = new Set<string>();
      for (const v of values)
        for (const x of Array.isArray(v) ? v : isEmptyValue(v) ? [] : [v])
          seen.add(typeof x === "object" && x !== null ? x.name : String(x));
      value = String(seen.size);
      break;
    }
    case "empty":
      value = String(total - filled.length);
      break;
    case "not_empty":
      value = String(filled.length);
      break;
    case "percent_empty":
      value = percent(total - filled.length, total);
      break;
    case "percent_not_empty":
      value = percent(filled.length, total);
      break;
    case "sum":
      value = num(numbers.reduce((a, b) => a + b, 0));
      break;
    case "average":
      value = numbers.length ? num(numbers.reduce((a, b) => a + b, 0) / numbers.length) : "—";
      break;
    case "median": {
      const s = [...numbers].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      value = s.length ? num(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) : "—";
      break;
    }
    case "min":
      value = numbers.length ? num(Math.min(...numbers)) : "—";
      break;
    case "max":
      value = numbers.length ? num(Math.max(...numbers)) : "—";
      break;
    case "range":
      value = numbers.length ? num(Math.max(...numbers) - Math.min(...numbers)) : "—";
      break;
    case "checked":
      value = String(checked);
      break;
    case "unchecked":
      value = String(total - checked);
      break;
    case "percent_checked":
      value = percent(checked, total);
      break;
    case "percent_unchecked":
      value = percent(total - checked, total);
      break;
    case "earliest_date":
      value = days.length ? formatDay(days[0]) : "—";
      break;
    case "latest_date":
      value = days.length ? formatDay(days[days.length - 1]) : "—";
      break;
    case "date_range":
      value = days.length ? spanText(days[0], days[days.length - 1]) : "—";
      break;
    case "count_per_group":
    case "percent_per_group": {
      const options = schema.groups?.find((g) => g.id === group)?.option_ids ?? [];
      const n = values.filter((v) => typeof v === "string" && options.includes(v)).length;
      value = name === "count_per_group" ? String(n) : percent(n, total);
      break;
    }
  }
  return { label: SHORT[name], value };
}
