import { liveQuery } from "dexie";
import { db } from "./db";
import { evaluate } from "./compute";
import { isAutomationWrite, runActions, type Action } from "./actions";
import { applyQuery, isComputedType, queryComputedIds } from "./query";
import type { Block, Collection, FilterOperator, PropertyValue, TemplateRepeat } from "./model";
import { addRowFromTemplate } from "./ops";
import { repeatedTitle, repeatTrigger, REPEAT_CATCH_UP } from "./templates";

// Database automations (⚡): when a page is added, a property is edited
// or on a schedule, run actions (lib/actions.ts). Each database keeps its own on
// the collection. Edits made by an automation never start another one, and an
// automation whose action fails is paused with the error.

/** A "Propiedad editada" condition: the property changed (to a value matching the rule, when it has one). */
export interface TriggerRule {
  id: string;
  property: string;
  /** No operator: any change. */
  operator?: FilterOperator;
  value?: PropertyValue;
}

export type RecurringEvery = "day" | "week" | "month" | "year";

export type Trigger =
  | { type: "page_added" }
  | { type: "property_edited"; rules: TriggerRule[]; match: "any" | "all" }
  | {
      type: "recurring";
      every: RecurringEvery;
      /** Every N days, weeks, months or years. */
      interval: number;
      /** "HH:mm", local time. */
      time: string;
      /** week: the days it runs (0 Sunday … 6 Saturday); the day it was created when empty. */
      weekdays?: number[];
    };

export interface Automation {
  id: string;
  name: string;
  /** Off: paused by hand, or after an error (`error`). */
  enabled: boolean;
  /** Any of them starts it. */
  triggers: Trigger[];
  actions: Action[];
  /** Only pages this view shows (its filters); every page when absent ("Todas las vistas"). */
  view_id?: string;
  /** The error that paused it. */
  error?: string;
  /** When it last ran. */
  last_run?: number;
  /** Recurring: the last time it was due (it ran then, or when Xot opened after it). */
  last_due?: number;
  created_time: number;
}

export const TRIGGER_LABELS: Record<Trigger["type"], string> = {
  page_added: "Página añadida",
  property_edited: "Propiedad editada",
  recurring: "Recurrente",
};

// ----------------------------------------------------------------- storage

export async function saveAutomation(collectionId: string, automation: Automation) {
  await db.transaction("rw", db.collections, async () => {
    const c = await db.collections.get(collectionId);
    if (!c) return;
    const list = c.automations ?? [];
    const at = list.findIndex((a) => a.id === automation.id);
    await db.collections.update(collectionId, {
      automations: at < 0 ? [...list, automation] : list.map((a) => (a.id === automation.id ? automation : a)),
    });
  });
}

