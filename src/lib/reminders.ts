import { useEffect, useState } from "react";
import Dexie from "dexie";
import { db } from "./db";
import { pageTitle } from "./hooks";
import { addToInbox } from "./inbox";
import type { Block, Collection } from "./model";

/**
 * Reminders: a date mention made with "Recordar" (or given one in
 * its picker) and a date property's "Recordatorio". Each is a code for how
 * long before the date it fires: "0" at the time (9:00 on a day without
 * time), "5m", "1h", "1d", "1w"… The app keeps them all scheduled, whatever
 * page is open (startReminders, from App.tsx).
 */

/** The picker's choices for a day without time (they fire at 9:00). */
const DAY_CHOICES: [string, string][] = [
  ["", "Ninguno"],
  ["0", "El día del evento (9:00)"],
  ["1d", "1 día antes (9:00)"],
  ["2d", "2 días antes (9:00)"],
  ["1w", "1 semana antes (9:00)"],
];
/** …and for a date with a time. */
const TIME_CHOICES: [string, string][] = [
  ["", "Ninguno"],
  ["0", "A la hora del evento"],
  ["5m", "5 minutos antes"],
  ["10m", "10 minutos antes"],
  ["15m", "15 minutos antes"],
  ["30m", "30 minutos antes"],
  ["1h", "1 hora antes"],
  ["2h", "2 horas antes"],
  ["1d", "1 día antes"],
  ["2d", "2 días antes"],
];

export const reminderChoices = (withTime: boolean) => (withTime ? TIME_CHOICES : DAY_CHOICES);

/** A code that doesn't fit the date (minutes before a day) falls back to the event's own time. */
export function reminderCode(code: string, withTime: boolean) {
  if (!code) return "";
  return reminderChoices(withTime).some(([c]) => c === code) ? code : "0";
}

export function reminderLabel(code: string, withTime: boolean) {
  const c = reminderCode(code, withTime);
  return reminderChoices(withTime).find(([id]) => id === c)?.[1] ?? "Ninguno";
}

/** When a reminder for the date `value` (its start, for a range) fires, or null. */
export function reminderTime(value: string, code: string): number | null {
  const [day, time] = value.split("/")[0].split("T");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) return null;
  const withTime = !!time && /^\d{2}:\d{2}/.test(time);
  const [, n = "0", unit = ""] = /^(\d+)([mhdw]?)$/.exec(reminderCode(code || "0", withTime)) ?? [];
  const d = new Date(`${day}T${withTime ? time.slice(0, 5) : "09:00"}`);
  if (Number.isNaN(d.getTime())) return null;
  const amount = Number(n);
  if (unit === "m") d.setMinutes(d.getMinutes() - amount);
  else if (unit === "h") d.setHours(d.getHours() - amount);
  else if (unit === "d") d.setDate(d.getDate() - amount);
  else if (unit === "w") d.setDate(d.getDate() - amount * 7);
  return d.getTime();
}

/**
 * True once a reminder's time has passed: it shows in red then. It flips on time while the
 * page is open. `code` is the reminder ("" or null: none).
 */
export function useOverdue(value: string | null | undefined, code: string | null | undefined) {
  const at = value && code ? reminderTime(value, code) : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const left = at - Date.now();
    if (left <= 0) return void setNow(Date.now());
    const t = window.setTimeout(() => setNow(Date.now()), Math.min(left + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(t);
  }, [at]);
  return at !== null && at <= now;
}

const longDay = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" });
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "Hoy, 9:00", "Mañana" or "16 de octubre de 2026, 14:30": the date the reminder is about. */
export function reminderWhen(value: string) {
  const [day, time] = value.split("/")[0].split("T");
  const d = new Date(`${day}T00:00`);
  if (Number.isNaN(d.getTime())) return value;
  const today = new Date();
  const offset = (n: number) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
  const name = { [offset(0)]: "Hoy", [offset(1)]: "Mañana", [offset(-1)]: "Ayer" }[day] ?? longDay.format(d);
  return time ? `${name}, ${time.slice(0, 5).replace(/^0(\d)/, "$1")}` : name;
}

/** A reminder due at `at`: the notification's text and the page it opens. */
export interface Reminder {
  /** Stable while the reminder doesn't change; it includes the time, so moving it arms it again. */
  id: string;
  at: number;
  pageId: string;
  title: string;
  body: string;
}

