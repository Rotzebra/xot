import { db } from "./db";
import {
  type Block,
  type Collection,
  type CollectionView,
  type FileRef,
  type OptionColor,
  type ParentTable,
  type PropertySchema,
  type PropertyType,
  type PropertyValue,
  READ_ONLY_TYPES,
} from "./model";
import { appendRows, createPage, emptyQuery, insertPageLink, shortId, uuid } from "./ops";
import { storeFile } from "./files";
import { readZip, type ZipFile } from "./zip";

// "Importar": Markdown and text become pages, HTML is converted to
// blocks (headings, lists, links, images, tables…), and a CSV becomes a
// full-page database whose columns are typed from their values. "Combinar con
// CSV" appends a CSV's rows to an existing database, matching columns by name.

/** Where imported pages go: a page (they become its subpages) or the workspace's top level. */
export interface ImportTarget {
  table: ParentTable;
  id: string;
}

export type ImportKind = "markdown" | "csv" | "html" | "word" | "pdf" | "excel" | "epub" | "opml";

export const IMPORT_ACCEPT: Record<ImportKind, string> = {
  markdown: ".md,.markdown,.mdown,.mkdn,.mkd,.rmd,.txt,text/markdown,text/plain",
  csv: ".csv,.tsv,text/csv,text/tab-separated-values",
  html: ".html,.htm,text/html",
  word: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: ".pdf,application/pdf",
  excel: ".xlsx,.ods,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.spreadsheet",
  epub: ".epub,application/epub+zip",
  opml: ".opml,text/x-opml",
};

/** Word, Excel, OpenDocument, EPUB, OPML and PDF files: read by lib/importOffice.ts. */
export const OFFICE_EXTENSION = /\.(docx|xlsx|ods|epub|opml|pdf)$/i;

/** Workspace exports (Xot's too) come as a .zip: every import tile takes one too. */
export const ZIP_ACCEPT = ".zip,application/zip";

const EXTENSION = /\.(md|markdown|mdown|mkdn|mkd|rmd|txt|csv|tsv|html?)$/i;
// Workspace exports name files "Title <32-hex id>.md".
const baseName = (name: string) =>
  name
    .replace(EXTENSION, "")
    .replace(/\s[0-9a-f]{32}$/i, "")
    .trim() || "Sin título";

export function importKind(name: string): ImportKind {
  if (/\.(csv|tsv)$/i.test(name)) return "csv";
  if (/\.html?$/i.test(name)) return "html";
  return "markdown";
}

// ------------------------------------------------------------------ text

/** A file's text: UTF-8 (with or without BOM) or UTF-16 by BOM; anything else is read as Windows-1252 (Excel's CSVs). */
export function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

export async function readFileText(file: File) {
  return decodeText(await file.arrayBuffer());
}

// ------------------------------------------------------------------- CSV

const DELIMITERS = [",", ";", "\t", "|"];

/** Splits CSV text into rows of fields: quoted fields may hold the delimiter, newlines and doubled quotes. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      // An opening quote (spaces before it are padding, as Excel writes them).
      field = "";
      quoted = true;
    } else if (ch === delimiter) endField();
    else if (ch === "\n" || ch === "\r") {
      endRow();
      if (ch === "\r" && src[i + 1] === "\n") i++;
    } else field += ch;
    i++;
  }
  if (field !== "" || row.length) endRow();
  // Blank lines (and the trailing newline) aren't rows.
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** The delimiter that splits the first lines into the same number of fields (more fields wins ties). */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 20000);
  let best = ",";
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const rows = parseCsv(sample, d).slice(0, 10);
    if (rows.length > 1 && rows[rows.length - 1].length < rows[0].length) rows.pop(); // the sample may cut the last row
    const counts = rows.map((r) => r.length);
    if (!counts.length || counts[0] < 2) continue;
    const consistent = counts.filter((c) => c === counts[0]).length / counts.length;
    const score = consistent * 1000 + counts[0];
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export interface CsvTable {
  headers: string[];
  rows: string[][];
  /** ";" CSVs come from locales that write decimals with a comma. */
  decimalComma: boolean;
}

/** The first row names the columns: blank names become "Columna N", repeated ones are numbered. */
export function readCsv(text: string, delimiter = detectDelimiter(text)): CsvTable {
  const [head = [], ...body] = parseCsv(text, delimiter);
  const width = Math.max(head.length, ...body.map((r) => r.length));
  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, i) => {
    const name = (head[i] ?? "").replace(/\s+/g, " ").trim() || `Columna ${i + 1}`;
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n > 1 ? `${name} (${n})` : name;
  });
  const rows = body.map((r) => headers.map((_, i) => r[i] ?? ""));
  return { headers, rows, decimalComma: delimiter === ";" };
}

// --------------------------------------------------------------- values

const TRUE_WORDS = new Set(["yes", "true", "sí", "si", "x", "✓", "✔", "checked", "verdadero"]);
const FALSE_WORDS = new Set(["no", "false", "unchecked", "falso"]);

const MONTHS: Record<string, number> = {};
[
  ["january", "jan", "enero", "ene"],
  ["february", "feb", "febrero"],
  ["march", "mar", "marzo"],
  ["april", "apr", "abril", "abr"],
  ["may", "mayo"],
  ["june", "jun", "junio"],
  ["july", "jul", "julio"],
  ["august", "aug", "agosto", "ago"],
  ["september", "sep", "sept", "septiembre", "setiembre", "set"],
  ["october", "oct", "octubre"],
  ["november", "nov", "noviembre"],
  ["december", "dec", "diciembre", "dic"],
].forEach((names, i) => names.forEach((n) => (MONTHS[n] = i + 1)));

const pad = (n: number) => String(n).padStart(2, "0");

/** "10:30", "10:30 PM", "22:30:05", "10:30 p. m." → "HH:mm". */
function parseTime(raw: string): string | null | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(?:([ap])\.?\s?m\.?)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

