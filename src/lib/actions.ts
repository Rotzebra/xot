import { db } from "./db";
import { pageForFormula, runFormula } from "./compute";
import { compile, display, isDate, isPage, pagePropNames, parseStoredDate, storedDate, truthy, type FValue } from "./formula";
import { addToInbox } from "./inbox";
import { pageTitle } from "./hooks";
import { addOption, addRow, addRowFromTemplate, setRelation, setRowValue, updateBlock } from "./ops";
import { applyQuery } from "./query";
import {
  LOCAL_PERSON,
  type Block,
  type Collection,
  type FileRef,
  type Filter,
  type PageRef,
  type PropertySchema,
  type PropertyValue,
} from "./model";

// Actions, shared by the button block, the "Botón" property and database
// automations (lib/automations.ts): add a page, edit this page or pages in a
// database, notify, send a webhook, define variables… Values can be literal,
// relative ("@today"), or formulas run when the action does.

/** multi_select, relation, person and file values: added to or removed from what the page has ("set" replaces). */
export type ValueOp = "set" | "add" | "remove";

/** The values an action writes: literals by property id, formulas that replace them, and how lists combine. */
export interface ValueEdits {
  /** Literal values; "@today", "@now", "@me", "@trigger"… resolve when the action runs (see resolveValue). */
  set?: Record<string, PropertyValue>;
  /** Formula sources by property id, computed when the action runs. */
  formulas?: Record<string, string>;
  ops?: Record<string, ValueOp>;
}

/** One step of a button or an automation, run in order. */
export type Action =
  | ({
      type: "create_page";
      collectionId: string;
      title?: string;
      /** Literal values (older buttons); `set` takes over when both are there. */
      values?: Record<string, PropertyValue>;
      /** false: an empty page instead of the database's default template. */
      template?: boolean;
    } & ValueEdits)
  /** "Editar propiedad": the page that triggered it (the automation's page, the button's row). */
  | ({ type: "edit_this" } & ValueEdits)
  /** "Editar páginas en": the pages of a database that match `filters` (all when empty), up to `limit`. */
  | ({
      type: "edit_pages";
      collectionId: string;
      filters?: Filter[];
      filter_operator?: "and" | "or";
      limit?: number;
    } & ValueEdits)
  | { type: "notify"; message: string }
  | { type: "webhook"; url: string }
  /** "Definir variables": named formulas the later steps use by name. */
  | { type: "variables"; vars: { name: string; source: string }[] }
  | { type: "open_created"; from: number }
  | { type: "open_page"; pageId: string }
  /**
   * Blocks added next to the button, or at the start or end of its page: `blocks` (the
   * editor's, written in the action's own editor); older buttons only have `markdown`.
   */
  | { type: "insert_blocks"; markdown: string; blocks?: unknown[]; position: "above" | "below" | "start" | "end" }
  | { type: "open_url"; url: string }
  | { type: "confirm"; text: [string, boolean][]; cancel: string; continue: string }
  | { type: "unsupported"; name: string };

export type ActionType = Action["type"];

/** Steps that only make sense with someone at the window (buttons). */
export const WINDOW_ACTIONS: ActionType[] = ["open_created", "open_page", "insert_blocks", "open_url", "confirm"];

export const ACTION_LABELS: Record<ActionType, string> = {
  edit_this: "Editar propiedad",
  create_page: "Agregar página a…",
  edit_pages: "Editar páginas en…",
  notify: "Enviar notificación a…",
  webhook: "Enviar webhook",
  variables: "Definir variables",
  insert_blocks: "Insertar bloques",
  open_created: "Abrir la página creada",
  open_page: "Abrir página",
  open_url: "Abrir enlace",
  confirm: "Mostrar confirmación",
  unsupported: "Acción no disponible",
};

/** How an action run is happening: who started it and, for buttons, the window's part. */
export interface ActionContext {
  origin: "button" | "automation";
  /** The page that triggered it: the automation's page, the button property's row or the page holding the button. */
  pageId?: string;
  /** Its name in notifications and webhooks ("Marcar como hecho"). */
  source: string;
  /** Automations: their id, for the webhook's payload. */
  automationId?: string;
  confirm?: (action: Extract<Action, { type: "confirm" }>) => Promise<boolean>;
  /** "Insertar bloques": editor blocks (without ids), or Markdown from older buttons. */
  insert?: (content: unknown[] | string, position: "above" | "below" | "start" | "end") => void;
  open?: (id: string) => void;
}

