import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowDownToLine,
  ArrowUpDown,
  Calendar,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CalendarX,
  ChartBar,
  ChartColumn,
  ChartGantt,
  ChartLine,
  ChartPie,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Columns3,
  CopyPlus,
  Crop,
  Ellipsis,
  GripVertical,
  Eye,
  EyeOff,
  FileText,
  FileUp,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutGrid,
  Map as MapIcon,
  MapPin,
  Link,
  List,
  ListFilter,
  ListTree,
  Lock,
  Maximize2,
  MoveHorizontal,
  Paintbrush,
  Newspaper,
  PaintBucket,
  PanelRight,
  Plus,
  Rows3,
  Scaling,
  Search,
  SlidersHorizontal,
  SquareKanban,
  Table2,
  Trash,
  Workflow,
  WrapText,
  X,
} from "lucide-react";
import { db } from "../../lib/db";
import { LOCAL_PERSON } from "../../lib/model";
import type {
  Block,
  Collection,
  CollectionView,
  Filter,
  FilterGroup,
  GroupBy,
  PropertySchema,
  PropertyValue,
  Query,
  ViewProperty,
  ViewType,
} from "../../lib/model";
import {
  addDependencyProperties,
  addRow,
  addRowFromTemplate,
  addView,
  deleteView,
  disableSubitems,
  duplicateView,
  effectiveTemplate,
  enableSubitems,
  setFormat,
  shortId,
  updateBlock,
  updateView,
} from "../../lib/ops";
import {
  applyQuery,
  countActiveFilters,
  dateDay,
  effectiveSchema,
  groupRules,
  needsValue,
  OPERATOR_LABELS,
  operatorsFor,
  PERSON_TYPES,
  plainText,
  queryComputedIds,
  subitemConfig,
  WITHIN_LABELS,
  type ResultKind,
} from "../../lib/query";
import { RELATIVE_DATES } from "../../lib/format";
import { defaultChart } from "../../lib/chart";
import {
  boardGroupBy,
  GROUPABLE_TYPES,
  groupRows,
  isComputedGroup,
  NO_GROUP,
  numberRange,
  useComputed,
  useGroupValues,
  viewGrouping,
} from "../../lib/group";
import {
  navigate,
  openInNewTab,
  pageTitle,
  useBlock,
  useChildren,
  useStoredState,
  wantsNewTab,
} from "../../lib/hooks";
import { copyLink, MenuItem, MenuLabel, MenuSeparator, PageIcon, Popover, Switch, usePopover } from "../ui";
import { AddPropertyMenu, DatePicker, Tag, TypeIcon } from "./properties";
import { TableView } from "./TableView";
import { BoardView, boardColumns, boardRowOrder, ColumnLabel, columnSetting, savedColumns, type Column } from "./BoardView";
import { CalendarView, GalleryView, ListView } from "./views";
import { FeedView, FormView } from "./FeedFormViews";
import { filterWithSubitems } from "../../lib/subitems";
import { ColorRulesMenu } from "./ConditionalColor";
import { MapView } from "./MapView";
import { TimelineView } from "./TimelineView";
import { ChartSettings, ChartView } from "./ChartView";
import { AddWidgetButton, DashboardView } from "./DashboardView";
import { RowPeek } from "./RowPeek";
import { AutomationsButton } from "./Automations";
import { TemplateMenu } from "./TemplateMenu";
import { GroupValue } from "./GroupHeader";
import { mergeCsvFile } from "../ImportDialog";
import { AddViewToSidebarItem } from "../SidebarCustomizer";
import { WIKI_HOME_ICON, WikiHome } from "../WikiHome";

export const VIEW_LABELS: Record<ViewType, string> = {
  table: "Tabla",
  board: "Tablero",
  list: "Lista",
  gallery: "Galería",
  calendar: "Calendario",
  timeline: "Cronograma",
  chart: "Gráfico",
  feed: "Feed",
  form: "Formulario",
  dashboard: "Panel de control",
  map: "Mapa",
};

export const VIEW_ICONS: Record<ViewType, typeof Table2> = {
  table: Table2,
  board: SquareKanban,
  list: List,
  gallery: LayoutGrid,
  calendar: CalendarDays,
  timeline: ChartGantt,
  chart: ChartColumn,
  feed: Newspaper,
  form: ClipboardList,
  dashboard: LayoutDashboard,
  map: MapIcon,
};

/** A view's icon; a chart view follows its chart type. */
export function viewIcon(view: CollectionView): typeof Table2 {
  if (view.format.wiki_home) return WIKI_HOME_ICON;
  if (view.type !== "chart") return VIEW_ICONS[view.type];
  const type = view.format.chart?.type;
  return type === "donut" ? ChartPie : type === "line" ? ChartLine : type === "bar" ? ChartBar : ChartColumn;
}

/** View property order, healed against the schema (new or deleted properties). */
export function viewProperties(view: CollectionView, collection: Collection): ViewProperty[] {
  const known = view.format.properties.filter((p) => collection.schema[p.property]);
  const missing = Object.keys(collection.schema)
    .filter((id) => !known.some((p) => p.property === id))
    .map((property) => ({ property, visible: true }));
  const all = [...known, ...missing];
  const title = all.find((p) => p.property === "title");
  if (!title) return all;
  // The title always shows. It leads unless the user dragged it elsewhere in a table
  // (imports list it last when the source's own order omits it, which means first there).
  if (view.format.table_title_moved) return all.map((p) => (p === title ? { ...p, visible: true } : p));
  return [{ ...title, visible: true }, ...all.filter((p) => p !== title)];
}

/** Values implied by AND filters, so a new row stays visible in the view. */
export function defaultsFromQuery(query: Query, schema: Record<string, PropertySchema>) {
  const values: Record<string, PropertyValue> = {};
  if (query.filter_operator !== "and") return values;
  for (const f of query.filters) {
    const prop = schema[f.property];
    if (!prop || f.value === undefined || f.value === null || f.value === "") continue;
    // A checklist filter with several options can't pick one for the new row.
    const one = Array.isArray(f.value) ? (f.value.length === 1 ? (f.value[0] as string) : null) : f.value;
    if (f.operator === "is" && prop.type !== "multi_select" && one !== null && !String(one).startsWith("group:"))
      values[f.property] = one;
    if (f.operator === "contains" && prop.type === "multi_select")
      values[f.property] = Array.isArray(f.value) ? (f.value as string[]) : [f.value as string];
  }
  return values;
}

/** Rows whose title or text-like properties contain the search text (the in-view search). */
function searchRows(rows: Block[], schema: Record<string, PropertySchema>, search: string) {
  const q = search.trim().toLowerCase();
  if (!q) return rows;
  const props = Object.entries(schema).filter(([, s]) =>
    ["title", "text", "url", "email", "phone_number", "select", "multi_select", "status", "person", "relation"].includes(s.type),
  );
  return rows.filter((row) =>
    props.some(([id, s]) => {
      const v = row.properties[id];
      const text =
        s.type === "select" || s.type === "status" || s.type === "multi_select"
          ? (Array.isArray(v) ? v : [v])
              .map((o) => s.options?.find((opt) => opt.id === o)?.value ?? "")
              .join(" ")
          : plainText(v);
      return text.toLowerCase().includes(q);
    }),
  );
}

/** Result kinds of the database's formulas and rollups, so their filters offer the right operators. */
const KindsContext = createContext<Record<string, ResultKind>>({});
/** A database inside a database template: the template's id, so its relation filters can name "Esta página". */
const TemplateHostContext = createContext<string | null>(null);

/** A property as its filter sees it: formulas and rollups by their result type. */
function useFilterSchema() {
  const kinds = useContext(KindsContext);
  return (schema: PropertySchema, id: string) => effectiveSchema(schema, kinds[id]);
}

