import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, CopyPlus, Ellipsis, FileText, Plus, Repeat, SquarePen, Star, Trash } from "lucide-react";
import type { Block, Collection, CollectionView, TemplateRepeat } from "../../lib/model";
import {
  addTemplate,
  duplicateTemplate,
  effectiveTemplate,
  setDefaultTemplate,
  setTemplateRepeat,
  setViewDefaultTemplate,
  trashBlock,
} from "../../lib/ops";
import { everyOptions, nextOccurrence, recurringLabel, type RecurringEvery } from "../../lib/automations";
import { nextRunLabel, quickRepeat, repeatOf, repeatTrigger } from "../../lib/templates";
import { pageTitle, useTemplates } from "../../lib/hooks";
import { MenuItem, MenuLabel, MenuSeparator, PageIcon, Popover, usePopover } from "../ui";
import { DayField, MenuSelect, TimeField } from "../MenuSelect";
const DAY_LETTERS: [number, string][] = [
  [1, "L"],
  [2, "M"],
  [3, "X"],
  [4, "J"],
  [5, "V"],
  [6, "S"],
  [0, "D"],
];
const QUICK: [RecurringEvery, string][] = [
  ["day", "Diariamente"],
  ["week", "Semanalmente"],
  ["month", "Mensualmente"],
  ["year", "Anualmente"],
];

/** When a repeat makes its next page. */
export const nextRepeat = (r: TemplateRepeat, now = Date.now()) => nextOccurrence(repeatTrigger(r), r.start, Math.max(now, r.last_due ?? 0));