export interface ActionResult {
  /** Pages added by each step (by index). */
  created: (string | undefined)[];
  /** Pages edited. */
  edited: number;
  /** A confirmation was declined: the steps after it didn't run. */
  cancelled?: boolean;
}

// ------------------------------------------------------------ write guard

/** Pages adding while an automation adds one, and the pages it's editing (by id, with a count). */
let automationCreates = 0;
const automationEdits = new Map<string, number>();

/**
 * An automation's own write, which never starts other automations (no chains): with `id`, an
 * edit to that page while an automation edits it; without, a page added while one adds a page.
 * The user's edits to other pages meanwhile still count.
 */
export const isAutomationWrite = (id?: string) => (id === undefined ? automationCreates > 0 : automationEdits.has(id));

/** `ids`: the pages the write edits (the row, and the ones its relations link on the other side); `adds`: it adds a page. */
async function guarded<T>(ctx: ActionContext, ids: string[], run: () => Promise<T>, adds = false): Promise<T> {
  if (ctx.origin !== "automation") return run();
  if (adds) automationCreates++;
  for (const id of ids) automationEdits.set(id, (automationEdits.get(id) ?? 0) + 1);
  try {
    return await run();
  } finally {
    if (adds) automationCreates--;
    for (const id of ids) {
      const n = (automationEdits.get(id) ?? 1) - 1;
      if (n > 0) automationEdits.set(id, n);
      else automationEdits.delete(id);
    }
  }
}

/** The pages a write of `values` touches: the row, and every page its relations link or unlink. */
function touched(collection: Collection, values: Record<string, PropertyValue>, row?: Block): string[] {
  const ids = new Set<string>(row ? [row.id] : []);
  for (const [id, value] of Object.entries(values)) {
    if (collection.schema[id]?.type !== "relation") continue;
    for (const ref of [...((value as PageRef[] | undefined) ?? []), ...((row?.properties[id] as PageRef[] | undefined) ?? [])])
      if (ref?.id) ids.add(ref.id);
  }
  return [...ids];
}

// ------------------------------------------------------------------ values

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Relative dates a value can hold: the day (or moment) the action runs. */
export const RELATIVE_DATE_VALUES: [string, string][] = [
  ["@now", "Ahora"],
  ["@today", "Hoy"],
  ["@tomorrow", "Mañana"],
  ["@yesterday", "Ayer"],
  ["@next_week", "Dentro de una semana"],
  ["@next_month", "Dentro de un mes"],
];

