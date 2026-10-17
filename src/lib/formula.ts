// Formulas (2.0 syntax): a tokenizer, a Pratt parser and an evaluator. Property
// values are read up front (they may be rollups, which load other rows), so the
// evaluation itself is synchronous and can run on every keystroke for the preview.

import { formatNumber } from "./format";

/** A date value; `end` makes it a range. Times are local. */
export interface FDate {
  kind: "date";
  start: number;
  end?: number;
  time: boolean;
}

/** A page (a related row): its title, and the properties the formula reads from it, loaded up front. */
export interface FPage {
  kind: "page";
  id: string;
  name: string;
  props?: Map<string, FValue>;
}

/** A run of styled text: style() / link() results. Styles are "b", "i", "u", "s", "c", "red", "red_background"…. */
export interface FRichPart {
  text: string;
  styles?: string[];
  link?: string;
}

/** Rich text: what style(), unstyle() and link() return, and text joined with it. */
export interface FRich {
  kind: "rich";
  parts: FRichPart[];
}

export type FValue = number | string | boolean | FDate | FPage | FRich | FValue[] | null;

/** A formula error; `at`/`end` mark the part of the source it comes from (for the editor's highlight). */
export class FormulaError extends Error {
  constructor(
    message: string,
    public at?: number,
    public end?: number,
  ) {
    super(message);
  }
}

type Token =
  | { t: "num"; v: number; at: number; end: number }
  | { t: "str"; v: string; at: number; end: number }
  | { t: "id"; v: string; at: number; end: number }
  | { t: "op"; v: string; at: number; end: number }
  | { t: "eof"; at: number; end: number };

export type Node =
  | { k: "lit"; v: FValue }
  | { k: "var"; name: string; at?: number; end?: number }
  | { k: "list"; items: Node[] }
  | { k: "call"; name: string; args: Node[]; at?: number; end?: number }
  | { k: "unary"; op: string; x: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "cond"; c: Node; a: Node; b: Node };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">", "!", "?", ":", "(", ")", ",", ".", "[", "]"];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // /* comments */ are ignored.
    if (src.startsWith("/*", i)) {
      const close = src.indexOf("*/", i + 2);
      if (close < 0) throw new FormulaError("Falta cerrar el comentario con «*/»", i, src.length);
      i = close + 2;
      continue;
    }
    const num = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]), at: i, end: i + num[0].length });
      i += num[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === "“" || c === "”") {
      const close = c === "“" ? "”" : c;
      let s = "";
      let j = i + 1;
      while (j < src.length && src[j] !== close) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[++j];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new FormulaError("Falta cerrar las comillas", i, src.length);
      out.push({ t: "str", v: s, at: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    const id = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0], at: i, end: i + id[0].length });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i)) ?? (src.startsWith("≠", i) ? "≠" : src.startsWith("≤", i) ? "≤" : src.startsWith("≥", i) ? "≥" : null);
    if (!op) throw new FormulaError(`Carácter inesperado «${c}»`, i, i + 1);
    out.push({ t: "op", v: op === "≠" ? "!=" : op === "≤" ? "<=" : op === "≥" ? ">=" : op, at: i, end: i + op.length });
    i += op.length;
  }
  out.push({ t: "eof", at: src.length, end: src.length });
  return out;
}

/** Binding power of the infix operators (higher binds tighter). */
const INFIX: Record<string, number> = {
  "?": 1,
  or: 2,
  "||": 2,
  and: 3,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  ">": 5,
  "<=": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
  "^": 8,
};