function validDay(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return false;
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d;
}

/** A date as Xot stores it ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"); null when it isn't one. */
export function parseDate(raw: string, dayFirst = true): string | null {
  // Some exports add the time zone: "October 16, 2026 10:30 AM (GMT-5)".
  const s = raw.trim().replace(/\s*\((?:GMT|UTC)[^)]*\)$/i, "").replace(/\s+/g, " ");
  if (!s) return null;
  const range = s.split(/\s+(?:→|->)\s+/);
  if (range.length === 2) {
    const a = parseDate(range[0], dayFirst);
    const b = parseDate(range[1], dayFirst);
    return a && b ? `${a}/${b}` : null;
  }
  let y = 0;
  let mo = 0;
  let d = 0;
  let rest = "";
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|[+-]\d{2}:?\d{2})?)?$/i))) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rest = m[4] ?? "";
  } else if ((m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:,?\s+(.+))?$/))) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rest = m[4] ?? "";
  } else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:,?\s+(.+))?$/))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    [d, mo] = dayFirst ? [a, b] : [b, a];
    y = Number(m[3]) + (m[3].length === 2 ? 2000 : 0);
    rest = m[4] ?? "";
  } else if ((m = s.match(/^([a-záéíóú]+)\.? (\d{1,2}),? (\d{4})(?:,?\s+(?:at |a las )?(.+))?$/i))) {
    // "October 16, 2026", "Oct 16 2026 10:30 AM"
    [mo, d, y] = [MONTHS[m[1].toLowerCase()] ?? 0, Number(m[2]), Number(m[3])];
    rest = m[4] ?? "";
  } else if ((m = s.match(/^(\d{1,2})(?: de)? ([a-záéíóú]+)\.?,?(?: de)? (\d{4})(?:,?\s+(?:a las )?(.+))?$/i))) {
    // "16 de octubre de 2026", "16 oct 2026 10:30"
    [d, mo, y] = [Number(m[1]), MONTHS[m[2].toLowerCase()] ?? 0, Number(m[3])];
    rest = m[4] ?? "";
  } else return null;
  if (!validDay(y, mo, d)) return null;
  const day = `${y}-${pad(mo)}-${pad(d)}`;
  const time = parseTime(rest);
  if (time === null) return null;
  return time ? `${day}T${time}` : day;
}

/** Whether a column's d/m/y dates put the day first: any part over 12 tells; Spanish order otherwise. */
function dayFirstFor(values: string[]) {
  for (const v of values) {
    const m = v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/);
    if (!m) continue;
    if (Number(m[1]) > 12) return true;
    if (Number(m[2]) > 12) return false;
  }
  return true;
}

const CURRENCY = /^(?:[$€£¥₹]|COP|USD|EUR|MXN)\s*|\s*(?:[$€£¥₹]|COP|USD|EUR|MXN)$/gi;

/** "1,234.5", "1.234,5", "$ 1.200", "12 %" → a number; null when the text isn't one. Leading zeros ("007") are codes, not numbers. */
export function parseNumber(raw: string, decimalComma = false): { value: number; percent: boolean; currency: string | null; grouped: boolean } | null {
  let s = raw.trim().replace(/[\s\u00a0]/g, "");
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  if (negative) s = s.slice(1, -1);
  const percent = s.endsWith("%");
  if (percent) s = s.slice(0, -1);
  const currency = s.match(/[$€£¥₹]|COP|USD|EUR|MXN/i)?.[0].toUpperCase() ?? null;
  s = s.replace(CURRENCY, "").replace(/^([-+])(?:[$€£¥₹])/, "$1");
  if (!/^[-+]?(?:\d[\d.,]*|[.,]\d+)$/.test(s)) return null;
  const sign = s.startsWith("-") ? -1 : 1;
  s = s.replace(/^[-+]/, "");
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  let grouped = false;
  let normal: string;
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const group = decimal === "," ? "." : ",";
    const [int, frac = ""] = s.split(decimal);
    if (s.split(decimal).length > 2 || !new RegExp(`^\\d{1,3}(\\${group}\\d{3})*$`).test(int)) return null;
    normal = `${int.split(group).join("")}.${frac}`;
    grouped = true;
  } else if (comma >= 0) {
    const thousands = /^\d{1,3}(,\d{3})+$/.test(s) && !(decimalComma && s.split(",").length === 2);
    if (thousands) {
      normal = s.replace(/,/g, "");
      grouped = true;
    } else if (s.split(",").length === 2) normal = s.replace(",", ".");
    else return null;
  } else if (dot >= 0) {
    const thousands = /^\d{1,3}(\.\d{3})+$/.test(s) && (s.split(".").length > 2 || decimalComma);
    if (thousands) {
      normal = s.replace(/\./g, "");
      grouped = true;
    } else if (s.split(".").length === 2) normal = s;
    else return null;
  } else normal = s;
  if (/^0\d/.test(normal.split(".")[0])) return null;
  const value = Number(normal.startsWith(".") ? `0${normal}` : normal) * sign * (negative ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  return { value: percent ? value / 100 : value, percent, currency, grouped };
}

const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const splitList = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const CURRENCY_FORMATS: Record<string, string> = { $: "dollar", USD: "dollar", "€": "euro", EUR: "euro", COP: "colombian_peso", MXN: "mexican_peso" };