export async function patchAutomation(collectionId: string, id: string, patch: Partial<Automation>) {
  await db.transaction("rw", db.collections, async () => {
    const c = await db.collections.get(collectionId);
    if (!c?.automations?.some((a) => a.id === id)) return;
    await db.collections.update(collectionId, { automations: c.automations.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  });
}

export async function deleteAutomation(collectionId: string, id: string) {
  await db.transaction("rw", db.collections, async () => {
    const c = await db.collections.get(collectionId);
    if (!c) return;
    await db.collections.update(collectionId, { automations: (c.automations ?? []).filter((a) => a.id !== id) });
  });
}

export function newAutomation(): Automation {
  return { id: crypto.randomUUID(), name: "", enabled: true, triggers: [], actions: [], created_time: Date.now() };
}

// -------------------------------------------------------------- recurring

const DAY = 86_400_000;

function timeOf(t: string): [number, number] {
  const [, h = "9", m = "0"] = /^(\d{1,2}):(\d{2})$/.exec(t) ?? [];
  return [Math.min(23, Number(h)), Math.min(59, Number(m))];
}

/** The first time a recurring trigger is due after `after`, counting from `anchor` (when it was set up). */
export function nextOccurrence(t: Extract<Trigger, { type: "recurring" }>, anchor: number, after: number): number {
  const [h, m] = timeOf(t.time);
  const n = Math.max(1, Math.floor(t.interval || 1));
  const a = new Date(anchor);
  const day = (y: number, mo: number, d: number) => new Date(y, mo, d, h, m).getTime();
  const from = Math.max(after, anchor);
  if (t.every === "day") {
    const first = day(a.getFullYear(), a.getMonth(), a.getDate());
    let k = Math.max(0, Math.floor((from - first) / DAY / n) - 1);
    for (;;) {
      const at = day(a.getFullYear(), a.getMonth(), a.getDate() + k * n);
      if (at > from) return at;
      k++;
    }
  }
  if (t.every === "week") {
    // Weeks start on Monday (Sunday last); the anchor's week is week 0.
    const days = mondayFirst(t.weekdays?.length ? t.weekdays : [a.getDay()]);
    const monday = a.getDate() - ((a.getDay() + 6) % 7);
    let k = Math.max(0, Math.floor((from - day(a.getFullYear(), a.getMonth(), monday)) / (7 * DAY) / n) - 1);
    for (;;) {
      for (const wd of days) {
        const at = day(a.getFullYear(), a.getMonth(), monday + k * n * 7 + ((wd + 6) % 7));
        if (at > from) return at;
      }
      k++;
    }
  }
  const months = t.every === "year" ? 12 * n : n;
  const f = new Date(from);
  let k = Math.max(0, Math.floor(((f.getFullYear() - a.getFullYear()) * 12 + f.getMonth() - a.getMonth()) / months) - 1);
  for (;;) {
    const y = a.getFullYear();
    const mo = a.getMonth() + k * months;
    const last = new Date(y, mo + 1, 0).getDate();
    const at = day(y, mo, Math.min(a.getDate(), last));
    if (at > from) return at;
    k++;
  }
}

/** The last time it was due at or before `now` (after `after`), or null. */
function lastOccurrence(t: Extract<Trigger, { type: "recurring" }>, anchor: number, after: number, now: number): number | null {
  let found: number | null = null;
  let at = nextOccurrence(t, anchor, after);
  for (let i = 0; at <= now && i < 10_000; i++) {
    found = at;
    at = nextOccurrence(t, anchor, at);
  }
  return found;
}

/** "día"/"días"… as the unit after "Cada N". */
export const everyOptions = (n: number): [RecurringEvery, string][] => [
  ["day", n === 1 ? "día" : "días"],
  ["week", n === 1 ? "semana" : "semanas"],
  ["month", n === 1 ? "mes" : "meses"],
  ["year", n === 1 ? "año" : "años"],
];

/** Weekdays (0 Sunday … 6 Saturday) in the picker's order, L M X J V S D. */
export const mondayFirst = (days: number[]) => [...new Set(days)].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** "Todos los días a las 9:00", "Cada 2 semanas el lunes y jueves a las 8:30"… */
export function recurringLabel(t: Extract<Trigger, { type: "recurring" }>, anchor = Date.now()) {
  const n = Math.max(1, t.interval || 1);
  const [h, m] = timeOf(t.time);
  const hour = `${h}:${String(m).padStart(2, "0")}`;
  const unit = { day: ["día", "días"], week: ["semana", "semanas"], month: ["mes", "meses"], year: ["año", "años"] }[t.every];
  const every =
    n === 1
      ? { day: "Todos los días", week: "Todas las semanas", month: "Todos los meses", year: "Todos los años" }[t.every]
      : `Cada ${n} ${unit[1]}`;
  const days = t.every === "week" ? mondayFirst(t.weekdays?.length ? t.weekdays : [new Date(anchor).getDay()]) : [];
  const on = days.length ? ` el ${days.map((d) => WEEKDAYS[d]).join(", ").replace(/, ([^,]*)$/, " y $1")}` : "";
  return `${every}${on} a las ${hour}`;
}

// ------------------------------------------------------------------ engine

type RowEvent = { rowId: string; collectionId: string; added: boolean; before: Record<string, PropertyValue | undefined> };

/** Collections with at least one automation switched on, by id. */
let active = new Map<string, Collection>();
const pending = new Map<string, RowEvent>();
let timer: number | undefined;
let processing = false;
/** Runs report here (a toast when one is paused). */
let report: (message: string) => void = () => {};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function queue(row: Block, added: boolean, before: Record<string, PropertyValue | undefined>) {
  const prev = pending.get(row.id);
  // The first value before the burst of edits is what it changed from.
  pending.set(row.id, {
    rowId: row.id,
    collectionId: row.parent_id,
    added: added || !!prev?.added,
    before: { ...before, ...prev?.before },
  });
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void flush(), 600);
}

/** `id`: an edit to that page (an automation's own edits are skipped); none: a page being added. */
function watches(row: Pick<Block, "parent_table" | "parent_id" | "is_template">, id?: string) {
  return row.parent_table === "collection" && !row.is_template && active.has(row.parent_id) && !isAutomationWrite(id);
}

function onCreating(_key: unknown, obj: Block) {
  if (watches(obj) && obj.alive) queue(obj, true, {});
}

function onUpdating(mods: Record<string, unknown>, _key: unknown, obj: Block) {
  // A page moved into a database (Mover a): added to it.
  const parent = typeof mods.parent_id === "string" ? mods.parent_id : undefined;
  if (parent && parent !== obj.parent_id) {
    const moved = { ...obj, ...mods } as Block;
    if (watches(moved, obj.id) && moved.alive) queue(moved, true, {});
    return;
  }
  if (!watches(obj, obj.id) || !obj.alive) return;
  const before: Record<string, PropertyValue | undefined> = {};
  for (const [key, value] of Object.entries(mods)) {
    if (key === "properties" && value && typeof value === "object") {
      const next = value as Record<string, PropertyValue>;
      for (const id of new Set([...Object.keys(next), ...Object.keys(obj.properties)]))
        if (!same(next[id], obj.properties[id])) before[id] = obj.properties[id];
    } else if (key.startsWith("properties.")) {
      const id = key.slice("properties.".length);
      if (!same(value, obj.properties[id])) before[id] = obj.properties[id];
    }
  }
  if (Object.keys(before).length) queue(obj, false, before);
}

/** Whether the row is in the automation's view (its filters, formulas included). */
async function inScope(a: Automation, row: Block, collection: Collection) {
  if (!a.view_id) return true;
  const view = await db.views.get(a.view_id);
  if (!view) return true;
  const computedIds = queryComputedIds(view.query2, collection.schema);
  const values = new Map<string, Record<string, PropertyValue>>();
  if (computedIds.length) {
    const own: Record<string, PropertyValue> = {};
    for (const id of computedIds) own[id] = await evaluate(row, id, collection);
    values.set(row.id, own);
  }
  return applyQuery([row], collection.schema, { ...view.query2, sort: [] }, undefined, { values }).length > 0;
}

/** A rule on its own: does the row's value match it? */
const ruleMatches = (row: Block, collection: Collection, rule: TriggerRule) =>
  !rule.operator ||
  applyQuery([row], collection.schema, {
    filter_operator: "and",
    filters: [{ id: rule.id, property: rule.property, operator: rule.operator, value: rule.value }],
    sort: [],
  }).length > 0;

function editTriggers(t: Extract<Trigger, { type: "property_edited" }>, row: Block, collection: Collection, changed: string[]) {
  const rules = t.rules.filter((r) => collection.schema[r.property] && !isComputedType(collection.schema[r.property].type));
  // No rule: any edit to the page.
  if (!rules.length) return changed.length > 0;
  const hits = rules.map((r) => changed.includes(r.property) && ruleMatches(row, collection, r));
  if (t.match === "all") return hits.some(Boolean) && rules.every((r) => ruleMatches(row, collection, r));
  return hits.some(Boolean);
}

let flushing: Promise<void> | undefined;

/** Runs the automations for the pages queued; while it runs, the same run (which picks up any queued meanwhile). */
function flush(): Promise<void> {
  flushing ??= runQueued().finally(() => (flushing = undefined));
  return flushing;
}

async function runQueued() {
  if (processing) return;
  processing = true;
  try {
    while (pending.size) {
      const events = [...pending.values()];
      pending.clear();
      for (const ev of events) {
        const collection = await db.collections.get(ev.collectionId);
        const row = await db.blocks.get(ev.rowId);
        if (!collection || !row?.alive || row.is_template) continue;
        const changed = Object.keys(ev.before).filter((id) => !same(ev.before[id], row.properties[id]));
        for (const a of collection.automations ?? []) {
          if (!a.enabled || !a.actions.length) continue;
          const fires = a.triggers.some((t) =>
            t.type === "page_added" ? ev.added : t.type === "property_edited" && !ev.added && editTriggers(t, row, collection, changed),
          );
          if (fires && (await inScope(a, row, collection))) await runAutomation(collection.id, a, row.id);
        }
      }
    }
  } finally {
    processing = false;
  }
}

/** Runs one automation (on a page, or none for recurring ones); a failure pauses it with the error. */
export async function runAutomation(collectionId: string, a: Automation, pageId?: string) {
  const name = a.name.trim() || "Automatización sin título";
  try {
    await runActions(a.actions, { origin: "automation", pageId, source: name, automationId: a.id });
    await patchAutomation(collectionId, a.id, { last_run: Date.now(), error: undefined });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await patchAutomation(collectionId, a.id, { enabled: false, error, last_run: Date.now() });
    report(`Se pausó la automatización «${name}»: ${error}`);
  }
}

// Recurring automations: one tab at a time runs them; one that came due while Xot was closed runs once on launch.
// Xot.app also runs them with every window closed: each run tells it when the next one is due, and at
// that time it loads a hidden window that only runs the ones due (runInBackground) and closes again.
let recurTimer: number | undefined;

type DesktopAutomations = {
  /** When the next recurring automation is due (null: none); `done` from the hidden window, when it finished. */
  setNextAutomation?(at: number | null | undefined, done?: boolean): void;
  notify?(n: { title: string; body: string; pageId?: string }): void;
};
const desktop = () => (window as { xotDesktop?: DesktopAutomations }).xotDesktop;

function exclusive(run: () => Promise<void>) {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks ? locks.request("xot-automations", run).catch(run) : run();
}

async function runRecurring() {
  window.clearTimeout(recurTimer);
  const next = await runDue();
  desktop()?.setNextAutomation?.(Number.isFinite(next) ? next : null);
  if (Number.isFinite(next)) recurTimer = window.setTimeout(() => void runRecurring(), Math.min(Math.max(next - Date.now(), 0) + 50, 3600_000));
}

/** Runs the recurring automations that are due; resolves to when the next one is (Infinity: none). */
async function runDue(): Promise<number> {
  let next = Infinity;
  await exclusive(async () => {
    const now = Date.now();
    for (const c of await db.collections.toArray()) {
      for (const a of c.automations ?? []) {
        if (!a.enabled) continue;
        for (const t of a.triggers) {
          if (t.type !== "recurring") continue;
          const since = a.last_due ?? a.created_time;
          const due = lastOccurrence(t, a.created_time, since, now);
          if (due !== null) {
            // Marked first, so a slow run (or another tab) never runs it twice.
            await patchAutomation(c.id, a.id, { last_due: due });
            await runAutomation(c.id, { ...a, last_due: due });
          }
          next = Math.min(next, nextOccurrence(t, a.created_time, Math.max(now, due ?? 0)));
        }
      }
      next = Math.min(next, await runRepeats(c, now));
    }
  });
  return next;
}

/**
 * Templates set to "Repetir": a page from each one every time it's due. Those missed
 * while Xot was closed are made when it opens (the latest REPEAT_CATCH_UP), each dated
 * as when it was due. Resolves to the next one due (Infinity: none).
 */
async function runRepeats(c: Collection, now: number): Promise<number> {
  let next = Infinity;
  for (const r of c.template_repeats ?? []) {
    const template = await db.blocks.get(r.template_id);
    if (!template?.alive || !template.is_template) continue;
    const t = repeatTrigger(r);
    const due: number[] = [];
    for (let at = nextOccurrence(t, r.start, r.last_due ?? r.start); at <= now && due.length < 10_000; at = nextOccurrence(t, r.start, at))
      due.push(at);
    // Each one is marked before its page is made, so a slow run (or another tab) never makes it twice;
    // one that fails is unmarked (tried again on the next run) and the rest wait for it.
    let done = r.last_due;
    for (const at of due.slice(-REPEAT_CATCH_UP)) {
      await patchRepeat(c.id, r.template_id, { last_due: at });
      try {
        await addRowFromTemplate(c.id, r.template_id, {}, { at, title: (title) => repeatedTitle(title, at) });
        done = at;
      } catch (e) {
        await patchRepeat(c.id, r.template_id, { last_due: done });
        const title = String(template.properties.title ?? "").trim() || "Sin título";
        report(`No se pudo crear la página repetida «${title}»: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
    next = Math.min(next, nextOccurrence(t, r.start, Math.max(now, due[due.length - 1] ?? 0)));
  }
  return next;
}

async function patchRepeat(collectionId: string, templateId: string, patch: Partial<TemplateRepeat>) {
  await db.transaction("rw", db.collections, async () => {
    const c = await db.collections.get(collectionId);
    if (!c?.template_repeats) return;
    await db.collections.update(collectionId, {
      template_repeats: c.template_repeats.map((r) => (r.template_id === templateId ? { ...r, ...patch } : r)),
    });
  });
}

/**
 * Xot.app's hidden window (main.tsx, "?automations"): with every window closed, it runs the
 * recurring automations that are due, reports the next one and is closed by the app.
 */
export async function runInBackground() {
  const app = desktop();
  // No window to show a toast: a paused automation says so in a notification.
  report = (message) => app?.notify?.({ title: "Xot", body: message });
  // Undefined (the run failed): the app keeps its time and tries again a minute later.
  let next: number | undefined;
  // Pages made here (repeated templates) start "Página añadida" automations, as with a window open.
  db.blocks.hook("creating", onCreating as never);
  db.blocks.hook("updating", onUpdating as never);
  try {
    active = new Map((await db.collections.toArray()).filter((c) => c.automations?.some((a) => a.enabled)).map((c) => [c.id, c]));
    next = await runDue();
    // They run before the app closes the window.
    window.clearTimeout(timer);
    await flush();
  } finally {
    app?.setNextAutomation?.(next === undefined ? undefined : Number.isFinite(next) ? next : null, true);
  }
}

/** Starts the engine (App.tsx): page triggers through Dexie's hooks, recurring ones on timers. */
export function startAutomations(show: (message: string) => void): () => void {
  report = show;
  db.blocks.hook("creating", onCreating as never);
  db.blocks.hook("updating", onUpdating as never);
  let recurKey = "";
  const sub = liveQuery(() => db.collections.toArray()).subscribe((all) => {
    active = new Map(all.filter((c) => c.automations?.some((a) => a.enabled)).map((c) => [c.id, c]));
    // Rescheduled whenever a recurring automation changes (not on each run's bookkeeping).
    const key = JSON.stringify([
      all.flatMap((c) => (c.automations ?? []).filter((a) => a.enabled && a.triggers.some((t) => t.type === "recurring")).map((a) => [a.id, a.triggers])),
      // Repeated templates too (their schedule and start, not each run's last_due).
      all.flatMap((c) => (c.template_repeats ?? []).map((r) => [r.template_id, r.every, r.interval, r.time, r.weekdays, r.start])),
    ]);
    if (key !== recurKey) {
      recurKey = key;
      void runRecurring();
    }
  });
  const onVisible = () => document.visibilityState === "visible" && void runRecurring();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    sub.unsubscribe();
    db.blocks.hook("creating").unsubscribe(onCreating as never);
    db.blocks.hook("updating").unsubscribe(onUpdating as never);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearTimeout(recurTimer);
    window.clearTimeout(timer);
  };
}