/** "@today"… as a stored date, or null for anything else. */
export function relativeDate(value: PropertyValue | undefined, at = new Date()): string | null {
  const d = new Date(at);
  switch (value) {
    case "@now":
      return `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    case "@today":
      return isoDay(d);
    case "@tomorrow":
      d.setDate(d.getDate() + 1);
      return isoDay(d);
    case "@yesterday":
      d.setDate(d.getDate() - 1);
      return isoDay(d);
    case "@next_week":
      d.setDate(d.getDate() + 7);
      return isoDay(d);
    case "@next_month":
      d.setMonth(d.getMonth() + 1);
      return isoDay(d);
  }
  return null;
}

/** The page that triggered the action, as a relation value holds it. */
export const TRIGGER_REF: PageRef = { id: "@trigger", name: "Página activadora" };

/** A literal value as it's written: relative dates, "@me" and the trigger page resolved. */
export async function resolveValue(value: PropertyValue, ctx: Pick<ActionContext, "pageId">): Promise<PropertyValue> {
  const date = relativeDate(value);
  if (date) return date;
  if (Array.isArray(value)) {
    if (value.some((v) => v === "@me")) return value.map((v) => (v === "@me" ? LOCAL_PERSON : v)) as string[];
    if (value.some((v) => typeof v === "object" && v && "id" in v && v.id === TRIGGER_REF.id)) {
      const page = ctx.pageId ? await db.blocks.get(ctx.pageId) : undefined;
      return (value as PageRef[]).flatMap((r) => (r.id !== TRIGGER_REF.id ? [r] : page ? [{ id: page.id, name: pageTitle(page) }] : []));
    }
  }
  return value;
}

/** A "Botón" property's steps; older ones only set values on the row and maybe open it. */
export function buttonPropertyActions(button: PropertySchema["button"]): Action[] {
  if (button?.actions) return button.actions;
  const out: Action[] = [];
  if (button?.set && Object.keys(button.set).length) out.push({ type: "edit_this", set: button.set });
  if (button?.open_page) out.push({ type: "open_page", pageId: TRIGGER_REF.id });
  return out;
}

/** A formula's result written into a property of `schema`'s type (new select options are added). */
async function fromFormula(v: FValue, schema: PropertySchema, collectionId: string, propertyId: string): Promise<PropertyValue> {
  const list = (x: FValue): FValue[] => (Array.isArray(x) ? x : x === null || x === "" ? [] : [x]);
  switch (schema.type) {
    case "number": {
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      const n = Number(display(v));
      return display(v).trim() !== "" && Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return truthy(v);
    case "date":
      if (isDate(v)) return storedDate(v);
      if (typeof v === "string" && parseStoredDate(v)) return v;
      return v === null ? null : display(v) || null;
    case "select":
    case "status": {
      const name = display(Array.isArray(v) ? (v[0] ?? null) : v).trim();
      return name ? await optionId(schema, collectionId, propertyId, name, schema.type === "select") : null;
    }
    case "multi_select": {
      const ids: string[] = [];
      for (const item of list(v)) {
        const id = await optionId(schema, collectionId, propertyId, display(item).trim(), true);
        if (id) ids.push(id);
      }
      return ids;
    }
    case "relation":
      return list(v).flatMap((p) => (isPage(p) ? [{ id: p.id, name: p.name }] : []));
    case "person":
      return list(v).map((p) => display(p)).filter(Boolean);
    case "file":
      return list(v)
        .map((p) => display(p))
        .filter(Boolean)
        .map((url): FileRef => ({ name: url.split("/").pop() || url, url }));
    default:
      return display(v);
  }
}

/** An option's id by its name; select and multi-select add the option when it's new. */
async function optionId(schema: PropertySchema, collectionId: string, propertyId: string, name: string, create: boolean) {
  if (!name) return null;
  const found = schema.options?.find((o) => o.value.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  if (!create) return null;
  const added = await addOption(collectionId, propertyId, name);
  if (added) schema.options = [...(schema.options ?? []), added];
  return added?.id ?? null;
}

/** "Agregar"/"Quitar" on lists: the page's values with these added or removed. */
function combine(current: PropertyValue | undefined, value: PropertyValue, op: ValueOp): PropertyValue {
  if (op === "set" || !Array.isArray(value)) return value;
  const key = (x: unknown) => (typeof x === "object" && x ? ((x as { id?: string; url?: string }).id ?? (x as FileRef).url) : String(x));
  const now = Array.isArray(current) ? (current as unknown[]) : [];
  const keys = new Set((value as unknown[]).map(key));
  if (op === "remove") return now.filter((x) => !keys.has(key(x))) as PropertyValue;
  const have = new Set(now.map(key));
  return [...now, ...(value as unknown[]).filter((x) => !have.has(key(x)))] as PropertyValue;
}

// ---------------------------------------------------------------- formulas

const EMPTY_COLLECTION: Collection = { id: "", parent_id: "", schema: {} };

/** Runs a formula for an action: prop() reads `row` (the page being written), names read the variables. */
async function evalFormula(source: string, row: Block | undefined, vars: Map<string, FValue>, ctx: ActionContext): Promise<FValue> {
  const tree = compile(source);
  // The trigger page's properties are loaded for página.prop("…").
  const names = pagePropNames(tree);
  const scope = new Map(vars);
  if (ctx.pageId && names.size) scope.set("página", await pageForFormula(ctx.pageId, names));
  const collection = row?.parent_table === "collection" ? await db.collections.get(row.parent_id) : undefined;
  const target: Block =
    row ??
    ({ id: "", type: "page", parent_id: "", parent_table: "block", properties: {}, format: {}, content: null, alive: true, order: 0, created_time: 0, last_edited_time: 0 } as Block);
  return runFormula(target, source, collection ?? EMPTY_COLLECTION, 0, scope);
}

/** "{{ formula }}" parts of a message, filled in. */
async function fillText(text: string, vars: Map<string, FValue>, ctx: ActionContext, row?: Block): Promise<string> {
  const parts = text.split(/\{\{([\s\S]*?)\}\}/);
  let out = "";
  for (const [i, part] of parts.entries()) out += i % 2 ? display(await evalFormula(part, row, vars, ctx)) : part;
  return out;
}

/** Inserted blocks as new ones (no ids), with the {{ formulas }} in their text run. */
async function fillBlocks(blocks: unknown[], vars: Map<string, FValue>, ctx: ActionContext, row?: Block): Promise<unknown[]> {
  const visit = async (node: unknown): Promise<unknown> => {
    if (Array.isArray(node)) return Promise.all(node.map(visit));
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "id") continue;
      out[key] = key === "text" && typeof value === "string" && value.includes("{{") ? await fillText(value, vars, ctx, row) : await visit(value);
    }
    return out;
  };
  return (await visit(blocks)) as unknown[];
}

/** The variables every formula in an action can use. */
async function baseVariables(ctx: ActionContext): Promise<Map<string, FValue>> {
  const vars = new Map<string, FValue>();
  vars.set("página", ctx.pageId ? await pageForFormula(ctx.pageId) : null);
  vars.set("usuario", LOCAL_PERSON);
  vars.set("ahora", { kind: "date", start: Date.now(), time: true });
  return vars;
}

/** The values to write on `row` (or a new page of `collection`): literals resolved, formulas run, lists combined. */
async function valuesFor(
  edits: ValueEdits,
  collection: Collection,
  row: Block | undefined,
  context: Block | undefined,
  vars: Map<string, FValue>,
  ctx: ActionContext,
): Promise<Record<string, PropertyValue>> {
  const out: Record<string, PropertyValue> = {};
  const ids = new Set([...Object.keys(edits.set ?? {}), ...Object.keys(edits.formulas ?? {})]);
  for (const id of ids) {
    const schema = collection.schema[id];
    if (!schema) continue;
    const source = edits.formulas?.[id];
    let value: PropertyValue;
    if (source?.trim()) value = await fromFormula(await evalFormula(source, context, vars, ctx), schema, collection.id, id);
    else value = await resolveValue(edits.set?.[id] ?? null, ctx);
    out[id] = combine(row?.properties[id], value, edits.ops?.[id] ?? "set");
  }
  return out;
}

/** Writes values on a row (relations through setRelation, so two-way ones stay in sync). */
async function writeValues(rowId: string, collection: Collection, values: Record<string, PropertyValue>, ctx: ActionContext) {
  const plain: Record<string, PropertyValue> = {};
  for (const [id, value] of Object.entries(values)) {
    if (collection.schema[id]?.type === "relation") await setRelation(rowId, id, (value as PageRef[]) ?? [], ctx.origin === "button");
    else if (ctx.origin === "button") await setRowValue(rowId, id, value);
    else plain[id] = value;
  }
  if (!Object.keys(plain).length) return;
  const row = await db.blocks.get(rowId);
  if (row) await updateBlock(rowId, { properties: { ...row.properties, ...plain } });
}

const editsOf = (a: ValueEdits & { values?: Record<string, PropertyValue> }): ValueEdits => ({
  set: { ...a.values, ...a.set },
  formulas: a.formulas,
  ops: a.ops,
});

// ------------------------------------------------------------------ webhook

/** A page as a webhook sends it (simplified): its values by property name. */
async function pagePayload(id: string) {
  const page = await db.blocks.get(id);
  if (!page) return null;
  const collection = page.parent_table === "collection" ? await db.collections.get(page.parent_id) : undefined;
  const properties: Record<string, { id: string; type: string; value: PropertyValue }> = {};
  for (const [pid, schema] of Object.entries(collection?.schema ?? { title: { name: "title", type: "title" } as PropertySchema })) {
    let value = page.properties[pid] ?? null;
    if ((schema.type === "select" || schema.type === "status") && typeof value === "string")
      value = schema.options?.find((o) => o.id === value)?.value ?? value;
    if (schema.type === "multi_select" && Array.isArray(value))
      value = (value as string[]).map((v) => schema.options?.find((o) => o.id === v)?.value ?? v);
    properties[schema.name] = { id: pid, type: schema.type, value };
  }
  return {
    object: "page",
    id: page.id,
    created_time: new Date(page.created_time).toISOString(),
    last_edited_time: new Date(page.last_edited_time).toISOString(),
    parent: page.parent_table === "collection" ? { type: "database_id", database_id: collection?.parent_id ?? page.parent_id } : { type: "page_id", page_id: page.parent_id },
    properties,
    url: `xot://page/${page.id}`,
  };
}

