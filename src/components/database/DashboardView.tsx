import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowUpDown, Copy, Ellipsis, ListFilter, Pencil, Plus, Settings2, SquareArrowOutUpRight, Trash, X } from "lucide-react";
import { db } from "../../lib/db";
import type { Collection, CollectionView, DashboardRow, Filter, PropertySchema, PropertyValue } from "../../lib/model";
import { addRow, addWidget, removeWidget, setDashboardRowHeight, shortId, updateView, type WidgetKind } from "../../lib/ops";
import {
  addWidgetFromView,
  duplicateWidget,
  MAX_PER_ROW,
  moveWidget,
  setDashboardFilters,
  setRowWidths,
  useDashboardEditing,
  withDashboardFilters,
} from "../../lib/dashboard";
import { applyQuery, OPERATOR_LABELS, operatorsFor, queryComputedIds } from "../../lib/query";
import { useComputed } from "../../lib/group";
import { navigate, pageTitle, useChildren } from "../../lib/hooks";
import { MenuItem, MenuLabel, MenuSeparator, Popover, usePopover } from "../ui";
import { Chart } from "./Chart";
import { ChartSettings } from "./ChartView";
import { TableView } from "./TableView";
import { BoardView } from "./BoardView";
import { TimelineView } from "./TimelineView";
import { CalendarView, GalleryView, ListView } from "./views";
import { RowPeek } from "./RowPeek";
import { FilterPanel, FilterRule, SortPanel, VIEW_LABELS } from "./DatabaseView";
import { TypeIcon } from "./properties";

const WIDGET_KINDS: [WidgetKind, string][] = [
  ["number", "Número (KPI)"],
  ["column", "Columnas"],
  ["bar", "Barras"],
  ["line", "Líneas"],
  ["donut", "Dona"],
  ["table", "Tabla"],
  ["list", "Lista"],
  ["board", "Tablero"],
  ["gallery", "Galería"],
  ["calendar", "Calendario"],
  ["timeline", "Cronograma"],
];

const MIN_ROW = 140;
const MIN_WIDTH = 0.35;

/** The dashboard's databases (the collections its widgets show), for its filters. */
function useWidgetCollections(view: CollectionView) {
  const ids = (view.format.dashboard?.rows ?? []).flatMap((r) => r.widgets);
  return useLiveQuery(async () => {
    const widgets = (await db.views.bulkGet(ids)).filter((w): w is CollectionView => !!w);
    const cids = [...new Set(widgets.map((w) => w.collection_id))];
    return (await db.collections.bulkGet(cids)).filter((c): c is Collection => !!c);
  }, [ids.join()]);
}

/** Every property name the widgets' databases have, with the schema of the first one that has it. */
function schemaByName(collections: Collection[] | undefined) {
  const out: Record<string, PropertySchema> = {};
  for (const c of collections ?? [])
    for (const s of Object.values(c.schema)) if (!out[s.name] && s.type !== "button" && s.type !== "formula" && s.type !== "rollup") out[s.name] = s;
  return out;
}

/**
 * Rows of widgets; each widget is a view of any database. "Editar" lets
 * widgets be dragged to another place, resized by their edges and changed; the filters at the top
 * apply to every widget whose database has that property.
 */
