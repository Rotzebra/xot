import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Circle, CircleCheck, Clock, House, Plus, SlidersHorizontal, X } from "lucide-react";
import { SidebarOpenIcon } from "./SidebarOpenIcon";
import { db } from "../lib/db";
import type { Block, Collection, CollectionView } from "../lib/model";
import { pageLinkProps, pageTitle, useRecentPages, useStoredState } from "../lib/hooks";
import { localDay } from "../lib/format";
import { getAncestors, setRowValue } from "../lib/ops";
import { applyQuery, dateDay } from "../lib/query";
import { useSettings } from "../lib/settings";
import { inWorkspace, loadWorkspace, useStoredWorkspace } from "../lib/workspace";
import { coverSrc, gradientOf } from "./PageCover";
import { MenuItem, MenuLabel, MenuSeparator, PageIcon, Popover, Switch, usePopover } from "./ui";
import { viewIcon } from "./database/DatabaseView";
import { ViewPicker } from "./SidebarCustomizer";

/** "#/home": Inicio, opened from the sidebar's first pill. */
export const HOME_ROUTE = "home";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";
const shortDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });

/** Pages shown in "Visitado recientemente". */
const RECENT_CARDS = 12;
/** Rows a task or view widget lists. */
const WIDGET_ROWS = 8;

/** Inicio's widgets: which built-in ones are hidden, and the database views added. */
type HomeWidgets = { hidden: ("recent" | "tasks")[]; views: { databaseId: string; viewId: string }[] };
const DEFAULT_WIDGETS: HomeWidgets = { hidden: [], views: [] };

/** The widget's frame: label on the left, optional actions on the right. */
function Widget({ icon, label, right, children, id }: { icon: ReactNode; label: ReactNode; right?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="home__section" data-widget={id}>
      <div className="home__label">
        {icon}
        <span className="home__label-text">{label}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

/** The group a status option belongs to is "complete" (Completado). */
function completeOptions(schema: Collection["schema"][string]) {
  const groups = schema.groups ?? [];
  const done = groups.find((g) => /complet|hecho|done/i.test(g.name)) ?? groups[groups.length - 1];
  return done?.option_ids ?? [];
}

const dueDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });

/** Whether a page lies in workspace `ws` (Inicio only shows the open workspace). */
async function inWs(b: Block, ws: string) {
  return inWorkspace((await getAncestors(b))[0] ?? b, ws);
}

/**
 * "Mis tareas": the open tasks of every database with a Status property (not in
 * its Completado group) in the open workspace, by due date. The circle marks one done.
 */
function MyTasks() {
  const stored = useStoredWorkspace();
  const [showAll, setShowAll] = useState(false);
  const tasks = useLiveQuery(async () => {
    const ws = await loadWorkspace();
    const collections = await db.collections.toArray();
    const out: { row: Block; db: Block; statusId: string; doneId?: string; due: string }[] = [];
    for (const c of collections) {
      const status = Object.entries(c.schema).find(([, p]) => p.type === "status");
      if (!status) continue;
      const owner = await db.blocks.get(c.parent_id);
      if (!owner?.alive || owner.is_template || !(await inWs(owner, ws))) continue;
      const [statusId, schema] = status;
      const done = completeOptions(schema);
      const dateId = Object.entries(c.schema).find(([, p]) => p.type === "date")?.[0];
      const rows = await db.blocks.where("[parent_table+parent_id]").equals(["collection", c.id]).toArray();
      for (const row of rows) {
        if (!row.alive || row.is_template) continue;
        const value = row.properties[statusId];
        if (typeof value === "string" && done.includes(value)) continue;
        out.push({ row, db: owner, statusId, doneId: done[0], due: dateId ? dateDay(row.properties[dateId]) : "" });
      }
    }
    return out.sort(
      (a, b) =>
        (a.due ? 0 : 1) - (b.due ? 0 : 1) || a.due.localeCompare(b.due) || b.row.last_edited_time - a.row.last_edited_time,
    );
  }, [stored]);
  const today = localDay();
  if (!tasks) return null;
  if (!tasks.length) return <div className="home-widget__empty">No tienes tareas pendientes.</div>;
  return (
    <div className="home-widget">
      {(showAll ? tasks : tasks.slice(0, WIDGET_ROWS)).map((t) => (
        <div key={t.row.id} className="home-task">
          <button
            type="button"
            className="home-task__check"
            aria-label="Marcar como completada"
            data-tooltip="Marcar como completada"
            disabled={!t.doneId}
            onClick={() => t.doneId && void setRowValue(t.row.id, t.statusId, t.doneId)}
          >
            <Circle size={16} className="home-task__open" />
            <CircleCheck size={16} className="home-task__done" />
          </button>
          <button type="button" className="home-task__title" {...pageLinkProps(t.row.id)}>
            {pageTitle(t.row)}
          </button>
          <span className="home-task__db">
            <PageIcon block={t.db} size={14} />
            {pageTitle(t.db)}
          </span>
          {t.due && (
            <span className={`home-task__due${t.due < today ? " is-overdue" : ""}`}>
              {dueDate.format(new Date(`${t.due}T00:00:00`))}
            </span>
          )}
        </div>
      ))}
      {tasks.length > WIDGET_ROWS && (
        <button type="button" className="home-widget__more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Mostrar menos" : `${tasks.length - WIDGET_ROWS} tareas más`}
        </button>
      )}
    </div>
  );
}