type Mention = { date: string; code: string; text: string };

/** The plain text of a block's inline content (mentions left out). */
function inlineText(content: unknown[]): string {
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const o = item as { type?: string; text?: unknown; content?: unknown };
      if (o.type === "text" && typeof o.text === "string") return o.text;
      if (o.type === "link" && Array.isArray(o.content)) return inlineText(o.content);
      return "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Date mentions with a reminder anywhere in a page's body, with the text of the block that holds each. */
function reminderMentions(content: unknown): Mention[] {
  const found: Mention[] = [];
  const visit = (node: unknown, text: string) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, text));
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (o.type === "mention") {
      const p = o.props as { date?: unknown; reminder?: unknown; remind?: unknown } | undefined;
      if (p?.reminder && typeof p.date === "string" && p.date)
        found.push({ date: p.date, code: typeof p.remind === "string" && p.remind ? p.remind : "0", text });
      return;
    }
    // A block (it has an id and inline content): its mentions read with its text.
    const own = typeof o.id === "string" && Array.isArray(o.content) ? inlineText(o.content) : text;
    for (const value of Object.values(o)) if (value && typeof value === "object") visit(value, own);
  };
  visit(content, "");
  return found;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Every reminder in the workspace: date mentions in live pages and date properties of live rows. */
export async function collectReminders(): Promise<Reminder[]> {
  const collections = new Map<string, Collection>((await db.collections.toArray()).map((c) => [c.id, c]));
  const out: Reminder[] = [];
  const seen = new Map<string, number>();
  const add = (base: string, r: Omit<Reminder, "id">) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ id: n ? `${base}#${n}` : base, ...r });
  };
  await db.blocks.each((b: Block) => {
    if (!b.alive || b.is_template) return;
    const title = pageTitle(b);
    if (Array.isArray(b.content) && b.content.length) {
      for (const m of reminderMentions(b.content)) {
        const at = reminderTime(m.date, m.code);
        if (at === null) continue;
        add(`m:${b.id}:${m.date}:${m.code}`, {
          at,
          pageId: b.id,
          title,
          body: clip(m.text ? `${m.text}\n${reminderWhen(m.date)}` : `Recordatorio: ${reminderWhen(m.date)}`, 240),
        });
      }
    }
    if (b.reminders && b.parent_table === "collection") {
      const schema = collections.get(b.parent_id)?.schema ?? {};
      for (const [propertyId, code] of Object.entries(b.reminders)) {
        const value = b.properties[propertyId];
        if (!code || schema[propertyId]?.type !== "date" || typeof value !== "string" || !value) continue;
        const at = reminderTime(value, code);
        if (at === null) continue;
        add(`p:${b.id}:${propertyId}:${value}:${code}`, {
          at,
          pageId: b.id,
          title,
          body: clip(`${schema[propertyId].name}: ${reminderWhen(value)}`, 240),
        });
      }
    }
  });
  return out;
}

// ------------------------------------------------------------- scheduling

/** A reminder that was due while Xot was closed still fires on launch, within this long. */
export const MISSED_WINDOW = 24 * 3600 * 1000;
/** Timers sleep at most this long, so a clock change or a long sleep never leaves one far off. */
const MAX_WAIT = 3600 * 1000;

type DesktopReminders = {
  setReminders?(list: Reminder[]): void;
  onReminder?(cb: (r: Reminder) => void): void;
  /** The reminders the app has fired (lately), also with no window open: the inbox picks up the ones it missed. */
  firedReminders?(): Promise<Reminder[]>;
};
const desktop = () => (window as { xotDesktop?: DesktopReminders }).xotDesktop;

/** The browser asks once, when a reminder is set (Xot.app's notifications need no permission here). */
export function askNotificationPermission() {
  if (desktop()?.setReminders || typeof Notification === "undefined") return;
  if (Notification.permission === "default") void Notification.requestPermission().catch(() => {});
}

/** Shows a reminder in the app: a toast, with "Abrir" to go to the page. */
export function reminderToast(r: Pick<Reminder, "title" | "pageId">, show: (message: string, action: { label: string; run: () => void }) => void) {
  show(`Recordatorio: ${r.title}`, { label: "Abrir", run: () => (window.location.hash = `/${r.pageId}`) });
}

