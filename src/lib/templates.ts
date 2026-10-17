import type { RecurringEvery } from "./automations";
import type { Collection, PropertySchema, PropertyValue, TemplateRepeat } from "./model";

// Database templates' dynamic values and repeats ("Repetir").
//
// A template's date can be dynamic: "@today", "@now" or "@today+N" days stand
// for the day the page is made from it (date properties and @-mentions in its
// body). They are stored as written in the template and resolved when it's used.

const DYNAMIC = /^@(today|now)([+-]\d{1,4})?$/;

export const isDynamicDate = (value: unknown): boolean =>
  typeof value === "string" && value.split("/").some((part) => DYNAMIC.test(part));

/** The dynamic dates a template's date picker offers, by token. */
export const DYNAMIC_DATES: [string, string][] = [
  ["@today", "Hoy"],
  ["@now", "Ahora"],
  ["@today+1", "Mañana"],
  ["@today-1", "Ayer"],
  ["@today+7", "En una semana"],
];

/** "Hoy", "Ahora", "Mañana", "En 3 días"… (a range as "Hoy → En una semana"). */
export function dynamicLabel(value: string): string {
  return value
    .split("/")
    .map((part) => {
      const known = DYNAMIC_DATES.find(([t]) => t === part);
      if (known) return known[1];
      const m = DYNAMIC.exec(part);
      if (!m) return part;
      const n = Number(m[2] ?? 0);
      const base = m[1] === "now" ? "Ahora" : "Hoy";
      return n > 0 ? `${base} + ${n} ${n === 1 ? "día" : "días"}` : `${base} − ${-n} ${n === -1 ? "día" : "días"}`;
    })
    .join(" → ");
}

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A dynamic date for a page made at `at`; anything else passes through. */
export function resolveDynamicDate(value: string, at: number): string {
  return value
    .split("/")
    .map((part) => {
      const m = DYNAMIC.exec(part);
      if (!m) return part;
      const base = new Date(at);
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Number(m[2] ?? 0), base.getHours(), base.getMinutes());
      return m[1] === "now" ? `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}` : isoDay(d);
    })
    .join("/");
}

/** A template's values for a page made at `at`: its dynamic dates resolved. */
export function resolveProperties(
  properties: Record<string, PropertyValue>,
  schema: Record<string, PropertySchema> | undefined,
  at: number,
): Record<string, PropertyValue> {
  const out = { ...properties };
  for (const [id, value] of Object.entries(out))
    if (schema?.[id]?.type === "date" && typeof value === "string" && isDynamicDate(value)) out[id] = resolveDynamicDate(value, at);
  return out;
}

/** A template's body for a page made at `at`: its "@Hoy"/"@Ahora" mentions become that day. */
export function resolveContent(content: unknown[] | null, at: number): unknown[] | null {
  if (!content) return content;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
    const props = out.props as Record<string, unknown> | undefined;
    if (obj.type === "mention" && props && isDynamicDate(props.date))
      out.props = { ...props, date: resolveDynamicDate(props.date as string, at) };
    return out;
  };
  return walk(content) as unknown[];
}

// ----------------------------------------------------------------- repeat

/** The recurring trigger (lib/automations.ts) a repeat follows. */
export const repeatTrigger = (r: TemplateRepeat) => ({
  type: "recurring" as const,
  every: r.every,
  interval: r.interval,
  time: r.time,
  weekdays: r.weekdays,
});

export const repeatOf = (collection: Collection | undefined, templateId: string) =>
  collection?.template_repeats?.find((r) => r.template_id === templateId);

/** The menu's quick choices: a repeat starting today at 9:00 (weekly on today's weekday). */
export function quickRepeat(templateId: string, every: RecurringEvery, now = Date.now()): TemplateRepeat {
  const d = new Date(now);
  return {
    template_id: templateId,
    every,
    interval: 1,
    time: "09:00",
    weekdays: every === "week" ? [d.getDay()] : undefined,
    start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    last_due: now,
  };
}

const longDay = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" });
const nextLabel = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** "Próxima: vie, 17 oct, 9:00". */
export const nextRunLabel = (at: number) => `Próxima: ${nextLabel.format(new Date(at))}`;

/** A repeated page's title: the template's, then the day it was made ("Diario 16 de octubre de 2026"). */
export function repeatedTitle(title: string, at: number) {
  const day = longDay.format(new Date(at));
  return title.trim() ? `${title.trim()} ${day}` : day;
}

/** How many missed repeats are made when Xot opens after being closed (the latest ones). */
export const REPEAT_CATCH_UP = 31;