/** A database view on Inicio: its rows, with the view's filters and sorts, linking to the view. */
function ViewWidget({ databaseId, viewId, onRemove }: { databaseId: string; viewId: string; onRemove: () => void }) {
  const data = useLiveQuery(async () => {
    const [block, view] = await Promise.all([db.blocks.get(databaseId), db.views.get(viewId)]);
    if (!block?.alive || !view || !block.collection_id) return null;
    const collection = await db.collections.get(block.collection_id);
    if (!collection) return null;
    const rows = (await db.blocks.where("[parent_table+parent_id]").equals(["collection", collection.id]).toArray()).filter(
      (r) => r.alive && !r.is_template,
    );
    return { block, view, rows: applyQuery(rows, collection.schema, view.query2, view.format.page_sort) };
  }, [databaseId, viewId]);
  if (data === undefined) return null;
  if (!data) return null;
  const Icon = viewIcon(data.view as CollectionView);
  return (
    <Widget
      icon={<PageIcon block={data.block} size={14} />}
      label={
        <a className="home__view-link" href={`#/${data.block.id}?v=${data.view.id}`}>
          {pageTitle(data.block)}
          <span className="home__view-name">
            <Icon size={12} /> {data.view.name || "Sin título"}
          </span>
        </a>
      }
      right={
        <button type="button" className="icon-btn home__widget-remove" aria-label="Quitar widget" data-tooltip="Quitar widget" onClick={onRemove}>
          <X size={14} />
        </button>
      }
    >
      <div className="home-widget">
        {data.rows.length === 0 && <div className="home-widget__empty">Sin páginas</div>}
        {data.rows.slice(0, WIDGET_ROWS).map((r) => (
          <button key={r.id} type="button" className="home-row" {...pageLinkProps(r.id)}>
            <PageIcon block={r} size={16} />
            <span className="home-row__title">{pageTitle(r)}</span>
            <span className="home-row__meta">{shortDate.format(r.last_edited_time)}</span>
          </button>
        ))}
        {data.rows.length > WIDGET_ROWS && (
          <a className="home-widget__more" href={`#/${data.block.id}?v=${data.view.id}`}>
            Ver las {data.rows.length} páginas
          </a>
        )}
      </div>
    </Widget>
  );
}

function greeting(hour = new Date().getHours()) {
  if (hour >= 5 && hour < 12) return "Buenos días";
  if (hour >= 12 && hour < 20) return "Buenas tardes";
  return "Buenas noches";
}

/** A recent page: cover strip, icon over its edge, title and when it was edited. */
function PageCard({ block }: { block: Block }) {
  const cover = block.format.cover;
  const gradient = cover ? gradientOf(cover) : null;
  return (
    <button type="button" className="home-card" {...pageLinkProps(block.id)}>
      <span
        className="home-card__cover"
        style={
          cover
            ? gradient
              ? { background: gradient }
              : { backgroundImage: `url("${coverSrc(cover)}")`, backgroundPosition: `center ${(block.format.cover_position ?? 0.5) * 100}%` }
            : undefined
        }
      />
      <span className="home-card__icon">
        <PageIcon block={block} size={32} />
      </span>
      <span className="home-card__title">{pageTitle(block)}</span>
      <span className="home-card__meta">{shortDate.format(block.last_edited_time)}</span>
    </button>
  );
}