let desktopListener = false;

const STATE_KEY = "xot:reminders";
/** In a browser: ids scheduled before their time ("known") and ids already shown ("fired"), with their times. */
type State = { known: Record<string, number>; fired: Record<string, number> };

function readState(): State {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null") as State | null;
    return { known: s?.known ?? {}, fired: s?.fired ?? {} };
  } catch {
    return { known: {}, fired: {} };
  }
}

function writeState(s: State) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** One tab at a time decides what fires (the Web Locks API), so two tabs never show one reminder twice. */
function exclusive(run: () => void) {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks) void locks.request("xot-reminders", async () => run()).catch(run);
  else run();
}

/**
 * Keeps every reminder scheduled from launch: scans Dexie now and after each
 * change. Xot.app's main process does the scheduling (it notifies with no
 * window open); a browser tab fires them itself with the Notification API.
 */
export function startReminders(show: (message: string, action: { label: string; run: () => void }) => void): () => void {
  let list: Reminder[] = [];
  let timer: number | undefined;
  let scanTimer: number | undefined;
  let stopped = false;
  const app = desktop();

  const notify = (r: Reminder) => {
    reminderToast(r, show);
    void addToInbox([r]);
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const n = new Notification(r.title, { body: r.body, tag: r.id });
      n.onclick = () => {
        window.focus();
        window.location.hash = `/${r.pageId}`;
        n.close();
      };
    } catch {
      /* the toast is enough */
    }
  };

  // Browser only: fire what is due, remember what is coming, wait for the next one.
  const run = () => {
    window.clearTimeout(timer);
    if (stopped) return;
    exclusive(() => {
      const now = Date.now();
      const state = readState();
      const known: Record<string, number> = {};
      const fired: Record<string, number> = {};
      for (const [id, at] of Object.entries(state.fired)) if (at > now - 2 * MISSED_WINDOW) fired[id] = at;
      for (const r of list) {
        if (fired[r.id]) continue;
        if (r.at > now) known[r.id] = r.at;
        // Due: it fires if it was scheduled before its time (now, or while Xot was closed);
        // one set for a time already gone never does.
        else if (state.known[r.id] && r.at > now - MISSED_WINDOW) {
          fired[r.id] = r.at;
          notify(r);
        }
      }
      writeState({ known, fired });
    });
    const next = Math.min(...list.map((r) => r.at).filter((at) => at > Date.now()));
    if (Number.isFinite(next)) timer = window.setTimeout(run, Math.min(Math.max(next - Date.now(), 0) + 50, MAX_WAIT));
  };

  const scan = async () => {
    const found = await collectReminders().catch(() => null);
    if (stopped || !found) return;
    list = found;
    if (app?.setReminders) {
      app.setReminders(found.filter((r) => r.at > Date.now() - MISSED_WINDOW));
      // What fired before this window was there to hear it (at launch, with every window closed).
      if (!caughtUp && app.firedReminders) {
        caughtUp = true;
        void app
          .firedReminders()
          .then((fired) => (Array.isArray(fired) ? addToInbox(fired) : undefined))
          .catch(() => {});
      }
    } else run();
  };
  let caughtUp = false;
  const rescan = () => {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => void scan(), 800);
  };

  // Any write to the pages (an edit, an import, another tab) rescans, once the edits pause.
  const onChange = (parts: Record<string, unknown>) => {
    if (Object.keys(parts).some((k) => k.includes("/blocks/") || k.includes("/collections/"))) rescan();
  };
  Dexie.on.storagemutated.subscribe(onChange);
  // After the computer sleeps, timers run late: a tab shown again checks at once.
  const onVisible = () => !app?.setReminders && document.visibilityState === "visible" && run();
  document.addEventListener("visibilitychange", onVisible);
  // Xot.app's notifications also show in the window (registered once: the bridge can't remove it).
  if (app?.onReminder && !desktopListener) {
    desktopListener = true;
    app.onReminder((r) => {
      reminderToast(r, show);
      void addToInbox([r]);
    });
  }
  void scan();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearTimeout(scanTimer);
    Dexie.on.storagemutated.unsubscribe(onChange);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