export function parse(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (v: string, tok = peek()) => tok.t === "op" && tok.v === v;
  const expect = (v: string) => {
    const tok = next();
    if (tok.t !== "op" || tok.v !== v) throw new FormulaError(`Se esperaba «${v}»`, tok.at, tok.t === "eof" ? tok.at : tok.end);
  };
  const args = (): Node[] => {
    expect("(");
    const list: Node[] = [];
    if (!isOp(")"))
      do list.push(expr(0));
      while (isOp(",") && next());
    expect(")");
    return list;
  };

  const prefix = (): Node => {
    const tok = next();
    if (tok.t === "num") return { k: "lit", v: tok.v };
    if (tok.t === "str") return { k: "lit", v: tok.v };
    if (tok.t === "id") {
      if (tok.v === "true" || tok.v === "false") return { k: "lit", v: tok.v === "true" };
      if (tok.v === "not") return { k: "unary", op: "!", x: expr(4) };
      if (isOp("(")) {
        const list = args();
        return { k: "call", name: tok.v, args: list, at: tok.at, end: tokens[pos - 1].end };
      }
      return { k: "var", name: tok.v, at: tok.at, end: tok.end };
    }
    if (tok.t === "op") {
      if (tok.v === "(") {
        const inner = expr(0);
        expect(")");
        return inner;
      }
      if (tok.v === "[") {
        const items: Node[] = [];
        if (!isOp("]"))
          do items.push(expr(0));
          while (isOp(",") && next());
        expect("]");
        return { k: "list", items };
      }
      // Unary minus binds just below ^ (-2^2 is -(2^2)); ! binds tightest.
      if (tok.v === "-") return { k: "unary", op: tok.v, x: expr(7) };
      if (tok.v === "!") return { k: "unary", op: tok.v, x: expr(9) };
    }
    throw new FormulaError(tok.t === "eof" ? "La fórmula está incompleta" : "Expresión no válida", tok.at, tok.end);
  };

  const expr = (minBp: number): Node => {
    let left = prefix();
    for (;;) {
      const tok = peek();
      // .method(args): the value becomes the first argument.
      if (isOp(".", tok)) {
        next();
        const name = next();
        if (name.t !== "id") throw new FormulaError("Se esperaba un nombre de función después de «.»", name.at, name.end);
        left = { k: "call", name: name.v, args: [left, ...(isOp("(") ? args() : [])], at: name.at, end: tokens[pos - 1].end };
        continue;
      }
      const op = tok.t === "op" || (tok.t === "id" && (tok.v === "and" || tok.v === "or")) ? (tok as { v: string }).v : null;
      const bp = op ? INFIX[op] : undefined;
      if (!op || bp === undefined || bp <= minBp) break;
      next();
      if (op === "?") {
        const a = expr(0);
        expect(":");
        left = { k: "cond", c: left, a, b: expr(bp - 1) };
        continue;
      }
      // ^ is right-associative.
      const b = expr(op === "^" ? bp - 1 : bp);
      left = { k: "bin", op: op === "&&" ? "and" : op === "||" ? "or" : op, a: left, b };
    }
    return left;
  };

  const tree = expr(0);
  if (peek().t !== "eof") throw new FormulaError("Hay texto de más al final de la fórmula", peek().at, src.length);
  return tree;
}

const cache = new Map<string, Node | FormulaError>();

/** The parsed formula (cached by source); throws its syntax error. */
export function compile(src: string): Node {
  let hit = cache.get(src);
  if (!hit) {
    try {
      hit = parse(src);
    } catch (e) {
      hit = e instanceof FormulaError ? e : new FormulaError(String(e));
    }
    if (cache.size > 500) cache.clear();
    cache.set(src, hit);
  }
  if (hit instanceof FormulaError) throw hit;
  return hit;
}

/** The property names a formula reads through prop("…"). */
export function propNames(node: Node, out = new Set<string>()): Set<string> {
  switch (node.k) {
    case "call":
      if (node.name === "prop" && node.args[0]?.k === "lit" && typeof node.args[0].v === "string") out.add(node.args[0].v);
      node.args.forEach((a) => propNames(a, out));
      break;
    case "list":
      node.items.forEach((a) => propNames(a, out));
      break;
    case "unary":
      propNames(node.x, out);
      break;
    case "bin":
      propNames(node.a, out);
      propNames(node.b, out);
      break;
    case "cond":
      propNames(node.c, out);
      propNames(node.a, out);
      propNames(node.b, out);
      break;
  }
  return out;
}

/** The property names a formula reads from other pages: page.prop("…") (current.prop("X") in map()…). */
export function pagePropNames(node: Node, out = new Set<string>()): Set<string> {
  switch (node.k) {
    case "call":
      if (node.name === "prop" && node.args.length === 2 && node.args[1].k === "lit" && typeof node.args[1].v === "string")
        out.add(node.args[1].v);
      node.args.forEach((a) => pagePropNames(a, out));
      break;
    case "list":
      node.items.forEach((a) => pagePropNames(a, out));
      break;
    case "unary":
      pagePropNames(node.x, out);
      break;
    case "bin":
      pagePropNames(node.a, out);
      pagePropNames(node.b, out);
      break;
    case "cond":
      pagePropNames(node.c, out);
      pagePropNames(node.a, out);
      pagePropNames(node.b, out);
      break;
  }
  return out;
}

