import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, CalendarClock, Check, ChevronDown, CopyPlus, Database, Ellipsis, FilePlus2, PencilLine, Plus, Trash, TriangleAlert, X, Zap } from "lucide-react";
import { ACTION_LABELS, type ActionType } from "../../lib/actions";
import {
  TRIGGER_LABELS,
  deleteAutomation,
  everyOptions,
  newAutomation,
  patchAutomation,
  recurringLabel,
  saveAutomation,
  type Automation,
  type Trigger,
  type TriggerRule,
} from "../../lib/automations";
import type { Collection, CollectionView, PropertySchema } from "../../lib/model";
import { operatorsFor } from "../../lib/query";
import { ActionsEditor } from "../ActionsEditor";
import { MenuSelect, TimeField } from "../MenuSelect";
import { MenuItem, MenuLabel, Popover, Switch, confirmDialog, usePopover } from "../ui";
import { FilterRule, PropertyPicker, viewIcon } from "./DatabaseView";
import { TypeIcon } from "./properties";

/** What an automation can do (window-only steps, like opening a page, are for buttons). */
const AUTOMATION_ACTIONS: ActionType[] = ["edit_this", "create_page", "edit_pages", "notify", "webhook", "variables"];

const TRIGGER_ICONS = { page_added: FilePlus2, property_edited: PencilLine, recurring: CalendarClock };

/** "Cuando se añade una página → Editar propiedad, Enviar notificación". */
function summary(a: Automation, schema: Record<string, PropertySchema>) {
  const when = a.triggers
    .map((t) =>
      t.type === "recurring"
        ? recurringLabel(t, a.created_time)
        : t.type === "property_edited" && t.rules.length
          ? `${t.rules.map((r) => schema[r.property]?.name ?? "?").join(t.match === "all" ? " y " : " o ")} editado`
          : TRIGGER_LABELS[t.type],
    )
    .join(" o ");
  const then = a.actions.map((x) => ACTION_LABELS[x.type].replace(/( a| en)?…$/, "")).join(", ");
  return `${when || "Sin disparador"} → ${then || "sin acciones"}`;
}

