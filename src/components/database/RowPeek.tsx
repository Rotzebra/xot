import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  ChevronUp,
  Ellipsis,
  FileDown,
  LayoutTemplate,
  Link,
  Maximize2,
  PanelRight,
  Plus,
  Star,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { Block, Collection, PageRef } from "../../lib/model";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../lib/db";
import { useRowLayout } from "../../lib/pageLayout";
import { editedLabel } from "../../lib/format";
import {
  HAS_TABS,
  navigate,
  openInNewTab,
  pageTitle,
  toggleFavorite,
  useBlock,
  useFavorites,
  useStoredState,
} from "../../lib/hooks";
import { leavePage } from "../../lib/history";
import { duplicatePage } from "../../lib/ops";
import {
  copyLink,
  hasOpenPopover,
  MenuItem,
  MenuLabel,
  PageIcon,
  Popover,
  usePopover,
} from "../ui";
import { focusTitleEnd, mergeIntoTitle, PageHeader } from "../PageHeader";
import { PageCover } from "../PageCover";
import { Editor, focusBodyStart, insertBodyLines, insertBodyStart, type XotEditor } from "../Editor";
import { cellValue, isEmptyValue } from "../../lib/query";
import { AddPropertyMenu, PropertyCell, PropertyMenu, propertyTooltip, TypeIcon } from "./properties";
import { PropertyCommentButton } from "./PropertyComments";
import { TemplatePicker, useBodyKey } from "./TemplatePicker";
import { VersionHistory } from "../VersionHistory";
import { PageDiscussions } from "../Comments";
import { PageMenu } from "../PageView";
import { ExportDialog } from "../ExportDialog";
import { ImportDialog } from "../ImportDialog";
import { MovePicker } from "../MovePicker";

const isTyping = (el: Element | null) =>
  !!el && (el.matches("input, textarea, select, [contenteditable='true']") || !!el.closest(".bn-editor"));

// Clicks inside these (menus, BlockNote toolbars) never dismiss the side peek.
const KEEP_OPEN =
  ".peek, .popover, [role='menu'], [role='dialog'], [data-floating-ui-portal], .bn-ui-container, .bn-toolbar, .bn-suggestion-menu, .bn-menu-dropdown, .bn-side-menu";

/**
 * A database row opened over its view. "side" is the default side peek
 * (right edge, resizable, no backdrop); "center" is the centered modal.
 */