// ------------------------------------------------------------------ values

export const isDate = (v: FValue): v is FDate => !!v && typeof v === "object" && !Array.isArray(v) && v.kind === "date";
export const isPage = (v: FValue): v is FPage => !!v && typeof v === "object" && !Array.isArray(v) && v.kind === "page";
export const isRich = (v: FValue): v is FRich => !!v && typeof v === "object" && !Array.isArray(v) && v.kind === "rich";

/** Text that keeps its styles: plain values become one unstyled run. */
const richParts = (v: FValue): FRichPart[] => (isRich(v) ? v.parts : [{ text: display(v) }]);

/** Joins values as text; the result is rich text when any of them is. */
function joinText(values: FValue[], sep: FValue = ""): FValue {
  if (!values.some(isRich) && !isRich(sep)) return values.map(display).join(display(sep));
  const parts: FRichPart[] = [];
  values.forEach((v, i) => {
    if (i && display(sep)) parts.push(...richParts(sep));
    parts.push(...richParts(v));
  });
  return { kind: "rich", parts: parts.filter((p) => p.text) };
}

export const dateValue = (start: number, end?: number, time = false): FDate => ({ kind: "date", start, end, time });

/** Stored date ("2026-06-10", "2026-06-10T09:30", "a/b" range) → FDate. */
export function parseStoredDate(value: string): FDate | null {
  const [a, b] = value.split("/");
  const point = (s: string) => new Date(s.length <= 10 ? `${s}T00:00:00` : s).getTime();
  const start = point(a);
  if (Number.isNaN(start)) return null;
  const end = b ? point(b) : undefined;
  return dateValue(start, end !== undefined && !Number.isNaN(end) ? end : undefined, a.length > 10);
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (t: number, time: boolean) => {
  const d = new Date(t);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return time ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
};

/** FDate → the stored date format, so cells show it like a date property. */
export const storedDate = (d: FDate) => isoOf(d.start, d.time) + (d.end !== undefined ? `/${isoOf(d.end, d.time)}` : "");

const longDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" });
const timeOfDay = new Intl.DateTimeFormat("es", { hour: "numeric", minute: "2-digit" });

/** How a value prints inside text (format(), concatenation). */
export function display(v: FValue): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(display).join(", ");
  if (isPage(v)) return v.name;
  if (isRich(v)) return v.parts.map((p) => p.text).join("");
  const one = (t: number) => longDate.format(t) + (v.time ? ` ${timeOfDay.format(t)}` : "");
  return v.end !== undefined ? `${one(v.start)} → ${one(v.end)}` : one(v.start);
}

/** The type of a value, as the formula editor and its errors name it. */
export const typeName = (v: FValue) =>
  v === null
    ? "vacío"
    : Array.isArray(v)
      ? "lista"
      : isDate(v)
        ? "fecha"
        : isPage(v)
          ? "página"
          : typeof v === "number"
            ? "número"
            : typeof v === "string" || isRich(v)
              ? "texto"
              : "booleano";

function num(v: FValue, fn: string): number {
  if (v === null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new FormulaError(`${fn} espera un número, no ${typeName(v)}`);
}

function str(v: FValue): string {
  return display(v);
}

function list(v: FValue, fn: string): FValue[] {
  if (Array.isArray(v)) return v;
  if (v === null) return [];
  throw new FormulaError(`${fn} espera una lista, no ${typeName(v)}`);
}

function date(v: FValue, fn: string): FDate {
  if (isDate(v)) return v;
  if (typeof v === "string") {
    const d = parseStoredDate(v);
    if (d) return d;
  }
  throw new FormulaError(`${fn} espera una fecha, no ${typeName(v)}`);
}

export function truthy(v: FValue): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (isRich(v)) return display(v) !== "";
  return true;
}

const isEmpty = (v: FValue) =>
  v === null || v === "" || v === false || v === 0 || (Array.isArray(v) && v.length === 0) || (isRich(v) && display(v) === "");

function equal(a: FValue, b: FValue): boolean {
  if (a === null || b === null) return (a === null || a === "" || (Array.isArray(a) && !a.length)) && (b === null || b === "" || (Array.isArray(b) && !b.length));
  if (isDate(a) && isDate(b)) return a.start === b.start && a.end === b.end;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isPage(a) && isPage(b)) return a.id === b.id;
  // A page equals its title, and styled text its plain text.
  if (isPage(a) || isPage(b) || isRich(a) || isRich(b)) return !Array.isArray(a) && !Array.isArray(b) && display(a) === display(b);
  return a === b;
}

