// Dashboards ("Panel"): moving, resizing, duplicating widgets, the widgets made from an existing
// view, and the filters the whole dashboard applies. Edit mode is kept per dashboard while Xot runs.
import { useSyncExternalStore } from "react";
import { db } from "./db";
import { shortId, uuid } from "./ops";
import type { Collection, CollectionView, DashboardRow, Filter, PropertySchema, Query } from "./model";

type Dashboard = NonNullable<CollectionView["format"]["dashboard"]>;

async function editDashboard(dashboardId: string, change: (d: Dashboard) => Dashboard) {
  const view = await db.views.get(dashboardId);
  if (!view?.format.dashboard) return;
  const next = change(view.format.dashboard);
  next.rows = next.rows.filter((r) => r.widgets.length);
  await db.views.update(dashboardId, { format: { ...view.format, dashboard: next } });
}

/** Four widgets fit in a row. */
export const MAX_PER_ROW = 4;

/**
 * Moves a widget next to another (before or after it, in that one's row) or into a new row at
 * the end. A full row doesn't take one more from another row.
 */
export function moveWidget(dashboardId: string, widgetId: string, target: { id: string; side: "before" | "after" } | "new_row") {
  return editDashboard(dashboardId, (d) => {
    const from = d.rows.find((r) => r.widgets.includes(widgetId));
    if (!from) return d;
    if (target === "new_row") {
      const rows = d.rows.map((r) => (r === from ? { ...r, widgets: r.widgets.filter((w) => w !== widgetId) } : r));
      return { ...d, rows: [...rows, { id: shortId(), height: from.height, widgets: [widgetId] }] };
    }
    const to = d.rows.find((r) => r.widgets.includes(target.id));
    if (!to || target.id === widgetId) return d;
    if (to !== from && to.widgets.length >= MAX_PER_ROW) return d;
    const rows = d.rows.map((r) => {
      let widgets = r.widgets.filter((w) => w !== widgetId);
      if (r === to) {
        const at = widgets.indexOf(target.id) + (target.side === "after" ? 1 : 0);
        widgets = [...widgets.slice(0, at), widgetId, ...widgets.slice(at)];
      }
      const widths = r.widths && Object.fromEntries(Object.entries(r.widths).filter(([k]) => widgets.includes(k)));
      return { ...r, widgets, ...(widths ? { widths } : {}) };
    });
    return { ...d, rows };
  });
}

/** The widths (relative) of the widgets in a row, after dragging the edge between two of them. */
export function setRowWidths(dashboardId: string, rowId: string, widths: Record<string, number>) {
  return editDashboard(dashboardId, (d) => ({ ...d, rows: d.rows.map((r) => (r.id === rowId ? { ...r, widths } : r)) }));
}

/** "Duplicar": a copy of the widget right after it (in a new row when its row is full). */
export async function duplicateWidget(dashboardId: string, widgetId: string) {
  const widget = await db.views.get(widgetId);
  if (!widget) return;
  const copy: CollectionView = { ...structuredClone(widget), id: uuid(), name: `${widget.name} (copia)` };
  await db.views.add(copy);
  await editDashboard(dashboardId, (d) => {
    const rows: DashboardRow[] = [];
    for (const r of d.rows) {
      if (!r.widgets.includes(widgetId)) rows.push(r);
      else if (r.widgets.length < MAX_PER_ROW) {
        const at = r.widgets.indexOf(widgetId) + 1;
        rows.push({ ...r, widgets: [...r.widgets.slice(0, at), copy.id, ...r.widgets.slice(at)] });
      } else rows.push(r, { id: shortId(), height: r.height, widgets: [copy.id] });
    }
    return { ...d, rows };
  });
  return copy.id;
}

/** "Usar una vista existente": a widget that starts as a copy of that view (layout, filters and sorts). */
export async function addWidgetFromView(dashboardId: string, sourceId: string) {
  const dashboard = await db.views.get(dashboardId);
  const source = await db.views.get(sourceId);
  if (!dashboard?.format.dashboard || !source) return;
  const widget: CollectionView = { ...structuredClone(source), id: uuid(), parent_id: dashboardId };
  await db.views.add(widget);
  await editDashboard(dashboardId, (d) => {
    const last = d.rows[d.rows.length - 1];
    const rows =
      last && last.widgets.length < MAX_PER_ROW
        ? [...d.rows.slice(0, -1), { ...last, widgets: [...last.widgets, widget.id] }]
        : [...d.rows, { id: shortId(), height: source.type === "chart" && source.format.chart?.type === "number" ? 200 : 360, widgets: [widget.id] }];
    return { ...d, rows };
  });
  return widget.id;
}

export function setDashboardFilters(dashboardId: string, filters: Filter[]) {
  return editDashboard(dashboardId, (d) => ({ ...d, filters }));
}

/**
 * The dashboard's filters as a widget's own: each one applies to the widget's property with the
 * same name and type (options matched by name), and is left out where there's none. They join the
 * widget's filters with "Y".
 */
export function withDashboardFilters(
  query: Query,
  collection: Collection,
  filters: Filter[] | undefined,
  schemaByName: Record<string, PropertySchema>,
): Query {
  const mapped: Filter[] = [];
  for (const f of filters ?? []) {
    const base = schemaByName[f.property];
    const entry = Object.entries(collection.schema).find(([, s]) => s.name === f.property && base && s.type === base.type);
    if (!entry) continue;
    const [id, schema] = entry;
    const optionId = (oid: unknown) => {
      if (typeof oid !== "string" || !base.options) return oid;
      const name = base.options.find((o) => o.id === oid)?.value;
      return schema.options?.find((o) => o.value === name)?.id ?? oid;
    };
    const value = Array.isArray(f.value) ? (f.value as unknown[]).map(optionId) : optionId(f.value);
    mapped.push({ ...f, property: id, value: value as Filter["value"] });
  }
  if (!mapped.length) return query;
  if (query.filter_operator === "and" || query.filters.length + (query.filter_groups?.length ?? 0) <= 1)
    return { ...query, filter_operator: "and", filters: [...query.filters, ...mapped] };
  return {
    ...query,
    filter_operator: "and",
    filters: mapped,
    filter_groups: [
      {
        id: "dashboard",
        operator: "or",
        filters: query.filters,
        groups: (query.filter_groups ?? []).map(({ id, operator, filters: rules }) => ({ id, operator, filters: rules })),
      },
    ],
  };
}

// ------------------------------------------------------------------ edit mode

const editing = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** "Editar" / "Listo": widgets move, resize and change only while editing. */
export function useDashboardEditing(dashboardId: string): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, () => editing.has(dashboardId));
  const set = (value: boolean) => {
    if (value) editing.add(dashboardId);
    else editing.delete(dashboardId);
    listeners.forEach((l) => l());
  };
  return [on, set];
}