/** The "Nuevo" caret's templates: pick one, edit, repeat, duplicate or delete it, set the default, add one, or start empty. */
export function TemplateMenu({
  block,
  collection,
  view,
  onPick,
  onEdit,
}: {
  block: Block;
  collection: Collection;
  view?: CollectionView;
  onPick: (templateId?: string) => void;
  onEdit: (id: string) => void;
}) {
  const templates = useTemplates(collection.id);
  const itemPop = usePopover();
  // The template whose "..." menu is open ("" is "Página vacía").
  const [current, setCurrent] = useState<string | null>(null);
  const [page, setPage] = useState<"root" | "default" | "repeat" | "custom">("root");
  const fallback = effectiveTemplate(collection, view) ?? "";
  const more = (id: string) => (
    <span
      role="button"
      tabIndex={-1}
      className="template-item__more"
      aria-label="Opciones de la plantilla"
      onClick={(e) => {
        e.stopPropagation();
        setCurrent(id);
        setPage("root");
        itemPop.toggle(e.currentTarget);
      }}
    >
      <Ellipsis size={16} />
    </span>
  );
  const close = () => {
    itemPop.close();
    setPage("root");
  };
  const repeat = current ? repeatOf(collection, current) : undefined;
  return (
    <>
      <MenuLabel>Plantillas de {pageTitle(block)}</MenuLabel>
      {templates?.map((t) => {
        const r = repeatOf(collection, t.id);
        return (
          <MenuItem
            key={t.id}
            className={`template-item${r ? " template-item--repeat" : ""}`}
            icon={<PageIcon block={t} size={18} />}
            onClick={() => onPick(t.id)}
            right={more(t.id)}
          >
            <span className="template-item__name">
              {pageTitle(t)}
              {fallback === t.id && <span className="template-item__default">Predeterminada</span>}
            </span>
            {r && (
              <span className="template-item__repeat">
                <Repeat size={12} />
                {nextRunLabel(nextRepeat(r))}
              </span>
            )}
          </MenuItem>
        );
      })}
      <MenuItem className="template-item" icon={<FileText size={18} />} onClick={() => onPick("")} right={more("")}>
        <span className="template-item__name">
          Página vacía
          {view?.format.default_template === "" && <span className="template-item__default">Predeterminada</span>}
        </span>
      </MenuItem>
      <MenuItem icon={<Plus size={18} />} onClick={async () => onEdit(await addTemplate(collection.id))}>
        Nueva plantilla
      </MenuItem>
      {itemPop.anchor && current !== null && (
        <Popover anchor={itemPop.anchor} onClose={close} width={page === "custom" ? 300 : 276}>
          <div className="menu template-menu">
            {page === "root" && (
              <>
                <MenuItem icon={<Star size={18} />} right={<ChevronRight size={14} />} onClick={() => setPage("default")}>
                  Establecer como predeterminada
                </MenuItem>
                {current && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<SquarePen size={18} />}
                      onClick={() => {
                        close();
                        onEdit(current);
                      }}
                    >
                      Editar
                    </MenuItem>
                    <MenuItem
                      icon={<Repeat size={18} />}
                      right={
                        <>
                          <span className="template-menu__value">{!repeat ? "Desactivado" : repeat.interval === 1 ? QUICK.find(([e]) => e === repeat.every)?.[1] : "Personalizado"}</span>
                          <ChevronRight size={14} />
                        </>
                      }
                      onClick={() => setPage("repeat")}
                    >
                      Repetir
                    </MenuItem>
                    <MenuItem
                      icon={<CopyPlus size={18} />}
                      onClick={() => {
                        close();
                        void duplicateTemplate(current);
                      }}
                    >
                      Duplicar
                    </MenuItem>
                    <MenuItem
                      danger
                      icon={<Trash size={18} />}
                      onClick={() => {
                        close();
                        void trashBlock(current);
                        if (collection.default_template === current) void setDefaultTemplate(collection.id, undefined);
                        if (view?.format.default_template === current) void setViewDefaultTemplate(view.id, undefined);
                        if (repeat) void setTemplateRepeat(collection.id, current, null);
                      }}
                    >
                      Eliminar
                    </MenuItem>
                  </>
                )}
              </>
            )}
            {page === "default" && (
              <>
                <Head title="Establecer como predeterminada" onBack={() => setPage("root")} />
                <MenuItem
                  right={(collection.default_template ?? "") === current ? <Check size={16} /> : undefined}
                  onClick={() => {
                    close();
                    // "Para todas las vistas" also drops the views' own choices.
                    void setDefaultTemplate(collection.id, current || undefined);
                    if (view?.format.default_template !== undefined) void setViewDefaultTemplate(view.id, undefined);
                  }}
                >
                  Para todas las vistas
                </MenuItem>
                {view && (
                  <MenuItem
                    right={view.format.default_template === current ? <Check size={16} /> : undefined}
                    onClick={() => {
                      close();
                      void setViewDefaultTemplate(view.id, current);
                    }}
                  >
                    Para esta vista
                    <span className="template-menu__view"> · {view.name || "Sin título"}</span>
                  </MenuItem>
                )}
              </>
            )}
            {page === "repeat" && current && (
              <>
                <Head title="Repetir" onBack={() => setPage("root")} />
                <MenuItem
                  right={!repeat ? <Check size={16} /> : undefined}
                  onClick={() => {
                    close();
                    void setTemplateRepeat(collection.id, current, null);
                  }}
                >
                  Desactivado
                </MenuItem>
                {QUICK.map(([every, label]) => (
                  <MenuItem
                    key={every}
                    right={repeat?.every === every && repeat.interval === 1 ? <Check size={16} /> : undefined}
                    onClick={() => {
                      close();
                      void setTemplateRepeat(collection.id, current, quickRepeat(current, every));
                    }}
                  >
                    {label}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem right={<ChevronRight size={14} />} onClick={() => setPage("custom")}>
                  Personalizado…
                </MenuItem>
              </>
            )}
            {page === "custom" && current && (
              <>
                <Head title="Repetir" onBack={() => setPage("repeat")} />
                <RepeatEditor
                  repeat={repeat ?? quickRepeat(current, "week")}
                  onChange={(next) => void setTemplateRepeat(collection.id, current, { ...next, last_due: Math.max(Date.now(), next.last_due ?? 0) })}
                />
              </>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

function Head({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="settings-head">
      <button type="button" className="icon-btn icon-btn--sm" aria-label="Atrás" onClick={onBack}>
        <ChevronLeft size={16} />
      </button>
      <span className="settings-head__title">{title}</span>
    </div>
  );
}

/** "Personalizado": every N days/weeks/months/years, on which weekdays, at what time, from which day. */
function RepeatEditor({ repeat: r, onChange }: { repeat: TemplateRepeat; onChange: (r: TemplateRepeat) => void }) {
  const days = r.weekdays?.length ? r.weekdays : [new Date(r.start).getDay()];
  const t = repeatTrigger(r);
  return (
    <div className="recurring template-repeat">
      <span className="recurring__row">
        Repetir cada
        <input
          className="field field--sm recurring__n"
          type="number"
          min={1}
          value={r.interval}
          onChange={(e) => onChange({ ...r, interval: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
          aria-label="Cada cuántos"
        />
        <MenuSelect
          value={r.every}
          options={everyOptions(r.interval)}
          onChange={(every) => onChange({ ...r, every, weekdays: every === "week" ? days : undefined })}
          label="Frecuencia"
          width={160}
        />
      </span>
      {r.every === "week" && (
        <span className="recurring__days">
          {DAY_LETTERS.map(([d, letter]) => (
            <button
              key={d}
              type="button"
              className={`recurring__day${days.includes(d) ? " is-on" : ""}`}
              aria-pressed={days.includes(d)}
              onClick={() => {
                const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
                onChange({ ...r, weekdays: next.length ? next : days });
              }}
            >
              {letter}
            </button>
          ))}
        </span>
      )}
      <span className="recurring__row">
        A las
        <TimeField value={r.time} onChange={(time) => onChange({ ...r, time })} />
      </span>
      <span className="recurring__row">
        Empezando el
        <DayField value={r.start} onChange={(start) => onChange({ ...r, start })} label="Empieza" />
      </span>
      <span className="action-card__hint">
        {recurringLabel(t, r.start)}. {nextRunLabel(nextRepeat(r))}.{" "}
        {navigator.userAgent.includes("Electron")
          ? "Se crea aunque cierres todas las ventanas; si saliste de Xot, al volver a abrirlo."
          : "Si Xot estaba cerrado a esa hora, se crea al abrirlo."}
      </span>
    </div>
  );
}