export function HomeView({
  sidebarOpen,
  onOpenSidebar,
  onPeekSidebar,
  onUnpeekSidebar,
}: {
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onPeekSidebar?: () => void;
  onUnpeekSidebar?: () => void;
}) {
  const recents = useRecentPages();
  const stored = useStoredWorkspace();
  const name = useSettings().name.trim();
  const [widgets, setWidgets] = useStoredState<HomeWidgets>("xotion:home-widgets", DEFAULT_WIDGETS);
  const custom = usePopover();
  const addView = usePopover();
  const tasksRef = useRef<HTMLDivElement>(null);
  // The sidebar's "Mis tareas" shortcut opens Inicio at the tasks widget.
  useEffect(() => {
    if (window.location.hash.includes("?tasks")) tasksRef.current?.scrollIntoView({ block: "start" });
  });
  const shows = (w: "recent" | "tasks") => !widgets.hidden.includes(w);
  const toggle = (w: "recent" | "tasks") =>
    setWidgets({ ...widgets, hidden: shows(w) ? [...widgets.hidden, w] : widgets.hidden.filter((h) => h !== w) });
  const pages = useLiveQuery(async () => {
    const ws = await loadWorkspace();
    const out: Block[] = [];
    for (const b of await db.blocks.bulkGet(recents)) {
      if (out.length >= RECENT_CARDS) break;
      if (!b?.alive || b.is_template || (b.type !== "page" && b.type !== "collection_view_page")) continue;
      if (await inWs(b, ws)) out.push(b);
    }
    return out;
  }, [recents, stored]);

  return (
    <div className="page-shell">
      <header className="topbar">
        {!sidebarOpen && (
          <button
            type="button"
            className="icon-btn topbar__sidebar"
            aria-label="Mostrar barra lateral"
            data-tooltip="Mostrar barra lateral"
            data-shortcut={`${mod}\\`}
            onClick={onOpenSidebar}
            onMouseEnter={onPeekSidebar}
            onMouseLeave={onUnpeekSidebar}
          >
            <SidebarOpenIcon />
          </button>
        )}
        <nav className="crumbs" aria-label="Ruta">
          <span className="crumbs__item">
            <span className="crumb">
              <House size={16} />
              <span className="crumb__title">Inicio</span>
            </span>
          </span>
        </nav>
        <button type="button" className="ghost-btn home__customize" onClick={(e) => custom.toggle(e.currentTarget)}>
          <SlidersHorizontal size={14} /> Personalizar Inicio
        </button>
        {custom.anchor && (
          <Popover anchor={custom.anchor} onClose={custom.close} width={280} align="end">
            <div className="menu">
              <MenuLabel>Mostrar u ocultar widgets</MenuLabel>
              <MenuItem icon={<Clock size={18} />} right={<Switch on={shows("recent")} />} onClick={() => toggle("recent")}>
                Visitado recientemente
              </MenuItem>
              <MenuItem icon={<CircleCheck size={18} />} right={<Switch on={shows("tasks")} />} onClick={() => toggle("tasks")}>
                Mis tareas
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Plus size={18} />} onClick={(e) => addView.open(e.currentTarget)}>
                Añadir una vista de base de datos
              </MenuItem>
            </div>
          </Popover>
        )}
        {addView.anchor && (
          <Popover anchor={addView.anchor} onClose={addView.close} width={300}>
            <ViewPicker
              onPick={(databaseId, viewId) => {
                addView.close();
                custom.close();
                if (!widgets.views.some((v) => v.viewId === viewId))
                  setWidgets({ ...widgets, views: [...widgets.views, { databaseId, viewId }] });
              }}
            />
          </Popover>
        )}
      </header>
      <div className="scroller">
        <div className="home">
          <h1 className="home__greeting">{name ? `${greeting()}, ${name}` : greeting()}</h1>
          {shows("recent") && pages && pages.length > 0 && (
            <Widget icon={<Clock size={14} />} label="Visitado recientemente" id="recent">
              <div className="home__cards">
                {pages.map((b) => (
                  <PageCard key={b.id} block={b} />
                ))}
              </div>
            </Widget>
          )}
          {shows("tasks") && (
            <div ref={tasksRef}>
              <Widget icon={<CircleCheck size={14} />} label="Mis tareas" id="tasks">
                <MyTasks />
              </Widget>
            </div>
          )}
          {widgets.views.map((v) => (
            <ViewWidget
              key={v.viewId}
              databaseId={v.databaseId}
              viewId={v.viewId}
              onRemove={() => setWidgets({ ...widgets, views: widgets.views.filter((x) => x.viewId !== v.viewId) })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
