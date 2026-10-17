import { lazy, Suspense, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Bell,
  Braces,
  Check,
  ExternalLink,
  FilePlus2,
  FileText,
  Link2,
  ListPlus,
  MessageSquareWarning,
  PencilLine,
  Plus,
  Rows3,
  Send,
  X,
} from "lucide-react";
import { db } from "../lib/db";
import { compile } from "../lib/formula";
import { pageTitle } from "../lib/hooks";
import { askNotificationPermission } from "../lib/reminders";
import {
  ACTION_LABELS,
  RELATIVE_DATE_VALUES,
  TRIGGER_REF,
  type Action,
  type ActionType,
  type ValueEdits,
  type ValueOp,
} from "../lib/actions";
import { LOCAL_PERSON, type Filter, type PageRef, type PropertySchema, type PropertyValue } from "../lib/model";
import { operatorsFor } from "../lib/query";
import { FilterRule, JoinPicker, PropertyPicker } from "./database/DatabaseView";
import { Tag, TypeIcon } from "./database/properties";
import { DayField, MenuSelect } from "./MenuSelect";
import { PagePicker } from "./PagePicker";
import { MenuItem, Popover, Switch, usePopover } from "./ui";

// Its own BlockNote editor (it needs Editor.tsx's schema, which imports this file).
const BlocksField = lazy(() => import("./BlocksField"));

// The step editor shared by the button block, the "Botón" property and database
// automations: one card per action, each with its fields, and "Añadir acción".

export const ACTION_ICONS: Record<ActionType, typeof Plus> = {
  edit_this: PencilLine,
  create_page: FilePlus2,
  edit_pages: Rows3,
  notify: Bell,
  webhook: Send,
  variables: Braces,
  insert_blocks: ListPlus,
  open_created: FileText,
  open_page: FileText,
  open_url: ExternalLink,
  confirm: MessageSquareWarning,
  unsupported: X,
};

/** Property types an action can write. */
const SETTABLE = [
  "title",
  "text",
  "number",
  "select",
  "status",
  "multi_select",
  "checkbox",
  "date",
  "url",
  "email",
  "phone_number",
  "place",
  "person",
  "relation",
  "file",
];
const LIST_TYPES = ["multi_select", "relation", "person", "file"];