/** A column's property type from its values (text when nothing else fits). */
export function inferProperty(name: string, values: string[], decimalComma: boolean): PropertySchema {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  const schema = (type: PropertyType, extra: Partial<PropertySchema> = {}): PropertySchema => ({ name, type, ...extra });
  if (!filled.length) return schema("text");
  const lower = filled.map((v) => v.toLowerCase());
  if (lower.every((v) => TRUE_WORDS.has(v) || FALSE_WORDS.has(v))) return schema("checkbox");
  const numbers = filled.map((v) => parseNumber(v, decimalComma));
  if (numbers.every(Boolean)) {
    const parsed = numbers as NonNullable<(typeof numbers)[number]>[];
    const currencies = new Set(parsed.map((n) => n.currency));
    const currency = currencies.size === 1 ? [...currencies][0] : null;
    const number_format = parsed.every((n) => n.percent)
      ? "percent"
      : currency && CURRENCY_FORMATS[currency]
        ? CURRENCY_FORMATS[currency]
        : parsed.some((n) => n.grouped)
          ? "number_with_commas"
          : undefined;
    return schema("number", number_format ? { number_format } : {});
  }
  const dayFirst = dayFirstFor(filled);
  if (filled.every((v) => parseDate(v, dayFirst))) return schema("date");
  if (filled.every((v) => URL_RE.test(v))) return schema("url");
  if (filled.every((v) => EMAIL_RE.test(v))) return schema("email");
  const oneLine = filled.every((v) => !/[\r\n]/.test(v));
  if (oneLine && filled.some((v) => v.includes(","))) {
    const tokens = filled.flatMap(splitList);
    const distinct = new Set(tokens);
    const short = tokens.every((t) => t.length <= 30 && t.split(/\s+/).length <= 4);
    if (short && distinct.size <= 20 && distinct.size <= tokens.length * 0.6) return schema("multi_select", { options: [] });
  }
  const distinct = new Set(filled);
  if (oneLine && distinct.size <= 12 && distinct.size <= filled.length * 0.6 && filled.every((v) => v.length <= 40))
    return schema("select", { options: [] });
  return schema("text");
}

const PALETTE: OptionColor[] = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/** The option named `value`, added to the property (in place) when it has none. */
function optionFor(schema: PropertySchema, value: string) {
  schema.options ??= [];
  const found =
    schema.options.find((o) => o.value === value) ?? schema.options.find((o) => o.value.toLowerCase() === value.toLowerCase());
  if (found) return found.id;
  const option = { id: shortId(), value, color: PALETTE[schema.options.length % PALETTE.length] };
  schema.options.push(option);
  // New status options join the first group, as when typed in.
  if (schema.groups?.length) schema.groups[0] = { ...schema.groups[0], option_ids: [...schema.groups[0].option_ids, option.id] };
  return option.id;
}

