import { useState, type ReactNode } from "react";
import { ChartBar, ChartColumn, ChartLine, ChartPie, Check, ChevronRight, Download, Eye, EyeOff, Hash, Table2 } from "lucide-react";
import type { Block, ChartConfig, ChartType, Collection, CollectionView, PropertyType } from "../../lib/model";
import { addView, updateView } from "../../lib/ops";
import { db } from "../../lib/db";
import { AGGREGATOR_LABELS, chartGroupFilter, chartGroupRows, chartGroups, defaultChart, type ChartPoint } from "../../lib/chart";
import { NUMBER_FORMATS } from "../../lib/format";
import { useComputed } from "../../lib/group";
import { pageTitle, useChildren } from "../../lib/hooks";
import { MenuItem, MenuLabel, MenuSeparator, PageIcon, Popover, Switch, toast, usePopover } from "../ui";
import { TypeIcon } from "./properties";
import { Chart, exportChart } from "./Chart";

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  column: "Columnas",
  bar: "Barras horizontales",
  line: "Líneas",
  donut: "Dona",
  number: "Número",
};

const GROUPABLE: PropertyType[] = [
  "select",
  "status",
  "multi_select",
  "person",
  "relation",
  "checkbox",
  "date",
  "created_time",
  "last_edited_time",
  "text",
  "title",
  "number",
];
const NUMERIC: PropertyType[] = ["number", "auto_increment_id"];