export function RowPeek({
  rowId,
  collection,
  onClose,
  rowIds,
  onNavigate,
  mode = "side",
  onModeChange,
}: {
  rowId: string;
  collection: Collection;
  onClose: () => void;
  /** The rows of the current view, in order, for the previous/next arrows. */
  rowIds?: string[];
  onNavigate?: (id: string) => void;
  mode?: "side" | "center";
  /** The peek-mode switcher: changes how the view opens its pages. */
  onModeChange?: (mode: "side" | "center" | "full") => void;
}) {
  const row = useBlock(rowId);
  const ref = useRef<HTMLDivElement>(null);
  const editorRef = useRef<XotEditor | null>(null);
  const setEditor = useCallback((editor: XotEditor | null) => void (editorRef.current = editor), []);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const exitTop = useCallback(() => focusTitleEnd(titleRef.current), []);
  const mergeTop = useCallback((text: string) => mergeIntoTitle(titleRef.current, text), []);
  const menu = usePopover();
  const move = usePopover();
  const moreRef = useRef<HTMLButtonElement>(null);
  const share = usePopover();
  const modePop = usePopover();
  const isFavorite = useFavorites().includes(rowId);
  const [width, setWidth] = useStoredState<number | null>("xotion:peek-width", null);
  const [resizing, setResizing] = useState(false);
  const body = useBodyKey(row);
  const [dialog, setDialog] = useState<"export" | "history" | "import" | null>(null);
  const [commenting, setCommenting] = useState(false);
  const index = rowIds ? rowIds.indexOf(rowId) : -1;
  const prev = index > 0 ? rowIds![index - 1] : null;
  const next = index !== -1 && index < rowIds!.length - 1 ? rowIds![index + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !hasOpenPopover() && !document.querySelector(".bn-suggestion-menu"))
        onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The side peek has no backdrop: a click anywhere else in the app closes it.
  useEffect(() => {
    if (mode !== "side") return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target?.isConnected || hasOpenPopover() || target.closest(KEEP_OPEN)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [mode, onClose]);

  // Trashed, deleted, or moved out of this database ("Mover a"): the peek closes.
  useEffect(() => {
    if (row === null || row?.alive === false || (row && (row.parent_table !== "collection" || row.parent_id !== collection.id)))
      onClose();
  }, [row, onClose, collection.id]);

  // While the peek is open, page shortcuts act on its row (the host page stands aside):
  // ⌘L copies its link, ⌘D outside the text duplicates it, ⌘⇧P moves it.
  const keys = useRef({ onNavigate, open: move.open });
  keys.current = { onNavigate, open: move.open };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "l" && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void copyLink(rowId);
      } else if (key === "d" && !e.shiftKey && !isTyping(document.activeElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void duplicatePage(rowId).then((id) => id && (keys.current.onNavigate ? keys.current.onNavigate(id) : navigate(id)));
      } else if (key === "p" && e.shiftKey && moreRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        keys.current.open(moreRef.current);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rowId]);

  // "Historial de versiones": closing the peek (or moving to another row) leaves the page.
  useEffect(() => () => leavePage(rowId), [rowId]);

  if (!row) return null;

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    setResizing(true);
    const onMove = (ev: PointerEvent) =>
      setWidth(Math.round(Math.min(window.innerWidth - 120, Math.max(420, window.innerWidth - ev.clientX))));
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const panel = (
    <div
      ref={ref}
      className={`peek peek--${mode}${resizing ? " is-resizing" : ""}`}
      role="dialog"
      aria-label={mode === "side" ? "Ventana lateral" : "Ventana central"}
      style={mode === "side" && width ? { width } : undefined}
    >
      {mode === "side" && <div className="peek__resize" onPointerDown={startResize} aria-hidden />}
      <div className="peek__bar">
        <div className="peek__bar-left">
          <button
            type="button"
            className="icon-btn"
            aria-label="Cerrar"
            data-tooltip="Cerrar"
            data-shortcut="Esc"
            onClick={onClose}
          >
            <ChevronsRight size={20} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Abrir como página completa"
            data-tooltip="Abrir como página completa"
            onClick={() => navigate(row.id)}
          >
            <Maximize2 size={16} />
          </button>
          {onModeChange && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Modo de vista previa"
              data-tooltip="Modo de vista previa"
              onClick={(e) => modePop.toggle(e.currentTarget)}
            >
              <PanelRight size={16} />
            </button>
          )}
          {rowIds && onNavigate && (
            <>
              <span className="peek__bar-sep" />
              <button
                type="button"
                className="icon-btn"
                aria-label="Página anterior"
                data-tooltip="Página anterior"
                disabled={!prev}
                onClick={() => prev && onNavigate(prev)}
              >
                <ChevronUp size={20} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Página siguiente"
                data-tooltip="Página siguiente"
                disabled={!next}
                onClick={() => next && onNavigate(next)}
              >
                <ChevronDown size={20} />
              </button>
            </>
          )}
        </div>
        <div className="peek__bar-right">
          <span className="peek__edited">{editedLabel(row.last_edited_time)}</span>
          <button type="button" className="topbar__share" onClick={(e) => share.toggle(e.currentTarget)}>
            Compartir
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Copiar enlace"
            data-tooltip="Copiar enlace"
            onClick={() => void copyLink(row.id)}
          >
            <Link size={20} />
          </button>
          <button
            type="button"
            className={`icon-btn${isFavorite ? " is-favorite" : ""}`}
            aria-label={isFavorite ? "Quitar de favoritos" : "Agregar a favoritos"}
            data-tooltip={isFavorite ? "Quitar de favoritos" : "Agregar a favoritos"}
            aria-pressed={isFavorite}
            onClick={() => toggleFavorite(row.id)}
          >
            <Star size={20} fill={isFavorite ? "currentColor" : "none"} />
          </button>
          <button
            ref={moreRef}
            type="button"
            className="icon-btn"
            aria-label="Más acciones"
            data-tooltip="Más acciones"
            onClick={(e) => menu.toggle(e.currentTarget)}
          >
            <Ellipsis size={20} />
          </button>
        </div>
        {modePop.anchor && onModeChange && (
          <Popover anchor={modePop.anchor} onClose={modePop.close} width={220}>
            <div className="menu">
              <MenuLabel>Abrir páginas en</MenuLabel>
              {(
                [
                  ["side", "Ventana lateral"],
                  ["center", "Ventana central"],
                  ["full", "Página completa"],
                ] as const
              ).map(([m, label]) => (
                <MenuItem
                  key={m}
                  right={mode === m ? <Check size={14} /> : null}
                  onClick={() => {
                    modePop.close();
                    onModeChange(m);
                  }}
                >
                  {label}
                </MenuItem>
              ))}
            </div>
          </Popover>
        )}
        {share.anchor && (
          <Popover anchor={share.anchor} onClose={share.close} width={256} align="end">
            <div className="menu">
              <MenuItem
                icon={<Link size={18} />}
                onClick={() => {
                  share.close();
                  void copyLink(row.id);
                }}
              >
                Copiar enlace
              </MenuItem>
              <MenuItem
                icon={<FileDown size={18} />}
                onClick={() => {
                  share.close();
                  setDialog("export");
                }}
              >
                Exportar
              </MenuItem>
            </div>
          </Popover>
        )}
        {menu.anchor && (
          <Popover anchor={menu.anchor} onClose={menu.close} width={256} align="end">
            <PageMenu
              block={row}
              editor={editorRef.current}
              font={row.format.page_font ?? "default"}
              onClose={menu.close}
              onMove={() => {
                const anchor = menu.anchor;
                menu.close();
                if (anchor) move.open(anchor);
              }}
              onDialog={setDialog}
              onTrashed={onClose}
              inPeek
              onDuplicated={(id) => (onNavigate ? onNavigate(id) : navigate(id))}
              extraTop={
                <>
                  <MenuItem
                    icon={<Maximize2 size={18} />}
                    onClick={() => {
                      menu.close();
                      navigate(row.id);
                    }}
                  >
                    Abrir como página
                  </MenuItem>
                  {HAS_TABS && (
                    <MenuItem
                      icon={<SquareArrowOutUpRight size={18} />}
                      right="⌘↵"
                      onClick={() => {
                        menu.close();
                        openInNewTab(row.id);
                      }}
                    >
                      Abrir en una pestaña nueva
                    </MenuItem>
                  )}
                </>
              }
            />
          </Popover>
        )}
        {move.anchor && (
          <Popover anchor={move.anchor} onClose={move.close} width={320} align="end">
            <MovePicker block={row} onDone={move.close} />
          </Popover>
        )}
        {dialog === "export" && <ExportDialog block={row} onClose={() => setDialog(null)} />}
        {dialog === "history" && <VersionHistory block={row} editor={editorRef.current} onClose={() => setDialog(null)} />}
        {dialog === "import" && <ImportDialog target={{ table: "block", id: row.id }} onClose={() => setDialog(null)} />}
      </div>
      <div className="peek__body">
        {/* The peek shows the cover across its full width, above the icon. */}
        {row.format.cover && <PageCover block={row} />}
        {/* The row's own text size and typeface, never the host page's. */}
        <div
          className={`peek__content${row.format.small_text ? " page--small" : ""}${
            row.format.page_font && row.format.page_font !== "default" ? ` page--${row.format.page_font}` : ""
          }${row.format.cover ? " has-cover" : ""}`}
        >
          {row.is_template && <TemplateNote collection={collection} />}
          <PageHeader
            block={row}
            compact
            titleRef={titleRef}
            onEnter={(tail) => editorRef.current && insertBodyStart(editorRef.current, tail)}
            onArrowDown={() => editorRef.current && focusBodyStart(editorRef.current)}
            onPasteLines={(lines) => editorRef.current && insertBodyLines(editorRef.current, lines)}
            onComment={() => setCommenting(true)}
          />
          <RowProperties row={row} collection={collection} readOnly={!!row.format.locked || !row.alive} />
          <PeekDiscussions collection={collection} off={row.format.page_comments === "off"}>
            <PageDiscussions
              pageId={row.id}
              persistent
              composing={commenting}
              onComposed={() => setCommenting(false)}
              readOnly={!!row.format.locked}
            />
          </PeekDiscussions>
          <div className="peek__divider" />
          <TemplatePicker
            row={row}
            collection={collection}
            onApplied={body.onApplied}
            onEmpty={() => editorRef.current && focusBodyStart(editorRef.current)}
            onOpenTemplate={(id) => (onNavigate ? onNavigate(id) : navigate(id))}
          />
          <div className="peek__editor">
            <Editor key={body.key} block={row} onReady={setEditor} onExitTop={exitTop} onMergeTop={mergeTop} />
          </div>
        </div>
      </div>
    </div>
  );

  // A separate layer on <body>, so the host page's editor and text settings never reach it.
  return createPortal(
    mode === "side" ? (
      panel
    ) : (
      <div className="peek-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {panel}
      </div>
    ),
    document.body,
  );
}