export function DatabaseView({
  block,
  embedded = false,
  title,
}: {
  block: Block;
  embedded?: boolean;
  /** The inline title, shown above the view (inline databases). */
  title?: ReactNode;
}) {
  const collectionId = block.collection_id!;
  const collection = useLiveQuery(() => db.collections.get(collectionId), [collectionId]);
  const viewOrder = (block.view_ids ?? []).join(",");
  const views = useLiveQuery(async () => {
    const list = await db.views.where("parent_id").equals(block.id).toArray();
    const order = viewOrder.split(",");
    return list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [block.id, viewOrder]);
  const rows = useChildren("collection", collectionId);
  // An inline database (or linked view) is locked with the page that holds it.
  const host = useBlock(embedded && block.parent_table === "block" ? block.parent_id : null);
  const [activeId, setActiveId] = useStoredState(`xotion:view:${block.id}`, "");
  const [peekId, setPeekId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // The filter chip whose editor opens once it is on screen (a filter just added).
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  // Views whose filter/sort chip bar is shown: it stays folded until the filter button opens it.
  const [barViews, setBarViews] = useStoredState<string[]>(`xotion:bar:${block.id}`, []);
  // "Copiar enlace a la vista" links open the database on that view ("#/<database>?v=<view>").
  useEffect(() => {
    const pick = () => {
      const v = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("v");
      if (v && viewOrder.split(",").includes(v)) setActiveId(v);
    };
    pick();
    window.addEventListener("hashchange", pick);
    return () => window.removeEventListener("hashchange", pick);
  }, [viewOrder]);

  // Formula and rollup results the view filters or sorts by, and every computed property's result kind.
  const current = views?.find((v) => v.id === activeId) ?? views?.[0];
  const computed = useComputed(rows, collection, current && collection ? queryComputedIds(current.query2, collection.schema) : []);

  if (!collection || !views || !rows) return null;
  const view = views.find((v) => v.id === activeId) ?? views[0];
  if (!view) return null;
  // Sub-items: the filter can apply to top-level rows only, or to sub-items only.
  const subConfig = subitemConfig(collection);
  const subFilter = view.format.subitems_filter ?? "both";
  const queried = applyQuery(rows, collection.schema, view.query2, view.format.page_sort, computed);
  const shown = searchRows(
    subConfig && subFilter !== "both"
      ? filterWithSubitems(
          applyQuery(rows, collection.schema, { ...view.query2, filters: [], filter_groups: [] }, view.format.page_sort, computed),
          queried,
          subConfig.parent,
          subFilter,
        )
      : queried,
    collection.schema,
    search,
  );
  const openIn = view.format.open_pages_in ?? "side";
  const openRow = (id: string) => {
    // ⌘-click on a row, card or event opens it in a new tab (Xot.app).
    const click = window.event;
    if (click instanceof MouseEvent && click.type === "click" && wantsNewTab(click)) return openInNewTab(id);
    if (openIn === "full") navigate(id);
    else setPeekId(id);
  };
  // The peek's ↑/↓ follow the rows as this view lays them out.
  const peekOrder = () => {
    if (view.type === "board") return boardRowOrder(view, collection, shown);
    const grouping = viewGrouping(view, collection.schema);
    if (grouping && (view.type === "table" || view.type === "list" || view.type === "gallery" || view.type === "timeline"))
      return [...new Set(groupRows(shown, grouping.groupBy, grouping.schema).flatMap((g) => g.rows.map((r) => r.id)))];
    const by = view.format.calendar_by;
    if (view.type === "calendar" && by && collection.schema[by])
      return shown
        .filter((r) => dateDay(r.properties[by]))
        .sort((a, b) => dateDay(a.properties[by]).localeCompare(dateDay(b.properties[by])))
        .map((r) => r.id);
    return shown.map((r) => r.id);
  };

  const newRow = async (values: Record<string, PropertyValue> = {}, mode?: "side" | "full", templateId?: string) => {
    const defaults = { ...defaultsFromQuery(view.query2, collection.schema), ...values };
    // Without a choice, the view's or the database's default template (if any); "" is "Página vacía".
    const template = templateId ?? effectiveTemplate(collection, view);
    const id = template
      ? await addRowFromTemplate(collection.id, template, defaults)
      : await addRow(collection.id, defaults);
    if (mode === "side") setPeekId(id);
    else if (mode === "full") navigate(id);
    else openRow(id);
  };
  /** A filter on a property, with its chip editor opened ("Filtrar por…"). */
  const addFilter = async (property: string) => {
    const id = shortId();
    const operator = operatorsFor(effectiveSchema(collection.schema[property], computed.kinds?.[property]).type)[0];
    await updateView(view.id, {
      query2: { ...view.query2, filters: [...view.query2.filters, { id, property, operator }] },
    });
    showBar(true);
    setOpenFilter(id);
  };
  const hasRules = view.query2.filters.length > 0 || !!view.query2.filter_groups?.length || view.query2.sort.length > 0;
  const barShown = barViews.includes(view.id);
  const showBar = (on: boolean) =>
    setBarViews((list) => (on ? (list.includes(view.id) ? list : [...list, view.id]) : list.filter((id) => id !== view.id)));

  /** Board and gallery cards created in place: the row is added but not opened (from the default template, if any). */
  const createRow = (values: Record<string, PropertyValue> = {}, order?: number) => {
    const template = effectiveTemplate(collection, view);
    const defaults = { ...defaultsFromQuery(view.query2, collection.schema), ...values };
    return template ? addRowFromTemplate(collection.id, template, defaults, { order }) : addRow(collection.id, defaults, order);
  };

  // One view and a title: the toolbar goes on the title row, with no tab row.
  const titled = !!title && views.length === 1 && !collection.description;
  // "Bloquear base de datos": views and properties stay as they are; rows can still be added and edited.
  const locked = !!block.format.locked || !!host?.format.locked;

  return (
    <KindsContext.Provider value={computed.kinds ?? {}}>
      <TemplateHostContext.Provider value={host?.is_template ? host.id : null}>
      {!titled && title}
      <div className={`database${titled ? " database--titled" : ""}`}>
        {collection.description && <p className="db-description">{collection.description}</p>}
        <Toolbar
          block={block}
          title={titled ? title : undefined}
          views={views}
          view={view}
          collection={collection}
          rows={shown}
          onSelect={setActiveId}
          onNew={(mode, templateId) => void newRow({}, mode, templateId)}
          onOpenTemplate={openRow}
          search={search}
          onSearch={setSearch}
          embedded={embedded}
          onAddFilter={addFilter}
          onToggleBar={() => showBar(!barShown)}
          onSortAdded={() => showBar(true)}
          locked={locked}
        />
        {hasRules && barShown && view.type !== "dashboard" && (
          <FilterBar
            view={view}
            collection={collection}
            openFilter={openFilter}
            onOpened={() => setOpenFilter(null)}
            onAddFilter={addFilter}
          />
        )}
        {view.format.wiki_home ? (
          <WikiHome block={block} />
        ) : view.type === "table" ? (
          <TableView
            view={view}
            collection={collection}
            rows={shown}
            onOpen={openRow}
            onPeek={setPeekId}
            onFilter={(property) => void addFilter(property)}
            locked={locked}
          />
        ) : view.type === "board" ? (
          <BoardView
            view={view}
            collection={collection}
            rows={shown}
            onOpen={openRow}
            onNew={newRow}
            onCreate={createRow}
            locked={locked}
          />
        ) : view.type === "list" ? (
          <ListView view={view} collection={collection} rows={shown} onOpen={openRow} onNew={() => void newRow()} />
        ) : view.type === "gallery" ? (
          <GalleryView
            view={view}
            collection={collection}
            rows={shown}
            onOpen={openRow}
            onNew={() => void newRow()}
            onCreate={() => createRow()}
          />
        ) : view.type === "calendar" ? (
          <CalendarView view={view} collection={collection} rows={shown} onOpen={openRow} onNew={newRow} />
        ) : view.type === "timeline" ? (
          <TimelineView view={view} collection={collection} rows={shown} onOpen={openRow} onNew={newRow} />
        ) : view.type === "chart" ? (
          <ChartView view={view} collection={collection} rows={shown} onOpen={openRow} />
        ) : view.type === "feed" ? (
          <FeedView view={view} collection={collection} rows={shown} onOpen={openRow} onNew={() => void newRow()} />
        ) : view.type === "form" ? (
          <FormView view={view} collection={collection} onOpen={openRow} />
        ) : view.type === "map" ? (
          <MapView view={view} collection={collection} rows={shown} onOpen={openRow} />
        ) : (
          <DashboardView view={view} />
        )}
        {peekId && (
          <RowPeek
            rowId={peekId}
            collection={collection}
            onClose={() => setPeekId(null)}
            rowIds={peekOrder()}
            onNavigate={setPeekId}
            mode={openIn === "center" ? "center" : "side"}
            onModeChange={(mode) => {
              void updateView(view.id, { format: { ...view.format, open_pages_in: mode } });
              if (mode === "full") navigate(peekId);
            }}
          />
        )}
      </div>
      </TemplateHostContext.Provider>
    </KindsContext.Provider>
  );
}

// ---------------------------------------------------------------- toolbar

function Toolbar({
  block,
  title,
  views,
  view,
  collection,
  rows,
  onSelect,
  onNew,
  onOpenTemplate,
  search,
  onSearch,
  embedded,
  onAddFilter,
  onToggleBar,
  onSortAdded,
  locked,
}: {
  block: Block;
  /** Shown in place of the view tabs (an inline database with a single view). */
  title?: ReactNode;
  views: CollectionView[];
  view: CollectionView;
  collection: Collection;
  /** The view's rows (filtered and sorted), for the board's group list in "Agrupar". */
  rows: Block[];
  onSelect: (id: string) => void;
  onNew: (mode?: "side" | "full", templateId?: string) => void;
  /** Opens a template page for editing (it never shows among the rows). */
  onOpenTemplate: (id: string) => void;
  search: string;
  onSearch: (value: string) => void;
  embedded: boolean;
  onAddFilter: (property: string) => void;
  onToggleBar: () => void;
  /** A first sort was picked: the chip bar shows it. */
  onSortAdded: () => void;
  /** A locked database: no view can be added, renamed, moved or set up. */
  locked: boolean;
}) {
  const addPop = usePopover();
  const viewPop = usePopover();
  const filterPop = usePopover();
  const sortPop = usePopover();
  const propsPop = usePopover();
  const newPop = usePopover();
  const morePop = usePopover();
  const settingsRef = useRef<HTMLButtonElement>(null);
  const [searching, setSearching] = useState(false);
  const hidden = useHiddenTabs(
    views.map((v) => v.id),
    view.id,
  );
  const tabViews = [
    ...hidden.order.map((id) => views.find((v) => v.id === id)).filter((v): v is CollectionView => !!v),
    ...views.filter((v) => !hidden.order.includes(v.id)),
  ];
  const filters = countActiveFilters(view.query2, collection.schema);
  const sorts = view.query2.sort.length;
  const [advanced, setAdvanced] = useState(false);
  const order = viewProperties(view, collection).map((p) => p.property);
  // Tabs reorder by drag: the dragged view goes before or after the one under the pointer.
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dropTab, setDropTab] = useState<{ id: string; after: boolean } | null>(null);
  const dropTabOn = (e: React.DragEvent<HTMLElement>, id: string) => {
    if (!dragTab || dragTab === id) return setDropTab(null);
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDropTab({ id, after: e.clientX > r.left + r.width / 2 });
  };
  const moveTab = () => {
    if (dragTab && dropTab) {
      const ids = (block.view_ids ?? views.map((v) => v.id)).filter((id) => id !== dragTab);
      const at = ids.indexOf(dropTab.id);
      if (at >= 0) {
        ids.splice(at + (dropTab.after ? 1 : 0), 0, dragTab);
        void updateBlock(block.id, { view_ids: ids });
      }
    }
    setDragTab(null);
    setDropTab(null);
  };

  return (
    <div className={`db-toolbar${title ? " db-toolbar--titled" : ""}`}>
      {title ? (
        <div className="db-toolbar__title">{title}</div>
      ) : (
        <div className="db-tabs">
          <div className="db-tabs__list" role="tablist" ref={hidden.ref}>
            {tabViews.map((v) => {
              const Icon = viewIcon(v);
              const active = v.id === view.id;
              return (
                <button
                  key={v.id}
                  data-view={v.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`db-tab${active ? " is-active" : ""}${hidden.ids.includes(v.id) ? " is-clipped" : ""}${
                    dropTab?.id === v.id ? (dropTab.after ? " is-drop-after" : " is-drop-before") : ""
                  }${dragTab === v.id ? " is-dragging" : ""}`}
                  onClick={(e) => (active ? !locked && viewPop.toggle(e.currentTarget) : onSelect(v.id))}
                  draggable={views.length > 1 && !locked}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", v.name);
                    setDragTab(v.id);
                  }}
                  onDragOver={(e) => dropTabOn(e, v.id)}
                  onDrop={(e) => {
                    e.preventDefault();
                    moveTab();
                  }}
                  onDragEnd={() => {
                    setDragTab(null);
                    setDropTab(null);
                  }}
                >
                  <Icon size={16} strokeWidth={1.8} />
                  <span className="db-tab__name">{v.name}</span>
                </button>
              );
            })}
          </div>
          {hidden.ids.length > 0 && (
            <button
              type="button"
              className="db-tab db-tab--more"
              onClick={(e) => morePop.toggle(e.currentTarget)}
            >
              {hidden.ids.length} más
            </button>
          )}
          {!locked && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Agregar una nueva vista"
              data-tooltip="Agregar una nueva vista"
              onClick={(e) => addPop.toggle(e.currentTarget)}
            >
              <Plus size={16} />
            </button>
          )}
        </div>
      )}

      <div className="db-actions">
        {locked && block.format.locked && (
          <button
            type="button"
            className="db-locked"
            title="Esta base de datos está bloqueada. Haz clic para desbloquearla."
            onClick={() => void setFormat(block.id, { locked: false })}
          >
            <Lock size={14} /> Bloqueada
          </button>
        )}
        {title && !locked && (
          <button
            type="button"
            className="db-icon-btn db-icon-btn--optional"
            aria-label="Agregar una nueva vista"
            title="Agregar una nueva vista"
            onClick={(e) => addPop.toggle(e.currentTarget)}
          >
            <Plus size={16} />
          </button>
        )}
        {view.type === "dashboard" ? (
          <AddWidgetButton view={view} defaultCollection={collection.id} />
        ) : (
          <>
            {/* A form asks for new pages: there is nothing to filter, sort or search. */}
            {view.type !== "form" && (
              <button
                type="button"
                className={`db-icon-btn db-icon-btn--optional${filters ? " is-on" : ""}`}
                aria-label="Filtro"
                title={filters ? `Filtro · ${filters}` : "Filtro"}
                onClick={(e) => {
                  // With filter rules in place the button shows or hides the chip bar;
                  // without any (even with sorts) it picks the property of the first filter.
                  if (view.query2.filters.length || view.query2.filter_groups?.length) return onToggleBar();
                  setAdvanced(false);
                  filterPop.toggle(e.currentTarget);
                }}
              >
                <ListFilter size={16} />
              </button>
            )}
            {view.type !== "chart" && view.type !== "form" && (
              <button
                type="button"
                className={`db-icon-btn db-icon-btn--optional${sorts ? " is-on" : ""}`}
                aria-label="Ordenar"
                title={sorts ? `Ordenar · ${sorts}` : "Ordenar"}
                onClick={(e) => sortPop.toggle(e.currentTarget)}
              >
                <ArrowUpDown size={16} />
              </button>
            )}
            <AutomationsButton collection={collection} views={views} />
            {view.type !== "chart" && view.type !== "form" && !searching && (
              <button
                type="button"
                className="db-icon-btn db-icon-btn--optional"
                aria-label="Buscar"
                title="Buscar"
                onClick={() => setSearching(true)}
              >
                <Search size={16} />
              </button>
            )}
            {searching && (
              <div className="db-search-wrap">
                <Search size={16} className="db-search-wrap__icon" />
                <input
                  className="db-search"
                  autoFocus
                  placeholder="Escribe para buscar…"
                  value={search}
                  onChange={(e) => onSearch(e.target.value)}
                  onBlur={() => !search && setSearching(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      onSearch("");
                      setSearching(false);
                    }
                  }}
                />
                {search && (
                  <button
                    type="button"
                    className="db-search-wrap__clear"
                    aria-label="Borrar búsqueda"
                    title="Borrar búsqueda"
                    // Keep the field focused, so it doesn't collapse on blur.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onSearch("")}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
            {embedded && (
              <button
                type="button"
                className="db-icon-btn"
                aria-label="Abrir como página completa"
                title="Abrir como página completa"
                onClick={() => navigate(block.id)}
              >
                <Maximize2 size={16} />
              </button>
            )}
            <button
              ref={settingsRef}
              type="button"
              className={`db-icon-btn${locked ? " db-icon-btn--locked" : ""}`}
              aria-label={view.type === "chart" ? "Configurar gráfico" : "Configuración de la vista"}
              title={view.type === "chart" ? "Configurar gráfico" : "Configuración de la vista"}
              onClick={(e) => propsPop.toggle(e.currentTarget)}
            >
              <SlidersHorizontal size={16} />
            </button>
            <div className="db-new">
              <button type="button" className="db-new__main" onClick={() => onNew()}>
                Nuevo
              </button>
              <button
                type="button"
                className="db-new__caret"
                aria-label="Más opciones"
                onClick={(e) => newPop.toggle(e.currentTarget)}
              >
                <ChevronDown size={16} />
              </button>
            </div>
          </>
        )}
      </div>

      {addPop.anchor && (
        <Popover anchor={addPop.anchor} onClose={addPop.close} width={200}>
          <div className="menu">
            <MenuLabel>Agregar una nueva vista</MenuLabel>
            {(Object.keys(VIEW_LABELS) as ViewType[]).map((type) => {
              const Icon = VIEW_ICONS[type];
              return (
                <MenuItem
                  key={type}
                  icon={<Icon size={15} />}
                  onClick={async () => {
                    addPop.close();
                    const id = await addView(block.id, type);
                    if (id) onSelect(id);
                  }}
                >
                  {VIEW_LABELS[type]}
                </MenuItem>
              );
            })}
          </div>
        </Popover>
      )}
      {morePop.anchor && (
        <Popover anchor={morePop.anchor} onClose={morePop.close} width={220}>
          <div className="menu">
            {views
              .filter((v) => v.id !== view.id && hidden.ids.includes(v.id))
              .map((v) => {
                const Icon = viewIcon(v);
                return (
                  <MenuItem
                    key={v.id}
                    icon={<Icon size={15} />}
                    right={v.id === view.id ? <Check size={14} /> : null}
                    onClick={() => {
                      morePop.close();
                      onSelect(v.id);
                    }}
                  >
                    {v.name}
                  </MenuItem>
                );
              })}
          </div>
        </Popover>
      )}
      {newPop.anchor && (
        <Popover anchor={newPop.anchor} onClose={newPop.close} width={300} align="end">
          <div className="menu">
            <TemplateMenu
              block={block}
              collection={collection}
              view={view}
              onPick={(templateId) => {
                newPop.close();
                onNew(undefined, templateId);
              }}
              onEdit={(id) => {
                newPop.close();
                onOpenTemplate(id);
              }}
            />
            <MenuSeparator />
            <MenuItem
              icon={<PanelRight size={15} />}
              onClick={() => {
                newPop.close();
                onNew("side");
              }}
            >
              Nueva página en vista previa lateral
            </MenuItem>
            <MenuItem
              icon={<Maximize2 size={15} />}
              onClick={() => {
                newPop.close();
                onNew("full");
              }}
            >
              Nueva página a pantalla completa
            </MenuItem>
          </div>
        </Popover>
      )}
      {viewPop.anchor && (
        <Popover anchor={viewPop.anchor} onClose={viewPop.close} width={256}>
          <ViewMenu
            block={block}
            view={view}
            canDelete={views.length > 1}
            onClose={viewPop.close}
            onEdit={() => settingsRef.current && propsPop.open(settingsRef.current)}
            onSelect={onSelect}
          />
        </Popover>
      )}
      {filterPop.anchor && (
        <Popover anchor={filterPop.anchor} onClose={filterPop.close} align="end" width={advanced ? undefined : 256}>
          {advanced ? (
            <FilterPanel view={view} collection={collection} />
          ) : (
            <PropertyPicker
              schema={collection.schema}
              order={order}
              placeholder="Filtrar por…"
              onPick={(id) => {
                filterPop.close();
                onAddFilter(id);
              }}
              footer={
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={<Plus size={16} />}
                    onClick={() => {
                      // The advanced rules it adds show in the chip bar.
                      onSortAdded();
                      setAdvanced(true);
                    }}
                  >
                    Agregar filtro avanzado
                  </MenuItem>
                </>
              }
            />
          )}
        </Popover>
      )}
      {sortPop.anchor && (
        <Popover anchor={sortPop.anchor} onClose={sortPop.close} align="end" width={sorts ? undefined : 256}>
          {sorts ? (
            <SortPanel view={view} collection={collection} />
          ) : (
            <PropertyPicker
              schema={collection.schema}
              order={order}
              placeholder="Ordenar por…"
              onPick={(property) => {
                onSortAdded();
                void updateView(view.id, {
                  query2: { ...view.query2, sort: [{ id: shortId(), property, direction: "ascending" }] },
                });
              }}
            />
          )}
        </Popover>
      )}
      {propsPop.anchor && (
        <Popover anchor={propsPop.anchor} onClose={propsPop.close} width={view.type === "chart" ? 300 : 290} align="end">
          {view.type === "chart" ? (
            <ChartSettings view={view} collection={collection} />
          ) : (
            <PropertiesPanel
              key={view.id}
              block={block}
              view={view}
              collection={collection}
              rows={rows}
              canDelete={views.length > 1}
              onClose={propsPop.close}
              onSelect={onSelect}
              onFilter={() => {
                propsPop.close();
                setAdvanced(view.query2.filters.length > 0 || !!view.query2.filter_groups?.length);
                if (settingsRef.current) filterPop.open(settingsRef.current);
              }}
              onSort={() => {
                propsPop.close();
                if (settingsRef.current) sortPop.open(settingsRef.current);
              }}
            />
          )}
        </Popover>
      )}
    </div>
  );
}

/**
 * Tabs that wrapped out of the one-line tab row (shown in the "N más" menu). The active view
 * always stays in the row: when it would fall past the end it takes the last visible slot.
 * `order` is the display order; the database's view_ids stay as they are.
 */
function useHiddenTabs(viewIds: string[], activeId: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ ids: string[]; order: string[] }>({ ids: [], order: viewIds });
  const key = viewIds.join(",");
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const all = key ? key.split(",") : [];
    const measure = () => {
      // Measured at its natural width, then narrowed to the tabs left on the first line,
      // so "N más" follows the last visible tab instead of the end of the row.
      list.style.width = "";
      const avail = list.getBoundingClientRect().width + 1;
      const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
      const widths = new Map<string, number>();
      for (const t of [...list.children] as HTMLElement[]) widths.set(t.dataset.view ?? "", t.getBoundingClientRect().width);
      const w = (id: string) => widths.get(id) ?? 0;
      // The longest run of tabs from `ids` that fits in `room`.
      const fit = (ids: string[], room: number) => {
        let used = 0;
        let n = 0;
        for (const id of ids) {
          const next = used + (n ? gap : 0) + w(id);
          if (next > room) break;
          used = next;
          n++;
        }
        return { n, used };
      };
      let order = all;
      let shown = fit(all, avail);
      if (shown.n < all.length && all.indexOf(activeId) >= Math.max(shown.n, 1)) {
        // The active view falls past the end: it goes in place of the last tab that fits.
        const rest = all.filter((id) => id !== activeId);
        const before = fit(rest, avail - w(activeId) - gap);
        const n = w(activeId) > avail ? 0 : before.n;
        order = [...rest.slice(0, n), activeId, ...rest.slice(n)];
        shown = { n: n + 1, used: before.used + (n ? gap : 0) + w(activeId) };
      }
      // The first tab narrows (with an ellipsis) rather than going behind "N más".
      const visible = Math.max(shown.n, Math.min(1, order.length));
      const next = order.slice(visible);
      // When not even the first tab fits whole, it keeps the room there is and narrows.
      const used = shown.n ? shown.used : Math.min(w(order[0] ?? ""), avail - 1);
      if (next.length) list.style.width = `${Math.ceil(Math.min(used, avail - 1))}px`;
      setState((prev) =>
        prev.ids.join(",") === next.join(",") && prev.order.join(",") === order.join(",") ? prev : { ids: next, order },
      );
    };
    measure();
    // The row it sits in, too: a list narrowed above doesn't grow back by itself.
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    if (list.parentElement) observer.observe(list.parentElement);
    return () => observer.disconnect();
  }, [key, activeId]);
  return { ref, ids: state.ids, order: state.order };
}