export function ChartView({
  view,
  collection,
  rows,
  onOpen,
}: {
  view: CollectionView;
  collection: Collection;
  rows: Block[];
  onOpen?: (id: string) => void;
}) {
  const config = view.format.chart ?? defaultChart(collection);
  // A click on a bar or slice lists its pages; each opens in the peek.
  const [picked, setPicked] = useState<{ point: ChartPoint; anchor: HTMLElement } | null>(null);
  const pages = picked ? chartGroupRows(rows, collection, config, picked.point.key) : [];
  return (
    <div className="chart-view">
      <Chart
        rows={rows}
        collection={collection}
        config={config}
        title={view.name}
        onPick={onOpen ? (point, anchor) => setPicked({ point, anchor }) : undefined}
        exportId={view.id}
      />
      {picked && (
        <Popover anchor={picked.anchor} onClose={() => setPicked(null)} width={280} className="chart-pick-pop">
          <div className="menu chart-pick">
            <div className="chart-pick__head">
              {picked.point.label} · {pages.length} {pages.length === 1 ? "página" : "páginas"}
            </div>
            {pages.map((row) => (
              <MenuItem
                key={row.id}
                icon={<PageIcon block={row} size={16} />}
                onClick={() => {
                  setPicked(null);
                  onOpen?.(row.id);
                }}
              >
                {pageTitle(row)}
              </MenuItem>
            ))}
            {chartGroupFilter(collection, config, picked.point.key) && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={<Table2 size={16} />}
                  onClick={async () => {
                    // "Guardar como vista": a table of this category's pages, with the chart's filters.
                    const point = picked.point;
                    setPicked(null);
                    const rule = chartGroupFilter(collection, config, point.key);
                    const id = await addView(view.parent_id, "table");
                    const created = id && (await db.views.get(id));
                    if (!created || !rule) return;
                    // The chart's own filters still apply: joined with "Y" as they are, or kept as one group when joined with "O".
                    const q = view.query2;
                    const query2 =
                      q.filter_operator === "and" || !q.filters.length
                        ? { ...q, filters: [...q.filters, rule] }
                        : {
                            ...q,
                            filter_operator: "and" as const,
                            filters: [rule],
                            filter_groups: [
                              {
                                id: rule.id + "g",
                                operator: "or" as const,
                                filters: q.filters,
                                groups: (q.filter_groups ?? []).map(({ id: gid, operator, filters }) => ({ id: gid, operator, filters })),
                              },
                            ],
                          };
                    await updateView(id, { name: `${view.name}: ${point.label}`, query2 });
                    toast(`Vista «${view.name}: ${point.label}» creada`);
                  }}
                >
                  Guardar como vista
                </MenuItem>
              </>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}

/** Short names under the chart-type tiles. */
const CHART_TILES: [ChartType, string, typeof ChartColumn][] = [
  ["column", "Columnas", ChartColumn],
  ["bar", "Barras", ChartBar],
  ["line", "Líneas", ChartLine],
  ["donut", "Dona", ChartPie],
  ["number", "Número", Hash],
];

const SORT_LABELS: [ChartConfig["sort"], string][] = [
  ["manual", "Orden de la propiedad"],
  ["y-descending", "Valor: mayor a menor"],
  ["y-ascending", "Valor: menor a mayor"],
  ["x-ascending", "Nombre: A → Z"],
  ["x-descending", "Nombre: Z → A"],
];

const HEIGHT_LABELS: [NonNullable<ChartConfig["height"]>, string][] = [
  ["small", "Pequeño"],
  ["medium", "Mediano"],
  ["large", "Grande"],
];

type Choice = { key: string; label: string; icon?: ReactNode; on: boolean; pick: () => void };

/** Settings for a chart view or chart widget, in the menu chrome: type tiles, then a row per setting. */
export function ChartSettings({ view, collection }: { view: CollectionView; collection: Collection }) {
  const config = view.format.chart ?? defaultChart(collection);
  const set = (patch: Partial<ChartConfig>) =>
    updateView(view.id, { format: { ...view.format, chart: { ...config, ...patch } } });
  // Formulas and rollups chart their values when they work out numbers.
  const rows = useChildren("collection", collection.id);
  const { kinds } = useComputed(rows, collection, []);
  const props = Object.entries(collection.schema);
  const numeric = props.filter(
    ([id, s]) => NUMERIC.includes(s.type) || ((s.type === "formula" || s.type === "rollup") && kinds?.[id] === "number"),
  );
  const pop = usePopover();
  const [open, setOpen] = useState<string | null>(null);
  const isNumber = config.type === "number";

  const valueKey = config.aggregator === "count" ? "count" : `${config.aggregator}:${config.property ?? ""}`;
  const valueChoices: Choice[] = [
    { key: "count", label: "Recuento de filas", on: valueKey === "count", pick: () => set({ aggregator: "count", property: undefined }) },
    ...numeric.flatMap(([id, s]) =>
      (["sum", "average", "min", "max"] as const).map((agg) => ({
        key: `${agg}:${id}`,
        label: `${AGGREGATOR_LABELS[agg]} de ${s.name}`,
        icon: <TypeIcon type={s.type} />,
        on: valueKey === `${agg}:${id}`,
        pick: () => set({ aggregator: agg, property: id }),
      })),
    ),
  ];
  const valueLabel = valueChoices.find((c) => c.on)?.label ?? "Recuento de filas";
  const groupProp = config.group_by ? collection.schema[config.group_by] : undefined;
  const seriesProp = config.series_by && config.series_by !== config.group_by ? collection.schema[config.series_by] : undefined;
  // "Ocultar grupos": every category the chart has, hidden or not.
  const groups = isNumber ? [] : chartGroups(rows ?? [], collection, config);
  const legendOn = config.legend ?? (config.type === "donut" || !!seriesProp);
  const formatLabel = NUMBER_FORMATS.find(([id]) => id === config.number_format)?.[1] ?? "Automático";
  const labels: [NonNullable<ChartConfig["data_labels"]>, string][] = [
    ["value", "Valores"],
    ["none", "Ninguna"],
    ...(config.type === "donut" ? ([["name", "Solo nombres"]] as [NonNullable<ChartConfig["data_labels"]>, string][]) : []),
  ];

  /** A setting row ("Eje X   Status ›") whose choices open in a menu beside it. */
  const row = (id: string, label: string, current: string, choices: Choice[]) => (
    <>
      <MenuItem
        className="view-settings__row"
        right={
          <>
            <span className="chart-settings__value">{current}</span>
            <ChevronRight size={14} />
          </>
        }
        onClick={(e) => {
          setOpen(id);
          pop.toggle(e.currentTarget);
        }}
      >
        {label}
      </MenuItem>
      {open === id && pop.anchor && (
        <Popover
          anchor={pop.anchor}
          onClose={() => {
            pop.close();
            setOpen(null);
          }}
          width={250}
          align="end"
        >
          <div className="menu settings-choice">
            {choices.map((c) => (
              <MenuItem
                key={c.key}
                icon={c.icon}
                right={c.on ? <Check size={14} /> : null}
                onClick={() => {
                  pop.close();
                  setOpen(null);
                  c.pick();
                }}
              >
                {c.label}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
  const list = <K extends string>(items: [K, string][], current: K, pick: (k: K) => void): Choice[] =>
    items.map(([key, label]) => ({ key, label, on: key === current, pick: () => pick(key) }));

  return (
    <div className="menu chart-settings">
      <MenuLabel>Tipo de gráfico</MenuLabel>
      <div className="layout-grid layout-grid--chart">
        {CHART_TILES.map(([type, label, Icon]) => (
          <button
            type="button"
            key={type}
            className={`layout-grid__item${config.type === type ? " is-active" : ""}`}
            aria-label={CHART_TYPE_LABELS[type]}
            title={CHART_TYPE_LABELS[type]}
            onClick={() =>
              set({ type, group_by: type === "number" ? config.group_by : (config.group_by ?? defaultChart(collection).group_by) })
            }
          >
            <Icon size={20} strokeWidth={1.6} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <MenuSeparator />
      {!isNumber &&
        row(
          "x",
          "Eje X",
          groupProp?.name ?? "Ninguno",
          props
            .filter(([, s]) => GROUPABLE.includes(s.type))
            .map(([id, s]) => ({
              key: id,
              label: s.name,
              icon: <TypeIcon type={s.type} />,
              on: config.group_by === id,
              pick: () => set({ group_by: id }),
            })),
        )}
      {row("y", isNumber ? "Valor" : "Eje Y", valueLabel, valueChoices)}
      {!isNumber &&
        config.type !== "donut" &&
        row("series", "Serie", seriesProp?.name ?? "Ninguna", [
          { key: "", label: "Ninguna", on: !seriesProp, pick: () => set({ series_by: undefined }) },
          ...props
            .filter(([id, s]) => GROUPABLE.includes(s.type) && id !== config.group_by)
            .map(([id, s]) => ({
              key: id,
              label: s.name,
              icon: <TypeIcon type={s.type} />,
              on: config.series_by === id,
              pick: () => set({ series_by: id }),
            })),
        ])}
      {!isNumber && (
        <>
          {row("sort", "Ordenar", SORT_LABELS.find(([k]) => k === config.sort)?.[1] ?? "", list(SORT_LABELS, config.sort, (sort) => set({ sort })))}
          {row(
            "labels",
            "Etiquetas de datos",
            labels.find(([k]) => k === (config.data_labels ?? "value"))?.[1] ?? "Valores",
            list(labels, config.data_labels ?? "value", (data_labels) => set({ data_labels })),
          )}
        </>
      )}
      {row("format", "Formato numérico", formatLabel, [
        { key: "", label: "Automático", on: !config.number_format, pick: () => set({ number_format: undefined }) },
        ...NUMBER_FORMATS.map(([id, label]) => ({
          key: id,
          label,
          on: config.number_format === id,
          pick: () => set({ number_format: id }),
        })),
      ])}
      {row(
        "height",
        "Alto",
        HEIGHT_LABELS.find(([k]) => k === (config.height ?? "medium"))?.[1] ?? "Mediano",
        list(HEIGHT_LABELS, config.height ?? "medium", (height) => set({ height })),
      )}
      {!isNumber && (
        <MenuItem right={<Switch on={!!config.hide_empty} />} onClick={() => set({ hide_empty: !config.hide_empty })}>
          Ocultar grupos vacíos
        </MenuItem>
      )}
      {!isNumber && (
        <MenuItem right={<Switch on={!!config.omit_zero} />} onClick={() => set({ omit_zero: !config.omit_zero || undefined })}>
          Omitir valores cero
        </MenuItem>
      )}
      {!isNumber && (
        <>
          <MenuItem
            className="view-settings__row"
            right={
              <>
                <span className="chart-settings__value">
                  {config.hidden_groups?.length ? `${config.hidden_groups.length} ocultos` : "Ninguno"}
                </span>
                <ChevronRight size={14} />
              </>
            }
            onClick={(e) => {
              setOpen("hidden");
              pop.toggle(e.currentTarget);
            }}
          >
            Ocultar grupos
          </MenuItem>
          {open === "hidden" && pop.anchor && (
            <Popover
              anchor={pop.anchor}
              onClose={() => {
                pop.close();
                setOpen(null);
              }}
              width={250}
              align="end"
            >
              <div className="menu menu-scroll settings-choice">
                {groups.map((g) => {
                  const hiddenNow = config.hidden_groups?.includes(g.key);
                  return (
                    <MenuItem
                      key={g.key}
                      icon={hiddenNow ? <EyeOff size={16} /> : <Eye size={16} />}
                      onClick={() =>
                        set({
                          hidden_groups: hiddenNow
                            ? config.hidden_groups!.filter((k) => k !== g.key)
                            : [...(config.hidden_groups ?? []), g.key],
                        })
                      }
                    >
                      <span className={hiddenNow ? "muted" : ""}>{g.label}</span>
                    </MenuItem>
                  );
                })}
                {!groups.length && <div className="menu-label">Sin grupos</div>}
              </div>
            </Popover>
          )}
        </>
      )}
      {!isNumber && config.type !== "donut" && (
        <>
          <MenuSeparator />
          <MenuLabel>Estilo</MenuLabel>
          <MenuItem right={<Switch on={!!config.cumulative} />} onClick={() => set({ cumulative: !config.cumulative || undefined })}>
            Acumulado
          </MenuItem>
          {config.type === "line" && (
            <>
              <MenuItem right={<Switch on={!!config.smooth} />} onClick={() => set({ smooth: !config.smooth || undefined })}>
                Línea suave
              </MenuItem>
              <MenuItem right={<Switch on={!!config.area} />} onClick={() => set({ area: !config.area || undefined })}>
                Rellenar área
              </MenuItem>
            </>
          )}
          <MenuItem right={<Switch on={config.grid !== false} />} onClick={() => set({ grid: config.grid === false ? undefined : false })}>
            Cuadrícula
          </MenuItem>
          <MenuItem right={<Switch on={!!config.axis_names} />} onClick={() => set({ axis_names: !config.axis_names || undefined })}>
            Nombres de los ejes
          </MenuItem>
        </>
      )}
      {!isNumber && (
        <>
          {config.type === "donut" && <MenuSeparator />}
          <MenuItem
            right={<Switch on={legendOn} />}
            onClick={() => set({ legend: legendOn ? false : true })}
          >
            Leyenda
          </MenuItem>
          {row("palette", "Colores", PALETTE_LABELS.find(([k]) => k === (config.palette ?? "auto"))?.[1] ?? "Automático", list(PALETTE_LABELS, config.palette ?? "auto", (palette) => set({ palette: palette === "auto" ? undefined : palette })))}
          {config.type !== "line" && (
            <MenuItem right={<Switch on={!!config.color_by_value} />} onClick={() => set({ color_by_value: !config.color_by_value || undefined })}>
              Colorear por valor
            </MenuItem>
          )}
        </>
      )}
      <MenuSeparator />
      <MenuItem icon={<Download size={16} />} onClick={() => void exportChart(view.id, "png", view.name || "Gráfico")}>
        Exportar como PNG
      </MenuItem>
      <MenuItem icon={<Download size={16} />} onClick={() => void exportChart(view.id, "svg", view.name || "Gráfico")}>
        Exportar como SVG
      </MenuItem>
    </div>
  );
}

const PALETTE_LABELS: [NonNullable<ChartConfig["palette"]>, string][] = [
  ["auto", "Automático"],
  ["colorful", "Multicolor"],
  ["blue", "Azul"],
  ["green", "Verde"],
  ["orange", "Naranja"],
  ["purple", "Morado"],
  ["pink", "Rosa"],
  ["gray", "Gris"],
];