function compare(a: FValue, b: FValue, op: string): number {
  if (isDate(a) || isDate(b)) return date(a, op).start - date(b, op).start;
  const text = (v: FValue) => typeof v === "string" || isPage(v) || isRich(v);
  if (text(a) && text(b)) return display(a).localeCompare(display(b), "es");
  return num(a, op) - num(b, op);
}

const UNITS: Record<string, string> = {
  year: "years", years: "years", y: "years",
  quarter: "quarters", quarters: "quarters", Q: "quarters",
  month: "months", months: "months", M: "months",
  week: "weeks", weeks: "weeks", w: "weeks",
  day: "days", days: "days", d: "days",
  hour: "hours", hours: "hours", h: "hours",
  minute: "minutes", minutes: "minutes", m: "minutes",
  second: "seconds", seconds: "seconds", s: "seconds",
  millisecond: "milliseconds", milliseconds: "milliseconds", ms: "milliseconds",
};
const FIXED: Record<string, number> = { weeks: 604_800_000, days: 86_400_000, hours: 3_600_000, minutes: 60_000, seconds: 1000, milliseconds: 1 };

function unitOf(v: FValue): string {
  const u = UNITS[str(v)];
  if (!u) throw new FormulaError(`Unidad de tiempo no válida: «${str(v)}»`);
  return u;
}

function addTime(t: number, n: number, unit: string): number {
  if (FIXED[unit]) {
    // Days and weeks keep the time of day across daylight-saving changes.
    if (unit === "days" || unit === "weeks") {
      const d = new Date(t);
      d.setDate(d.getDate() + n * (unit === "weeks" ? 7 : 1));
      return d.getTime();
    }
    return t + n * FIXED[unit];
  }
  const d = new Date(t);
  const months = unit === "years" ? n * 12 : unit === "quarters" ? n * 3 : n;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + Math.trunc(months));
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.getTime();
}

function between(a: number, b: number, unit: string): number {
  if (FIXED[unit]) return Math.trunc((a - b) / FIXED[unit]);
  const da = new Date(a);
  const db = new Date(b);
  let months = (da.getFullYear() - db.getFullYear()) * 12 + (da.getMonth() - db.getMonth());
  // A month only counts once its day (and time) is reached.
  if (months > 0 && addTime(b, months, "months") > a) months--;
  if (months < 0 && addTime(b, months, "months") < a) months++;
  return unit === "years" ? Math.trunc(months / 12) : unit === "quarters" ? Math.trunc(months / 3) : months;
}

const MONTHS = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat("es", { month: "long" }).format(new Date(2026, i, 1)));
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat("es", { weekday: "long" }).format(new Date(2026, 0, 4 + i)));

/** Moment-style tokens, as formatDate() takes them ("YYYY-MM-DD", "D [de] MMMM"…). */
function formatDate(t: number, format: string): string {
  const d = new Date(t);
  const h12 = d.getHours() % 12 || 12;
  const values: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MMMM: MONTHS[d.getMonth()],
    MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad(d.getDate()),
    Do: `${d.getDate()}º`,
    D: String(d.getDate()),
    dddd: WEEKDAYS[d.getDay()],
    ddd: WEEKDAYS[d.getDay()].slice(0, 3),
    d: String(d.getDay()),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    hh: pad(h12),
    h: String(h12),
    mm: pad(d.getMinutes()),
    m: String(d.getMinutes()),
    ss: pad(d.getSeconds()),
    s: String(d.getSeconds()),
    A: d.getHours() < 12 ? "AM" : "PM",
    a: d.getHours() < 12 ? "am" : "pm",
    X: String(Math.floor(t / 1000)),
    x: String(t),
  };
  return format.replace(/\[([^\]]*)]|YYYY|YY|MMMM|MMM|MM|M|DD|Do|D|dddd|ddd|d|HH|H|hh|h|mm|m|ss|s|A|a|X|x/g, (tok, literal) =>
    literal !== undefined ? literal : values[tok],
  );
}

/** ISO week number (week()). */
function isoWeek(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

function toNumber(v: FValue): FValue {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isDate(v)) return v.start;
  if (isRich(v) || isPage(v)) return toNumber(display(v));
  if (typeof v === "string") {
    const m = /-?\d+(\.\d+)?/.exec(v.replace(/,/g, ""));
    return m ? Number(m[0]) : null;
  }
  return null;
}