/** Copies a link that opens the database on this view ("#/<database>?v=<view>"). */
const copyViewLink = (block: Block, view: CollectionView) => copyLink(`${block.id}?v=${view.id}`);

/** The active tab's menu: its name, then edit, copy link, duplicate and delete. */
function ViewMenu({
  block,
  view,
  canDelete,
  onClose,
  onEdit,
  onSelect,
}: {
  block: Block;
  view: CollectionView;
  canDelete: boolean;
  onClose: () => void;
  onEdit: () => void;
  onSelect: (id: string) => void;
}) {
  const [name, setName] = useState(view.name);
  const commit = () => name.trim() && name !== view.name && updateView(view.id, { name: name.trim() });
  const Icon = viewIcon(view);
  const run = (fn: () => void) => () => {
    commit();
    onClose();
    fn();
  };
  return (
    <div className="menu">
      <div className="view-name">
        <span className="view-name__icon">
          <Icon size={16} strokeWidth={1.8} />
        </span>
        <input
          className="field view-name__input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              onClose();
            }
          }}
          aria-label="Nombre de la vista"
        />
      </div>
      <MenuItem icon={<SlidersHorizontal size={16} />} onClick={run(onEdit)}>
        Editar vista
      </MenuItem>
      <MenuItem icon={<Link size={16} />} onClick={run(() => void copyViewLink(block, view))}>
        Copiar enlace a la vista
      </MenuItem>
      <AddViewToSidebarItem databaseId={block.id} viewId={view.id} onDone={() => (commit(), onClose())} />
      <MenuItem
        icon={<CopyPlus size={16} />}
        onClick={run(async () => {
          const id = await duplicateView(block.id, view.id);
          if (id) onSelect(id);
        })}
      >
        Duplicar vista
      </MenuItem>
      <MenuItem danger icon={<Trash size={16} />} disabled={!canDelete} onClick={run(() => void deleteView(block.id, view.id))}>
        Eliminar vista
      </MenuItem>
    </div>
  );
}

// ---------------------------------------------------------------- filters