/** Every database (full page or inline), once per collection, named so two with one title can be told apart. */
export function useDatabases() {
  return useLiveQuery(async () => {
    const all = await db.blocks.toArray();
    const byId = new Map(all.map((b) => [b.id, b]));
    const seen = new Set<string>();
    const list = all
      .filter((b) => b.alive && b.type === "collection_view_page" && b.collection_id && !b.is_template)
      .filter((b) => !seen.has(b.collection_id!) && seen.add(b.collection_id!))
      .map((b) => ({ id: b.id, collectionId: b.collection_id!, title: pageTitle(b), parent: b.parent_id ? byId.get(b.parent_id) : undefined }));
    const count = new Map<string, number>();
    for (const d of list) count.set(d.title, (count.get(d.title) ?? 0) + 1);
    return list
      .map((d) => ({
        ...d,
        label: count.get(d.title)! > 1 && d.parent ? `${d.title} (en ${pageTitle(d.parent)})` : d.title,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "es"));
  });
}

function DatabaseSelect({ value, prefix, onChange }: { value: string; prefix: string; onChange: (collectionId: string) => void }) {
  const databases = useDatabases();
  return (
    <MenuSelect
      value={value}
      options={[["", `${prefix}…`], ...(databases ?? []).map((d) => [d.collectionId, `${prefix} ${d.label}`] as const)]}
      onChange={onChange}
      label={prefix}
      width={280}
    />
  );
}

/** A formula field: checked as it's typed, the error under it. */
function FormulaField({ value, placeholder, onChange }: { value: string; placeholder?: string; onChange: (source: string) => void }) {
  const [text, setText] = useState(value);
  let error = "";
  try {
    if (text.trim()) compile(text);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <span className="action-formula">
      <input
        className="field field--sm field--mono"
        value={text}
        placeholder={placeholder ?? 'prop("Número") + 1'}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onChange(text)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        aria-label="Fórmula"
      />
      {error && <span className="action-formula__error">{error}</span>}
    </span>
  );
}

function defaultValue(p: PropertySchema): PropertyValue {
  if (p.type === "checkbox") return true;
  if (p.type === "date") return "@today";
  if (p.type === "select" || p.type === "status") return p.options?.[0]?.id ?? null;
  if (p.type === "multi_select") return p.options?.[0] ? [p.options[0].id] : [];
  if (p.type === "person") return ["@me"];
  if (p.type === "relation" || p.type === "file") return [];
  return "";
}

/**
 * The values an action writes, one row per property: how (set, add, remove or a formula) and the value.
 * `thisLabel` names the page that triggered it ("Página activadora", "Esta página"), offered in relations.
 */
export function ValuesEditor({
  collectionId,
  edits,
  thisLabel,
  onChange,
}: {
  collectionId: string;
  edits: ValueEdits;
  thisLabel?: string;
  onChange: (edits: ValueEdits) => void;
}) {
  const schema = useLiveQuery(async () => (await db.collections.get(collectionId))?.schema, [collectionId]);
  const pick = usePopover();
  if (!schema) return null;
  const set = edits.set ?? {};
  const formulas = edits.formulas ?? {};
  const ops = edits.ops ?? {};
  const ids = [...new Set([...Object.keys(set), ...Object.keys(formulas)])].filter((id) => schema[id]);
  const free = Object.keys(schema).filter((id) => SETTABLE.includes(schema[id].type) && !ids.includes(id));
  const strip = <T,>(o: Record<string, T>, id: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== id));
  const update = (id: string, mode: ValueOp | "formula", value?: PropertyValue, source?: string) =>
    onChange({
      set: mode === "formula" ? strip(set, id) : { ...set, [id]: value === undefined ? (set[id] ?? defaultValue(schema[id])) : value },
      formulas: mode === "formula" ? { ...formulas, [id]: source ?? formulas[id] ?? "" } : strip(formulas, id),
      ops: mode === "add" || mode === "remove" ? { ...ops, [id]: mode } : strip(ops, id),
    });
  const remove = (id: string) => onChange({ set: strip(set, id), formulas: strip(formulas, id), ops: strip(ops, id) });
  return (
    <div className="action-values">
      {ids.map((id) => {
        const p = schema[id];
        const mode: ValueOp | "formula" = id in formulas ? "formula" : (ops[id] ?? "set");
        return (
          <div className="action-values__row" key={id}>
            <span className="action-values__name" title={p.name}>
              <TypeIcon type={p.type} size={14} />
              {p.name}
            </span>
            <MenuSelect<ValueOp | "formula">
              className="action-values__mode"
              value={mode}
              options={[
                ["set", "Establecer"],
                ...(LIST_TYPES.includes(p.type)
                  ? ([
                      ["add", "Añadir"],
                      ["remove", "Quitar"],
                    ] as const)
                  : []),
                ["formula", "Fórmula"],
              ]}
              onChange={(next) => update(id, next)}
              label="Cómo cambia"
              width={180}
            />
            <button type="button" className="icon-btn icon-btn--sm" aria-label={`Quitar ${p.name}`} onClick={() => remove(id)}>
              <X size={12} />
            </button>
            <div className="action-values__value">
              {mode === "formula" ? (
                <FormulaField
                  value={formulas[id] ?? ""}
                  placeholder={p.type === "date" ? 'dateAdd(now(), 7, "days")' : p.type === "number" ? `prop("${p.name}") + 1` : undefined}
                  onChange={(source) => update(id, "formula", undefined, source)}
                />
              ) : (
                <ValueInput
                  schema={p}
                  collectionId={collectionId}
                  value={set[id] ?? null}
                  thisLabel={thisLabel}
                  onChange={(v) => update(id, mode, v)}
                />
              )}
            </div>
          </div>
        );
      })}
      {free.length > 0 && (
        <button type="button" className="action-values__add" onClick={(e) => pick.toggle(e.currentTarget)}>
          <Plus size={14} /> Editar una propiedad
        </button>
      )}
      {pick.anchor && (
        <Popover anchor={pick.anchor} onClose={pick.close} width={240}>
          <PropertyPicker
            schema={Object.fromEntries(free.map((id) => [id, schema[id]]))}
            order={free}
            placeholder="Buscar una propiedad…"
            onPick={(id) => {
              pick.close();
              update(id, "set", defaultValue(schema[id]));
            }}
          />
        </Popover>
      )}
    </div>
  );
}