type Fn = (a: FValue[]) => FValue;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Numbers from the arguments, flattening lists (sum(1, [2, 3])). */
const numbers = (args: FValue[], fn: string): number[] =>
  args.flatMap((a) => (Array.isArray(a) ? numbers(a, fn) : a === null ? [] : [num(a, fn)]));

const FUNCTIONS: Record<string, Fn> = {
  // Text
  concat: (a) => (a.length && a.every(Array.isArray) ? (a as FValue[][]).flat() : joinText(a)),
  join: ([l, sep]) => joinText(list(l, "join"), sep ?? ""),
  length: ([v]) => (Array.isArray(v) ? v.length : str(v).length),
  contains: ([v, s]) => (Array.isArray(v) ? v.some((x) => equal(x, s)) : str(v).includes(str(s))),
  includes: ([v, s]) => (Array.isArray(v) ? v.some((x) => equal(x, s)) : str(v).includes(str(s))),
  test: ([v, re]) => new RegExp(str(re)).test(str(v)),
  match: ([v, re]) => str(v).match(new RegExp(str(re), "g")) ?? [],
  replace: ([v, re, by]) => str(v).replace(new RegExp(str(re)), str(by ?? "")),
  replaceAll: ([v, re, by]) => str(v).replace(new RegExp(str(re), "g"), str(by ?? "")),
  lower: ([v]) => str(v).toLowerCase(),
  upper: ([v]) => str(v).toUpperCase(),
  trim: ([v]) => str(v).trim(),
  repeat: ([v, n]) => str(v).repeat(Math.max(0, Math.trunc(num(n, "repeat")))),
  padStart: ([v, n, p]) => str(v).padStart(num(n, "padStart"), str(p ?? " ")),
  padEnd: ([v, n, p]) => str(v).padEnd(num(n, "padEnd"), str(p ?? " ")),
  substring: ([v, s, e]) => str(v).substring(num(s, "substring"), e === undefined ? undefined : num(e, "substring")),
  split: ([v, sep]) => str(v).split(str(sep ?? "")),
  format: ([v]) => str(v),
  toNumber: ([v]) => toNumber(v),
  formatNumber: ([v, f, places]) =>
    formatNumberAs(num(v, "formatNumber"), f === undefined || f === null ? undefined : str(f), places === undefined || places === null ? undefined : num(places, "formatNumber")),
  link: ([label, url]) => ({ kind: "rich", parts: [{ text: str(label), link: str(url ?? label) }] }),
  style: ([v, ...styles]) => {
    const add = styles.flatMap((x) => (Array.isArray(x) ? x : [x])).map(str).filter((x) => STYLES.test(x));
    return { kind: "rich", parts: richParts(v).map((p) => ({ ...p, styles: [...new Set([...(p.styles ?? []), ...add])] })) };
  },
  unstyle: ([v, ...styles]) => {
    if (!styles.length || !isRich(v)) return str(v);
    const drop = new Set(styles.map(str));
    return { kind: "rich", parts: v.parts.map((p) => ({ ...p, styles: p.styles?.filter((x) => !drop.has(x)) })) };
  },
  // People are names in Xot; there are no e-mail addresses to read.
  name: ([v]) => (Array.isArray(v) ? v.map(str) : str(v)),
  email: ([v]) => (Array.isArray(v) ? v.map(() => "") : ""),
  // Logic
  empty: ([v]) => isEmpty(v),
  equal: ([a, b]) => equal(a, b),
  unequal: ([a, b]) => !equal(a, b),
  // Formulas 1.0 names of the operators, still accepted.
  larger: ([a, b]) => compare(a, b, "larger") > 0,
  largerEq: ([a, b]) => compare(a, b, "largerEq") >= 0,
  smaller: ([a, b]) => compare(a, b, "smaller") < 0,
  smallerEq: ([a, b]) => compare(a, b, "smallerEq") <= 0,
  unaryMinus: ([v]) => -num(v, "unaryMinus"),
  unaryPlus: ([v]) => num(v, "unaryPlus"),
  // Math
  add: ([a, b]) => num(a, "add") + num(b, "add"),
  subtract: ([a, b]) => num(a, "subtract") - num(b, "subtract"),
  multiply: ([a, b]) => num(a, "multiply") * num(b, "multiply"),
  divide: ([a, b]) => num(a, "divide") / num(b, "divide"),
  mod: ([a, b]) => num(a, "mod") % num(b, "mod"),
  pow: ([a, b]) => num(a, "pow") ** num(b, "pow"),
  round: ([v, places]) => {
    const f = 10 ** (places === undefined ? 0 : num(places, "round"));
    return Math.round(num(v, "round") * f) / f;
  },
  floor: ([v]) => Math.floor(num(v, "floor")),
  ceil: ([v]) => Math.ceil(num(v, "ceil")),
  abs: ([v]) => Math.abs(num(v, "abs")),
  sqrt: ([v]) => Math.sqrt(num(v, "sqrt")),
  cbrt: ([v]) => Math.cbrt(num(v, "cbrt")),
  exp: ([v]) => Math.exp(num(v, "exp")),
  ln: ([v]) => Math.log(num(v, "ln")),
  log10: ([v]) => Math.log10(num(v, "log10")),
  log2: ([v]) => Math.log2(num(v, "log2")),
  sign: ([v]) => Math.sign(num(v, "sign")),
  pi: () => Math.PI,
  e: () => Math.E,
  min: (a) => (numbers(a, "min").length ? Math.min(...numbers(a, "min")) : null),
  max: (a) => (numbers(a, "max").length ? Math.max(...numbers(a, "max")) : null),
  sum: (a) => numbers(a, "sum").reduce((s, x) => s + x, 0),
  mean: (a) => {
    const xs = numbers(a, "mean");
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  },
  median: (a) => median(numbers(a, "median")),
  // Dates
  now: () => dateValue(Date.now(), undefined, true),
  today: () => dateValue(new Date().setHours(0, 0, 0, 0)),
  minute: ([d]) => new Date(date(d, "minute").start).getMinutes(),
  hour: ([d]) => new Date(date(d, "hour").start).getHours(),
  // ISO weekday: 1 (Monday) to 7 (Sunday).
  day: ([d]) => ((new Date(date(d, "day").start).getDay() + 6) % 7) + 1,
  date: ([d]) => new Date(date(d, "date").start).getDate(),
  week: ([d]) => isoWeek(date(d, "week").start),
  month: ([d]) => new Date(date(d, "month").start).getMonth() + 1,
  year: ([d]) => new Date(date(d, "year").start).getFullYear(),
  dateAdd: ([d, n, u]) => {
    const v = date(d, "dateAdd");
    const unit = unitOf(u);
    const k = num(n, "dateAdd");
    return dateValue(addTime(v.start, k, unit), v.end === undefined ? undefined : addTime(v.end, k, unit), v.time || (!!FIXED[unit] && unit !== "days" && unit !== "weeks"));
  },
  dateSubtract: ([d, n, u]) => FUNCTIONS.dateAdd([d, -num(n, "dateSubtract"), u]),
  dateBetween: ([a, b, u]) => between(date(a, "dateBetween").start, date(b, "dateBetween").start, unitOf(u)),
  dateRange: ([a, b]) => {
    const s = date(a, "dateRange");
    const e = date(b, "dateRange");
    return dateValue(s.start, e.end ?? e.start, s.time || e.time);
  },
  dateStart: ([d]) => {
    const v = date(d, "dateStart");
    return dateValue(v.start, undefined, v.time);
  },
  dateEnd: ([d]) => {
    const v = date(d, "dateEnd");
    return dateValue(v.end ?? v.start, undefined, v.time);
  },
  timestamp: ([d]) => date(d, "timestamp").start,
  fromTimestamp: ([n]) => dateValue(num(n, "fromTimestamp"), undefined, true),
  formatDate: ([d, f]) => formatDate(date(d, "formatDate").start, f === undefined ? "D [de] MMMM [de] YYYY" : str(f)),
  parseDate: ([s]) => {
    const v = parseStoredDate(str(s)) ?? (Number.isNaN(Date.parse(str(s))) ? null : dateValue(Date.parse(str(s)), undefined, true));
    if (!v) throw new FormulaError(`No es una fecha: «${str(s)}»`);
    return v;
  },
  // Lists
  at: ([l, i]) => {
    const xs = list(l, "at");
    const k = num(i, "at");
    return xs[k < 0 ? xs.length + k : k] ?? null;
  },
  first: ([l]) => list(l, "first")[0] ?? null,
  last: ([l]) => list(l, "last").at(-1) ?? null,
  slice: ([v, s, e]) =>
    Array.isArray(v)
      ? v.slice(num(s, "slice"), e === undefined ? undefined : num(e, "slice"))
      : str(v).slice(num(s, "slice"), e === undefined ? undefined : num(e, "slice")),
  splice: ([l, s, n, ...items]) => {
    const xs = [...list(l, "splice")];
    xs.splice(num(s, "splice"), n === undefined ? xs.length : num(n, "splice"), ...items);
    return xs;
  },
  reverse: ([l]) => [...list(l, "reverse")].reverse(),
  unique: ([l]) => list(l, "unique").filter((x, i, xs) => xs.findIndex((y) => equal(x, y)) === i),
  flat: ([l]) => list(l, "flat").flatMap((x) => (Array.isArray(x) ? x : [x])),
};