/** A cell's text as a value of the property; undefined leaves the cell empty. Options it names are added to `schema`. */
export function cellValue(raw: string, schema: PropertySchema, ctx: { decimalComma: boolean; dayFirst: boolean }): PropertyValue | undefined {
  const s = raw.trim();
  switch (schema.type) {
    case "checkbox":
      return TRUE_WORDS.has(s.toLowerCase());
    case "title":
      return s ? s.replace(/\s*[\r\n]+\s*/g, " ") : undefined;
  }
  if (!s || READ_ONLY_TYPES.includes(schema.type) || schema.type === "relation") return undefined;
  switch (schema.type) {
    case "number": {
      const n = parseNumber(s, ctx.decimalComma);
      return n ? n.value : undefined;
    }
    case "date":
      return parseDate(s, ctx.dayFirst) ?? undefined;
    case "select":
    case "status":
      return optionFor(schema, s.replace(/\s+/g, " "));
    case "multi_select":
      return [...new Set(splitList(s).map((v) => optionFor(schema, v)))];
    case "person":
      return splitList(s);
    case "file":
      return splitList(s).map((url): FileRef => ({ name: decodeURIComponent(url.split(/[/?#]/).filter(Boolean).pop() ?? url), url }));
    default:
      return raw.replace(/\r\n?/g, "\n").trim();
  }
}

/** Row values from CSV rows: column i fills property ids[i] (skipped when null). Mutates `schema` with new options. */
function rowValues(table: CsvTable, ids: (string | null)[], schema: Record<string, PropertySchema>) {
  const contexts = ids.map((_, i) => ({ decimalComma: table.decimalComma, dayFirst: dayFirstFor(table.rows.map((r) => r[i])) }));
  return table.rows.map((r) => {
    const values: Block["properties"] = { title: "" };
    ids.forEach((id, i) => {
      if (!id) return;
      const v = cellValue(r[i], schema[id], contexts[i]);
      if (v !== undefined) values[id] = v;
    });
    return values;
  });
}

/** A CSV as a full-page database: the first column is the title, the others typed by their values; one "Tabla" view. */
export async function importCsv(
  text: string,
  name: string,
  target: ImportTarget,
  /** The database's id (a .zip's pages link to it), and whether its parent page gets its block now. */
  {
    id: blockId = uuid(),
    link = true,
    delimiter,
  }: { id?: string; link?: boolean; /** Known separator (a .tsv's tab, a spreadsheet's rows); detected otherwise. */ delimiter?: string } = {},
): Promise<string> {
  const table = readCsv(text, delimiter);
  if (!table.headers.length) throw new Error("El archivo CSV está vacío");
  const collectionId = uuid();
  const schema: Record<string, PropertySchema> = { title: { name: table.headers[0], type: "title" } };
  const ids: string[] = ["title"];
  for (let i = 1; i < table.headers.length; i++) {
    const id = shortId();
    ids.push(id);
    schema[id] = inferProperty(table.headers[i], table.rows.map((r) => r[i]), table.decimalComma);
  }
  const rows = rowValues(table, ids, schema);
  const collection: Collection = { id: collectionId, parent_id: blockId, schema };
  const view: CollectionView = {
    id: uuid(),
    type: "table",
    name: "Tabla",
    parent_id: blockId,
    collection_id: collectionId,
    format: { properties: ids.map((property) => ({ property, visible: true })) },
    query2: emptyQuery(),
  };
  const t = Date.now();
  await db.transaction("rw", db.blocks, db.collections, db.views, async () => {
    await db.collections.add(collection);
    await db.views.add(view);
    await db.blocks.add({
      id: blockId,
      type: "collection_view_page",
      parent_id: target.id,
      parent_table: target.table,
      properties: { title: name },
      format: {},
      content: null,
      collection_id: collectionId,
      view_ids: [view.id],
      alive: true,
      order: t,
      created_time: t,
      last_edited_time: t,
    });
    await db.blocks.bulkAdd(
      rows.map((properties, i) => ({
        id: uuid(),
        type: "page" as const,
        parent_id: collectionId,
        parent_table: "collection" as const,
        properties,
        format: {},
        content: null,
        alive: true,
        order: t + i,
        created_time: t,
        last_edited_time: t,
      })),
    );
  });
  if (link && target.table === "block") await insertPageLink(target.id, blockId);
  return blockId;
}

/**
 * "Combinar con CSV": the CSV's rows join the database. Columns match properties
 * by name (ignoring case); the title takes its own column, or the first one when
 * none is named like it. Other columns become new properties, typed by their values.
 */
export async function mergeCsv(collectionId: string, text: string): Promise<{ rows: number; added: string[] }> {
  const collection = await db.collections.get(collectionId);
  if (!collection) throw new Error("No se encontró la base de datos");
  const table = readCsv(text);
  if (!table.headers.length) throw new Error("El archivo CSV está vacío");
  const schema: Record<string, PropertySchema> = structuredClone(collection.schema);
  const byName = new Map<string, string>();
  for (const [id, p] of Object.entries(schema)) if (!byName.has(p.name.trim().toLowerCase())) byName.set(p.name.trim().toLowerCase(), id);
  const ids: (string | null)[] = table.headers.map((h) => byName.get(h.toLowerCase()) ?? null);
  if (!ids.includes("title") && !ids[0]) ids[0] = "title";
  const added: string[] = [];
  table.headers.forEach((h, i) => {
    if (ids[i]) return;
    const id = shortId();
    ids[i] = id;
    schema[id] = inferProperty(h, table.rows.map((r) => r[i]), table.decimalComma);
    added.push(id);
  });
  // A column matched twice (a repeated name) fills the property once.
  const used = new Set<string>();
  const unique = ids.map((id) => (id && !used.has(id) ? (used.add(id), id) : null));
  const rows = rowValues(table, unique, schema);
  await appendRows(collectionId, schema, added, rows, "Combinar con CSV");
  return { rows: rows.length, added };
}

// ------------------------------------------------------------------ HTML

// HTML becomes blocks directly (not Markdown, which can't hold to-dos' state,
// toggles, callouts, colors or equations), reading exported workspace HTML as
// well as ordinary pages.

type Styles = Record<string, string | boolean>;
type TextRun = { type: "text"; text: string; styles: Styles };
type InlineNode = TextRun | { type: "link"; href: string; content: TextRun[] } | { type: "inlineEquation"; props: { latex: string } };
type TableCells = { type: "tableContent"; headerRows?: number; rows: { cells: InlineNode[][] }[] };
export interface ImportedBlock {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: InlineNode[] | TableCells;
  children: ImportedBlock[];
}

const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|META|LINK|TITLE|BUTTON|INPUT|SELECT|TEXTAREA|SVG|IFRAME|OBJECT)$/;
const isBlockTag = (tag: string) =>
  /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|NAV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|HR|FIGURE|FIGCAPTION|DETAILS|SUMMARY|DL|DT|DD|IMG|FORM|ADDRESS)$/.test(tag);
const COLORS = new Set(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);

function usableSrc(src: string | null) {
  return !!src && /^(https?:|data:image\/|xot-file:)/i.test(src);
}

const block = (type: string, props: Record<string, unknown> = {}, content?: ImportedBlock["content"], children: ImportedBlock[] = []): ImportedBlock => ({
  id: uuid(),
  type,
  props,
  ...(content !== undefined ? { content } : {}),
  children,
});

/** Exported "block-color-red" / "block-color-red_background" (and "highlight-…" marks) as BlockNote colors. */
function colorOf(el: Element, prefix: string): { textColor?: string; backgroundColor?: string } {
  for (const cls of Array.from(el.classList)) {
    if (!cls.startsWith(prefix)) continue;
    const [color, bg] = cls.slice(prefix.length).split("_");
    if (!COLORS.has(color)) continue;
    return bg === "background" ? { backgroundColor: color } : { textColor: color };
  }
  return {};
}

/** A KaTeX rendering's TeX source (exports keep it in an <annotation>). */
const texOf = (el: Element) =>
  el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? el.textContent?.trim() ?? "";

/** Inline nodes as BlockNote inline content: bold, italic, underline, strikethrough, code, colors, links, equations. */
function inlineContent(nodes: Node[], styles: Styles = {}, pre = false): InlineNode[] {
  const out: InlineNode[] = [];
  const push = (text: string, st: Styles) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.type === "text" && JSON.stringify(last.styles) === JSON.stringify(st)) last.text += text;
    else out.push({ type: "text", text, styles: { ...st } });
  };
  const walk = (node: Node, st: Styles) => {
    if (node.nodeType === Node.TEXT_NODE) return push(pre ? (node.textContent ?? "") : (node.textContent ?? "").replace(/\s+/g, " "), st);
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (SKIP.test(tag) || tag === "IMG") return;
    if (tag === "BR") return push("\n", st);
    // An equation: a KaTeX rendering, or an element wrapping one (an "…equation…" token, a bare <span>).
    if (el.matches(".katex") || (/equation/i.test(el.getAttribute("class") ?? "") && el.querySelector(".katex")) || (tag === "SPAN" && el.querySelector(":scope > .katex"))) {
      const latex = texOf(el);
      if (latex) out.push({ type: "inlineEquation", props: { latex } });
      return;
    }
    const next = { ...st };
    const style = el.getAttribute("style") ?? "";
    if (/^(STRONG|B)$/.test(tag) || /font-weight:\s*(bold|[6-9]00)/i.test(style)) next.bold = true;
    if (/^(EM|I)$/.test(tag) || /font-style:\s*italic/i.test(style)) next.italic = true;
    if (tag === "U" || /text-decoration:[^;]*underline|border-bottom:\s*0?\.05em solid/i.test(style)) next.underline = true;
    if (/^(S|DEL|STRIKE)$/.test(tag) || /text-decoration:[^;]*line-through/i.test(style)) next.strike = true;
    if (/^(CODE|KBD|SAMP)$/.test(tag)) next.code = true;
    if (tag === "MARK" || tag === "SPAN") Object.assign(next, colorOf(el, "highlight-"));
    if (tag === "A") {
      const href = el.getAttribute("href") ?? "";
      if (/^(https?:|mailto:|tel:)/i.test(href)) {
        const content = inlineContent(Array.from(el.childNodes), next, pre).filter((n): n is TextRun => n.type === "text");
        if (content.length) out.push({ type: "link", href, content });
        return;
      }
    }
    for (const child of Array.from(el.childNodes)) walk(child, next);
  };
  for (const node of nodes) walk(node, styles);
  // Whitespace at either end of a line of text isn't content.
  const first = out[0];
  if (first?.type === "text" && !pre) first.text = first.text.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last?.type === "text" && !pre) last.text = last.text.replace(/\s+$/, "");
  return out.filter((n) => n.type !== "text" || n.text);
}

const hasText = (content: InlineNode[]) => content.length > 0;

function tableBlock(el: HTMLTableElement): ImportedBlock | null {
  const rows = Array.from(el.rows).map((tr) => ({ cells: Array.from(tr.cells).map((c) => inlineContent(Array.from(c.childNodes))) }));
  if (!rows.length) return null;
  const width = Math.max(...rows.map((r) => r.cells.length));
  for (const r of rows) while (r.cells.length < width) r.cells.push([]);
  const header = el.rows[0] && Array.from(el.rows[0].cells).every((c) => c.tagName === "TH") ? 1 : 0;
  return block("table", {}, { type: "tableContent", ...(header ? { headerRows: header } : {}), rows });
}

/** The own text of a list item (or callout) and the blocks nested in it. */
function splitItem(el: Element, skip?: (child: Element) => boolean): { content: InlineNode[]; children: ImportedBlock[] } {
  const own: Node[] = [];
  const rest: Node[] = [];
  for (const child of Array.from(el.childNodes)) {
    const tag = (child as Element).tagName;
    if (tag && skip?.(child as Element)) continue;
    if (tag && isBlockTag(tag) && !rest.length && !own.some((n) => n.textContent?.trim()) && tag === "P") {
      // "<li><p>text</p>…": the first paragraph is the item's text.
      own.push(...Array.from(child.childNodes));
      continue;
    }
    if ((tag && isBlockTag(tag)) || rest.length) rest.push(child);
    else own.push(child);
  }
  const holder = document.createElement("div");
  for (const n of rest) holder.append(n.cloneNode(true));
  return { content: inlineContent(own), children: blocksOf(holder) };
}

function listBlocks(el: HTMLElement): ImportedBlock[] {
  const ordered = el.tagName === "OL";
  const start = Number(el.getAttribute("start") ?? 1) || 1;
  const toggleList = el.classList.contains("toggle");
  const items = Array.from(el.children).filter((c) => c.tagName === "LI") as HTMLElement[];
  return items.map((li, i) => {
    const details = li.querySelector(":scope > details");
    if (details && (toggleList || li.children.length === 1)) return detailsBlock(details as HTMLElement);
    const color = colorOf(li, "block-color-");
    // Exported to-dos: <div class="checkbox checkbox-on">; elsewhere an <input type="checkbox">.
    const box = li.querySelector(":scope > .checkbox, :scope > input[type=checkbox], :scope > label > input[type=checkbox]");
    if (box) {
      const checked = box.classList.contains("checkbox-on") || (box as HTMLInputElement).checked || box.hasAttribute("checked");
      const { content, children } = splitItem(li, (c) => c === box || (c.tagName === "LABEL" && c.contains(box)));
      return block("checkListItem", { checked, ...color }, content, children);
    }
    const { content, children } = splitItem(li);
    if (ordered) return block("numberedListItem", { ...color, ...(i === 0 && start !== 1 ? { start } : {}) }, content, children);
    return block("bulletListItem", color, content, children);
  });
}

/** <details><summary>: a toggle (a toggle heading when the summary is a heading). */
function detailsBlock(el: HTMLElement): ImportedBlock {
  const summary = el.querySelector(":scope > summary");
  const heading = summary?.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6");
  const holder = document.createElement("div");
  for (const child of Array.from(el.childNodes)) if (child !== summary) holder.append(child.cloneNode(true));
  const children = blocksOf(holder);
  const color = colorOf(el.closest("ul.toggle") ?? el, "block-color-");
  if (heading)
    return block("heading", { level: Math.min(Number(heading.tagName[1]), 4), isToggleable: true, ...color }, inlineContent(Array.from(heading.childNodes)), children);
  return block("toggleListItem", color, inlineContent(summary ? Array.from(summary.childNodes) : []), children);
}

function figureBlocks(el: HTMLElement): ImportedBlock[] {
  if (el.classList.contains("equation")) {
    const latex = texOf(el);
    return latex ? [block("equation", { latex })] : [];
  }
  if (el.classList.contains("callout")) {
    // Exported callouts: the icon in the first <div>, the text (and nested blocks) in the second.
    const parts = Array.from(el.children).filter((c) => c.tagName === "DIV");
    const iconEl = el.querySelector(".icon");
    const icon = iconEl?.tagName === "IMG" ? "💡" : iconEl?.textContent?.trim() || "💡";
    const body = parts.length > 1 ? parts[parts.length - 1] : (parts[0] ?? el);
    const { content, children } = splitItem(body);
    const color = colorOf(el, "block-color-");
    return [block("callout", { icon, backgroundColor: color.backgroundColor ?? (color.textColor ? "default" : "gray"), ...(color.textColor ? { textColor: color.textColor } : {}) }, content, children)];
  }
  if (el.classList.contains("bookmark")) {
    const href = el.querySelector("a")?.getAttribute("href") ?? "";
    if (/^https?:/i.test(href)) return [block("bookmark", { url: href, title: el.querySelector(".bookmark-title")?.textContent?.trim() ?? "" })];
  }
  if (el.classList.contains("link-to-page")) {
    const text = inlineContent(Array.from((el.querySelector("a") ?? el).childNodes).filter((n) => !(n as Element).classList?.contains("icon")));
    return hasText(text) ? [block("paragraph", {}, text)] : [];
  }
  const img = el.querySelector("img");
  if (img) {
    const src = img.getAttribute("src");
    if (!usableSrc(src)) return [];
    const caption = el.querySelector("figcaption")?.textContent?.trim() ?? "";
    return [block("image", { url: src, caption, name: img.getAttribute("alt") ?? "" })];
  }
  return blocksOf(el);
}

/** Block-level HTML as blocks; runs of inline nodes become paragraphs. */
function blocksOf(node: Node): ImportedBlock[] {
  const out: ImportedBlock[] = [];
  let run: Node[] = [];
  const flush = () => {
    const content = inlineContent(run);
    if (hasText(content)) out.push(block("paragraph", {}, content));
    run = [];
  };
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) {
      run.push(child);
      continue;
    }
    const el = child as HTMLElement;
    const tag = el.tagName;
    if (SKIP.test(tag)) continue;
    if (!isBlockTag(tag)) {
      // Inline elements that hold images still show them.
      if (el.querySelector("img")) {
        flush();
        out.push(...blocksOf(el));
      } else run.push(el);
      continue;
    }
    flush();
    const color = colorOf(el, "block-color-");
    switch (tag) {
      case "P": {
        out.push(block("paragraph", color, inlineContent(Array.from(el.childNodes))));
        for (const img of Array.from(el.querySelectorAll("img")))
          if (usableSrc(img.getAttribute("src"))) out.push(block("image", { url: img.getAttribute("src"), name: img.getAttribute("alt") ?? "" }));
        break;
      }
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6": {
        const content = inlineContent(Array.from(el.childNodes));
        if (hasText(content)) out.push(block("heading", { level: Math.min(Number(tag[1]), 4), ...color }, content));
        break;
      }
      case "UL":
      case "OL":
        out.push(...listBlocks(el));
        break;
      case "DETAILS":
        out.push(detailsBlock(el));
        break;
      case "PRE": {
        const code = el.querySelector("code");
        const lang = (code?.className.match(/language-([\w+#-]+)/) ?? el.className.match(/language-([\w+#-]+)/))?.[1] ?? "text";
        const text = (el.textContent ?? "").replace(/\n$/, "");
        out.push(block("codeBlock", { language: lang.toLowerCase() }, text ? [{ type: "text", text, styles: {} }] : []));
        break;
      }
      case "BLOCKQUOTE": {
        const { content, children } = splitItem(el);
        out.push(block("quote", color, content, children));
        break;
      }
      case "HR":
        out.push(block("divider"));
        break;
      case "TABLE": {
        const t = tableBlock(el as HTMLTableElement);
        if (t) out.push(t);
        break;
      }
      case "IMG": {
        const src = el.getAttribute("src");
        if (usableSrc(src)) out.push(block("image", { url: src, name: el.getAttribute("alt") ?? "" }));
        break;
      }
      case "FIGURE":
        out.push(...figureBlocks(el));
        break;
      case "NAV":
        if (el.classList.contains("table_of_contents")) out.push(block("tableOfContents"));
        else out.push(...blocksOf(el));
        break;
      default: {
        if (el.classList.contains("column-list")) {
          const columns = Array.from(el.children)
            .filter((c) => c.classList.contains("column"))
            .map((c) => block("column", { width: 1 }, undefined, blocksOf(c)))
            .filter((c) => c.children.length);
          if (columns.length > 1) out.push(block("columnList", {}, undefined, columns));
          else out.push(...(columns[0]?.children ?? []));
          break;
        }
        const inner = blocksOf(el);
        // Exported "indented" children belong to the block above them.
        const parent = out[out.length - 1];
        if (el.classList.contains("indented") && parent && parent.type !== "table" && parent.type !== "codeBlock") parent.children.push(...inner);
        else out.push(...inner);
      }
    }
  }
  flush();
  return out;
}

/** An HTML document as blocks, with its title (an exported page title, else a leading <h1>, else the <title>). */
export function htmlToBlocks(html: string): { title: string | null; blocks: ImportedBlock[] } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Exported workspace HTML: <header> holds the title (and a row's properties).
  const headerTitle = doc.querySelector("header .page-title");
  let title = headerTitle?.textContent?.trim() || null;
  if (headerTitle) headerTitle.closest("header")?.remove();
  if (!title) {
    const h1 = doc.body.querySelector("h1");
    const first = doc.body.textContent?.trim().startsWith(h1?.textContent?.trim() ?? "\0");
    if (h1 && first) {
      title = h1.textContent?.trim() || null;
      h1.remove();
    }
  }
  title ||= doc.title.trim() || null;
  return { title, blocks: blocksOf(doc.body) };
}

// ------------------------------------------------------------- importing

/** One file as a page (Markdown, text, HTML) or a database (CSV) under the target; returns its id. */
export async function importText(name: string, text: string, target: ImportTarget): Promise<string> {
  const kind = importKind(name);
  if (kind === "csv") return importCsv(text, baseName(name), target, { delimiter: /\.tsv$/i.test(name) ? "\t" : undefined });
  let page: Partial<Block>;
  if (kind === "html") {
    // HTML as blocks; Markdown and text keep their Markdown, converted when the page first opens.
    const { title, blocks } = htmlToBlocks(text);
    page = { properties: { title: title ?? baseName(name) }, content: blocks.length ? blocks : null };
  } else {
    // A leading "# Title" becomes the page title.
    const heading = text.match(/^\uFEFF?# (.+)\n?/);
    page = {
      properties: { title: heading?.[1].trim() ?? baseName(name) },
      content_markdown: heading ? text.slice(heading[0].length) : text.replace(/^\uFEFF/, ""),
    };
  }
  const id = await createPage(target.table, target.id, page);
  if (target.table === "block") await insertPageLink(target.id, id);
  return id;
}

/** Imports the chosen files; resolves with the id of the last page created (null when none). */
export async function importFiles(files: File[], target: ImportTarget): Promise<string | null> {
  let last: string | null = null;
  for (const file of files)
    last = /\.zip$/i.test(file.name)
      ? ((await importZip(file, target)) ?? last)
      : OFFICE_EXTENSION.test(file.name)
        ? await (await import("./importOffice")).importOffice(file, target)
        : await importText(file.name, await readFileText(file), target);
  return last;
}

/** A file or folder opened with Xot.app (Finder, the Dock): its bytes, or a folder's files by path. */
export interface OpenedFile {
  name: string;
  /** Older app builds sent a file's text. */
  text?: string;
  data?: Uint8Array;
  files?: { path: string; data: Uint8Array }[];
}

/** Imports what was opened with Xot.app where Importar would; resolves with the first page made. */
export async function importOpened(opened: OpenedFile, target: ImportTarget): Promise<string | null> {
  const name = opened.name.normalize("NFC");
  if (opened.files) return importEntries(opened.files.map((f) => ({ path: f.path.normalize("NFC"), data: f.data })), target);
  if (opened.data) return importFiles([new File([opened.data as BlobPart], name)], target);
  return importText(name, opened.text ?? "", target);
}

// ------------------------------------------------------------------- ZIP

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const stemOf = (path: string) => path.replace(/\.[^./]+$/, "");

/** A link inside the archive as a path from its root; null for web links, anchors and app links. */
function zipPath(dir: string, href: string): string | null {
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return null;
  let path = href.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it as written */
  }
  const parts = dir ? dir.split("/") : [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/").normalize("NFC");
}

/** "%%xotion:<id>%%" paragraphs (a page's own line) as page blocks, nested ones too. */
function withPageLinks(blocks: ImportedBlock[]): ImportedBlock[] {
  return blocks.map((b) => {
    const content = Array.isArray(b.content) ? b.content : null;
    const text = content?.length === 1 && content[0].type === "text" ? String(content[0].text).trim() : "";
    const m = b.type === "paragraph" ? text.match(/^%%xotion:([0-9a-f-]{36})%%$/) : null;
    if (m) return { id: b.id, type: "pageLink", props: { pageId: m[1] }, children: [] };
    return b.children.length ? { ...b, children: withPageLinks(b.children) } : b;
  });
}

/**
 * A .zip imported as a workspace: each Markdown, HTML or CSV file becomes a page or database, files in
 * "Página/" become the subpages of "Página.md" (rows, for a CSV's folder), and images and other files
 * the pages point to come along. Resolves with the first top-level page (null when there is none).
 */
export async function importZip(file: File, target: ImportTarget): Promise<string | null> {
  return importEntries(await readZip(await file.arrayBuffer()), target);
}

/**
 * An archive's files (a .zip's, or a folder's opened from Finder) as importZip imports them.
 * Large exports are a .zip of .zip parts: those are opened too. A folder of Word, PDF or
 * spreadsheet files (and no exported pages) imports each of them.
 */
export async function importEntries(entries: ZipFile[], target: ImportTarget): Promise<string | null> {
  if (!entries.some((e) => EXTENSION.test(e.path))) {
    const parts = entries.filter((e) => /\.zip$/i.test(e.path));
    for (const part of parts) entries = [...entries.filter((e) => e !== part), ...(await readZip(part.data.slice().buffer))];
  }
  if (!entries.some((e) => EXTENSION.test(e.path))) {
    const office = entries.filter((e) => OFFICE_EXTENSION.test(e.path));
    if (!office.length) throw new Error("El archivo no tiene páginas que importar");
    const { importOffice } = await import("./importOffice");
    let first: string | null = null;
    for (const e of office) first ??= await importOffice(new File([e.data as BlobPart], e.path.split("/").pop()!), target);
    return first;
  }
  const byPath = new Map(entries.map((e) => [e.path, e]));
  // Exports carry each database twice: "Base.csv" (its view) and "Base_all.csv" (every row): one
  // database, with every row.
  const docs = entries.filter((e) => {
    if (!EXTENSION.test(e.path)) return false;
    const all = e.path.match(/^(.*)_all\.csv$/i);
    const view = all && byPath.get(`${all[1]}.csv`);
    if (view) view.data = e.data;
    return !view;
  });
  if (!docs.length) throw new Error("El archivo .zip no tiene páginas que importar");
  type Doc = { path: string; id: string; kind: ImportKind; parent: Doc | null; collectionId?: string };
  const byStem = new Map<string, Doc>();
  const list: Doc[] = docs
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))
    .map((e) => {
      const doc: Doc = { path: e.path, id: uuid(), kind: importKind(e.path), parent: null };
      if (!byStem.has(stemOf(e.path))) byStem.set(stemOf(e.path), doc);
      return doc;
    });
  for (const doc of list) {
    // The page whose folder holds it: "A/B/C.md" belongs to "A/B.md", else to "A.md", else the target.
    for (let dir = dirOf(doc.path); dir && !doc.parent; dir = dirOf(dir)) doc.parent = byStem.get(dir) ?? null;
  }
  const docAt = (path: string) => byStem.get(stemOf(path.replace(/_all\.csv$/i, ".csv")));
  const stored = new Map<string, Promise<string>>();
  const fileUrl = (path: string) => {
    const entry = byPath.get(path);
    if (!entry) return null;
    if (!stored.has(path)) {
      const name = path.split("/").pop()!;
      const type = MEDIA_TYPES[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
      stored.set(path, storeFile(new File([entry.data as BlobPart], name, { type })));
    }
    return stored.get(path)!;
  };
  /** A link to another page of the archive becomes an app link; one to a file, the stored file. */
  const linkFor = async (dir: string, href: string): Promise<{ page: string } | { url: string } | null> => {
    const path = zipPath(dir, href);
    if (path === null) return null;
    const doc = EXTENSION.test(path) ? docAt(path) : undefined;
    if (doc) return { page: doc.id };
    const url = fileUrl(path);
    return url ? { url: await url } : null;
  };

  const markdownOf = async (doc: Doc, text: string) => {
    const dir = dirOf(doc.path);
    const LINK = /(!?)\[([^\]]*)\]\((<[^>]+>|(?:[^()\s]|\([^()\s]*\))+)(\s+"[^"]*")?\)/g;
    const out: string[] = [];
    for (const line of text.split("\n")) {
      // A page's own line ("[Hija](Página/Hija.md)") is its page block.
      const only = line.match(/^\s*\[[^\]]*\]\((<[^>]+>|(?:[^()\s]|\([^()\s]*\))+)\)\s*$/);
      if (only) {
        const target = await linkFor(dir, only[1].replace(/^<|>$/g, ""));
        if (target && "page" in target) {
          out.push(`%%xotion:${target.page}%%`);
          continue;
        }
      }
      let next = "";
      let last = 0;
      for (const m of line.matchAll(LINK)) {
        const target = await linkFor(dir, m[3].replace(/^<|>$/g, ""));
        if (!target) continue;
        const href = "page" in target ? `#/${target.page}` : target.url;
        next += `${line.slice(last, m.index)}${m[1]}[${m[2]}](${href}${m[4] ?? ""})`;
        last = m.index + m[0].length;
      }
      out.push(next + line.slice(last));
    }
    return out.join("\n");
  };

  const htmlOf = async (doc: Doc, text: string) => {
    const dir = dirOf(doc.path);
    const parsed = new DOMParser().parseFromString(text, "text/html");
    for (const img of Array.from(parsed.querySelectorAll("img[src]"))) {
      const target = await linkFor(dir, img.getAttribute("src")!);
      if (target && "url" in target) img.setAttribute("src", target.url);
    }
    for (const a of Array.from(parsed.querySelectorAll("a[href]"))) {
      const target = await linkFor(dir, a.getAttribute("href")!);
      if (!target) continue;
      if ("url" in target) {
        a.setAttribute("href", target.url);
        continue;
      }
      // An exported "link-to-page" figure and Xot's page-link paragraph: the subpage's block.
      const holder = a.closest("figure.link-to-page") ?? (a.classList.contains("page-link") ? a.parentElement : null);
      if (holder && holder.textContent?.trim() === a.textContent?.trim()) {
        const p = parsed.createElement("p");
        p.textContent = `%%xotion:${target.page}%%`;
        holder.replaceWith(p);
      } else a.setAttribute("href", `#/${target.page}`);
    }
    return htmlToBlocks(`<!doctype html>${parsed.documentElement.outerHTML}`);
  };

  let first: string | null = null;
  const t = Date.now();
  const linked = new Set<string>();
  for (const [i, doc] of list.entries()) {
    const text = decodeText(byPath.get(doc.path)!.data.slice().buffer);
    const parent = doc.parent;
    const where: ImportTarget = parent ? { table: "block", id: parent.id } : target;
    if (doc.kind === "csv") {
      if (parent?.collectionId) continue;
      await importCsv(text, baseName(doc.path.split("/").pop()!), where, { id: doc.id, link: false });
      doc.collectionId = (await db.blocks.get(doc.id))?.collection_id;
      if (!parent) first ??= doc.id;
      continue;
    }
    let page: Partial<Block>;
    if (doc.kind === "html") {
      const { title, blocks } = await htmlOf(doc, text);
      page = { properties: { title: title ?? baseName(doc.path.split("/").pop()!) }, content: blocks.length ? withPageLinks(blocks) : null };
    } else {
      const heading = text.match(/^\uFEFF?# (.+)\n?/);
      const body = heading ? text.slice(heading[0].length) : text.replace(/^\uFEFF/, "");
      page = { properties: { title: heading?.[1].trim() ?? baseName(doc.path.split("/").pop()!) }, content_markdown: await markdownOf(doc, body) };
    }
    const links = JSON.stringify(page.content ?? null) + (page.content_markdown ?? "");
    for (const m of links.matchAll(/%%xotion:([0-9a-f-]{36})%%|"pageId":"([0-9a-f-]{36})"/g)) linked.add(m[1] ?? m[2]);
    if (parent?.collectionId) {
      // A database row's page: its content goes to the row the CSV made with that title.
      const title = String(page.properties!.title);
      const rows = await db.blocks.where("[parent_table+parent_id]").equals(["collection", parent.collectionId]).toArray();
      const row = rows.find((r) => r.properties.title === title && !r.content && !r.content_markdown);
      if (row) {
        await db.transaction("rw", db.blocks, async () => {
          await db.blocks.delete(row.id);
          await db.blocks.add({ ...row, ...page, properties: row.properties, id: doc.id });
        });
      } else await createPage("collection", parent.collectionId, { ...page, id: doc.id, order: t + i });
      continue;
    }
    await createPage(where.table, where.id, { ...page, id: doc.id, order: t + i });
    if (!parent) first ??= doc.id;
  }
  // Every subpage has its block in its parent: those the parent didn't show yet go at its end.
  for (const doc of list) {
    if (doc.parent?.collectionId) continue;
    if (doc.parent) {
      if (!linked.has(doc.id)) await insertPageLink(doc.parent.id, doc.id);
    } else if (target.table === "block") await insertPageLink(target.id, doc.id);
  }
  return first;
}