/** HTTP POST with the page as JSON. A server without CORS still gets it (sent as text/plain, the answer unread). */
export async function sendWebhook(url: string, body: unknown) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`El webhook necesita una URL http(s): «${url}»`);
  const json = JSON.stringify(body);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
    if (!res.ok) throw new Error(`El webhook respondió ${res.status}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("El webhook")) throw e;
    // CORS (or a preflight the server doesn't answer): send it as a simple request.
    try {
      await fetch(url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: json });
    } catch {
      throw new Error(`No se pudo enviar el webhook a ${url}`);
    }
  }
}

// --------------------------------------------------------------------- run

/** Desktop notification: Xot.app shows it itself (also from its hidden automations window); a browser tab uses the Notification API. */
function desktopNotification(title: string, body: string, pageId?: string) {
  const app = (window as { xotDesktop?: { notify?(n: { title: string; body: string; pageId?: string }): void } }).xotDesktop;
  if (app?.notify) return app.notify({ title, body, pageId });
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      if (pageId) window.location.hash = `/${pageId}`;
      n.close();
    };
  } catch {
    /* the inbox has it */
  }
}

/** The pages of a database an "Editar páginas en" step changes. */
async function pagesToEdit(a: Extract<Action, { type: "edit_pages" }>, collection: Collection, ctx: ActionContext): Promise<Block[]> {
  const rows = (await db.blocks.where("[parent_table+parent_id]").equals(["collection", a.collectionId]).toArray()).filter(
    (r) => r.alive && !r.is_template,
  );
  // "Página activadora" in a relation rule: the page that triggered it.
  const filters = await Promise.all(
    (a.filters ?? []).map(async (f) => (Array.isArray(f.value) ? { ...f, value: await resolveValue(f.value, ctx) } : f)),
  );
  const matched = applyQuery(rows, collection.schema, { filter_operator: a.filter_operator ?? "and", filters, sort: [] });
  return a.limit && a.limit > 0 ? matched.slice(0, a.limit) : matched;
}

/** Runs the steps in order; throws (with a message for the user) when one fails. */
export async function runActions(actions: Action[], ctx: ActionContext): Promise<ActionResult> {
  const result: ActionResult = { created: [], edited: 0 };
  const vars = await baseVariables(ctx);
  for (const [i, action] of actions.entries()) {
    const trigger = ctx.pageId ? await db.blocks.get(ctx.pageId) : undefined;
    switch (action.type) {
      case "confirm": {
        if (!ctx.confirm) break;
        if (!(await ctx.confirm(action))) return { ...result, cancelled: true };
        break;
      }
      case "variables":
        for (const v of action.vars) if (v.name.trim()) vars.set(variableName(v.name), await evalFormula(v.source || "\"\"", trigger, vars, ctx));
        break;
      case "create_page": {
        const collection = await db.collections.get(action.collectionId);
        if (!collection) throw new Error("La base de datos de «Agregar página a» ya no existe");
        const values = await valuesFor(editsOf(action), collection, undefined, trigger, vars, ctx);
        if (action.title && !("title" in values)) values.title = await fillText(action.title, vars, ctx, trigger);
        const template = action.template !== false && collection.default_template;
        result.created[i] = await guarded(ctx, touched(collection, values), () =>
          template ? addRowFromTemplate(action.collectionId, template, values) : addRow(action.collectionId, values),
          true,
        );
        break;
      }
      case "edit_this": {
        if (!trigger || trigger.parent_table !== "collection") throw new Error("«Editar propiedad» necesita una página de la base de datos");
        const collection = await db.collections.get(trigger.parent_id);
        if (!collection) break;
        const values = await valuesFor(editsOf(action), collection, trigger, trigger, vars, ctx);
        await guarded(ctx, touched(collection, values, trigger), () => writeValues(trigger.id, collection, values, ctx));
        result.edited++;
        break;
      }
      case "edit_pages": {
        const collection = await db.collections.get(action.collectionId);
        if (!collection) throw new Error("La base de datos de «Editar páginas en» ya no existe");
        const rows = await pagesToEdit(action, collection, ctx);
        for (const row of rows) {
          const values = await valuesFor(editsOf(action), collection, row, row, vars, ctx);
          if (Object.keys(values).length) await guarded(ctx, touched(collection, values, row), () => writeValues(row.id, collection, values, ctx));
        }
        result.edited += rows.length;
        break;
      }
      case "notify": {
        const message = (await fillText(action.message, vars, ctx, trigger)).trim() || "Notificación";
        const pageId = ctx.pageId ?? "";
        const title = trigger ? pageTitle(trigger) : ctx.source;
        await addToInbox([{ id: `auto:${crypto.randomUUID()}`, pageId, title, body: message, at: Date.now(), kind: "automation", source: ctx.source }]);
        desktopNotification(ctx.source, message, pageId || undefined);
        break;
      }
      case "webhook": {
        const data = ctx.pageId ? await pagePayload(ctx.pageId) : null;
        await sendWebhook(action.url.trim(), {
          source: { type: ctx.origin, name: ctx.source, automation_id: ctx.automationId ?? null },
          data,
        });
        break;
      }
      case "insert_blocks":
        if (action.blocks?.length) ctx.insert?.(await fillBlocks(action.blocks, vars, ctx, trigger), action.position);
        else if (action.markdown.trim()) ctx.insert?.(await fillText(action.markdown, vars, ctx, trigger), action.position);
        break;
      case "open_created": {
        const id = result.created[action.from];
        if (id) ctx.open?.(id);
        break;
      }
      case "open_page": {
        const id = action.pageId === TRIGGER_REF.id ? ctx.pageId : action.pageId;
        if (id) ctx.open?.(id);
        break;
      }
      case "open_url":
        if (action.url) window.open(action.url, "_blank", "noopener");
        break;
    }
  }
  return result;
}

/** A variable's name as formulas read it: spaces become "_". */
export const variableName = (name: string) => name.trim().replace(/\s+/g, "_");

/** "@hoy", "@ahora", "@mañana", "@ayer" and "@página" in inserted blocks: the matching mention, made when the button is clicked. */
const MENTION_WORDS: Record<string, string> = { hoy: "@today", ahora: "@now", mañana: "@tomorrow", ayer: "@yesterday" };

export function withMentions<T>(blocks: T[], pageId?: string): T[] {
  const inline = (items: unknown[]): unknown[] =>
    items.flatMap((item) => {
      const o = item as { type?: string; text?: string; styles?: unknown };
      if (o?.type !== "text" || typeof o.text !== "string" || !o.text.includes("@")) return [item];
      const out: unknown[] = [];
      for (const part of o.text.split(/(@(?:hoy|ahora|mañana|ayer|página)(?![\p{L}\p{N}_]))/iu)) {
        if (!part) continue;
        const word = part.startsWith("@") ? part.slice(1).toLowerCase() : "";
        const date = MENTION_WORDS[word] ? relativeDate(MENTION_WORDS[word]) : null;
        const props = { pageId: "", date: "", title: "", reminder: false, remind: "" };
        if (date) out.push({ type: "mention", props: { ...props, date } });
        else if (word === "página" && pageId) out.push({ type: "mention", props: { ...props, pageId } });
        else out.push({ ...o, text: part });
      }
      return out;
    });
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const o = { ...(node as Record<string, unknown>) };
    if (Array.isArray(o.content)) o.content = inline(o.content).map(visit);
    if (Array.isArray(o.children)) o.children = o.children.map(visit);
    return o;
  };
  return blocks.map((b) => visit(b) as T);
}