export function DashboardView({ view }: { view: CollectionView }) {
  const rows = view.format.dashboard?.rows ?? [];
  const [editing] = useDashboardEditing(view.id);
  const collections = useWidgetCollections(view);
  const byName = schemaByName(collections);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; side: "before" | "after" } | "new_row" | null>(null);
  // Sizes being dragged, before they're saved.
  const [live, setLive] = useState<{ rowId: string; height?: number; widths?: Record<string, number> } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  if (!rows.length)
    return (
      <div className="board-empty">
        <p>Este panel aún no tiene widgets.</p>
        <p className="muted">Usa «Agregar widget» para sumar gráficos, cifras clave o tablas de cualquier base de datos.</p>
      </div>
    );

  const widthsOf = (row: DashboardRow) => (live?.rowId === row.id && live.widths ? live.widths : (row.widths ?? {}));
  const startResizeCol = (e: ReactPointerEvent, row: DashboardRow, left: string, right: string) => {
    e.preventDefault();
    const el = rowRefs.current.get(row.id);
    if (!el) return;
    const widths = { ...Object.fromEntries(row.widgets.map((w) => [w, row.widths?.[w] ?? 1])) };
    const total = row.widgets.reduce((a, w) => a + widths[w], 0);
    const perPx = total / el.clientWidth;
    const x0 = e.clientX;
    const a0 = widths[left];
    const b0 = widths[right];
    let next = widths;
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) * perPx;
      const a = Math.max(MIN_WIDTH, Math.min(a0 + b0 - MIN_WIDTH, a0 + d));
      next = { ...widths, [left]: a, [right]: a0 + b0 - a };
      setLive({ rowId: row.id, widths: next });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLive(null);
      void setRowWidths(view.id, row.id, next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const startResizeRow = (e: ReactPointerEvent, row: DashboardRow) => {
    e.preventDefault();
    const y0 = e.clientY;
    let height = row.height;
    const move = (ev: PointerEvent) => {
      height = Math.max(MIN_ROW, Math.round(row.height + ev.clientY - y0));
      setLive({ rowId: row.id, height });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLive(null);
      void setDashboardRowHeight(view.id, row.id, height);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const endDrag = () => {
    setDrag(null);
    setDrop(null);
  };

  return (
    <div className={`dashboard${editing ? " is-editing" : ""}`}>
      <DashboardFilters view={view} byName={byName} collections={collections ?? []} editing={editing} />
      {rows.map((row) => {
        const height = live?.rowId === row.id && live.height ? live.height : row.height;
        const widths = widthsOf(row);
        const full = row.widgets.length >= MAX_PER_ROW && !row.widgets.includes(drag ?? "");
        return (
          <div
            className="dashboard__row"
            key={row.id}
            style={{ height }}
            ref={(el) => {
              if (el) rowRefs.current.set(row.id, el);
              else rowRefs.current.delete(row.id);
            }}
          >
            {row.widgets.map((id, i) => (
              <div
                key={id}
                className={`dashboard__cell${drop && drop !== "new_row" && drop.id === id ? ` is-drop-${drop.side}` : ""}${drag === id ? " is-dragging" : ""}`}
                style={{ flex: `${widths[id] ?? 1} 1 0` } as CSSProperties}
                onDragOver={(e) => {
                  if (!drag || drag === id || full) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  const side = e.clientX < r.left + r.width / 2 ? "before" : "after";
                  if (!drop || drop === "new_row" || drop.id !== id || drop.side !== side) setDrop({ id, side });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag && drop && drop !== "new_row") void moveWidget(view.id, drag, drop);
                  endDrag();
                }}
              >
                <Widget
                  widgetId={id}
                  dashboard={view}
                  height={height}
                  editing={editing}
                  byName={byName}
                  onDragStart={() => setDrag(id)}
                  onDragEnd={endDrag}
                />
                {editing && i < row.widgets.length - 1 && (
                  <div
                    className="dashboard__col-resize"
                    role="separator"
                    aria-label="Cambiar el ancho"
                    onPointerDown={(e) => startResizeCol(e, row, id, row.widgets[i + 1])}
                  />
                )}
              </div>
            ))}
            {editing && (
              <div className="dashboard__row-resize" role="separator" aria-label="Cambiar el alto" onPointerDown={(e) => startResizeRow(e, row)} />
            )}
          </div>
        );
      })}
      {drag && (
        <div
          className={`dashboard__newrow${drop === "new_row" ? " is-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (drop !== "new_row") setDrop("new_row");
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={(e) => {
            e.preventDefault();
            void moveWidget(view.id, drag, "new_row");
            endDrag();
          }}
        >
          Suelta aquí para ponerlo en una fila nueva
        </div>
      )}
    </div>
  );
}

/** The dashboard's filters: chips over the widgets; each one edits like a view's rule. */
function DashboardFilters({
  view,
  byName,
  collections,
  editing,
}: {
  view: CollectionView;
  byName: Record<string, PropertySchema>;
  collections: Collection[];
  editing: boolean;
}) {
  const filters = (view.format.dashboard?.filters ?? []).filter((f) => byName[f.property]);
  const addPop = usePopover();
  const editPop = usePopover();
  const [current, setCurrent] = useState<string | null>(null);
  if (!filters.length && !editing) return null;
  const save = (next: Filter[]) => void setDashboardFilters(view.id, next);
  const names = Object.keys(byName);
  const base = collections[0]?.id ?? view.collection_id;
  const filter = filters.find((f) => f.id === current);
  const label = (f: Filter) => {
    const v = f.value;
    const schema = byName[f.property];
    const text = Array.isArray(v)
      ? v.map((x) => (typeof x === "string" ? (schema.options?.find((o) => o.id === x)?.value ?? x) : "")).join(", ")
      : typeof v === "string"
        ? (schema.options?.find((o) => o.id === v)?.value ?? v)
        : v === undefined || v === null
          ? ""
          : String(v);
    return `${f.property}: ${OPERATOR_LABELS[f.operator]}${text ? ` ${text}` : ""}`;
  };
  return (
    <div className="dashboard__filters">
      <ListFilter size={14} className="dashboard__filters-icon" />
      {filters.map((f) => (
        <button
          type="button"
          key={f.id}
          className="db-chip is-active"
          onClick={(e) => {
            setCurrent(f.id);
            editPop.toggle(e.currentTarget);
          }}
        >
          {label(f)}
        </button>
      ))}
      {editing && (
        <button type="button" className="db-chip" onClick={(e) => addPop.toggle(e.currentTarget)}>
          <Plus size={14} /> Filtro del panel
        </button>
      )}
      {addPop.anchor && (
        <Popover anchor={addPop.anchor} onClose={addPop.close} width={260}>
          <div className="menu menu-scroll">
            <MenuLabel>Filtrar todos los widgets por</MenuLabel>
            {names.map((name) => (
              <MenuItem
                key={name}
                icon={<TypeIcon type={byName[name].type} size={16} />}
                onClick={() => {
                  addPop.close();
                  const id = shortId();
                  save([...filters, { id, property: name, operator: operatorsFor(byName[name].type)[0], value: undefined }]);
                }}
              >
                {name}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
      {editPop.anchor && filter && (
        <Popover anchor={editPop.anchor} onClose={editPop.close} width={520}>
          <div className="rule-panel">
            <FilterRule
              lead="Donde"
              filter={filter}
              schema={byName}
              collectionId={base}
              order={names}
              onChange={(patch) => save(filters.map((x) => (x.id === filter.id ? { ...x, ...patch } : x)))}
              onRemove={() => {
                editPop.close();
                save(filters.filter((x) => x.id !== filter.id));
              }}
              onDuplicate={() => save([...filters, { ...structuredClone(filter), id: shortId() }])}
            />
          </div>
        </Popover>
      )}
    </div>
  );
}

function Widget({
  widgetId,
  dashboard,
  height,
  editing,
  byName,
  onDragStart,
  onDragEnd,
}: {
  widgetId: string;
  dashboard: CollectionView;
  height: number;
  editing: boolean;
  byName: Record<string, PropertySchema>;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const dashboardId = dashboard.id;
  const view = useLiveQuery(() => db.views.get(widgetId), [widgetId]);
  const collection = useLiveQuery(
    async () => (view ? ((await db.collections.get(view.collection_id)) ?? null) : undefined),
    [view?.collection_id],
  );
  const source = useLiveQuery(
    async () => (collection ? ((await db.blocks.get(collection.parent_id)) ?? null) : undefined),
    [collection?.parent_id],
  );
  const rows = useChildren("collection", view?.collection_id ?? "");
  const menu = usePopover();
  const settings = usePopover();
  const panel = usePopover();
  const [panelKind, setPanelKind] = useState<"filter" | "sort" | null>(null);
  const [peekId, setPeekId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  // Formula and rollup results the widget's filters and sorts read.
  const computed = useComputed(rows, collection ?? undefined, view && collection ? queryComputedIds(view.query2, collection.schema) : []);

  if (view === undefined || collection === undefined) return <div className="widget" />;
  if (!view || !collection)
    return (
      <div className="widget widget--missing">
        <span>Widget sin datos</span>
        <button type="button" className="text-btn" onClick={() => void removeWidget(dashboardId, widgetId)}>
          Quitar
        </button>
      </div>
    );

  // The widget's own filters and sorts, and the dashboard's filters on top.
  const query = withDashboardFilters(view.query2, collection, dashboard.format.dashboard?.filters, byName);
  const shown = applyQuery(rows ?? [], collection.schema, query, view.format.page_sort, computed);
  const bodyHeight = height - 44;
  const newRow = async (values: Record<string, PropertyValue> = {}) => setPeekId(await addRow(collection.id, values));
  const isNumber = view.type === "chart" && view.format.chart?.type === "number";
  // A table widget starts its columns narrow, so more of them fit.
  const shownView: CollectionView =
    view.type === "table"
      ? {
          ...view,
          format: {
            ...view.format,
            properties: view.format.properties.map((p) => ({ ...p, width: p.width ?? (p.property === "title" ? 180 : 120) })),
          },
        }
      : view;

  let body;
  switch (view.type) {
    case "chart":
      body = view.format.chart && (
        <Chart rows={shown} collection={collection} config={view.format.chart} height={isNumber ? undefined : bodyHeight} exportId={view.id} />
      );
      break;
    case "board":
      body = <BoardView view={view} collection={collection} rows={shown} onOpen={setPeekId} onNew={newRow} />;
      break;
    case "list":
      body = <ListView view={view} collection={collection} rows={shown} onOpen={setPeekId} onNew={() => void newRow()} />;
      break;
    case "gallery":
      body = <GalleryView view={view} collection={collection} rows={shown} onOpen={setPeekId} onNew={() => void newRow()} />;
      break;
    case "calendar":
      body = <CalendarView view={view} collection={collection} rows={shown} onOpen={setPeekId} onNew={newRow} />;
      break;
    case "timeline":
      body = <TimelineView view={view} collection={collection} rows={shown} onOpen={setPeekId} onNew={newRow} />;
      break;
    default:
      body = <TableView view={shownView} collection={collection} rows={shown} onOpen={setPeekId} />;
  }
  const own = view.query2.filters.length + (view.query2.filter_groups?.length ?? 0);

  return (
    <div className={`widget widget--${view.type}${isNumber ? " widget--number" : ""}`}>
      <div
        className="widget__head"
        draggable={editing && !renaming}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("application/x-xot-widget", widgetId);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
      >
        {renaming ? (
          <input
            className="field field--sm"
            autoFocus
            defaultValue={view.name}
            onBlur={(e) => {
              setRenaming(false);
              if (e.target.value.trim()) void updateView(view.id, { name: e.target.value.trim() });
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className="widget__title" onDoubleClick={() => editing && setRenaming(true)}>
            {view.name}
            {source && <span className="widget__source"> · {pageTitle(source)}</span>}
            {own > 0 && <ListFilter size={12} className="widget__filtered" aria-label="Con filtros" />}
          </span>
        )}
        {editing && (
          <span className="widget__actions">
            {view.type === "chart" && (
              <button type="button" className="icon-btn icon-btn--sm" aria-label="Configurar" onClick={(e) => settings.toggle(e.currentTarget)}>
                <Settings2 size={14} />
              </button>
            )}
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Más" onClick={(e) => menu.toggle(e.currentTarget)}>
              <Ellipsis size={15} />
            </button>
          </span>
        )}
      </div>
      <div className="widget__body">{body}</div>

      {settings.anchor && (
        <Popover anchor={settings.anchor} onClose={settings.close} width={300} align="end">
          <ChartSettings view={view} collection={collection} />
        </Popover>
      )}
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} width={220} align="end">
          <div className="menu">
            <MenuItem
              icon={<Pencil size={15} />}
              onClick={() => {
                menu.close();
                setRenaming(true);
              }}
            >
              Renombrar
            </MenuItem>
            <MenuItem
              icon={<ListFilter size={15} />}
              right={own ? <span className="muted">{own}</span> : null}
              onClick={(e) => {
                setPanelKind("filter");
                panel.open(e.currentTarget);
              }}
            >
              Filtrar
            </MenuItem>
            <MenuItem
              icon={<ArrowUpDown size={15} />}
              right={view.query2.sort.length ? <span className="muted">{view.query2.sort.length}</span> : null}
              onClick={(e) => {
                setPanelKind("sort");
                panel.open(e.currentTarget);
              }}
            >
              Ordenar
            </MenuItem>
            <MenuItem
              icon={<Copy size={15} />}
              onClick={() => {
                menu.close();
                void duplicateWidget(dashboardId, widgetId);
              }}
            >
              Duplicar
            </MenuItem>
            {source && (
              <MenuItem
                icon={<SquareArrowOutUpRight size={15} />}
                onClick={() => {
                  menu.close();
                  navigate(source.id);
                }}
              >
                Abrir base de datos
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash size={15} />}
              onClick={() => {
                menu.close();
                void removeWidget(dashboardId, widgetId);
              }}
            >
              Quitar widget
            </MenuItem>
          </div>
        </Popover>
      )}
      {panel.anchor && panelKind && (
        <Popover
          anchor={panel.anchor}
          onClose={() => {
            panel.close();
            setPanelKind(null);
            menu.close();
          }}
          width={panelKind === "filter" ? 560 : 360}
          align="end"
        >
          {panelKind === "filter" ? <FilterPanel view={view} collection={collection} /> : <SortPanel view={view} collection={collection} />}
        </Popover>
      )}
      {peekId && (
        <RowPeek
          rowId={peekId}
          collection={collection}
          onClose={() => setPeekId(null)}
          rowIds={shown.map((r) => r.id)}
          onNavigate={setPeekId}
        />
      )}
    </div>
  );
}

/** Toolbar control: "Editar" / "Listo", and while editing, "Agregar widget" (a database and a kind, or an existing view). */
export function AddWidgetButton({ view, defaultCollection }: { view: CollectionView; defaultCollection: string }) {
  const pop = usePopover();
  const [editing, setEditing] = useDashboardEditing(view.id);
  const [collectionId, setCollectionId] = useState(defaultCollection);
  const databases = useLiveQuery(async () => {
    const pages = (await db.blocks.toArray()).filter((b) => b.alive && b.type === "collection_view_page" && b.collection_id);
    const seen = new Set<string>();
    return pages.filter((b) => !seen.has(b.collection_id!) && seen.add(b.collection_id!));
  });
  // "Usar una vista existente": the chosen database's own views (dashboards and forms aside).
  const existing = useLiveQuery(async () => {
    const owner = (databases ?? []).find((b) => b.collection_id === collectionId);
    if (!owner) return [];
    return (await db.views.bulkGet(owner.view_ids ?? [])).filter(
      (v): v is CollectionView => !!v && v.type !== "dashboard" && v.type !== "form" && v.id !== view.id,
    );
  }, [collectionId, databases]);
  const empty = !view.format.dashboard?.rows.length;
  if (!editing && !empty)
    return (
      <button type="button" className="ghost-btn dashboard__mode" onClick={() => setEditing(true)}>
        <Pencil size={14} /> Editar
      </button>
    );
  return (
    <>
      {editing && (
        <button type="button" className="ghost-btn dashboard__mode" onClick={() => setEditing(false)}>
          <X size={14} /> Listo
        </button>
      )}
      <button
        type="button"
        className="primary-btn"
        onClick={(e) => {
          setEditing(true);
          pop.toggle(e.currentTarget);
        }}
      >
        <Plus size={14} /> Agregar widget
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={260} align="end">
          <div className="menu menu-scroll">
            <MenuLabel>Datos de</MenuLabel>
            <div className="menu-pad">
              <select className="field field--sm" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                {(databases ?? []).map((b) => (
                  <option key={b.id} value={b.collection_id}>
                    {pageTitle(b)}
                  </option>
                ))}
              </select>
            </div>
            <MenuSeparator />
            <MenuLabel>Tipo de widget</MenuLabel>
            {WIDGET_KINDS.map(([kind, label]) => (
              <MenuItem
                key={kind}
                onClick={() => {
                  pop.close();
                  void addWidget(view.id, collectionId, kind);
                }}
              >
                {label}
              </MenuItem>
            ))}
            {!!existing?.length && (
              <>
                <MenuSeparator />
                <MenuLabel>Usar una vista existente</MenuLabel>
                {existing.map((v) => (
                  <MenuItem
                    key={v.id}
                    right={<span className="muted">{VIEW_LABELS[v.type]}</span>}
                    onClick={() => {
                      pop.close();
                      void addWidgetFromView(view.id, v.id);
                    }}
                  >
                    {v.name}
                  </MenuItem>
                ))}
              </>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