/** `readOnly`: a locked page, or one in the trash, shows its values without letting them change. */
export function RowProperties({ row, collection, readOnly }: { row: Block; collection: Collection; readOnly?: boolean }) {
  const namePop = usePopover();
  const [propId, setPropId] = useState<string | null>(null);
  const addPop = usePopover();
  const [showHidden, setShowHidden] = useState(false);
  const [closedSections, setClosedSections] = useState<string[]>([]);
  const schema = propId ? collection.schema[propId] : undefined;
  // "Personalizar diseño": the saved layout, or the one being edited (its preview).
  const layout = useRowLayout(collection);
  const pl = layout.page_layout ?? {};

  // The page layout: its saved order first, then properties added since.
  const order = layout.page_properties ?? [];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const ids = Object.keys(collection.schema)
    .filter((id) => id !== "title")
    .sort((a, b) => rank(a) - rank(b));
  const isHidden = (id: string) => {
    const visibility = layout.property_visibility?.[id];
    if (visibility === "hide") return true;
    if (visibility !== "hide_if_empty") return false;
    const s = collection.schema[id];
    const value = cellValue(row, id, s);
    return s.type === "checkbox" ? !value : isEmptyValue(value);
  };
  const pinned = (pl.pinned ?? []).filter((id) => ids.includes(id));
  const sections = (pl.sections ?? []).map((sec) => ({
    ...sec,
    properties: ids.filter((id) => sec.properties.includes(id) && !pinned.includes(id)),
  }));
  const placed = new Set([...pinned, ...sections.flatMap((sec) => sec.properties)]);
  const main = ids.filter((id) => !placed.has(id));
  const visible = main.filter((id) => !isHidden(id));
  const hidden = main.filter(isHidden);
  const tabs = (pl.tabs ?? []).filter((id) => collection.schema[id]?.type === "relation");

  const nameButton = (id: string) => {
    const s = collection.schema[id];
    return (
      <button
        type="button"
        className="row-prop__name"
        data-tooltip={propertyTooltip(s)}
        onClick={(e) => {
          setPropId(id);
          namePop.open(e.currentTarget);
        }}
      >
        <TypeIcon type={s.type} size={16} />
        <span>{s.name}</span>
      </button>
    );
  };
  const renderProp = (id: string) => {
    const s = collection.schema[id];
    return (
      <div className="row-prop" key={id}>
        {nameButton(id)}
        <div className="row-prop__value">
          <PropertyCell row={row} propertyId={id} schema={s} collectionId={collection.id} variant="panel" />
        </div>
        {id !== "title" && pl.property_comments !== "off" && (
          <PropertyCommentButton pageId={row.id} propertyId={id} readOnly={readOnly} />
        )}
      </div>
    );
  };

  return (
    <>
      {pinned.length > 0 && (
        <div className={`row-pinned${readOnly ? " is-readonly" : ""}`}>
          {pinned.map((id) => (
            <div className="row-pinned__item" key={id}>
              {nameButton(id)}
              <div className="row-pinned__value">
                <PropertyCell row={row} propertyId={id} schema={collection.schema[id]} collectionId={collection.id} variant="panel" />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={`row-props${readOnly ? " is-readonly" : ""}${pl.panel ? " row-props--panel" : ""}`}>
        {pl.panel && <div className="row-props__panel-title">Propiedades</div>}
        {visible.map(renderProp)}
        {hidden.length > 0 && (
          <>
            {showHidden && hidden.map(renderProp)}
            <button
              type="button"
              className={`row-props__ghost row-props__more${showHidden ? " is-open" : ""}`}
              aria-expanded={showHidden}
              onClick={() => setShowHidden((v) => !v)}
            >
              <span className="row-props__ghost-icon">
                <ChevronDown size={16} />
              </span>
              {showHidden
                ? `Ocultar ${hidden.length} ${hidden.length === 1 ? "propiedad" : "propiedades"}`
                : `${hidden.length} ${hidden.length === 1 ? "propiedad más" : "propiedades más"}`}
            </button>
          </>
        )}
        {sections.map((sec) => {
          const open = !closedSections.includes(sec.id);
          const shownProps = sec.properties.filter((id) => !isHidden(id));
          return (
            <div className="row-section" key={sec.id}>
              <button
                type="button"
                className={`row-section__head${open ? " is-open" : ""}`}
                aria-expanded={open}
                onClick={() => setClosedSections((l) => (open ? [...l, sec.id] : l.filter((x) => x !== sec.id)))}
              >
                <ChevronRight size={14} />
                {sec.name || "Sección sin título"}
              </button>
              {open && shownProps.map(renderProp)}
              {open && !shownProps.length && <div className="row-section__empty">Sin propiedades</div>}
            </div>
          );
        })}
        {!readOnly && (
          <button type="button" className="row-props__ghost row-props__add" onClick={(e) => addPop.toggle(e.currentTarget)}>
            <span className="row-props__ghost-icon">
              <Plus size={16} />
            </span>
            Agregar una propiedad
          </button>
        )}

        {namePop.anchor && propId && schema && (
          <Popover anchor={namePop.anchor} onClose={namePop.close} width={250}>
            <PropertyMenu
              key={propId}
              collectionId={collection.id}
              propertyId={propId}
              schema={schema}
              onClose={namePop.close}
              locked={readOnly}
            />
          </Popover>
        )}
        {addPop.anchor && (
          <Popover anchor={addPop.anchor} onClose={addPop.close} width={220}>
            <AddPropertyMenu collectionId={collection.id} onDone={addPop.close} />
          </Popover>
        )}
      </div>
      {tabs.length > 0 && <RelationTabs row={row} collection={collection} tabs={tabs} />}
    </>
  );
}

/** The peek's discussions, unless the page layout (or the page's own "Comentarios de la página") turns them off. */
function PeekDiscussions({ collection, off, children }: { collection: Collection; off?: boolean; children: ReactNode }) {
  return useRowLayout(collection).page_layout?.discussions === "off" || off ? null : <>{children}</>;
}

/** Layout tabs: each relation's related pages, one relation at a time (page layout tabs). */
function RelationTabs({ row, collection, tabs }: { row: Block; collection: Collection; tabs: string[] }) {
  const [current, setCurrent] = useState(tabs[0]);
  const tab = tabs.includes(current) ? current : tabs[0];
  const refs = (row.properties[tab] as PageRef[] | undefined) ?? [];
  const pages = useLiveQuery(() => db.blocks.bulkGet(refs.map((r) => r.id)), [refs.map((r) => r.id).join()]);
  const shown = refs
    .map((ref, i) => ({ ref, page: pages?.[i] }))
    .filter(({ page }) => !page || (page.alive && !page.trashed_time));
  return (
    <div className="row-tabs">
      <div className="row-tabs__bar" role="tablist">
        {tabs.map((id) => {
          const n = ((row.properties[id] as PageRef[] | undefined) ?? []).length;
          return (
            <button
              type="button"
              role="tab"
              key={id}
              aria-selected={id === tab}
              className={`row-tabs__tab${id === tab ? " is-active" : ""}`}
              onClick={() => setCurrent(id)}
            >
              <TypeIcon type="relation" size={14} />
              {collection.schema[id].name}
              <span className="row-tabs__count">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="row-tabs__list">
        {shown.map(({ ref, page }) => (
          <button type="button" key={ref.id} className="row-tabs__item" onClick={() => page && navigate(ref.id)} disabled={!page}>
            <PageIcon block={page ?? null} size={16} />
            <span>{page ? pageTitle(page) || "Sin título" : ref.name}</span>
          </button>
        ))}
        {!shown.length && <div className="row-section__empty">Sin páginas relacionadas</div>}
      </div>
    </div>
  );
}

/** Templates open like rows; a note above the title says so. */
function TemplateNote({ collection }: { collection: Collection }) {
  const database = useBlock(collection.parent_id);
  return (
    <div className="template-banner template-banner--peek">
      <LayoutTemplate size={16} />
      <span>
        Estás editando una plantilla de <strong>{pageTitle(database)}</strong>
      </span>
    </div>
  );
}