/** The property list with a search field ("Filtrar por…", "Ordenar por…"). */
export function PropertyPicker({
  schema,
  order,
  placeholder,
  exclude = [],
  onPick,
  footer,
}: {
  schema: Record<string, PropertySchema>;
  /** Property ids in the view's order. */
  order: string[];
  placeholder: string;
  exclude?: string[];
  onPick: (id: string) => void;
  footer?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const ids = [...order, ...Object.keys(schema).filter((id) => !order.includes(id))].filter(
    // Buttons hold no value to filter or sort by.
    (id) => schema[id] && schema[id].type !== "button" && !exclude.includes(id) && schema[id].name.toLowerCase().includes(q),
  );
  return (
    <div className="menu property-picker">
      <input
        className="menu-search"
        autoFocus
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="property-picker__list">
        {ids.map((id) => (
          <MenuItem key={id} icon={<TypeIcon type={schema[id].type} size={16} />} onClick={() => onPick(id)}>
            {schema[id].name}
          </MenuItem>
        ))}
        {!ids.length && <div className="menu-empty">Sin resultados</div>}
      </div>
      {footer}
    </div>
  );
}

const DATE_TYPES = ["date", "created_time", "last_edited_time"];
const OPTION_TYPES = ["select", "status", "multi_select"];

/** What a chip says: "Status: Done, Doing", "Name contiene: x", "Fecha: Hoy". */
function filterLabel(f: Filter, prop: PropertySchema, valueText = filterValueText(f, prop)) {
  const op = f.operator;
  if (!needsValue(op)) return `${prop.name}: ${OPERATOR_LABELS[op]}`;
  const lead = op === operatorsFor(prop.type)[0] ? prop.name : `${prop.name} ${OPERATOR_LABELS[op]}`;
  const text = valueText;
  if (prop.type === "checkbox") return op === "is_not" ? `${prop.name} no es: ${text}` : `${prop.name}: ${text}`;
  return text ? `${lead}: ${text}` : lead;
}

/** A filter's value as text ("Done, Doing", "Hoy", "x"); empty when it has none. */
function filterValueText(f: Filter, prop: PropertySchema) {
  const op = f.operator;
  const v = f.value;
  if (prop.type === "checkbox") return v ? "Marcada" : "Sin marcar";
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return "";
  let text: string;
  if (OPTION_TYPES.includes(prop.type))
    text = (Array.isArray(v) ? v : [v])
      .map((id) => {
        const s = String(id);
        if (s.startsWith("group:")) return prop.groups?.find((g) => g.id === s.slice(6))?.name ?? "";
        return prop.options?.find((o) => o.id === s)?.value ?? "";
      })
      .filter(Boolean)
      .join(", ");
  else if (op === "is_within") text = WITHIN_LABELS[String(v)] ?? String(v);
  else if (op === "is_between") text = String(v).split("/").map(formatDateText).join(" → ");
  else if (DATE_TYPES.includes(prop.type)) {
    const s = String(v);
    text = s.startsWith("relative:") ? (RELATIVE_DATES[s.slice(9)] ?? s) : formatDateText(s);
  } else text = plainText(v);
  return text;
}

/** A filter's value text; relation filters name their pages (they store page ids). */
function useFilterValueText(f: Filter, prop: PropertySchema) {
  const ids = prop.type === "relation" && Array.isArray(f.value) ? (f.value as string[]) : null;
  const key = ids?.join() ?? "";
  const titles = useLiveQuery(
    async () =>
      ids ? (await db.blocks.bulkGet(ids)).map((b) => (b ? (b.is_template ? "Esta página" : pageTitle(b) || "Sin título") : "")) : null,
    [key],
  );
  if (ids) return (titles ?? []).filter(Boolean).join(", ");
  return filterValueText(f, prop);
}

/** Values don't carry over between operators that store different things (a day, a range, a period). */
const sameValueKind = (a: Filter["operator"], b: Filter["operator"]) => {
  const kind = (op: Filter["operator"]) => (op === "is_within" ? 1 : op === "is_between" ? 2 : 0);
  return kind(a) === kind(b);
};

const formatDateText = (day: string) => {
  const d = new Date(`${day.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
};

/** The chips under the toolbar: the sort, each filter and "+ Agregar filtro" (Xot saves at once, so no "Restablecer"). */
function FilterBar({
  view,
  collection,
  openFilter,
  onOpened,
  onAddFilter,
}: {
  view: CollectionView;
  collection: Collection;
  openFilter: string | null;
  onOpened: () => void;
  onAddFilter: (property: string) => void;
}) {
  const { query2 } = view;
  const addPop = usePopover();
  const advancedPop = usePopover();
  const order = viewProperties(view, collection).map((p) => p.property);
  const filters = query2.filters.filter((f) => collection.schema[f.property]);
  // OR rules and filter groups (imported, or built in the advanced panel) can't be read as separate chips.
  const groups = query2.filter_groups ?? [];
  const advanced = (query2.filter_operator === "or" && filters.length > 1) || groups.length > 0;
  return (
    <div className="db-filterbar">
      {query2.sort.length > 0 && <SortChip view={view} collection={collection} />}
      {query2.sort.length > 0 && (filters.length > 0 || groups.length > 0) && <span className="db-filterbar__sep" />}
      {advanced ? (
        <>
          <button type="button" className="db-chip is-active" onClick={(e) => advancedPop.toggle(e.currentTarget)}>
            <ListFilter size={14} />
            {filters.length + groups.reduce((n, g) => n + groupRules(g).length, 0)} reglas
            <ChevronDown size={12} />
          </button>
          {advancedPop.anchor && (
            <Popover anchor={advancedPop.anchor} onClose={advancedPop.close}>
              <FilterPanel view={view} collection={collection} />
            </Popover>
          )}
        </>
      ) : (
        filters.map((f) => (
          <FilterChip
            key={f.id}
            filter={f}
            view={view}
            collection={collection}
            autoOpen={openFilter === f.id}
            onOpened={onOpened}
          />
        ))
      )}
      <button type="button" className="db-chip db-chip--add" onClick={(e) => addPop.toggle(e.currentTarget)}>
        <Plus size={14} /> Agregar filtro
      </button>
      {addPop.anchor && (
        <Popover anchor={addPop.anchor} onClose={addPop.close} width={256}>
          <PropertyPicker
            schema={collection.schema}
            order={order}
            placeholder="Filtrar por…"
            onPick={(id) => {
              addPop.close();
              onAddFilter(id);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

function FilterChip({
  filter,
  view,
  collection,
  autoOpen,
  onOpened,
}: {
  filter: Filter;
  view: CollectionView;
  collection: Collection;
  autoOpen: boolean;
  onOpened: () => void;
}) {
  const pop = usePopover();
  const ref = useRef<HTMLButtonElement>(null);
  const prop = useFilterSchema()(collection.schema[filter.property], filter.property);
  const valueText = useFilterValueText(filter, prop);
  useEffect(() => {
    if (!autoOpen || !ref.current) return;
    pop.open(ref.current);
    onOpened();
  });
  const active = countActiveFilters({ ...view.query2, filters: [filter] }, collection.schema) > 0;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`db-chip${active ? " is-active" : ""}`}
        onClick={(e) => pop.toggle(e.currentTarget)}
      >
        <span className="db-chip__label">{filterLabel(filter, prop, valueText)}</span>
        <ChevronDown size={12} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={290}>
          <FilterEditor filter={filter} view={view} schema={prop} onRemove={pop.close} />
        </Popover>
      )}
    </>
  );
}

/** A filter chip's popover: the property, its operator and the value editor. */
function FilterEditor({
  filter,
  view,
  schema,
  onRemove,
}: {
  filter: Filter;
  view: CollectionView;
  schema: PropertySchema;
  onRemove: () => void;
}) {
  const opPop = usePopover();
  const morePop = usePopover();
  const set = (patch: Partial<Filter>) =>
    updateView(view.id, {
      query2: { ...view.query2, filters: view.query2.filters.map((f) => (f.id === filter.id ? { ...f, ...patch } : f)) },
    });
  const remove = () => {
    onRemove();
    void updateView(view.id, {
      query2: { ...view.query2, filters: view.query2.filters.filter((f) => f.id !== filter.id) },
    });
  };
  return (
    <div className="filter-editor">
      <div className="filter-editor__head">
        <span className="filter-editor__prop">{schema.name}</span>
        <button type="button" className="filter-editor__op" onClick={(e) => opPop.toggle(e.currentTarget)}>
          {OPERATOR_LABELS[filter.operator]}
          <ChevronDown size={12} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm filter-editor__more"
          aria-label="Más acciones"
          onClick={(e) => morePop.toggle(e.currentTarget)}
        >
          <Ellipsis size={16} />
        </button>
      </div>
      {(needsValue(filter.operator) || schema.type === "checkbox") && (
        <FilterValueEditor
          key={filter.operator}
          schema={schema}
          propertyId={filter.property}
          collectionId={view.collection_id}
          operator={filter.operator}
          value={filter.value}
          onChange={(value) => set({ value })}
        />
      )}
      {opPop.anchor && (
        <Popover anchor={opPop.anchor} onClose={opPop.close} width={200}>
          <div className="menu">
            {operatorsFor(schema.type).map((op) => (
              <MenuItem
                key={op}
                right={op === filter.operator ? <Check size={14} /> : null}
                onClick={() => {
                  opPop.close();
                  // Values don't carry over between date operators like "es" and "está dentro de".
                  set({ operator: op, value: sameValueKind(op, filter.operator) ? filter.value : undefined });
                }}
              >
                {OPERATOR_LABELS[op]}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
      {morePop.anchor && (
        <Popover anchor={morePop.anchor} onClose={morePop.close} width={200}>
          <div className="menu">
            <MenuItem
              danger
              icon={<Trash size={16} />}
              onClick={() => {
                morePop.close();
                remove();
              }}
            >
              Eliminar filtro
            </MenuItem>
          </div>
        </Popover>
      )}
    </div>
  );
}

function FilterValueEditor({
  schema,
  propertyId,
  collectionId,
  operator,
  value,
  onChange,
}: {
  schema: PropertySchema;
  propertyId: string;
  /** The filtered database: its people fill a person filter's checklist. */
  collectionId: string;
  operator: Filter["operator"];
  value: PropertyValue | undefined;
  onChange: (v: PropertyValue) => void;
}) {
  const [query, setQuery] = useState("");
  const relPop = usePopover();
  if (schema.type === "relation" || PERSON_TYPES.includes(schema.type))
    return (
      <RefFilterOptions schema={schema} propertyId={propertyId} collectionId={collectionId} value={value} onChange={onChange} />
    );
  if (operator === "is_between") {
    const v = typeof value === "string" && !value.startsWith("relative:") ? value : "";
    return (
      <div className="filter-editor__date">
        <DatePicker
          value={v || null}
          options={false}
          range
          onChange={(next) => onChange(next ? next.split("/").map((d) => d.slice(0, 10)).join("/") : null)}
        />
      </div>
    );
  }
  if (schema.type === "checkbox")
    return (
      <div className="menu filter-editor__list">
        {[true, false].map((on) => (
          <MenuItem key={String(on)} right={!!value === on ? <Check size={14} /> : null} onClick={() => onChange(on)}>
            {on ? "Marcada" : "Sin marcar"}
          </MenuItem>
        ))}
      </div>
    );
  if (operator === "is_within")
    return (
      <div className="menu filter-editor__list">
        {Object.entries(WITHIN_LABELS).map(([id, label]) => (
          <MenuItem key={id} right={value === id ? <Check size={14} /> : null} onClick={() => onChange(id)}>
            {label.charAt(0).toUpperCase() + label.slice(1)}
          </MenuItem>
        ))}
      </div>
    );
  if (DATE_TYPES.includes(schema.type)) {
    const v = typeof value === "string" ? value : "";
    const relative = v.startsWith("relative:");
    return (
      <div className="filter-editor__date">
        <div className="filter-editor__pad">
          <button type="button" className="filter-editor__select" onClick={(e) => relPop.toggle(e.currentTarget)}>
            <span>{relative ? RELATIVE_DATES[v.slice(9)] : "Fecha exacta"}</span>
            <ChevronDown size={12} />
          </button>
        </div>
        {!relative && <DatePicker value={v || null} options={false} onChange={(next) => onChange(next ? next.slice(0, 10) : null)} />}
        {relPop.anchor && (
          <Popover anchor={relPop.anchor} onClose={relPop.close} width={220}>
            <div className="menu">
              {[["exact", "Fecha exacta"] as const, ...Object.entries(RELATIVE_DATES)].map(([id, label]) => {
                const next = id === "exact" ? null : `relative:${id}`;
                return (
                  <MenuItem
                    key={id}
                    right={(relative ? v : null) === next ? <Check size={14} /> : null}
                    onClick={() => {
                      relPop.close();
                      onChange(next);
                    }}
                  >
                    {label}
                  </MenuItem>
                );
              })}
            </div>
          </Popover>
        )}
      </div>
    );
  }
  if (OPTION_TYPES.includes(schema.type)) {
    // A checklist of options (and status groups); several values match any of them.
    const ids = Array.isArray(value) ? (value as string[]) : typeof value === "string" && value ? [value] : [];
    const toggle = (id: string) => {
      const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
      onChange(next.length ? next : null);
    };
    const q = query.trim().toLowerCase();
    const groups = schema.type === "status" ? (schema.groups ?? []) : [];
    const options = (schema.options ?? []).filter((o) => o.value.toLowerCase().includes(q));
    const row = (id: string, label: React.ReactNode) => (
      <button type="button" key={id} className="option-row filter-editor__option" onClick={() => toggle(id)}>
        <span className={`checkbox${ids.includes(id) ? " is-checked" : ""}`} aria-hidden>
          {ids.includes(id) && <Check size={12} strokeWidth={3} />}
        </span>
        {label}
      </button>
    );
    return (
      <div className="filter-editor__options">
        <input
          className="menu-search"
          autoFocus
          placeholder="Busca una opción…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="filter-editor__list">
          {groups
            .filter((g) => g.name.toLowerCase().includes(q))
            .map((g) => row(`group:${g.id}`, <span className="filter-editor__group">{g.name}</span>))}
          {groups.length > 0 && options.length > 0 && <MenuSeparator />}
          {options.map((o) => row(o.id, <Tag option={o} status={schema.type === "status"} />))}
          {!options.length && !groups.length && <div className="menu-empty">Sin opciones</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="filter-editor__pad">
      <ValueInput schema={schema} value={value} placeholder="Escribe un valor…" autoFocus onChange={onChange} />
    </div>
  );
}

/**
 * A relation or person filter's checklist: the related database's pages
 * ("Buscar páginas…"), or the people of the column with you first.
 */
function RefFilterOptions({
  schema,
  propertyId,
  collectionId,
  value,
  onChange,
}: {
  schema: PropertySchema;
  propertyId: string;
  collectionId: string;
  value: PropertyValue | undefined;
  onChange: (v: PropertyValue) => void;
}) {
  const [query, setQuery] = useState("");
  const relation = schema.type === "relation";
  const rows = useChildren("collection", relation ? (schema.collection_id ?? "") : collectionId);
  // Inside a template of the related database: "Esta página", the page each copy of the template becomes.
  const template = useBlock(useContext(TemplateHostContext));
  type Item = { id: string; text: string; label: ReactNode };
  let items: Item[];
  if (relation)
    items = [
      ...(template?.alive && template.parent_id === schema.collection_id
        ? [
            {
              id: template.id,
              text: "Esta página",
              label: (
                <span className="filter-editor__page">
                  <FileText size={16} />
                  <span className="filter-editor__page-title">Esta página</span>
                </span>
              ),
            },
          ]
        : []),
      ...(rows ?? []).map((r) => ({
        id: r.id,
        text: pageTitle(r),
        label: (
          <span className="filter-editor__page">
            <PageIcon block={r} size={16} />
            <span className="filter-editor__page-title">{pageTitle(r) || "Sin título"}</span>
          </span>
        ),
      })),
    ];
  else {
    // You first, then the people already in this column (created/edited by: only you, locally).
    const names = new Set<string>([LOCAL_PERSON]);
    if (schema.type === "person")
      for (const r of rows ?? []) {
        const v = r.properties[propertyId];
        if (Array.isArray(v)) for (const n of v) if (typeof n === "string" && n.trim()) names.add(n);
      }
    items = [...names].map((name) => ({
      id: name,
      text: name,
      label: (
        <span className="person">
          <span className="person__avatar">{name.trim().charAt(0).toUpperCase()}</span>
          <span className="person__name">{name}</span>
        </span>
      ),
    }));
  }
  // Older filters hold one page id, name or title; they show as that page or person ticked.
  const ids = Array.isArray(value)
    ? (value as string[])
    : typeof value === "string" && value
      ? items.filter((i) => i.id === value || i.text.toLowerCase() === value.toLowerCase()).map((i) => i.id)
      : [];
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    onChange(next.length ? next : null);
  };
  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => i.text.toLowerCase().includes(q));
  return (
    <div className="filter-editor__options">
      <input
        className="menu-search"
        autoFocus
        placeholder={relation ? "Buscar páginas…" : "Buscar personas…"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="filter-editor__list">
        {shown.map((i) => (
          <button type="button" key={i.id} className="option-row filter-editor__option" onClick={() => toggle(i.id)}>
            <span className={`checkbox${ids.includes(i.id) ? " is-checked" : ""}`} aria-hidden>
              {ids.includes(i.id) && <Check size={12} strokeWidth={3} />}
            </span>
            {i.label}
          </button>
        ))}
        {!shown.length && <div className="menu-empty">{relation ? "Sin páginas" : "Sin personas"}</div>}
      </div>
    </div>
  );
}

/**
 * A typed filter value. It keeps its own text while typing, since the saved
 * view comes back a moment later, and follows outside changes when not focused.
 */
function ValueInput({
  schema,
  value,
  placeholder,
  autoFocus,
  onChange,
}: {
  schema: PropertySchema;
  value: PropertyValue | undefined;
  placeholder: string;
  autoFocus?: boolean;
  onChange: (v: PropertyValue) => void;
}) {
  const numeric = schema.type === "number" || schema.type === "auto_increment_id";
  const saved = value === null || value === undefined ? "" : String(value);
  const [text, setText] = useState(saved);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(saved);
  }, [saved]);
  return (
    <input
      className="filter-editor__input"
      autoFocus={autoFocus}
      type={numeric ? "number" : "text"}
      placeholder={placeholder}
      value={text}
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      onChange={(e) => {
        setText(e.target.value);
        onChange(numeric ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value);
      }}
    />
  );
}

/** The advanced filter: rules and groups of rules, joined by "Y" / "O". */
export function FilterPanel({ view, collection }: { view: CollectionView; collection: Collection }) {
  const { query2 } = view;
  const schema = collection.schema;
  const order = viewProperties(view, collection).map((p) => p.property);
  const groups = query2.filter_groups ?? [];
  const addPop = usePopover();
  const save = (patch: Partial<Query>) => updateView(view.id, { query2: { ...query2, ...patch } });
  const newRule = (): Filter => ({ id: shortId(), property: "title", operator: "contains", value: "" });
  const copyRule = (f: Filter): Filter => ({ ...structuredClone(f), id: shortId() });
  const copyGroup = (g: FilterGroup): FilterGroup => ({
    ...g,
    id: shortId(),
    filters: g.filters.map(copyRule),
    ...(g.groups ? { groups: g.groups.map(copyGroup) } : {}),
  });
  const count = query2.filters.length + groups.length;
  /** "Donde" first, the Y/O switch second, then the operator as plain text. */
  const lead = (i: number, operator: Query["filter_operator"], onOperator: (op: Query["filter_operator"]) => void) =>
    i === 0 ? "Donde" : i === 1 ? <JoinPicker value={operator} onChange={onOperator} /> : operator === "and" ? "Y" : "O";

  /**
   * A group's box: its rules, then the groups in it (one more level, three in all), and its
   * own "Agregar regla de filtros" / "Agregar grupo de filtros". `onChange(null)` drops the group.
   */
  const groupBox = (g: FilterGroup, depth: number, onChange: (next: FilterGroup | null) => void): ReactNode => {
    const inner = g.groups ?? [];
    const set = (patch: Partial<FilterGroup>) => {
      const next = { ...g, ...patch };
      onChange(next.filters.length || next.groups?.length ? next : null);
    };
    const nested = depth < 2;
    return (
      <div className="rule-group">
        {g.filters.map((f, i) =>
          schema[f.property] ? (
            <FilterRule
              key={f.id}
              lead={lead(i, g.operator, (operator) => set({ operator }))}
              filter={f}
              schema={schema}
              collectionId={collection.id}
              order={order}
              onChange={(patch) => set({ filters: g.filters.map((x) => (x.id === f.id ? { ...x, ...patch } : x)) })}
              onRemove={() => set({ filters: g.filters.filter((x) => x.id !== f.id) })}
              onDuplicate={() => {
                const next = [...g.filters];
                next.splice(i + 1, 0, copyRule(f));
                set({ filters: next });
              }}
              onToGroup={
                nested
                  ? () =>
                      set({
                        filters: g.filters.filter((x) => x.id !== f.id),
                        groups: [...inner, { id: shortId(), operator: "and", filters: [f] }],
                      })
                  : undefined
              }
            />
          ) : null,
        )}
        {inner.map((x, xi) => (
          <div className="rule rule--group" key={x.id}>
            <div className="rule__lead">{lead(g.filters.length + xi, g.operator, (operator) => set({ operator }))}</div>
            {groupBox(x, depth + 1, (next) =>
              set({ groups: next ? inner.map((y) => (y.id === x.id ? next : y)) : inner.filter((y) => y.id !== x.id) }),
            )}
            <RuleMenu
              onDuplicate={() => {
                const next = [...inner];
                next.splice(xi + 1, 0, copyGroup(x));
                set({ groups: next });
              }}
              onRemove={() => set({ groups: inner.filter((y) => y.id !== x.id) })}
            />
          </div>
        ))}
        <MenuItem icon={<Plus size={16} />} onClick={() => set({ filters: [...g.filters, newRule()] })}>
          Agregar regla de filtros
        </MenuItem>
        {nested && (
          <MenuItem
            icon={<CopyPlus size={16} />}
            onClick={() => set({ groups: [...inner, { id: shortId(), operator: "and", filters: [newRule()] }] })}
          >
            Agregar grupo de filtros
          </MenuItem>
        )}
      </div>
    );
  };

  return (
    <div className="rule-panel">
      {count === 0 && <p className="rule-panel__empty">Sin filtros en esta vista.</p>}
      {query2.filters.map((f, i) =>
        schema[f.property] ? (
          <FilterRule
            key={f.id}
            lead={lead(i, query2.filter_operator, (filter_operator) => void save({ filter_operator }))}
            filter={f}
            schema={schema}
            collectionId={collection.id}
            order={order}
            onChange={(patch) => save({ filters: query2.filters.map((x) => (x.id === f.id ? { ...x, ...patch } : x)) })}
            onRemove={() => save({ filters: query2.filters.filter((x) => x.id !== f.id) })}
            onDuplicate={() => {
              const next = [...query2.filters];
              next.splice(i + 1, 0, copyRule(f));
              void save({ filters: next });
            }}
            onToGroup={() =>
              save({
                filters: query2.filters.filter((x) => x.id !== f.id),
                filter_groups: [...groups, { id: shortId(), operator: "and", filters: [f] }],
              })
            }
          />
        ) : null,
      )}
      {groups.map((g, gi) => (
        <div className="rule rule--group" key={g.id}>
          <div className="rule__lead">
            {lead(query2.filters.length + gi, query2.filter_operator, (filter_operator) => void save({ filter_operator }))}
          </div>
          {groupBox(g, 1, (next) =>
            save({ filter_groups: next ? groups.map((x) => (x.id === g.id ? next : x)) : groups.filter((x) => x.id !== g.id) }),
          )}
          <RuleMenu
            onDuplicate={() => {
              const next = [...groups];
              next.splice(gi + 1, 0, copyGroup(g));
              void save({ filter_groups: next });
            }}
            onRemove={() => save({ filter_groups: groups.filter((x) => x.id !== g.id) })}
          />
        </div>
      ))}
      <div className="rule-panel__foot">
        <MenuItem icon={<Plus size={16} />} right={<ChevronDown size={14} />} onClick={(e) => addPop.toggle(e.currentTarget)}>
          Agregar regla de filtros
        </MenuItem>
        {count > 0 && (
          <MenuItem icon={<Trash size={16} />} onClick={() => save({ filters: [], filter_groups: [] })}>
            Eliminar filtro
          </MenuItem>
        )}
      </div>
      {addPop.anchor && (
        <Popover anchor={addPop.anchor} onClose={addPop.close} width={240}>
          <div className="menu">
            <MenuItem
              icon={<Plus size={16} />}
              onClick={() => {
                addPop.close();
                void save({ filters: [...query2.filters, newRule()] });
              }}
            >
              Agregar regla de filtros
            </MenuItem>
            <MenuItem
              icon={<CopyPlus size={16} />}
              onClick={() => {
                addPop.close();
                void save({ filter_groups: [...groups, { id: shortId(), operator: "and", filters: [newRule()] }] });
              }}
            >
              Agregar grupo de filtros
            </MenuItem>
          </div>
        </Popover>
      )}
    </div>
  );
}

/** The "Y" / "O" switch on a rule list's second line. */
export function JoinPicker({ value, onChange }: { value: Query["filter_operator"]; onChange: (v: Query["filter_operator"]) => void }) {
  const pop = usePopover();
  return (
    <>
      <button type="button" className="rule-btn rule-btn--join" onClick={(e) => pop.toggle(e.currentTarget)}>
        <span className="rule-btn__label">{value === "and" ? "Y" : "O"}</span>
        <ChevronDown size={12} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={120}>
          <div className="menu">
            {(["and", "or"] as const).map((op) => (
              <MenuItem
                key={op}
                right={op === value ? <Check size={14} /> : null}
                onClick={() => {
                  pop.close();
                  onChange(op);
                }}
              >
                {op === "and" ? "Y" : "O"}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** A rule's (or group's) "…": Duplicar, Eliminar and, for a top-level rule, Convertir en grupo. */
function RuleMenu({ onDuplicate, onRemove, onToGroup }: { onDuplicate: () => void; onRemove: () => void; onToGroup?: () => void }) {
  const pop = usePopover();
  const run = (fn: () => void) => () => {
    pop.close();
    fn();
  };
  return (
    <>
      <button type="button" className="icon-btn icon-btn--sm rule__more" aria-label="Más acciones" onClick={(e) => pop.toggle(e.currentTarget)}>
        <Ellipsis size={16} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={220} align="end">
          <div className="menu">
            <MenuItem icon={<CopyPlus size={16} />} onClick={run(onDuplicate)}>
              Duplicar
            </MenuItem>
            {onToGroup && (
              <MenuItem icon={<ListTree size={16} />} onClick={run(onToGroup)}>
                Convertir en grupo
              </MenuItem>
            )}
            <MenuItem danger icon={<Trash size={16} />} onClick={run(onRemove)}>
              Eliminar
            </MenuItem>
          </div>
        </Popover>
      )}
    </>
  );
}

/** One advanced-filter rule: property, operator and value buttons, and its "…". */
export function FilterRule({
  lead,
  filter,
  schema,
  collectionId,
  order,
  onChange,
  onRemove,
  onDuplicate,
  onToGroup,
}: {
  lead: ReactNode;
  filter: Filter;
  schema: Record<string, PropertySchema>;
  collectionId: string;
  order: string[];
  onChange: (patch: Partial<Filter>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onToGroup?: () => void;
}) {
  const propPop = usePopover();
  const opPop = usePopover();
  const valuePop = usePopover();
  const filterSchema = useFilterSchema();
  const prop = filterSchema(schema[filter.property], filter.property);
  const typed =
    !OPTION_TYPES.includes(prop.type) &&
    !DATE_TYPES.includes(prop.type) &&
    prop.type !== "checkbox" &&
    prop.type !== "relation" &&
    !PERSON_TYPES.includes(prop.type);
  const hasValue = needsValue(filter.operator) || prop.type === "checkbox";
  const text = useFilterValueText(filter, prop);
  return (
    <div className="rule">
      <div className="rule__lead">{lead}</div>
      <button type="button" className="rule-btn" onClick={(e) => propPop.toggle(e.currentTarget)}>
        <TypeIcon type={schema[filter.property].type} size={16} />
        <span className="rule-btn__label">{prop.name}</span>
        <ChevronDown size={12} />
      </button>
      <button type="button" className="rule-btn" onClick={(e) => opPop.toggle(e.currentTarget)}>
        <span className="rule-btn__label">{OPERATOR_LABELS[filter.operator]}</span>
        <ChevronDown size={12} />
      </button>
      <div className="rule__value">
        {hasValue &&
          (typed && filter.operator !== "is_within" ? (
            <ValueInput schema={prop} value={filter.value} placeholder="Valor" onChange={(value) => onChange({ value })} />
          ) : (
            <button type="button" className="rule-btn rule-btn--value" onClick={(e) => valuePop.toggle(e.currentTarget)}>
              <span className={`rule-btn__label${text ? "" : " rule-btn__label--empty"}`}>{text || "Elige un valor"}</span>
              <ChevronDown size={12} />
            </button>
          ))}
      </div>
      <RuleMenu onDuplicate={onDuplicate} onRemove={onRemove} onToGroup={onToGroup} />
      {propPop.anchor && (
        <Popover anchor={propPop.anchor} onClose={propPop.close} width={256}>
          <PropertyPicker
            schema={schema}
            order={order}
            placeholder="Filtrar por…"
            onPick={(id) => {
              propPop.close();
              if (id !== filter.property)
                onChange({ property: id, operator: operatorsFor(filterSchema(schema[id], id).type)[0], value: undefined });
            }}
          />
        </Popover>
      )}
      {opPop.anchor && (
        <Popover anchor={opPop.anchor} onClose={opPop.close} width={200}>
          <div className="menu">
            {operatorsFor(prop.type).map((op) => (
              <MenuItem
                key={op}
                right={op === filter.operator ? <Check size={14} /> : null}
                onClick={() => {
                  opPop.close();
                  onChange({ operator: op, value: sameValueKind(op, filter.operator) ? filter.value : undefined });
                }}
              >
                {OPERATOR_LABELS[op]}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
      {valuePop.anchor && (
        <Popover anchor={valuePop.anchor} onClose={valuePop.close} width={290}>
          <div className="filter-editor">
            <FilterValueEditor
              key={filter.operator}
              schema={prop}
              propertyId={filter.property}
              collectionId={collectionId}
              operator={filter.operator}
              value={filter.value}
              onChange={(value) => onChange({ value })}
            />
          </div>
        </Popover>
      )}
    </div>
  );
}

/**
 * ⋮⋮ dragging in a settings list (properties, groups): rows report where they'd land
 * (a blue line before or after) and `onMove` gets the dragged key and its new neighbour.
 */
function useRowDrag(onMove: (from: string, to: string, after: boolean) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(null);
  const end = () => {
    setDragging(null);
    setDrop(null);
  };
  return {
    dropClass: (key: string) => (drop?.key === key ? (drop.after ? " is-drop-after" : " is-drop-before") : "") + (dragging === key ? " is-dragging" : ""),
    rowProps: (key: string) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        setDragging(key);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", key);
      },
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        if (!dragging || dragging === key) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        if (drop?.key !== key || drop.after !== after) setDrop({ key, after });
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (dragging && drop) onMove(dragging, drop.key, drop.after);
        end();
      },
      onDragEnd: end,
    }),
  };
}

// ------------------------------------------------------------------ sorts

/** The sort chip in the bar ("↑↓ Name ▾"), opening the sort list. */
function SortChip({ view, collection }: { view: CollectionView; collection: Collection }) {
  const pop = usePopover();
  const sort = view.query2.sort;
  const first = collection.schema[sort[0].property];
  return (
    <>
      <button type="button" className="db-chip is-active" onClick={(e) => pop.toggle(e.currentTarget)}>
        <ArrowUpDown size={14} />
        <span className="db-chip__label">{sort.length > 1 ? `${sort.length} ordenaciones` : (first?.name ?? "Orden")}</span>
        <ChevronDown size={12} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close}>
          <SortPanel view={view} collection={collection} />
        </Popover>
      )}
    </>
  );
}

export function SortPanel({ view, collection }: { view: CollectionView; collection: Collection }) {
  const { query2 } = view;
  const schema = collection.schema;
  const save = (sort: Query["sort"]) => updateView(view.id, { query2: { ...query2, sort } });
  const order = viewProperties(view, collection).map((p) => p.property);
  const propPop = usePopover();
  const dirPop = usePopover();
  const addPop = usePopover();
  const [current, setCurrent] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const editing = query2.sort.find((s) => s.id === current);
  const unused = Object.keys(schema).filter((id) => !query2.sort.some((s) => s.property === id));
  const patch = (id: string, change: Partial<Query["sort"][number]>) =>
    save(query2.sort.map((x) => (x.id === id ? { ...x, ...change } : x)));

  return (
    <div className="menu sort-panel">
      {query2.sort.map((s) => {
        const prop = schema[s.property];
        return (
          <div
            className={`sort-rule${dragId === s.id ? " is-dragging" : ""}`}
            key={s.id}
            onDragOver={(e) => {
              if (!dragId || dragId === s.id) return;
              e.preventDefault();
              const from = query2.sort.findIndex((x) => x.id === dragId);
              const to = query2.sort.findIndex((x) => x.id === s.id);
              const next = [...query2.sort];
              next.splice(to, 0, next.splice(from, 1)[0]);
              void save(next);
            }}
          >
            <span
              className="sort-rule__grip"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", s.id);
                setDragId(s.id);
              }}
              onDragEnd={() => setDragId(null)}
            >
              <GripVertical size={14} />
            </span>
            <button
              type="button"
              className="rule-btn"
              onClick={(e) => {
                setCurrent(s.id);
                propPop.open(e.currentTarget);
              }}
            >
              {prop && <TypeIcon type={prop.type} size={16} />}
              <span className="rule-btn__label">{prop?.name ?? "Propiedad"}</span>
              <ChevronDown size={12} />
            </button>
            <button
              type="button"
              className="rule-btn"
              onClick={(e) => {
                setCurrent(s.id);
                dirPop.open(e.currentTarget);
              }}
            >
              <span className="rule-btn__label">{s.direction === "ascending" ? "Ascendente" : "Descendente"}</span>
              <ChevronDown size={12} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm sort-rule__remove"
              aria-label="Quitar orden"
              onClick={() => save(query2.sort.filter((x) => x.id !== s.id))}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      {unused.length > 0 && (
        <MenuItem icon={<Plus size={16} />} onClick={(e) => addPop.toggle(e.currentTarget)}>
          Agregar orden
        </MenuItem>
      )}
      <MenuItem icon={<Trash size={16} />} onClick={() => save([])}>
        Eliminar orden
      </MenuItem>
      {propPop.anchor && editing && (
        <Popover anchor={propPop.anchor} onClose={propPop.close} width={256}>
          <PropertyPicker
            schema={schema}
            order={order}
            placeholder="Ordenar por…"
            exclude={query2.sort.filter((x) => x.id !== editing.id).map((x) => x.property)}
            onPick={(property) => {
              propPop.close();
              void patch(editing.id, { property });
            }}
          />
        </Popover>
      )}
      {dirPop.anchor && editing && (
        <Popover anchor={dirPop.anchor} onClose={dirPop.close} width={180}>
          <div className="menu">
            {(["ascending", "descending"] as const).map((direction) => (
              <MenuItem
                key={direction}
                right={editing.direction === direction ? <Check size={14} /> : null}
                onClick={() => {
                  dirPop.close();
                  void patch(editing.id, { direction });
                }}
              >
                {direction === "ascending" ? "Ascendente" : "Descendente"}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
      {addPop.anchor && (
        <Popover anchor={addPop.anchor} onClose={addPop.close} width={256}>
          <PropertyPicker
            schema={schema}
            order={order}
            placeholder="Ordenar por…"
            exclude={query2.sort.map((x) => x.property)}
            onPick={(property) => {
              addPop.close();
              void save([...query2.sort, { id: shortId(), property, direction: "ascending" }]);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

// ------------------------------------------------------------- properties

const LOAD_LIMITS = [10, 25, 50, 100, 250, 500];

type SettingsPage = "root" | "layout" | "properties" | "group" | "subitems" | "load" | "colors";

/** Format patch that makes a view work in another layout (what each layout needs to show anything). */
function layoutFormat(view: CollectionView, collection: Collection, type: ViewType): CollectionView["format"] {
  const schema = Object.entries(collection.schema);
  const firstOf = (...types: string[]) => schema.find(([, s]) => types.includes(s.type))?.[0];
  const format = { ...view.format };
  if (type === "board" && !format.board_group_by)
    format.board_group_by = firstOf("status", "select", "multi_select") ?? firstOf(...GROUPABLE_TYPES);
  if (type === "calendar" && !format.calendar_by) format.calendar_by = firstOf("date", "created_time");
  if (type === "timeline" && !format.timeline_by) format.timeline_by = firstOf("date", "created_time");
  if (type === "timeline" && !format.timeline_zoom) format.timeline_zoom = "month";
  if (type === "gallery" && !format.gallery_cover) format.gallery_cover = { type: "page_content" };
  if (type === "chart" && !format.chart) format.chart = defaultChart(collection);
  if (type === "map" && !format.map_by) format.map_by = firstOf("place");
  return format;
}

/** Number grouping: the range the groups cover and each group's size ("Rango de números"). */
function NumberRangeFields({
  value,
  onChange,
}: {
  value: { start: number; end: number; step: number };
  onChange: (range: { start: number; end: number; step: number }) => void;
}) {
  const field = (key: keyof typeof value, label: string) => (
    <label className="number-range__field">
      <span>{label}</span>
      <input
        key={value[key]}
        className="field field--sm"
        type="number"
        defaultValue={value[key]}
        onBlur={(e) => {
          const n = Number(e.currentTarget.value);
          if (e.currentTarget.value.trim() === "" || !Number.isFinite(n) || n === value[key]) {
            e.currentTarget.value = String(value[key]);
            return;
          }
          const next = { ...value, [key]: n };
          if (next.step > 0 && next.end > next.start) onChange(next);
          else e.currentTarget.value = String(value[key]);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </label>
  );
  return (
    <>
      <MenuLabel>Rango de números</MenuLabel>
      <div className="number-range">
        {field("start", "Desde")}
        {field("end", "Hasta")}
      </div>
      <div className="number-range">{field("step", "Tamaño de cada grupo")}</div>
    </>
  );
}

/**
 * "Configuración de la vista": the view's name, then a row per setting
 * (layout, properties, filter, sort, group, sub-items, load limit) that opens
 * its own page, and the view actions.
 */
function PropertiesPanel({
  block,
  view,
  collection,
  rows,
  canDelete,
  onClose,
  onSelect,
  onFilter,
  onSort,
}: {
  block: Block;
  view: CollectionView;
  collection: Collection;
  rows: Block[];
  canDelete: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  /** Filter and sort open the toolbar's own popovers, anchored to the settings button. */
  onFilter: () => void;
  onSort: () => void;
}) {
  const props = viewProperties(view, collection);
  const deps = view.format.timeline_dependencies;
  const dependencies = deps && collection.schema[deps.blocked_by] && collection.schema[deps.blocking] ? deps : undefined;
  const addPop = usePopover();
  // "Agrupar": the dropdown open under one of its rows (property, date buckets, order…).
  const choicePop = usePopover();
  const [choice, setChoice] = useState<string | null>(null);
  const [page, setPage] = useState<SettingsPage>("root");
  const [name, setName] = useState(view.name);
  const commitName = () => name.trim() && name !== view.name && updateView(view.id, { name: name.trim() });
  const setFormat = (patch: Partial<CollectionView["format"]>) =>
    updateView(view.id, { format: { ...view.format, ...patch } });
  const toggle = (id: string) =>
    setFormat({ properties: props.map((p) => (p.property === id ? { ...p, visible: !p.visible } : p)) });
  // "Propiedades": the search, and ⋮⋮ dragging that sets the order cards and columns show.
  const [propQuery, setPropQuery] = useState("");
  const propDrag = useRowDrag((from, to, after) => {
    const moving = props.find((p) => p.property === from);
    if (!moving || from === to) return;
    const rest = props.filter((p) => p.property !== from);
    const at = rest.findIndex((p) => p.property === to);
    if (at === -1) return;
    rest.splice(after ? at + 1 : at, 0, moving);
    // The title leads cards; a table keeps it where it's dragged (as dragging its column does).
    void setFormat({ properties: rest, ...(from === "title" ? { table_title_moved: true } : {}) });
  });
  const groupable =
    view.type === "table" || view.type === "list" || view.type === "board" || view.type === "gallery" || view.type === "timeline";
  const grouping = groupable ? viewGrouping(view, collection.schema) : null;
  // Grouped tables, lists, galleries and timelines list their groups to hide and reorder.
  const groupValues = useGroupValues(rows, grouping?.groupBy.property, collection);
  const groupDrag = useRowDrag((from, to, after) => moveGroupRef.current?.(from, to, after));
  const moveGroupRef = useRef<((from: string, to: string, after: boolean) => void) | null>(null);
  // Boards' "Subagrupar" (swimlanes): the property's name, while it still exists and differs from the grouping.
  const subGroup = view.type === "board" ? view.format.board_sub_group_by : undefined;
  const subGroupName =
    subGroup && subGroup !== grouping?.groupBy.property && GROUPABLE_TYPES.includes(collection.schema[subGroup]?.type)
      ? collection.schema[subGroup].name
      : undefined;
  // "Subelementos" is offered in table, list and board views, turned on or not.
  const subitemsRow = view.type === "table" || view.type === "list" || view.type === "board" || view.type === "timeline";
  const subitems = subitemConfig(collection);
  const [confirmOff, setConfirmOff] = useState(false);
  const shownCount = props.filter((p) => p.visible).length;
  const filters = countActiveFilters(view.query2, collection.schema);
  const sorts = view.query2.sort.length;
  const value = (text: string) => (
    <>
      <span className="view-settings__value">{text}</span>
      <ChevronRight size={14} />
    </>
  );
  const row = (target: SettingsPage | (() => void), icon: React.ReactNode, label: string, right: string) => (
    <MenuItem
      className="view-settings__row"
      icon={icon}
      right={value(right)}
      onClick={() => (typeof target === "function" ? target() : setPage(target))}
    >
      {label}
    </MenuItem>
  );
  const head = (title: string) => (
    <div className="settings-head">
      <button type="button" className="icon-btn icon-btn--sm" aria-label="Atrás" onClick={() => setPage("root")}>
        <ChevronLeft size={16} />
      </button>
      <span className="settings-head__title">{title}</span>
    </div>
  );

  type Choice = { key: string; label: string; icon?: ReactNode; on: boolean; pick: () => void };
  /** A setting row ("Fecha por  Relativa ›") whose options open in a dropdown beside it. */
  const choiceRow = (id: string, label: string, current: string, options: Choice[], icon?: ReactNode) => (
    <>
      <MenuItem
        className="view-settings__row"
        icon={icon}
        right={value(current)}
        onClick={(e) => {
          setChoice(id);
          choicePop.toggle(e.currentTarget);
        }}
      >
        {label}
      </MenuItem>
      {choice === id && choicePop.anchor && (
        <Popover
          anchor={choicePop.anchor}
          onClose={() => {
            choicePop.close();
            setChoice(null);
          }}
          width={240}
          align="end"
        >
          <div className="menu settings-choice">
            {options.map((o) => (
              <MenuItem
                key={o.key}
                icon={o.icon}
                right={o.on ? <Check size={14} /> : null}
                onClick={() => {
                  choicePop.close();
                  setChoice(null);
                  o.pick();
                }}
              >
                {o.label}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
  const options = <K extends string>(list: readonly (readonly [K, string])[], current: K, set: (k: K) => void): Choice[] =>
    list.map(([key, label]) => ({ key, label, on: key === current, pick: () => set(key) }));
  /** Property pickers list properties in the view's order, as the table shows them. */
  const propOrder = props.map((p) => p.property);
  const inViewOrder = <T,>(list: [string, T][]) =>
    [...list].sort(([a], [b]) => {
      const ia = propOrder.indexOf(a);
      const ib = propOrder.indexOf(b);
      return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
    });
  /** A property choice: its type icon, checked when it's the current one. */
  const propChoices = (list: [string, PropertySchema][], current: string | undefined, set: (id: string) => void): Choice[] =>
    list.map(([id, s]) => ({ key: id, label: s.name, icon: <TypeIcon type={s.type} />, on: current === id, pick: () => set(id) }));
  const propName = (id: string | undefined) => (id && collection.schema[id]?.name) || "Ninguna";

  const dateProps = inViewOrder(Object.entries(collection.schema).filter(([, s]) => s.type === "date"));
  /** Card preview: none, the page cover, the page's first blocks, or a file property (gallery and board). */
  const coverMenu = (key: "gallery_cover" | "board_cover") => {
    const current = view.format[key] ?? { type: "none" };
    const list = [
      { type: "none" as const, label: "Ninguna" },
      { type: "page_cover" as const, label: "Portada de la página" },
      { type: "page_content" as const, label: "Contenido de la página" },
      ...inViewOrder(Object.entries(collection.schema).filter(([, s]) => s.type === "file")).map(([id, s]) => ({
        type: "property" as const,
        property: id,
        label: s.name,
      })),
    ].map((opt) => ({
      key: `${opt.type}:${"property" in opt ? opt.property : ""}`,
      label: opt.label,
      on: current.type === opt.type && (opt.type !== "property" || current.property === opt.property),
      pick: () => setFormat({ [key]: { type: opt.type, ...("property" in opt ? { property: opt.property } : {}) } }),
    }));
    return choiceRow("cover", "Vista previa de la tarjeta", list.find((o) => o.on)?.label ?? "Ninguna", list, <ImageIcon size={16} />);
  };
  const sizeLabels = [
    ["small", "Pequeño"],
    ["medium", "Mediano"],
    ["large", "Grande"],
  ] as const;
  const sizeMenu = (key: "gallery_card_size" | "board_card_size") => {
    const size = view.format[key] ?? "medium";
    return choiceRow(
      "size",
      "Tamaño de tarjeta",
      sizeLabels.find(([k]) => k === size)![1],
      options(sizeLabels, size, (next) => setFormat({ [key]: next })),
      <Scaling size={16} />,
    );
  };
  // "Ajustar contenido multimedia": the whole image fits the preview instead of filling it.
  const fitSwitch = (
    <MenuItem
      icon={<Crop size={16} />}
      right={<Switch on={view.format.gallery_cover_aspect === "contain"} />}
      onClick={() => setFormat({ gallery_cover_aspect: view.format.gallery_cover_aspect === "contain" ? "cover" : "contain" })}
    >
      Ajustar contenido multimedia
    </MenuItem>
  );

  if (page === "layout")
    return (
      <div className="menu">
        {head("Diseño")}
        <div className="layout-grid">
          {(Object.keys(VIEW_LABELS) as ViewType[])
            .filter((t) => t !== "dashboard")
            .map((type) => {
              const Icon = type === view.type ? viewIcon(view) : VIEW_ICONS[type];
              return (
                <button
                  type="button"
                  key={type}
                  className={`layout-grid__item${view.type === type ? " is-active" : ""}`}
                  onClick={() => updateView(view.id, { type, format: layoutFormat(view, collection, type) })}
                >
                  <Icon size={20} strokeWidth={1.6} />
                  <span>{VIEW_LABELS[type]}</span>
                </button>
              );
            })}
        </div>
        <MenuSeparator />
        {view.type === "board" && (
          <>
            {row("group", <Rows3 size={16} />, "Agrupar", grouping ? grouping.schema.name : "Ninguno")}
            {grouping && row("group", <Rows3 size={16} />, "Subagrupar", subGroupName ?? "Ninguno")}
            <MenuSeparator />
            {coverMenu("board_cover")}
            {sizeMenu("board_card_size")}
            {fitSwitch}
            <MenuItem
              icon={<PaintBucket size={16} />}
              right={<Switch on={view.format.board_color_columns !== false} />}
              onClick={() => setFormat({ board_color_columns: view.format.board_color_columns === false })}
            >
              Columnas de color
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {view.type === "calendar" && (
          <>
            {choiceRow(
              "calendar_by",
              "Mostrar calendario por",
              propName(view.format.calendar_by),
              propChoices(
                inViewOrder(
                  Object.entries(collection.schema).filter(
                    ([, s]) => s.type === "date" || s.type === "created_time" || s.type === "last_edited_time",
                  ),
                ),
                view.format.calendar_by,
                (id) => setFormat({ calendar_by: id }),
              ),
              <Calendar size={16} />,
            )}
            {choiceRow(
              "calendar_range",
              "Mostrar calendario como",
              (view.format.calendar_range ?? "month") === "week" ? "Semana" : "Mes",
              options(
                [
                  ["month", "Mes"],
                  ["week", "Semana"],
                ] as const,
                view.format.calendar_range ?? "month",
                (range) => setFormat({ calendar_range: range }),
              ),
              <CalendarRange size={16} />,
            )}
            <MenuItem
              icon={<CalendarDays size={16} />}
              right={<Switch on={view.format.calendar_show_weekends !== false} />}
              onClick={() => setFormat({ calendar_show_weekends: view.format.calendar_show_weekends === false })}
            >
              Mostrar fines de semana
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {view.type === "map" && (
          <>
            {choiceRow(
              "map_by",
              "Mapa por",
              propName(view.format.map_by),
              propChoices(
                inViewOrder(Object.entries(collection.schema).filter(([, s]) => s.type === "place")),
                view.format.map_by,
                (id) => setFormat({ map_by: id }),
              ),
              <MapPin size={16} />,
            )}
            <MenuSeparator />
          </>
        )}
        {view.type === "timeline" && (
          <>
            {choiceRow(
              "timeline_by",
              "Mostrar cronograma por",
              propName(view.format.timeline_by),
              propChoices(dateProps, view.format.timeline_by, (id) => setFormat({ timeline_by: id })),
              <ChartGantt size={16} />,
            )}
            <MenuItem
              icon={<CalendarRange size={16} />}
              right={<Switch on={!!view.format.timeline_by_end} />}
              onClick={() =>
                setFormat({
                  timeline_by_end: view.format.timeline_by_end
                    ? undefined
                    : (dateProps.find(([id]) => id !== view.format.timeline_by)?.[0] ?? view.format.timeline_by),
                })
              }
            >
              Separar fechas de inicio y finalización
            </MenuItem>
            {view.format.timeline_by_end &&
              choiceRow(
                "timeline_by_end",
                "Fecha de finalización",
                propName(view.format.timeline_by_end),
                propChoices(dateProps, view.format.timeline_by_end, (id) => setFormat({ timeline_by_end: id })),
                <CalendarClock size={16} />,
              )}
            <MenuItem
              icon={<Table2 size={16} />}
              right={<Switch on={view.format.timeline_show_table !== false} />}
              onClick={() => setFormat({ timeline_show_table: view.format.timeline_show_table === false })}
            >
              Mostrar tabla
            </MenuItem>
            <MenuItem
              icon={<Workflow size={16} />}
              right={<Switch on={!!dependencies} />}
              onClick={async () => {
                if (dependencies) return setFormat({ timeline_dependencies: undefined });
                const pair = await addDependencyProperties(collection.id);
                // Read the view again: the new properties were just added to its list.
                const fresh = pair && (await db.views.get(view.id));
                if (fresh) await updateView(view.id, { format: { ...fresh.format, timeline_dependencies: pair } });
              }}
            >
              Dependencias
            </MenuItem>
            {dependencies &&
              (() => {
                const modes = [
                  ["overlap", "Mover solo si las fechas se superponen", "Superposición"],
                  ["gap", "Mover y mantener la separación", "Separación"],
                  ["none", "No mover", "Ninguno"],
                ] as const;
                const mode = dependencies.shift ?? "overlap";
                const setDeps = (patch: Partial<typeof dependencies>) =>
                  setFormat({ timeline_dependencies: { ...dependencies, ...patch } });
                return (
                  <>
                    {choiceRow(
                      "dep_shift",
                      "Cambio de fechas",
                      modes.find(([m]) => m === mode)![2],
                      modes.map(([m, text]) => ({ key: m, label: text, on: m === mode, pick: () => setDeps({ shift: m }) })),
                      <MoveHorizontal size={16} />,
                    )}
                    <MenuItem
                      icon={<CalendarX size={16} />}
                      right={<Switch on={!!dependencies.skip_weekends} />}
                      onClick={() => setDeps({ skip_weekends: !dependencies.skip_weekends || undefined })}
                    >
                      Evitar fines de semana
                    </MenuItem>
                  </>
                );
              })()}
            <MenuSeparator />
          </>
        )}
        {view.type === "gallery" && (
          <>
            {coverMenu("gallery_cover")}
            {sizeMenu("gallery_card_size")}
            {fitSwitch}
            <MenuSeparator />
          </>
        )}
        {view.type === "table" && (
          <>
            <MenuItem
              icon={<WrapText size={16} />}
              right={<Switch on={view.format.table_wrap !== false} />}
              onClick={() => setFormat({ table_wrap: view.format.table_wrap === false })}
            >
              Ajustar contenido de las celdas
            </MenuItem>
            <MenuItem
              icon={<FileText size={16} />}
              right={<Switch on={view.format.show_page_icon !== false} />}
              onClick={() => setFormat({ show_page_icon: view.format.show_page_icon === false })}
            >
              Mostrar icono de página
            </MenuItem>
            <MenuItem
              icon={<Columns3 size={16} />}
              right={<Switch on={view.format.table_vertical_lines !== false} />}
              onClick={() => setFormat({ table_vertical_lines: view.format.table_vertical_lines === false })}
            >
              Mostrar líneas verticales
            </MenuItem>
          </>
        )}
        {view.type !== "chart" &&
          (() => {
            const modes = [
              ["side", "Ventana lateral", PanelRight],
              ["center", "Ventana central", Maximize2],
              ["full", "Página completa", FileText],
            ] as const;
            const mode = view.format.open_pages_in ?? "side";
            const [, label, Icon] = modes.find(([m]) => m === mode) ?? modes[0];
            return choiceRow(
              "open",
              "Abrir páginas en",
              label,
              modes.map(([m, text, ModeIcon]) => ({
                key: m,
                label: text,
                icon: <ModeIcon size={16} />,
                on: m === mode,
                pick: () => setFormat({ open_pages_in: m }),
              })),
              <Icon size={16} />,
            );
          })()}
      </div>
    );

  if (page === "properties") {
    const q = propQuery.trim().toLowerCase();
    const found = props.filter((p) => collection.schema[p.property].name.toLowerCase().includes(q));
    const setVisible = (ids: string[], visible: boolean) =>
      setFormat({ properties: props.map((p) => (ids.includes(p.property) && p.property !== "title" ? { ...p, visible } : p)) });
    const section = (title: string, list: ViewProperty[], shown: boolean) =>
      list.length > 0 && (
        <>
          <div className="settings-groups__label">
            <MenuLabel>{title}</MenuLabel>
            <button
              type="button"
              className="settings-groups__all"
              onClick={() => setVisible(list.map((p) => p.property), !shown)}
            >
              {shown ? "Ocultar todas" : "Mostrar todas"}
            </button>
          </div>
          {list.map((p) => {
            const s = collection.schema[p.property];
            const locked = p.property === "title";
            return (
              <div
                key={p.property}
                className={`menu-item settings-drag-row${propDrag.dropClass(p.property)}`}
                {...(locked && view.type !== "table" ? {} : propDrag.rowProps(p.property))}
              >
                <span className="settings-drag-row__grip" aria-hidden>
                  <GripVertical size={14} />
                </span>
                <span className="menu-item__icon">
                  <TypeIcon type={s.type} />
                </span>
                <span className="menu-item__label">{s.name}</span>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm settings-groups__eye"
                  aria-label={p.visible ? "Ocultar propiedad" : "Mostrar propiedad"}
                  disabled={locked}
                  onClick={() => toggle(p.property)}
                >
                  {p.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
              </div>
            );
          })}
        </>
      );
    return (
      <div className="menu">
        {head("Propiedades")}
        <input
          className="menu-search"
          autoFocus
          placeholder="Buscar una propiedad"
          value={propQuery}
          onChange={(e) => setPropQuery(e.target.value)}
        />
        <div className="settings-groups">
          {section(`Mostradas en ${view.name || VIEW_LABELS[view.type]}`, found.filter((p) => p.visible), true)}
          {section(`Ocultas en ${view.name || VIEW_LABELS[view.type]}`, found.filter((p) => !p.visible), false)}
          {!found.length && <div className="menu-empty">Sin resultados</div>}
        </div>
        <MenuSeparator />
        <MenuItem icon={<Plus size={16} />} onClick={(e) => addPop.toggle(e.currentTarget)}>
          Nueva propiedad
        </MenuItem>
        {addPop.anchor && (
          <Popover anchor={addPop.anchor} onClose={addPop.close} width={256}>
            <AddPropertyMenu collectionId={collection.id} onDone={addPop.close} />
          </Popover>
        )}
      </div>
    );
  }

  if (page === "group") {
    const board = view.type === "board";
    const current = board ? boardGroupBy(view) : view.format.group_by;
    /** Boards keep their grouping in their own fields; tables and lists in group_by. */
    const setGroup = (patch: Partial<GroupBy> | null) => {
      if (!board)
        return setFormat({ group_by: patch && (current || patch.property) ? ({ ...current, ...patch } as GroupBy) : undefined });
      if (!patch) return;
      const { property, mode, hide_empty, ...rest } = patch;
      const next: Partial<CollectionView["format"]> = {};
      if (mode !== undefined) next.board_group_mode = mode;
      if (hide_empty !== undefined) next.board_hide_empty = hide_empty;
      if (Object.keys(rest).length) next.board_group = { ...view.format.board_group, ...rest };
      return setFormat(next);
    };
    const pick = (id: string) =>
      board
        ? setFormat({ board_group_by: id, board_group_mode: undefined, board_group: undefined })
        : setFormat({ group_by: { property: id } });
    const candidates = inViewOrder(Object.entries(collection.schema).filter(([, s]) => GROUPABLE_TYPES.includes(s.type)));
    const type = grouping?.schema.type;
    const isDate = type === "date" || type === "created_time" || type === "last_edited_time";
    const isText = type === "text" || type === "url" || type === "email" || type === "phone_number";
    // Group order, named for each kind of value.
    const sortLabels: Record<"manual" | "ascending" | "descending", string> = isDate
      ? { manual: "Manual", ascending: "Más antiguas primero", descending: "Más recientes primero" }
      : type === "number" || type === "checkbox" || type === "formula" || type === "rollup"
        ? { manual: "Manual", ascending: "Ascendente", descending: "Descendente" }
        : { manual: "Manual", ascending: "Alfabético", descending: "Alfabético inverso" };
    const columns = board && grouping && !isComputedGroup(grouping.schema.type) ? boardColumns(view, collection, rows) : null;
    const listedColumns = columns
      ? columns.columns.filter((c) => c.key !== NO_GROUP || columns.byColumn.get(c.key)!.length || columnSetting(view, c.key))
      : [];
    const hiddenOf = (c: Column) => !!columnSetting(view, c.key)?.hidden;
    // Other layouts: their groups as the view draws them, hidden ones and dragged order kept in group_by.
    const rowGroups = !board && grouping ? groupRows(rows, { ...grouping.groupBy, hidden: [] }, grouping.schema, groupValues) : [];
    const hiddenKeys = (!board && grouping?.groupBy.hidden) || [];
    type GroupItem = { key: string; label: ReactNode; hidden: boolean };
    const listed: GroupItem[] = board
      ? listedColumns.map((c) => ({ key: c.key, label: <ColumnLabel column={c} schema={grouping!.schema} />, hidden: hiddenOf(c) }))
      : rowGroups.map((g) => ({ key: g.key, label: <GroupValue group={g} schema={grouping!.schema} />, hidden: hiddenKeys.includes(g.key) }));
    const setHiddenGroups = (keys: string[], hide: boolean) => {
      if (!board) {
        const next = hide ? [...new Set([...hiddenKeys, ...keys])] : hiddenKeys.filter((k) => !keys.includes(k));
        return setGroup({ hidden: next.length ? next : undefined });
      }
      return (
        columns &&
        setFormat({
          board_columns: savedColumns(view, columns.columns, keys.length === 1 ? keys[0] : "", (c) =>
            keys.includes(c.key) ? hide : hiddenOf(c),
          ),
        })
      );
    };
    // ⋮⋮ drags a group to a new place: boards save their column order, the others a manual group order.
    moveGroupRef.current = (from, to, after) => {
      const keys = board ? (columns?.columns ?? []).map((c) => c.key) : rowGroups.map((g) => g.key);
      if (!keys.includes(from) || !keys.includes(to) || from === to) return;
      const rest = keys.filter((k) => k !== from);
      const at = rest.indexOf(to);
      rest.splice(after ? at + 1 : at, 0, from);
      if (!board) return void setGroup({ order: rest, sort: "manual" });
      if (!columns) return;
      const byKey = new Map(columns.columns.map((c) => [c.key, c]));
      void setFormat({ board_group: { ...view.format.board_group, sort: "manual" }, board_columns: savedColumns(view, rest.map((k) => byKey.get(k)!), from, hiddenOf) });
    };
    const groupList = (title: string, list: GroupItem[], hide: boolean) =>
      list.length > 0 && (
        <>
          <div className="settings-groups__label">
            <MenuLabel>{title}</MenuLabel>
            <button
              type="button"
              className="settings-groups__all"
              onClick={() => setHiddenGroups(list.map((c) => c.key), hide)}
            >
              {hide ? "Ocultar todos" : "Mostrar todos"}
            </button>
          </div>
          {list.map((c) => (
            // A row, not a button: the label can hold a page link or a person chip.
            <div
              key={c.key}
              className={`menu-item settings-groups__row settings-drag-row${groupDrag.dropClass(c.key)}`}
              {...groupDrag.rowProps(c.key)}
            >
              <span className="settings-drag-row__grip" aria-hidden>
                <GripVertical size={14} />
              </span>
              <span className="settings-groups__name">{c.label}</span>
              <button
                type="button"
                className="icon-btn icon-btn--sm settings-groups__eye"
                aria-label={hide ? "Ocultar grupo" : "Mostrar grupo"}
                onClick={() => setHiddenGroups([c.key], hide)}
              >
                {hide ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </div>
          ))}
        </>
      );
    const dateBy = grouping?.groupBy.date_by ?? "relative";
    const dateLabels = [
      ["relative", "Relativa"],
      ["day", "Día"],
      ["week", "Semana"],
      ["month", "Mes"],
      ["year", "Año"],
    ] as const;
    const textLabels = [
      ["exact", "Texto exacto"],
      ["alphabetical", "Alfabético"],
    ] as const;
    const sort = grouping?.groupBy.sort ?? "manual";
    return (
      <div className="menu">
        {head("Agrupar")}
        {choiceRow("property", "Agrupar por", grouping ? grouping.schema.name : "Ninguno", [
          ...(board ? [] : [{ key: "", label: "Ninguno", on: !grouping, pick: () => setGroup(null) }]),
          ...candidates.map(([id, s]) => ({
            key: id,
            label: s.name,
            icon: <TypeIcon type={s.type} />,
            on: grouping?.groupBy.property === id,
            pick: () => pick(id),
          })),
        ])}
        {board &&
          grouping &&
          choiceRow("subgroup", "Subagrupar", subGroupName ?? "Ninguno", [
            { key: "", label: "Ninguno", on: !subGroupName, pick: () => setFormat({ board_sub_group_by: undefined }) },
            ...candidates
              .filter(([id]) => id !== grouping.groupBy.property)
              .map(([id, s]) => ({
                key: id,
                label: s.name,
                icon: <TypeIcon type={s.type} />,
                on: view.format.board_sub_group_by === id,
                pick: () => setFormat({ board_sub_group_by: id }),
              })),
          ])}
        {grouping && (
          <>
            {type === "status" &&
              choiceRow(
                "mode",
                "Agrupar estado por",
                grouping.groupBy.mode === "group" ? "Grupo" : "Opción",
                options(
                  [
                    ["group", "Grupo"],
                    ["option", "Opción"],
                  ] as const,
                  grouping.groupBy.mode === "group" ? "group" : "option",
                  (mode) => setGroup({ mode }),
                ),
              )}
            {isDate &&
              choiceRow(
                "date",
                "Fecha por",
                dateLabels.find(([k]) => k === dateBy)![1],
                options(dateLabels, dateBy, (date_by) => setGroup({ date_by })),
              )}
            {isText &&
              choiceRow(
                "text",
                "Texto por",
                textLabels.find(([k]) => k === (grouping.groupBy.text_by ?? "exact"))![1],
                options(textLabels, grouping.groupBy.text_by ?? "exact", (text_by) => setGroup({ text_by })),
              )}
            {type === "number" && (
              <NumberRangeFields value={numberRange(grouping.groupBy)} onChange={(number_range) => setGroup({ number_range })} />
            )}
            {choiceRow(
              "sort",
              "Ordenar",
              sortLabels[sort],
              options(
                (["manual", "ascending", "descending"] as const).map((k) => [k, sortLabels[k]] as const),
                sort,
                (next) => setGroup({ sort: next }),
              ),
            )}
            <MenuItem
              right={<Switch on={!!grouping.groupBy.hide_empty} />}
              onClick={() => setGroup({ hide_empty: !grouping.groupBy.hide_empty })}
            >
              Ocultar grupos vacíos
            </MenuItem>
            {board && (type === "select" || type === "status" || type === "multi_select") && (
              <MenuItem
                right={<Switch on={view.format.board_color_columns !== false} />}
                onClick={() => setFormat({ board_color_columns: view.format.board_color_columns === false })}
              >
                Columnas de color
              </MenuItem>
            )}
            {listed.length > 0 && (
              <>
                <MenuSeparator />
                <div className="settings-groups">
                  {groupList("Grupos visibles", listed.filter((c) => !c.hidden), true)}
                  {groupList("Grupos ocultos", listed.filter((c) => c.hidden), false)}
                </div>
              </>
            )}
            {!board && (
              <>
                <MenuSeparator />
                <MenuItem danger icon={<Trash size={16} />} onClick={() => setGroup(null)}>
                  Eliminar agrupación
                </MenuItem>
              </>
            )}
          </>
        )}
      </div>
    );
  }

  if (page === "subitems")
    return (
      <div className="menu">
        {head("Subelementos")}
        {!subitems ? (
          <>
            <div className="settings-note">
              Anida páginas dentro de otras páginas de esta base de datos con las propiedades «Elemento principal» y
              «Subelemento».
            </div>
            <MenuItem icon={<ListTree size={16} />} onClick={() => void enableSubitems(collection.id, view.id)}>
              Activar subelementos
            </MenuItem>
          </>
        ) : confirmOff ? (
          <>
            <MenuLabel>¿Conservar las propiedades de subelementos?</MenuLabel>
            <MenuItem
              onClick={() => {
                setConfirmOff(false);
                void disableSubitems(collection.id, false);
              }}
            >
              Desactivar y conservar propiedades
            </MenuItem>
            <MenuItem
              danger
              icon={<Trash size={16} />}
              onClick={() => {
                setConfirmOff(false);
                void disableSubitems(collection.id, true);
              }}
            >
              Desactivar y eliminar propiedades
            </MenuItem>
            <MenuItem onClick={() => setConfirmOff(false)}>Cancelar</MenuItem>
          </>
        ) : (
          <>
            {(
              [
                ["nested", "Alojados en menús desplegables"],
                ["property", "Propiedad de tarjeta"],
                ["off", "Desactivado"],
              ] as const
            ).map(([mode, label]) => (
              <MenuItem
                key={mode}
                right={(view.format.subitems_display ?? "nested") === mode ? <Check size={14} /> : null}
                onClick={() => setFormat({ subitems_display: mode })}
              >
                {label}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuLabel>Aplicar filtros a</MenuLabel>
            {(
              [
                ["both", "Elementos principales y subelementos"],
                ["parents", "Solo elementos principales"],
                ["subitems", "Solo subelementos"],
              ] as const
            ).map(([mode, label]) => (
              <MenuItem
                key={mode}
                right={(view.format.subitems_filter ?? "both") === mode ? <Check size={14} /> : null}
                onClick={() => setFormat({ subitems_filter: mode === "both" ? undefined : mode })}
              >
                {label}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem
              right={<Switch on={!!view.format.subitems_expanded} />}
              onClick={() => setFormat({ subitems_expanded: !view.format.subitems_expanded || undefined })}
            >
              Mostrar subelementos desplegados
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger icon={<Trash size={16} />} onClick={() => setConfirmOff(true)}>
              Desactivar subelementos
            </MenuItem>
          </>
        )}
      </div>
    );

  if (page === "colors")
    return (
      <div className="menu">
        {head("Color condicional")}
        <ColorRulesMenu view={view} collection={collection} />
      </div>
    );

  if (page === "load")
    return (
      <div className="menu">
        {head("Cargar")}
        {LOAD_LIMITS.map((n) => (
          <MenuItem
            key={n}
            right={(view.format.load_limit ?? 50) === n ? <Check size={14} /> : null}
            onClick={() => setFormat({ load_limit: n })}
          >
            {n} páginas
          </MenuItem>
        ))}
      </div>
    );

  const subLabel = subitems
    ? { nested: "Alojados", property: "Propiedad", off: "Desactivado" }[view.format.subitems_display ?? "nested"]
    : "Desactivado";
  return (
    <div className="menu view-settings">
      <div className="view-settings__title">Configuración de la vista</div>
      <div className="view-name">
        <span className="view-name__icon">
          {(() => {
            const Icon = viewIcon(view);
            return <Icon size={16} strokeWidth={1.8} />;
          })()}
        </span>
        <input
          className="field view-name__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === "Enter" && commitName()}
          aria-label="Nombre de la vista"
        />
      </div>
      {row("layout", <LayoutGrid size={16} />, "Diseño", VIEW_LABELS[view.type])}
      {view.type !== "dashboard" && (
        <>
          {row("properties", <List size={16} />, "Propiedades", `${shownCount} mostradas`)}
          {view.type !== "form" && (
            <>
              {row(onFilter, <ListFilter size={16} />, "Filtro", filters ? `${filters} ${filters === 1 ? "filtro" : "filtros"}` : "Ninguno")}
              {row(onSort, <ArrowUpDown size={16} />, "Ordenar", sorts ? `${sorts} ${sorts === 1 ? "orden" : "órdenes"}` : "Ninguno")}
            </>
          )}
          {groupable &&
            row("group", <Rows3 size={16} />, "Agrupar", grouping ? grouping.schema.name : "Ninguno")}
          {view.type === "board" && grouping && row("group", <Rows3 size={16} />, "Subagrupar", subGroupName ?? "Ninguno")}
          {subitemsRow && row("subitems", <ListTree size={16} />, "Subelementos", subLabel)}
          {["table", "board", "list", "gallery", "calendar", "timeline"].includes(view.type) &&
            row(
              "colors",
              <Paintbrush size={16} />,
              "Color condicional",
              view.format.color_rules?.length
                ? `${view.format.color_rules.length} ${view.format.color_rules.length === 1 ? "regla" : "reglas"}`
                : "Ninguna",
            )}
          {view.type !== "chart" &&
            view.type !== "form" &&
            row("load", <ArrowDownToLine size={16} />, "Cargar", `${view.format.load_limit ?? 50} páginas`)}
        </>
      )}
      <MenuSeparator />
      <MenuItem
        icon={<Link size={16} />}
        onClick={() => {
          onClose();
          void copyViewLink(block, view);
        }}
      >
        Copiar enlace a la vista
      </MenuItem>
      <AddViewToSidebarItem databaseId={block.id} viewId={view.id} onDone={onClose} />
      <MenuItem
        icon={<CopyPlus size={16} />}
        onClick={async () => {
          onClose();
          const id = await duplicateView(block.id, view.id);
          if (id) onSelect(id);
        }}
      >
        Duplicar vista
      </MenuItem>
      <MenuItem
        danger
        icon={<Trash size={16} />}
        disabled={!canDelete}
        onClick={() => {
          onClose();
          void deleteView(block.id, view.id);
        }}
      >
        Eliminar vista
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<FileUp size={16} />}
        onClick={() => {
          onClose();
          void mergeCsvFile(collection.id);
        }}
      >
        Combinar con CSV
      </MenuItem>
    </div>
  );
}