/** Text styles for style(): bold, italic, underline, strikethrough, code, and the colors (text or "_background"). */
const STYLES = /^(b|i|u|s|c|(default|gray|brown|orange|yellow|green|blue|purple|pink|red)(_background)?)$/;

/** formatNumber(): number format ids ("dollar", "percent"…), with an optional number of decimals. */
function formatNumberAs(n: number, format: string | undefined, places: number | undefined): string {
  const id = format?.trim().toLowerCase().replace(/\s+/g, "_");
  return formatNumber(n, id === "number" || !id ? "number_with_commas" : id, false, places === undefined ? undefined : Math.max(0, Math.min(10, Math.trunc(places))));
}

export interface FormulaEnv {
  /** Value of a property by name (already read; see propNames). */
  prop: (name: string) => FValue;
  /** The row's id, for id(). */
  id?: string;
  /** Named values the formula can use by name (automation and button variables). */
  vars?: Map<string, FValue>;
}

export function run(node: Node, env: FormulaEnv): FValue {
  const ev = (n: Node, scope: Map<string, FValue>): FValue => {
    switch (n.k) {
      case "lit":
        return n.v;
      case "list":
        return n.items.map((i) => ev(i, scope));
      case "var": {
        if (scope.has(n.name)) return scope.get(n.name)!;
        if (n.name in FUNCTIONS && FUNCTIONS[n.name].length === 0) return FUNCTIONS[n.name]([]);
        throw new FormulaError(`Variable desconocida: ${n.name}`, n.at, n.end);
      }
      case "unary": {
        const x = ev(n.x, scope);
        return n.op === "-" ? -num(x, "-") : !truthy(x);
      }
      case "cond":
        return truthy(ev(n.c, scope)) ? ev(n.a, scope) : ev(n.b, scope);
      case "bin": {
        if (n.op === "and") return truthy(ev(n.a, scope)) && truthy(ev(n.b, scope));
        if (n.op === "or") return truthy(ev(n.a, scope)) || truthy(ev(n.b, scope));
        const a = ev(n.a, scope);
        const b = ev(n.b, scope);
        switch (n.op) {
          case "==":
            return equal(a, b);
          case "!=":
            return !equal(a, b);
          case "<":
            return compare(a, b, "<") < 0;
          case ">":
            return compare(a, b, ">") > 0;
          case "<=":
            return compare(a, b, "<=") <= 0;
          case ">=":
            return compare(a, b, ">=") >= 0;
          case "+":
            if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
            if (isRich(a) || isRich(b)) return joinText([a, b]);
            if (typeof a === "string" || typeof b === "string" || isDate(a) || isDate(b)) return str(a) + str(b);
            if (a === null && b === null) return null;
            // Formulas 2.0 are typed: a number and a boolean do not add up.
            if ((typeof a === "boolean" && typeof b === "number") || (typeof a === "number" && typeof b === "boolean"))
              throw new FormulaError(`No se puede sumar ${typeName(a)} y ${typeName(b)}`);
            return num(a, "+") + num(b, "+");
          case "-":
            return num(a, "-") - num(b, "-");
          case "*":
            return num(a, "*") * num(b, "*");
          case "/":
            return num(a, "/") / num(b, "/");
          case "%":
            return num(a, "%") % num(b, "%");
          case "^":
            return num(a, "^") ** num(b, "^");
        }
        throw new FormulaError(`Operador desconocido: ${n.op}`);
      }
      case "call":
        try {
          return call(n, scope);
        } catch (e) {
          // The innermost call that failed marks the error in the editor.
          if (e instanceof FormulaError && e.at === undefined) {
            e.at = n.at;
            e.end = n.end;
          }
          throw e;
        }
    }
  };

  const call = (n: Extract<Node, { k: "call" }>, scope: Map<string, FValue>): FValue => {
    const a = n.args;
    const need = (count: number) => {
      if (a.length < count) throw new FormulaError(`${n.name}() necesita ${count} argumento${count > 1 ? "s" : ""}`);
    };
    // if/and/let/map… decide which arguments to evaluate; map/filter/… run the
    // expression once per item, with `current` and `index`.
    const each = (fn: (item: FValue, result: FValue, i: number) => boolean | void) => {
      need(2);
      const xs = list(ev(a[0], scope), n.name);
      const inner = new Map(scope);
      for (let i = 0; i < xs.length; i++) {
        inner.set("current", xs[i]);
        inner.set("index", i);
        if (fn(xs[i], ev(a[1], inner), i) === false) break;
      }
      return xs;
    };
    switch (n.name) {
      case "prop": {
        need(1);
        if (a.length < 2) return env.prop(str(ev(a[0], scope)));
        // page.prop("X"): a property of another page (a related row), loaded up front.
        const page = ev(a[0], scope);
        const name = str(ev(a[1], scope));
        if (!isPage(page)) throw new FormulaError(`prop() espera una página, no ${typeName(page)}`);
        if (!page.props?.has(name)) throw new FormulaError(`No existe la propiedad «${name}» en «${page.name || "Sin título"}»`);
        return page.props.get(name)!;
      }
      case "id": {
        if (!a.length) return env.id ?? "";
        const v = ev(a[0], scope);
        return isPage(v) ? v.id : Array.isArray(v) ? v.map((x) => (isPage(x) ? x.id : str(x))) : str(v);
      }
      case "count": {
        // count(list) or count(list, condition).
        need(1);
        if (a.length < 2) return list(ev(a[0], scope), "count").length;
        let total = 0;
        each((_, r) => void (truthy(r) && total++));
        return total;
      }
      case "sort": {
        need(1);
        const xs = [...list(ev(a[0], scope), "sort")];
        if (a.length < 2) return xs.sort((x, y) => compare(x, y, "sort"));
        // sort(list, expression): ordered by the expression's value for each item.
        const keyed = xs.map((item, i) => ({ item, key: ev(a[1], new Map(scope).set("current", item).set("index", i)) }));
        return keyed.sort((x, y) => compare(x.key, y.key, "sort")).map((k) => k.item);
      }
      case "if":
        need(3);
        return truthy(ev(a[0], scope)) ? ev(a[1], scope) : ev(a[2], scope);
      case "ifs": {
        for (let i = 0; i + 1 < a.length; i += 2) if (truthy(ev(a[i], scope))) return ev(a[i + 1], scope);
        return a.length % 2 ? ev(a[a.length - 1], scope) : null;
      }
      case "and":
        return a.every((x) => truthy(ev(x, scope)));
      case "or":
        return a.some((x) => truthy(ev(x, scope)));
      case "let":
      case "lets": {
        if (a.length < 3 || a.length % 2 === 0) throw new FormulaError(`${n.name}() necesita pares de nombre y valor, y una expresión`);
        const inner = new Map(scope);
        for (let i = 0; i + 1 < a.length; i += 2) {
          const name = a[i];
          if (name.k !== "var") throw new FormulaError(`${n.name}(): se esperaba un nombre de variable`);
          inner.set(name.name, ev(a[i + 1], inner));
        }
        return ev(a[a.length - 1], inner);
      }
      case "map": {
        const out: FValue[] = [];
        each((_, r) => void out.push(r));
        return out;
      }
      case "filter": {
        const out: FValue[] = [];
        each((item, r) => void (truthy(r) && out.push(item)));
        return out;
      }
      case "find": {
        let found: FValue = null;
        each((item, r) => (truthy(r) ? ((found = item), false) : undefined));
        return found;
      }
      case "findIndex": {
        let found = -1;
        each((_, r, i) => (truthy(r) ? ((found = i), false) : undefined));
        return found;
      }
      case "some": {
        let hit = false;
        each((_, r) => (truthy(r) ? ((hit = true), false) : undefined));
        return hit;
      }
      case "every": {
        let all = true;
        each((_, r) => (!truthy(r) ? ((all = false), false) : undefined));
        return all;
      }
    }
    const fn = FUNCTIONS[n.name];
    if (!fn) throw new FormulaError(`Función desconocida: ${n.name}()`, n.at, n.end);
    return fn(a.map((x) => ev(x, scope)));
  };

  return ev(node, new Map(env.vars));
}
