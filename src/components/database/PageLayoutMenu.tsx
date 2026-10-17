import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, ChevronDown, GripVertical, PanelRight, Pin, Plus, Trash, X } from "lucide-react";
import { db } from "../../lib/db";
import type { PageLayout, PropertyVisibility } from "../../lib/model";
import { setPageLayout } from "../../lib/ops";
import { layoutDraft, setLayoutDraft, useRowLayout, type LayoutFields } from "../../lib/pageLayout";
import { pageTitle, useBlock } from "../../lib/hooks";
import { confirmDialog, hasOpenPopover, MenuItem, MenuLabel, MenuSeparator, Popover, Switch, usePopover } from "../ui";
import { TypeIcon } from "./properties";

const VISIBILITY: [PropertyVisibility | undefined, string][] = [
  [undefined, "Mostrar siempre"],
  ["hide_if_empty", "Ocultar si está vacía"],
  ["hide", "Ocultar siempre"],
];

const visibilityLabel = (v: PropertyVisibility | undefined) =>
  VISIBILITY.find(([value]) => value === (v === "show" || v === "section" ? undefined : v))?.[1] ?? "Mostrar siempre";

/** Up to four properties are pinned under the title. */
const MAX_PINNED = 4;

const shortId = () => Math.random().toString(36).slice(2, 8);

/**
 * "Personalizar diseño" on a database page: a panel on the right that edits the layout every page
 * of the database shares (pinned properties, order and visibility, sections, the details panel,
 * relation tabs and comments). The page behind it previews the draft; "Aplicar a todas las
 * páginas" saves it and "Restablecer" goes back to the default layout.
 */