/** The ⚡ button of the database toolbar: highlighted while an automation is on. */
export function AutomationsButton({ collection, views }: { collection: Collection; views: CollectionView[] }) {
  const [open, setOpen] = useState(false);
  const on = (collection.automations ?? []).some((a) => a.enabled);
  return (
    <>
      <button
        type="button"
        className={`db-icon-btn db-icon-btn--optional${on ? " is-on" : ""}`}
        aria-label="Automatizaciones"
        title="Automatizaciones"
        onClick={() => setOpen(!open)}
      >
        <Zap size={16} />
      </button>
      {open && <AutomationsPanel collection={collection} views={views} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The automation panel, docked on the right: the list, and the editor of one. */
export function AutomationsPanel({ collection, views, onClose }: { collection: Collection; views: CollectionView[]; onClose: () => void }) {
  const [editing, setEditing] = useState<Automation | null>(null);
  const [isNew, setIsNew] = useState(false);
  const list = collection.automations ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".popover") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="automations" role="dialog" aria-label="Automatizaciones">
      {editing ? (
        <AutomationEditor
          automation={editing}
          isNew={isNew}
          collection={collection}
          views={views}
          onChange={setEditing}
          onDone={() => setEditing(null)}
        />
      ) : (
        <>
          <div className="automations__head">
            <Zap size={16} />
            <span className="automations__title">Automatizaciones</span>
            <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
          <div className="automations__list">
            {list.length === 0 && (
              <div className="automations__empty">
                <Zap size={28} strokeWidth={1.5} />
                <span>Automatiza el trabajo repetitivo</span>
                <span className="muted">Cuando se añada o edite una página, o cada cierto tiempo, Xot hará lo que le pidas.</span>
              </div>
            )}
            {list.map((a) => (
              <AutomationRow
                key={a.id}
                automation={a}
                collection={collection}
                onEdit={() => {
                  setIsNew(false);
                  setEditing(structuredClone(a));
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="automations__new"
            onClick={() => {
              setIsNew(true);
              setEditing(newAutomation());
            }}
          >
            <Plus size={16} /> Nueva automatización
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

function AutomationRow({ automation: a, collection, onEdit }: { automation: Automation; collection: Collection; onEdit: () => void }) {
  const more = usePopover();
  return (
    <div className={`automation-row${a.enabled ? "" : " is-paused"}`} role="button" tabIndex={0} onClick={onEdit} onKeyDown={(e) => e.key === "Enter" && onEdit()}>
      <span className="automation-row__icon">
        <Zap size={16} />
      </span>
      <span className="automation-row__text">
        <span className="automation-row__name">{a.name.trim() || "Automatización sin título"}</span>
        <span className="automation-row__summary">{summary(a, collection.schema)}</span>
        {a.error && (
          <span className="automation-row__error">
            <TriangleAlert size={12} /> Pausada por un error: {a.error}
          </span>
        )}
      </span>
      <button
        type="button"
        className="automation-row__switch"
        role="switch"
        aria-checked={a.enabled}
        aria-label={a.enabled ? "Pausar" : "Activar"}
        title={a.enabled ? "Pausar" : "Activar"}
        onClick={(e) => {
          e.stopPropagation();
          // Switched back on, it waits for its next time: the runs missed while paused are skipped.
          void patchAutomation(collection.id, a.id, a.enabled ? { enabled: false } : { enabled: true, error: undefined, last_due: Date.now() });
        }}
      >
        <Switch on={a.enabled} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Más acciones"
        onClick={(e) => {
          e.stopPropagation();
          more.toggle(e.currentTarget);
        }}
      >
        <Ellipsis size={16} />
      </button>
      {more.anchor && (
        <Popover anchor={more.anchor} onClose={more.close} width={200} align="end">
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <MenuItem
              icon={<PencilLine size={16} />}
              onClick={() => {
                more.close();
                onEdit();
              }}
            >
              Editar
            </MenuItem>
            <MenuItem
              icon={<CopyPlus size={16} />}
              onClick={() => {
                more.close();
                void saveAutomation(collection.id, {
                  ...structuredClone(a),
                  id: crypto.randomUUID(),
                  name: `${a.name.trim() || "Automatización sin título"} (copia)`,
                  created_time: Date.now(),
                  last_due: undefined,
                  last_run: undefined,
                });
              }}
            >
              Duplicar
            </MenuItem>
            <MenuItem
              danger
              icon={<Trash size={16} />}
              onClick={async () => {
                more.close();
                if (await confirmDialog({ text: "¿Eliminar esta automatización?", confirm: "Eliminar", danger: true }))
                  void deleteAutomation(collection.id, a.id);
              }}
            >
              Eliminar
            </MenuItem>
          </div>
        </Popover>
      )}
    </div>
  );
}

const DAY_LETTERS: [number, string][] = [
  [1, "L"],
  [2, "M"],
  [3, "X"],
  [4, "J"],
  [5, "V"],
  [6, "S"],
  [0, "D"],
];

function AutomationEditor({
  automation: a,
  isNew,
  collection,
  views,
  onChange,
  onDone,
}: {
  automation: Automation;
  isNew: boolean;
  collection: Collection;
  views: CollectionView[];
  onChange: (a: Automation) => void;
  onDone: () => void;
}) {
  const addTrigger = usePopover();
  const scope = usePopover();
  const scopeViews = views.filter((v) => v.collection_id === collection.id && v.type !== "dashboard" && v.type !== "form");
  const scopeView = scopeViews.find((v) => v.id === a.view_id);
  const ScopeIcon = scopeView ? viewIcon(scopeView) : Database;
  const set = (patch: Partial<Automation>) => onChange({ ...a, ...patch });
  const setTrigger = (i: number, t: Trigger) => set({ triggers: a.triggers.map((x, j) => (j === i ? t : x)) });
  const hasRecurring = a.triggers.some((t) => t.type === "recurring");
  const save = async () => {
    // Saving again starts it afresh (a paused one is switched back on).
    const saved = collection.automations?.find((x) => x.id === a.id);
    const enabled = isNew ? true : a.enabled || !!a.error;
    const schedule = (x?: Automation) => JSON.stringify(x?.triggers.filter((t) => t.type === "recurring") ?? []);
    // A new or changed schedule, or one switched back on, first runs at its next time (not one already past).
    const fresh = !saved || schedule(saved) !== schedule(a) || (enabled && !saved.enabled);
    await saveAutomation(collection.id, { ...a, enabled, error: undefined, ...(fresh ? { last_due: Date.now() } : {}) });
    onDone();
  };
  return (
    <>
      <div className="automations__head">
        <button type="button" className="icon-btn" aria-label="Volver" onClick={onDone}>
          <ArrowLeft size={16} />
        </button>
        <span className="automations__title">{isNew ? "Nueva automatización" : "Editar automatización"}</span>
      </div>
      <div className="automations__body">
        <input
          className="automations__name"
          placeholder="Automatización sin título"
          value={a.name}
          onChange={(e) => set({ name: e.target.value })}
          autoFocus={isNew}
          aria-label="Nombre de la automatización"
        />
        <div className="automations__scope">
          <span>Se aplica a</span>
          <button type="button" className="automations__scope-btn" aria-haspopup="menu" aria-expanded={!!scope.anchor} onClick={(e) => scope.toggle(e.currentTarget)}>
            <ScopeIcon size={14} strokeWidth={1.8} />
            <span className="automations__scope-label">{scopeView ? scopeView.name || "Sin título" : "Todas las vistas"}</span>
            <ChevronDown size={12} />
          </button>
          {scope.anchor && (
            <Popover anchor={scope.anchor} onClose={scope.close} width={240} align="end">
              <div className="menu" role="menu">
                <MenuItem
                  icon={<Database size={16} />}
                  active={!scopeView}
                  right={!scopeView ? <Check size={14} /> : null}
                  onClick={() => {
                    scope.close();
                    set({ view_id: undefined });
                  }}
                >
                  Todas las vistas
                </MenuItem>
                {scopeViews.map((v) => {
                  const Icon = viewIcon(v);
                  return (
                    <MenuItem
                      key={v.id}
                      icon={<Icon size={16} />}
                      active={v.id === scopeView?.id}
                      right={v.id === scopeView?.id ? <Check size={14} /> : null}
                      onClick={() => {
                        scope.close();
                        set({ view_id: v.id });
                      }}
                    >
                      {v.name || "Sin título"}
                    </MenuItem>
                  );
                })}
              </div>
            </Popover>
          )}
        </div>
        {a.error && (
          <div className="automation-row__error automations__error">
            <TriangleAlert size={14} /> Se pausó por un error: {a.error}. Guárdala para volver a activarla.
          </div>
        )}

        <MenuLabel>Cuando</MenuLabel>
        <div className="automations__triggers">
          {a.triggers.map((t, i) => {
            const Icon = TRIGGER_ICONS[t.type];
            return (
              <div className="action-card" key={i} data-trigger={t.type}>
                {i > 0 && <span className="action-card__or">o</span>}
                <div className="action-card__head">
                  <Icon size={16} strokeWidth={1.8} />
                  <span className="action-card__title">{TRIGGER_LABELS[t.type]}</span>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    aria-label="Quitar disparador"
                    onClick={() => set({ triggers: a.triggers.filter((_, j) => j !== i) })}
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="action-card__body">
                  {t.type === "page_added" && <span className="action-card__hint">Cuando se crea una página en esta base de datos{a.view_id ? " y aparece en la vista" : ""}.</span>}
                  {t.type === "property_edited" && (
                    <RulesEditor trigger={t} schema={collection.schema} collectionId={collection.id} onChange={(next) => setTrigger(i, next)} />
                  )}
                  {t.type === "recurring" && <RecurringEditor trigger={t} anchor={a.created_time} onChange={(next) => setTrigger(i, next)} />}
                </div>
              </div>
            );
          })}
          <button type="button" className="actions-editor__add" onClick={(e) => addTrigger.toggle(e.currentTarget)}>
            <Plus size={16} /> Agregar disparador
          </button>
          {addTrigger.anchor && (
            <Popover anchor={addTrigger.anchor} onClose={addTrigger.close} width={240}>
              <div className="menu">
                {(Object.keys(TRIGGER_LABELS) as Trigger["type"][]).map((type) => {
                  const Icon = TRIGGER_ICONS[type];
                  return (
                    <MenuItem
                      key={type}
                      icon={<Icon size={16} />}
                      onClick={() => {
                        addTrigger.close();
                        const t: Trigger =
                          type === "page_added"
                            ? { type }
                            : type === "property_edited"
                              ? { type, rules: [], match: "any" }
                              : { type, every: "day", interval: 1, time: "09:00" };
                        set({ triggers: [...a.triggers, t] });
                      }}
                    >
                      {TRIGGER_LABELS[type]}
                    </MenuItem>
                  );
                })}
              </div>
            </Popover>
          )}
        </div>

        <MenuLabel>Haz</MenuLabel>
        <ActionsEditor
          actions={a.actions}
          onChange={(actions) => set({ actions })}
          allowed={hasRecurring ? AUTOMATION_ACTIONS.filter((t) => t !== "edit_this") : AUTOMATION_ACTIONS}
          thisCollectionId={collection.id}
          thisLabel="Página activadora"
        />
      </div>
      <div className="automations__foot">
        {!isNew && (
          <button
            type="button"
            className="xot-btn xot-btn--danger"
            onClick={async () => {
              if (await confirmDialog({ text: "¿Eliminar esta automatización?", confirm: "Eliminar", danger: true })) {
                await deleteAutomation(collection.id, a.id);
                onDone();
              }
            }}
          >
            Eliminar
          </button>
        )}
        <span className="automations__spacer" />
        <button type="button" className="xot-btn" onClick={onDone}>
          Cancelar
        </button>
        <button type="button" className="xot-btn xot-btn--primary" disabled={!a.triggers.length || !a.actions.length} onClick={() => void save()}>
          {isNew ? "Crear" : "Guardar"}
        </button>
      </div>
    </>
  );
}

/** "Propiedad editada": which properties, with or without a condition on the new value, any or all of them. */
function RulesEditor({
  trigger,
  schema,
  collectionId,
  onChange,
}: {
  trigger: Extract<Trigger, { type: "property_edited" }>;
  schema: Record<string, PropertySchema>;
  collectionId: string;
  onChange: (t: Extract<Trigger, { type: "property_edited" }>) => void;
}) {
  const pick = usePopover();
  const editable = Object.fromEntries(
    Object.entries(schema).filter(([, p]) => !["formula", "rollup", "button", "created_time", "created_by", "last_edited_time", "last_edited_by", "auto_increment_id"].includes(p.type)),
  );
  const order = Object.keys(editable);
  const rules = trigger.rules.filter((r) => schema[r.property]);
  const setRules = (next: TriggerRule[]) => onChange({ ...trigger, rules: next });
  const patchRule = (id: string, patch: Partial<TriggerRule>) => setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="action-filter">
      {rules.length === 0 && <span className="action-card__hint">Cuando se edita cualquier propiedad.</span>}
      {rules.length > 1 && (
        <MenuSelect
          className="action-filter__match"
          value={trigger.match}
          options={[
            ["any", "Si se cumple cualquiera"],
            ["all", "Si se cumplen todas"],
          ]}
          onChange={(match) => onChange({ ...trigger, match })}
          label="Cuántas condiciones"
        />
      )}
      {rules.map((r) =>
        r.operator ? (
          <div className="trigger-rule" key={r.id}>
            <FilterRule
              lead={"Cambia a"}
              filter={{ id: r.id, property: r.property, operator: r.operator, value: r.value }}
              schema={editable}
              collectionId={collectionId}
              order={order}
              onChange={(patch) => patchRule(r.id, patch)}
              onRemove={() => setRules(rules.filter((x) => x.id !== r.id))}
              onDuplicate={() => setRules([...rules, { ...r, id: crypto.randomUUID() }])}
            />
            <button type="button" className="action-values__add" onClick={() => patchRule(r.id, { operator: undefined, value: undefined })}>
              Cualquier cambio
            </button>
          </div>
        ) : (
          <div className="trigger-rule trigger-rule--any" key={r.id}>
            <span className="trigger-rule__prop">
              <TypeIcon type={schema[r.property].type} size={14} />
              {schema[r.property].name}
            </span>
            <span className="muted">cualquier cambio</span>
            <button
              type="button"
              className="action-values__add"
              onClick={() => patchRule(r.id, { operator: operatorsFor(schema[r.property].type)[0] })}
            >
              <ChevronDown size={12} /> Agregar condición
            </button>
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Quitar" onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>
              <X size={12} />
            </button>
          </div>
        ),
      )}
      <button type="button" className="action-values__add" onClick={(e) => pick.toggle(e.currentTarget)}>
        <Plus size={14} /> Agregar propiedad
      </button>
      {pick.anchor && (
        <Popover anchor={pick.anchor} onClose={pick.close} width={240}>
          <PropertyPicker
            schema={editable}
            order={order}
            placeholder="Propiedad…"
            onPick={(property) => {
              pick.close();
              setRules([...rules, { id: crypto.randomUUID(), property }]);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

function RecurringEditor({
  trigger: t,
  anchor,
  onChange,
}: {
  trigger: Extract<Trigger, { type: "recurring" }>;
  anchor: number;
  onChange: (t: Extract<Trigger, { type: "recurring" }>) => void;
}) {
  const days = t.weekdays?.length ? t.weekdays : [new Date(anchor).getDay()];
  return (
    <div className="recurring">
      <span className="recurring__row">
        Cada
        <input
          className="field field--sm recurring__n"
          type="number"
          min={1}
          value={t.interval}
          onChange={(e) => onChange({ ...t, interval: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
          aria-label="Cada cuántos"
        />
        <MenuSelect value={t.every} options={everyOptions(t.interval)} onChange={(every) => onChange({ ...t, every })} label="Frecuencia" width={160} />
        a las
        <TimeField value={t.time} onChange={(time) => onChange({ ...t, time })} />
      </span>
      {t.every === "week" && (
        <span className="recurring__days">
          {DAY_LETTERS.map(([d, letter]) => (
            <button
              key={d}
              type="button"
              className={`recurring__day${days.includes(d) ? " is-on" : ""}`}
              aria-pressed={days.includes(d)}
              onClick={() => {
                const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
                onChange({ ...t, weekdays: next.length ? next : days });
              }}
            >
              {letter}
            </button>
          ))}
        </span>
      )}
      <span className="action-card__hint">
        {recurringLabel(t, anchor)}.{" "}
        {navigator.userAgent.includes("Electron")
          ? "Se ejecuta aunque cierres todas las ventanas; si saliste de Xot, al volver a abrirlo."
          : "Si Xot estaba cerrado a esa hora, se ejecuta al abrirlo."}
      </span>
    </div>
  );
}