/** "2026-10-16" (or with a time) → that day's local midnight. */
const dayStart = (value: string) => {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).getTime() : Date.now();
};

const iso = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function ValueInput({
  schema,
  collectionId,
  value,
  thisLabel,
  onChange,
}: {
  schema: PropertySchema;
  collectionId: string;
  value: PropertyValue;
  thisLabel?: string;
  onChange: (v: PropertyValue) => void;
}) {
  if (schema.type === "select" || schema.type === "status")
    return (
      <MenuSelect
        value={String(value ?? "")}
        options={[["", <span className="muted">Vacío</span>], ...(schema.options ?? []).map((o) => [o.id, <Tag option={o} />] as const)]}
        onChange={(v) => onChange(v || null)}
        label={schema.name}
      />
    );
  if (schema.type === "multi_select") {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    return (
      <span className="action-values__tags">
        {(schema.options ?? []).map((o) => (
          <button
            key={o.id}
            type="button"
            className={`action-values__tag${ids.includes(o.id) ? " is-on" : ""}`}
            aria-pressed={ids.includes(o.id)}
            onClick={() => onChange(ids.includes(o.id) ? ids.filter((x) => x !== o.id) : [...ids, o.id])}
          >
            <Tag option={o} />
          </button>
        ))}
        {!schema.options?.length && <span className="muted">Sin opciones</span>}
      </span>
    );
  }
  if (schema.type === "checkbox")
    return (
      <MenuSelect
        value={value ? "1" : ""}
        options={[
          ["1", "Marcada"],
          ["", "Sin marcar"],
        ]}
        onChange={(v) => onChange(!!v)}
        label={schema.name}
      />
    );
  if (schema.type === "date") {
    const relative = RELATIVE_DATE_VALUES.some(([v]) => v === value);
    return (
      <span className="action-values__date">
        <MenuSelect
          value={relative ? String(value) : value ? "fixed" : ""}
          options={[...RELATIVE_DATE_VALUES, ["fixed", "Fecha concreta"], ["", "Vacía"]]}
          onChange={(v) => onChange(v === "fixed" ? iso() : v || null)}
          label={schema.name}
        />
        {!relative && value && (
          <DayField
            value={dayStart(String(value))}
            onChange={(day) => onChange(iso(new Date(day)))}
            label={`${schema.name}: fecha`}
          />
        )}
      </span>
    );
  }
  if (schema.type === "person") {
    const people = Array.isArray(value) ? (value as string[]) : [];
    return (
      <MenuSelect
        value={people[0] === "@me" ? "@me" : people.length ? LOCAL_PERSON : ""}
        options={[
          ["@me", thisLabel === "Esta página" ? "Quien hizo clic" : "Quien la activó"],
          [LOCAL_PERSON, LOCAL_PERSON],
          ["", "Nadie"],
        ]}
        onChange={(v) => onChange(v ? [v] : [])}
        label={schema.name}
      />
    );
  }
  if (schema.type === "relation")
    return <RelationValue schema={schema} value={(value as PageRef[] | null) ?? []} thisLabel={thisLabel} onChange={onChange} />;
  if (schema.type === "file") {
    const files = Array.isArray(value) ? (value as { name: string; url: string }[]) : [];
    return (
      <input
        className="field field--sm"
        placeholder="https://… (enlace del archivo)"
        defaultValue={files.map((f) => f.url).join(" ")}
        onBlur={(e) =>
          onChange(
            e.target.value
              .split(/\s+/)
              .filter(Boolean)
              .map((url) => ({ name: url.split("/").pop() || url, url })),
          )
        }
      />
    );
  }
  void collectionId;
  return (
    <input
      key={String(value)}
      className="field field--sm"
      type={schema.type === "number" ? "number" : "text"}
      defaultValue={value === null ? "" : String(value)}
      placeholder="Vacío"
      onBlur={(e) => onChange(schema.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

/** Related pages: chips, the trigger page, and a picker of the other database's rows. */
function RelationValue({
  schema,
  value,
  thisLabel,
  onChange,
}: {
  schema: PropertySchema;
  value: PageRef[];
  thisLabel?: string;
  onChange: (v: PageRef[]) => void;
}) {
  const pop = usePopover();
  const [query, setQuery] = useState("");
  const rows = useLiveQuery(
    async () =>
      schema.collection_id
        ? (await db.blocks.where("[parent_table+parent_id]").equals(["collection", schema.collection_id]).toArray()).filter(
            (r) => r.alive && !r.is_template,
          )
        : [],
    [schema.collection_id],
  );
  const q = query.trim().toLowerCase();
  const has = (id: string) => value.some((r) => r.id === id);
  const toggle = (ref: PageRef) => onChange(has(ref.id) ? value.filter((r) => r.id !== ref.id) : [...value, ref]);
  return (
    <>
      <button type="button" className="field field--sm action-values__pick" onClick={(e) => pop.toggle(e.currentTarget)}>
        {value.length ? value.map((r) => (r.id === TRIGGER_REF.id ? (thisLabel ?? TRIGGER_REF.name) : r.name || "Sin título")).join(", ") : "Elegir páginas…"}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={280}>
          <div className="menu">
            <input className="menu-search" autoFocus placeholder="Buscar una página…" value={query} onChange={(e) => setQuery(e.target.value)} />
            {thisLabel && (
              <MenuItem icon={<Link2 size={16} />} right={has(TRIGGER_REF.id) ? <Check size={14} /> : null} onClick={() => toggle(TRIGGER_REF)}>
                {thisLabel}
              </MenuItem>
            )}
            <div className="move-picker__list">
              {(rows ?? [])
                .filter((r) => pageTitle(r).toLowerCase().includes(q))
                .slice(0, 50)
                .map((r) => (
                  <MenuItem
                    key={r.id}
                    icon={<FileText size={16} />}
                    right={has(r.id) ? <Check size={14} /> : null}
                    onClick={() => toggle({ id: r.id, name: pageTitle(r) })}
                  >
                    {pageTitle(r)}
                  </MenuItem>
                ))}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

/** "Editar páginas en": which pages (filter rules, as in a view) and how many at most. */
function PagesFilter({
  action,
  onChange,
  thisLabel,
}: {
  action: Extract<Action, { type: "edit_pages" }>;
  onChange: (patch: Partial<Extract<Action, { type: "edit_pages" }>>) => void;
  thisLabel?: string;
}) {
  const schema = useLiveQuery(async () => (await db.collections.get(action.collectionId))?.schema, [action.collectionId]);
  const pick = usePopover();
  if (!schema) return null;
  const filters = (action.filters ?? []).filter((f) => schema[f.property]);
  const setFilters = (next: Filter[]) => onChange({ filters: next });
  const order = Object.keys(schema);
  return (
    <div className="action-filter">
      <span className="action-filter__label">
        {filters.length ? "Páginas en las que" : "Todas las páginas"}
        {thisLabel && filters.some((f) => Array.isArray(f.value) && (f.value as PageRef[]).some((r) => r?.id === TRIGGER_REF.id))
          ? ` (con ${thisLabel})`
          : ""}
      </span>
      {filters.map((f, i) => (
        <FilterRule
          key={f.id}
          lead={
            i === 0 ? (
              "Donde"
            ) : i === 1 ? (
              <JoinPicker value={action.filter_operator ?? "and"} onChange={(filter_operator) => onChange({ filter_operator })} />
            ) : (
              action.filter_operator === "or" ? "O" : "Y"
            )
          }
          filter={f}
          schema={schema}
          collectionId={action.collectionId}
          order={order}
          onChange={(patch) => setFilters(filters.map((x) => (x.id === f.id ? { ...x, ...patch } : x)))}
          onRemove={() => setFilters(filters.filter((x) => x.id !== f.id))}
          onDuplicate={() => setFilters([...filters, { ...f, id: crypto.randomUUID() }])}
        />
      ))}
      <span className="action-filter__foot">
        <button type="button" className="action-values__add" onClick={(e) => pick.toggle(e.currentTarget)}>
          <Plus size={14} /> Añadir filtro
        </button>
        <label className="action-filter__limit">
          Como máximo
          <input
            className="field field--sm"
            type="number"
            min={0}
            placeholder="Todas"
            defaultValue={action.limit || ""}
            onBlur={(e) => onChange({ limit: Math.max(0, Math.floor(Number(e.target.value) || 0)) || undefined })}
            aria-label="Número máximo de páginas"
          />
        </label>
      </span>
      {pick.anchor && (
        <Popover anchor={pick.anchor} onClose={pick.close} width={240}>
          <PropertyPicker
            schema={schema}
            order={order}
            placeholder="Filtrar por…"
            onPick={(property) => {
              pick.close();
              const type = schema[property].type;
              setFilters([...filters, { id: crypto.randomUUID(), property, operator: operatorsFor(type)[0] }]);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

/** "Abrir página": the page (or the one that triggered it), or a picker to choose it. */
function PageChoice({ pageId, thisLabel, onPick }: { pageId: string; thisLabel?: string; onPick: (id: string) => void }) {
  const pop = usePopover();
  const page = useLiveQuery(async () => (pageId && pageId !== TRIGGER_REF.id ? await db.blocks.get(pageId) : undefined), [pageId]);
  return (
    <>
      <button type="button" className="field field--sm action-values__pick" onClick={(e) => pop.toggle(e.currentTarget)}>
        {pageId === TRIGGER_REF.id ? `Abrir ${thisLabel ?? TRIGGER_REF.name}` : page ? `Abrir «${pageTitle(page)}»` : "Elegir una página…"}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={320}>
          {thisLabel && (
            <div className="menu">
              <MenuItem
                icon={<Link2 size={16} />}
                onClick={() => {
                  pop.close();
                  onPick(TRIGGER_REF.id);
                }}
              >
                {thisLabel.charAt(0).toUpperCase() + thisLabel.slice(1)}
              </MenuItem>
            </div>
          )}
          <PagePicker
            placeholder="Buscar una página…"
            onPick={(p) => {
              pop.close();
              onPick(p.id);
            }}
          />
        </Popover>
      )}
    </>
  );
}

function newAction(type: ActionType, actions: Action[], thisCollectionId?: string): Action | null {
  switch (type) {
    case "edit_this":
      return { type, set: {} };
    case "create_page":
      return { type, collectionId: "", set: {} };
    case "edit_pages":
      return { type, collectionId: thisCollectionId ?? "", set: {}, filters: [] };
    case "notify":
      return { type, message: "" };
    case "webhook":
      return { type, url: "https://" };
    case "variables":
      return { type, vars: [{ name: "variable", source: "" }] };
    case "insert_blocks":
      return { type, markdown: "", position: "below" };
    case "open_created": {
      const from = actions.map((a) => a.type).lastIndexOf("create_page");
      return from < 0 ? null : { type, from };
    }
    case "open_page":
      return { type, pageId: "" };
    case "open_url":
      return { type, url: "https://" };
    case "confirm":
      return { type, text: [["¿Continuar?", false]], cancel: "Cancelar", continue: "Continuar" };
    default:
      return null;
  }
}

/**
 * The steps, in order. `allowed` are the actions offered; `thisCollectionId` is the database of the
 * page that triggers them ("Editar propiedad"), named `thisLabel` ("Página activadora", "Esta página").
 */
export function ActionsEditor({
  actions,
  onChange,
  allowed,
  thisCollectionId,
  thisLabel,
}: {
  actions: Action[];
  onChange: (actions: Action[]) => void;
  allowed: ActionType[];
  thisCollectionId?: string;
  thisLabel?: string;
}) {
  const addPop = usePopover();
  const patch = (i: number, p: Partial<Action>) => onChange(actions.map((a, j) => (j === i ? ({ ...a, ...p } as Action) : a)));
  const remove = (i: number) =>
    onChange(
      actions
        .filter((_, j) => j !== i)
        .flatMap((a): Action[] => (a.type !== "open_created" ? [a] : a.from === i ? [] : [{ ...a, from: a.from > i ? a.from - 1 : a.from }])),
    );
  const hint = (
    <span className="action-card__hint">
      Fórmulas: prop("…") es la página que se edita; también puedes usar página, usuario, ahora y tus variables.
    </span>
  );
  return (
    <div className="actions-editor">
      {actions.map((a, i) => {
        const Icon = ACTION_ICONS[a.type];
        let body: ReactNode = null;
        switch (a.type) {
          case "edit_this":
            body = thisCollectionId ? (
              <ValuesEditor collectionId={thisCollectionId} edits={a} thisLabel={thisLabel} onChange={(e) => patch(i, e)} />
            ) : null;
            break;
          case "create_page":
            body = (
              <>
                <DatabaseSelect value={a.collectionId} prefix="Añadir página a" onChange={(collectionId) => patch(i, { collectionId, set: {}, values: undefined, formulas: {}, ops: {} })} />
                <input
                  className="field field--sm"
                  placeholder="Título (opcional; admite {{ fórmulas }})"
                  defaultValue={a.title ?? ""}
                  onBlur={(e) => patch(i, { title: e.target.value })}
                />
                {a.collectionId && (
                  <>
                    <ValuesEditor
                      collectionId={a.collectionId}
                      edits={{ set: { ...a.values, ...a.set }, formulas: a.formulas, ops: a.ops }}
                      thisLabel={thisLabel}
                      onChange={(e) => patch(i, { ...e, values: undefined })}
                    />
                    <MenuItem right={<Switch on={a.template !== false} />} onClick={() => patch(i, { template: a.template === false })}>
                      Usar la plantilla predeterminada
                    </MenuItem>
                  </>
                )}
              </>
            );
            break;
          case "edit_pages":
            body = (
              <>
                <DatabaseSelect value={a.collectionId} prefix="Editar páginas en" onChange={(collectionId) => patch(i, { collectionId, set: {}, formulas: {}, ops: {}, filters: [] })} />
                {a.collectionId && (
                  <>
                    <PagesFilter action={a} thisLabel={thisLabel} onChange={(p) => patch(i, p)} />
                    <ValuesEditor collectionId={a.collectionId} edits={a} thisLabel={thisLabel} onChange={(e) => patch(i, e)} />
                  </>
                )}
              </>
            );
            break;
          case "notify":
            body = (
              <>
                <span className="action-card__to">
                  Para <strong>{LOCAL_PERSON}</strong> · en la Bandeja de entrada y como notificación del sistema
                </span>
                <textarea
                  className="field field--sm"
                  rows={2}
                  placeholder="Mensaje (admite {{ fórmulas }}, p. ej. {{ página }})"
                  defaultValue={a.message}
                  onBlur={(e) => patch(i, { message: e.target.value })}
                  aria-label="Mensaje de la notificación"
                />
              </>
            );
            break;
          case "webhook":
            body = (
              <>
                <input
                  className="field field--sm"
                  defaultValue={a.url}
                  placeholder="https://…"
                  onBlur={(e) => patch(i, { url: e.target.value.trim() })}
                  aria-label="URL del webhook"
                />
                <span className="action-card__hint">Envía la página y sus propiedades como JSON (HTTP POST).</span>
              </>
            );
            break;
          case "variables":
            body = (
              <>
                {a.vars.map((v, k) => (
                  <span className="action-var" key={k}>
                    <input
                      className="field field--sm"
                      defaultValue={v.name}
                      placeholder="Nombre"
                      onBlur={(e) => patch(i, { vars: a.vars.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })}
                      aria-label="Nombre de la variable"
                    />
                    <FormulaField
                      value={v.source}
                      placeholder='dateAdd(now(), 7, "days")'
                      onChange={(source) => patch(i, { vars: a.vars.map((x, j) => (j === k ? { ...x, source } : x)) })}
                    />
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      aria-label="Quitar variable"
                      onClick={() => patch(i, { vars: a.vars.filter((_, j) => j !== k) })}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                <button type="button" className="action-values__add" onClick={() => patch(i, { vars: [...a.vars, { name: "", source: "" }] })}>
                  <Plus size={14} /> Añadir variable
                </button>
              </>
            );
            break;
          case "insert_blocks":
            body = (
              <>
                <MenuSelect
                  value={a.position}
                  options={[
                    ["below", "Debajo del botón"],
                    ["above", "Encima del botón"],
                    ["start", "Al principio de la página"],
                    ["end", "Al final de la página"],
                  ]}
                  onChange={(position) => patch(i, { position })}
                  label="Dónde"
                />
                <Suspense fallback={<div className="blocks-field" />}>
                  <BlocksField blocks={a.blocks} markdown={a.markdown} onChange={(blocks, markdown) => patch(i, { blocks, markdown })} />
                </Suspense>
                <span className="action-card__hint">Escribe «/» para elegir un bloque y «@» para la fecha o la página del clic; {"{{ fórmulas }}"} se calculan al hacer clic.</span>
              </>
            );
            break;
          case "open_created":
            body = <span>Abrir la página creada en el paso {a.from + 1}</span>;
            break;
          case "open_page":
            body = <PageChoice pageId={a.pageId} thisLabel={thisCollectionId ? thisLabel : undefined} onPick={(pageId) => patch(i, { pageId })} />;
            break;
          case "open_url":
            body = <input className="field field--sm" defaultValue={a.url} onBlur={(e) => patch(i, { url: e.target.value.trim() })} aria-label="Enlace" />;
            break;
          case "confirm":
            body = (
              <textarea
                className="field field--sm"
                rows={2}
                defaultValue={a.text.map(([t]) => t).join("")}
                onBlur={(e) => patch(i, { text: [[e.target.value, false]] })}
                aria-label="Mensaje de confirmación"
              />
            );
            break;
          case "unsupported":
            body = <span className="muted">Acción no disponible ({a.name})</span>;
            break;
        }
        return (
          <div className="action-card" key={i} data-action={a.type}>
            <div className="action-card__head">
              <Icon size={16} strokeWidth={1.8} />
              <span className="action-card__title">
                {a.type === "edit_this" ? `Editar propiedad de ${thisLabel ?? "esta página"}` : ACTION_LABELS[a.type].replace(/( a| en)?…$/, "")}
              </span>
              <button type="button" className="icon-btn icon-btn--sm" aria-label="Quitar acción" onClick={() => remove(i)}>
                <X size={14} />
              </button>
            </div>
            <div className="action-card__body">
              {body}
              {(a.type === "edit_this" || a.type === "edit_pages" || a.type === "create_page" || a.type === "variables") && hint}
            </div>
          </div>
        );
      })}
      <button type="button" className="actions-editor__add" onClick={(e) => addPop.toggle(e.currentTarget)}>
        <Plus size={16} /> Añadir acción
      </button>
      {addPop.anchor && (
        <Popover anchor={addPop.anchor} onClose={addPop.close} width={260}>
          <div className="menu">
            {allowed.map((type) => {
              const Icon = ACTION_ICONS[type];
              const action = newAction(type, actions, thisCollectionId);
              return (
                <MenuItem
                  key={type}
                  icon={<Icon size={16} />}
                  disabled={!action}
                  onClick={() => {
                    addPop.close();
                    // The browser asks once whether Xot can show notifications.
                    if (type === "notify") askNotificationPermission();
                    if (action) onChange([...actions, action]);
                  }}
                >
                  {type === "edit_this" ? `Editar propiedad de ${thisLabel ?? "esta página"}` : ACTION_LABELS[type]}
                </MenuItem>
              );
            })}
          </div>
        </Popover>
      )}
    </div>
  );
}