export function PageLayoutMenu({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const collection = useLiveQuery(() => db.collections.get(collectionId), [collectionId]);
  const database = useBlock(collection?.parent_id ?? null);
  const layout = useRowLayout(collection);
  const pick = usePopover();
  const pinPop = usePopover();
  const [current, setCurrent] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const saved = useRef<string>("");

  // The draft starts as the saved layout, and goes when the panel closes.
  const ready = !!collection;
  useEffect(() => {
    if (!collection) return;
    const fields: LayoutFields = {
      page_properties: collection.page_properties,
      property_visibility: collection.property_visibility,
      page_layout: collection.page_layout,
    };
    saved.current = JSON.stringify(fields);
    setLayoutDraft(collectionId, structuredClone(fields));
    return () => setLayoutDraft(collectionId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, collectionId]);

  const dirty = () => JSON.stringify(layoutDraft(collectionId) ?? {}) !== saved.current;
  const close = async () => {
    if (dirty() && !(await confirmDialog({ text: "¿Descartar los cambios del diseño?", confirm: "Descartar", danger: true }))) return;
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || hasOpenPopover() || document.querySelector("[role='dialog']")) return;
      e.preventDefault();
      void closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!collection) return null;
  const edit = (change: (draft: LayoutFields) => LayoutFields) => {
    const draft = layoutDraft(collectionId) ?? {};
    setLayoutDraft(collectionId, change(draft));
  };
  const setPl = (patch: Partial<PageLayout>) => edit((d) => ({ ...d, page_layout: { ...d.page_layout, ...patch } }));
  const pl = layout.page_layout ?? {};

  const order = layout.page_properties ?? [];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const ids = Object.keys(collection.schema)
    .filter((id) => id !== "title")
    .sort((a, b) => rank(a) - rank(b));
  const visibility = layout.property_visibility ?? {};
  const pinned = (pl.pinned ?? []).filter((id) => ids.includes(id));
  const sections = pl.sections ?? [];
  const sectionOf = (id: string) => sections.find((s) => s.properties.includes(id));
  const relations = ids.filter((id) => collection.schema[id].type === "relation");

  const drop = (target: string) => {
    if (!dragging || dragging === target) return;
    const next = ids.filter((id) => id !== dragging);
    next.splice(next.indexOf(target) + (ids.indexOf(dragging) < ids.indexOf(target) ? 1 : 0), 0, dragging);
    edit((d) => ({ ...d, page_properties: next }));
  };
  const setVisibility = (id: string, value: PropertyVisibility | undefined) =>
    edit((d) => {
      const next = { ...d.property_visibility };
      if (value) next[id] = value;
      else delete next[id];
      return { ...d, property_visibility: next };
    });
  const moveToSection = (id: string, sectionId: string | null) =>
    setPl({
      sections: sections.map((s) => ({
        ...s,
        properties: s.id === sectionId ? [...s.properties.filter((p) => p !== id), id] : s.properties.filter((p) => p !== id),
      })),
    });

  const panel = (
    <div className="layout-editor" role="complementary" aria-label="Personalizar diseño">
      <div className="layout-editor__head">
        <div>
          <div className="layout-editor__title">Diseño de página</div>
          <div className="layout-editor__sub">
            Vista previa en esta página. Se aplica a todas las páginas de «{database ? pageTitle(database) || "Sin título" : ""}».
          </div>
        </div>
        <button type="button" className="icon-btn" aria-label="Cerrar" onClick={() => void close()}>
          <X size={16} />
        </button>
      </div>
      <div className="layout-editor__body">
        <MenuLabel>Encabezado</MenuLabel>
        <div className="layout-editor__note">Propiedades fijadas bajo el título ({pinned.length}/{MAX_PINNED})</div>
        {pinned.map((id) => (
          <div className="page-layout__row" key={id}>
            <span className="page-layout__icon">
              <Pin size={14} />
            </span>
            <span className="page-layout__icon">
              <TypeIcon type={collection.schema[id].type} size={16} />
            </span>
            <span className="page-layout__name">{collection.schema[id].name}</span>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Desfijar"
              onClick={() => setPl({ pinned: pinned.filter((x) => x !== id) })}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {pinned.length < MAX_PINNED && (
          <MenuItem icon={<Plus size={16} />} onClick={(e) => pinPop.toggle(e.currentTarget)}>
            Fijar una propiedad
          </MenuItem>
        )}

        <MenuSeparator />
        <MenuLabel>Propiedades</MenuLabel>
        {ids.map((id) => {
          const section = sectionOf(id);
          return (
            <div
              key={id}
              className={`page-layout__row${dragging === id ? " is-dragging" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                setDragging(id);
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => dragging && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                drop(id);
                setDragging(null);
              }}
            >
              <span className="page-layout__grip">
                <GripVertical size={14} />
              </span>
              <span className="page-layout__icon">
                <TypeIcon type={collection.schema[id].type} size={16} />
              </span>
              <span className="page-layout__name">{collection.schema[id].name}</span>
              <button
                type="button"
                className="page-layout__select"
                onClick={(e) => {
                  setCurrent(id);
                  pick.toggle(e.currentTarget);
                }}
              >
                {pinned.includes(id) ? "Fijada" : section ? section.name || "Sección" : visibilityLabel(visibility[id])}
                <ChevronDown size={12} />
              </button>
            </div>
          );
        })}

        <MenuSeparator />
        <MenuLabel>Secciones</MenuLabel>
        {sections.map((s) => (
          <div className="page-layout__row" key={s.id}>
            <input
              className="layout-editor__section-name"
              defaultValue={s.name}
              placeholder="Sección sin título"
              onBlur={(e) =>
                e.target.value !== s.name &&
                setPl({ sections: sections.map((x) => (x.id === s.id ? { ...x, name: e.target.value.trim() } : x)) })
              }
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <span className="layout-editor__count">{s.properties.filter((p) => ids.includes(p)).length}</span>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Eliminar sección"
              onClick={() => setPl({ sections: sections.filter((x) => x.id !== s.id) })}
            >
              <Trash size={14} />
            </button>
          </div>
        ))}
        <MenuItem
          icon={<Plus size={16} />}
          onClick={() => setPl({ sections: [...sections, { id: shortId(), name: `Sección ${sections.length + 1}`, properties: [] }] })}
        >
          Agregar sección
        </MenuItem>

        <MenuSeparator />
        <MenuLabel>Detalles</MenuLabel>
        <MenuItem icon={<PanelRight size={16} />} right={<Switch on={!!pl.panel} />} onClick={() => setPl({ panel: !pl.panel || undefined })}>
          Propiedades en un panel lateral
        </MenuItem>

        {relations.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Pestañas</MenuLabel>
            <div className="layout-editor__note">Páginas relacionadas en pestañas bajo las propiedades</div>
            {relations.map((id) => {
              const on = (pl.tabs ?? []).includes(id);
              return (
                <MenuItem
                  key={id}
                  icon={<TypeIcon type="relation" size={16} />}
                  right={<Switch on={on} />}
                  onClick={() => setPl({ tabs: on ? (pl.tabs ?? []).filter((x) => x !== id) : [...(pl.tabs ?? []), id] })}
                >
                  {collection.schema[id].name}
                </MenuItem>
              );
            })}
          </>
        )}

        <MenuSeparator />
        <MenuLabel>Comentarios</MenuLabel>
        <MenuItem
          right={<Switch on={pl.discussions !== "off"} />}
          onClick={() => setPl({ discussions: pl.discussions === "off" ? undefined : "off" })}
        >
          Discusiones de la página
        </MenuItem>
        <MenuItem
          right={<Switch on={pl.property_comments !== "off"} />}
          onClick={() => setPl({ property_comments: pl.property_comments === "off" ? undefined : "off" })}
        >
          Comentarios en propiedades
        </MenuItem>
      </div>
      <div className="layout-editor__foot">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setLayoutDraft(collectionId, { page_properties: undefined, property_visibility: undefined, page_layout: undefined })}
        >
          Restablecer
        </button>
        <button
          type="button"
          className="primary-btn"
          onClick={async () => {
            const draft = layoutDraft(collectionId);
            if (draft) await setPageLayout(collectionId, draft);
            onClose();
          }}
        >
          Aplicar a todas las páginas
        </button>
      </div>

      {pick.anchor && current && (
        <Popover anchor={pick.anchor} onClose={pick.close} width={220} align="end">
          <div className="menu">
            {VISIBILITY.map(([value, label]) => (
              <MenuItem
                key={label}
                right={!sectionOf(current) && visibilityLabel(visibility[current]) === label ? <Check size={14} /> : null}
                onClick={() => {
                  pick.close();
                  setVisibility(current, value);
                  if (sectionOf(current)) moveToSection(current, null);
                }}
              >
                {label}
              </MenuItem>
            ))}
            {sections.length > 0 && (
              <>
                <MenuSeparator />
                <MenuLabel>Mover a una sección</MenuLabel>
                {sections.map((s) => (
                  <MenuItem
                    key={s.id}
                    right={sectionOf(current)?.id === s.id ? <Check size={14} /> : null}
                    onClick={() => {
                      pick.close();
                      moveToSection(current, s.id);
                    }}
                  >
                    {s.name || "Sección sin título"}
                  </MenuItem>
                ))}
              </>
            )}
          </div>
        </Popover>
      )}
      {pinPop.anchor && (
        <Popover anchor={pinPop.anchor} onClose={pinPop.close} width={240}>
          <div className="menu menu-scroll">
            {ids
              .filter((id) => !pinned.includes(id))
              .map((id) => (
                <MenuItem
                  key={id}
                  icon={<TypeIcon type={collection.schema[id].type} size={16} />}
                  onClick={() => {
                    pinPop.close();
                    setPl({ pinned: [...pinned, id] });
                  }}
                >
                  {collection.schema[id].name}
                </MenuItem>
              ))}
          </div>
        </Popover>
      )}
    </div>
  );
  return createPortal(panel, document.body);
}
