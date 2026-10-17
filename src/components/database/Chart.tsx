import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Block, ChartConfig, Collection, OptionColor } from "../../lib/model";
import { AGGREGATOR_LABELS, chartData, chartNumberFormat, type ChartPart, type ChartPoint } from "../../lib/chart";
import { useComputed } from "../../lib/group";
import { formatNumber } from "../../lib/format";
import { downloadBlob, safeFileName } from "../../lib/files";
import { pointerAnchor } from "../ui";

const HEIGHTS = { small: 200, medium: 280, large: 360 };
/** Series colors for categories without an option color (people, relations, months…). */
const PALETTE: OptionColor[] = ["blue", "orange", "green", "purple", "pink", "yellow", "red", "brown", "gray"];
const LEGEND_H = 30;

/** A mark's color and opacity, from the chart's palette ("auto": each option's own color). */
type Paint = { fill: string; opacity: number };

function painter(config: ChartConfig, max: number) {
  const palette = config.palette ?? "auto";
  return (item: { color: OptionColor | null }, i: number, value?: number): Paint => {
    const single = palette !== "auto" && palette !== "colorful";
    const color: OptionColor = single
      ? (palette as OptionColor)
      : palette === "auto" && item.color && item.color !== "default"
        ? item.color
        : PALETTE[i % PALETTE.length];
    // "Colorear por valor": lighter for small values, full for the biggest.
    const opacity = config.color_by_value && value !== undefined && max > 0 ? 0.3 + 0.7 * Math.max(0, value / max) : 1;
    return { fill: `var(--dot-${color})`, opacity };
  };
}

/** Round axis maximum and ticks (1, 2, 5 × 10ⁿ). */
function niceTicks(max: number, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** A smooth curve through the points (Catmull-Rom as cubic Béziers), or straight segments. */
function linePath(pts: [number, number][], smooth: boolean) {
  if (!pts.length) return "";
  if (!smooth || pts.length < 3) return `M${pts.map(([x, y]) => `${x},${y}`).join("L")}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1] ?? pts[i];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const [x3, y3] = pts[i + 2] ?? pts[i + 1];
    d += `C${x1 + (x2 - x0) / 6},${y1 + (y2 - y0) / 6} ${x2 - (x3 - x1) / 6},${y2 - (y3 - y1) / 6} ${x2},${y2}`;
  }
  return d;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function Chart({
  rows,
  collection,
  config,
  title,
  height,
  onPick,
  exportId,
}: {
  rows: Block[];
  collection: Collection;
  config: ChartConfig;
  /** Shown above "number" charts (the view name). */
  title?: string;
  /** Pixel height override, e.g. the dashboard row height. */
  height?: number;
  /** A click on a bar or slice: its category, to list the pages in it. */
  onPick?: (point: ChartPoint, anchor: HTMLElement) => void;
  /** The view it draws, so "Exportar" can find it. */
  exportId?: string;
}) {
  const [ref, width] = useWidth();
  // The mark under the pointer: the others dim and a card shows its numbers.
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  // A formula or rollup value is worked out per row first.
  const computed = useComputed(rows, collection, [config.aggregator === "count" ? undefined : config.property]);
  const data = chartData(rows, collection, config, computed.values);
  const format = chartNumberFormat(config, collection);
  const fmt = (v: number, compact = false) => formatNumber(v, format, compact);
  const h = height ?? HEIGHTS[config.height ?? "medium"];

  if (typeof data === "number")
    return (
      <div className="chart chart--number" ref={ref} style={{ minHeight: Math.min(h, 160) }} data-chart={exportId}>
        {title && <div className="chart__title">{title}</div>}
        <div className="chart__big">{fmt(data)}</div>
      </div>
    );

  if (!data.length) return <div className="chart chart--empty">Sin datos para mostrar</div>;
  // Nothing to draw (no rows in range, or all zero): a centered gray note instead of an
  // axis of empty categories. Donuts keep an empty gray ring behind their total.
  if (config.type !== "donut" && data.every((d) => !d.value))
    return (
      <div className="chart chart--empty" style={{ height: h }} data-chart={exportId}>
        Sin datos para mostrar
      </div>
    );

  const series = data[0]?.parts?.map(({ key, label, color }) => ({ key, label, color })) ?? [];
  const max = Math.max(0, ...data.map((d) => d.value));
  const paint = painter(config, max);
  const total = data.reduce((a, d) => a + d.value, 0);
  // The legend: the series, or (when asked for) the categories; donuts keep theirs beside them.
  const legendItems =
    config.type === "donut"
      ? []
      : series.length
        ? config.legend !== false
          ? series.map((sr, i) => ({ label: sr.label, paint: paint(sr, i) }))
          : []
        : config.legend
          ? config.type === "line"
            ? [{ label: AGGREGATOR_LABELS[config.aggregator], paint: { fill: "var(--accent)", opacity: 1 } }]
            : data.map((d, i) => ({ label: d.label, paint: paint(d, i, d.value) }))
          : [];
  const plotH = legendItems.length ? h - LEGEND_H : h;
  const marks: Marks = {
    hover: hover?.i ?? null,
    pickable: !!onPick,
    move: (i, e) => {
      const box = ref.current?.getBoundingClientRect();
      if (box) setHover({ i, x: e.clientX - box.left, y: e.clientY - box.top });
    },
    leave: () => setHover(null),
    // The list opens where the click was, not over the whole mark.
    pick: (i, e) => onPick?.(data[i], pointerAnchor(e)),
  };
  const shown = hover && data[hover.i];
  const groupName = config.group_by ? collection.schema[config.group_by]?.name : undefined;
  const valueName =
    config.aggregator === "count" || !config.property
      ? "Recuento"
      : `${AGGREGATOR_LABELS[config.aggregator]} de ${collection.schema[config.property]?.name ?? ""}`;
  const axes = config.axis_names ? { x: groupName ?? "", y: valueName } : null;
  const common = { data, width, height: plotH, fmt, marks, paint, config, axes };

  return (
    <div className="chart" ref={ref} style={{ height: h }} data-chart={exportId}>
      {width > 0 &&
        (config.type === "donut" ? (
          <Donut data={data} width={width} height={h} fmt={fmt} labels={config.data_labels ?? "value"} marks={marks} paint={paint} legend={config.legend !== false} />
        ) : config.type === "bar" ? (
          <Bars {...common} showValues={config.data_labels !== "none"} />
        ) : (
          <Columns {...common} line={config.type === "line"} showValues={config.data_labels !== "none"} />
        ))}
      {legendItems.length > 0 && (
        <ul className="chart-legend">
          {legendItems.map((item, i) => (
            <li key={i}>
              <span className="chart-legend__swatch" style={{ background: item.paint.fill, opacity: item.paint.opacity }} />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      {shown && hover && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(hover.x + 12, width - 180),
            top: hover.y + 14,
          }}
        >
          <div className="chart-tooltip__label">
            <span
              className="chart-tooltip__swatch"
              style={{ background: config.type === "line" && !series.length ? "var(--accent)" : paint(shown, hover.i, shown.value).fill }}
            />
            {shown.label}
          </div>
          <div className="chart-tooltip__value">
            {fmt(shown.value)}
            {total > 0 && !config.cumulative && <span> · {Math.round((shown.value / total) * 100)}%</span>}
          </div>
          {shown.parts
            ?.filter((part) => part.value)
            .map((part) => (
              <div className="chart-tooltip__part" key={part.key}>
                <span className="chart-tooltip__swatch" style={{ background: paint(part, series.findIndex((sr) => sr.key === part.key)).fill }} />
                <span className="chart-tooltip__part-label">{part.label}</span>
                {fmt(part.value)}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** Hover and click on the bars, points or slices. */
type Marks = {
  hover: number | null;
  pickable: boolean;
  move: (i: number, e: ReactMouseEvent<SVGElement>) => void;
  leave: () => void;
  pick: (i: number, e: ReactMouseEvent<SVGElement>) => void;
};

const markProps = (marks: Marks, i: number, base = 1) => ({
  opacity: (marks.hover === null || marks.hover === i ? 1 : 0.4) * base,
  onMouseMove: (e: ReactMouseEvent<SVGElement>) => marks.move(i, e),
  onMouseLeave: marks.leave,
  onClick: (e: ReactMouseEvent<SVGElement>) => marks.pick(i, e),
  className: `chart__mark${marks.pickable ? " is-pickable" : ""}`,
});

type Fmt = (v: number, compact?: boolean) => string;
type PlotProps = {
  data: ChartPoint[];
  width: number;
  height: number;
  fmt: Fmt;
  marks: Marks;
  paint: ReturnType<typeof painter>;
  config: ChartConfig;
  /** Axis names, when shown. */
  axes: { x: string; y: string } | null;
  showValues: boolean;
};

/** The pieces a bar stacks: its series' parts, or the whole value. */
const stackOf = (d: ChartPoint): ChartPart[] => d.parts ?? [{ key: d.key, label: d.label, color: d.color, value: d.value }];

function Columns({ data, width, height, fmt, line, showValues, marks, paint, config, axes }: PlotProps & { line: boolean }) {
  const series = data[0]?.parts ?? [];
  const top = 18;
  // Stacked bars reach their parts' sum; lines, their highest series.
  const peak = Math.max(
    0,
    ...data.map((d) =>
      line && d.parts ? Math.max(0, ...d.parts.map((p) => p.value)) : d.parts ? d.parts.reduce((a, p) => a + Math.max(0, p.value), 0) : d.value,
    ),
  );
  const ticks = niceTicks(peak);
  const tmax = ticks[ticks.length - 1] || 1;
  const left = 8 + Math.max(...ticks.map((t) => fmt(t, true).length)) * 6.5 + (axes ? 18 : 0);
  const rotate = data.length > Math.floor((width - left) / 70);
  const bottom = (rotate ? 64 : 28) + (axes ? 18 : 0);
  const plotW = width - left - 8;
  const plotH = height - top - bottom;
  const band = plotW / data.length;
  const barW = Math.min(48, band * 0.62);
  const y = (v: number) => top + plotH - (v / tmax) * plotH;
  const x = (i: number) => left + band * i + band / 2;
  const grid = config.grid !== false;

  const lines = line
    ? series.length
      ? series.map((sr, si) => ({ key: sr.key, color: paint(sr, si).fill, pts: data.map((d, i) => [x(i), y(d.parts![si].value)] as [number, number]) }))
      : [{ key: "value", color: config.palette && config.palette !== "auto" && config.palette !== "colorful" ? paint({ color: null }, 0).fill : "var(--accent)", pts: data.map((d, i) => [x(i), y(d.value)] as [number, number]) }]
    : [];

  return (
    <svg width={width} height={height} role="img">
      {ticks.map((t) => (
        <g key={t}>
          {grid && <line x1={left} x2={width - 8} y1={y(t)} y2={y(t)} className="chart__grid" />}
          <text x={left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="chart__axis">
            {fmt(t, true)}
          </text>
        </g>
      ))}
      {!grid && <line x1={left} x2={width - 8} y1={y(0)} y2={y(0)} className="chart__grid" />}
      {line ? (
        <>
          {lines.map((l) => (
            <g key={l.key}>
              {config.area && (
                <path
                  d={`${linePath(l.pts, !!config.smooth)}L${l.pts[l.pts.length - 1][0]},${y(0)}L${l.pts[0][0]},${y(0)}Z`}
                  fill={l.color}
                  opacity={0.14}
                />
              )}
              <path d={linePath(l.pts, !!config.smooth)} fill="none" stroke={l.color} strokeWidth={2} />
              {l.pts.map(([px, py], i) => (
                <circle key={i} cx={px} cy={py} r={marks.hover === i ? 5 : 3.5} fill={l.color} {...markProps(marks, i)} />
              ))}
            </g>
          ))}
        </>
      ) : (
        data.map((d, i) => {
          let base = 0;
          return (
            <g key={d.key}>
              {stackOf(d).map((part, pi) => {
                const v = Math.max(0, part.value);
                const y0 = y(base);
                base += v;
                const y1 = y(base);
                const p = d.parts ? paint(part, pi) : paint(d, i, d.value);
                return (
                  <rect
                    key={part.key}
                    x={x(i) - barW / 2}
                    y={y1}
                    width={barW}
                    height={Math.max(0, y0 - y1)}
                    rx={d.parts ? 0 : 3}
                    fill={p.fill}
                    {...markProps(marks, i, p.opacity)}
                  />
                );
              })}
            </g>
          );
        })
      )}
      {showValues &&
        data.map((d, i) => {
          const v = line && d.parts ? Math.max(...d.parts.map((p) => p.value)) : d.parts ? d.parts.reduce((a, p) => a + Math.max(0, p.value), 0) : d.value;
          return d.value ? (
            <text key={d.key} x={x(i)} y={y(v) - 5} textAnchor="middle" className="chart__value">
              {fmt(d.value, true)}
            </text>
          ) : null;
        })}
      {data.map((d, i) => (
        <text
          key={d.key}
          className="chart__axis"
          textAnchor={rotate ? "end" : "middle"}
          transform={rotate ? `translate(${x(i)},${top + plotH + 10}) rotate(-35)` : `translate(${x(i)},${top + plotH + 16})`}
        >
          {d.label.length > 18 ? `${d.label.slice(0, 17)}…` : d.label}
        </text>
      ))}
      {axes && (
        <>
          <text x={left + plotW / 2} y={height - 4} textAnchor="middle" className="chart__axis-name">
            {axes.x}
          </text>
          <text transform={`translate(10,${top + plotH / 2}) rotate(-90)`} textAnchor="middle" className="chart__axis-name">
            {axes.y}
          </text>
        </>
      )}
    </svg>
  );
}

function Bars({ data, width, height, fmt, showValues, marks, paint, config, axes }: PlotProps) {
  const totalOf = (d: ChartPoint) => (d.parts ? d.parts.reduce((a, p) => a + Math.max(0, p.value), 0) : d.value);
  const ticks = niceTicks(Math.max(...data.map(totalOf)));
  const max = ticks[ticks.length - 1] || 1;
  const left = Math.min(180, 12 + Math.max(...data.map((d) => Math.min(d.label.length, 24))) * 6.6) + (axes ? 18 : 0);
  const right = showValues ? 64 : 12;
  const bottom = axes ? 22 : 0;
  const row = Math.min(34, (height - 8 - bottom) / data.length);
  const barH = Math.max(6, row * 0.62);
  const plotW = width - left - right;
  const svgH = Math.max(height, row * data.length + 8 + bottom);
  return (
    <svg width={width} height={svgH} role="img">
      {config.grid !== false &&
        ticks.map((t) => (
          <line key={t} x1={left + (t / max) * plotW} x2={left + (t / max) * plotW} y1={4} y2={4 + row * data.length} className="chart__grid" />
        ))}
      {data.map((d, i) => {
        const cy = 4 + row * i + row / 2;
        let base = 0;
        const w = (totalOf(d) / max) * plotW;
        return (
          <g key={d.key}>
            <text x={left - 8} y={cy} dy="0.32em" textAnchor="end" className="chart__axis">
              {d.label.length > 24 ? `${d.label.slice(0, 23)}…` : d.label}
            </text>
            {stackOf(d).map((part, pi) => {
              const pw = (Math.max(0, part.value) / max) * plotW;
              const px = left + base;
              base += pw;
              const p = d.parts ? paint(part, pi) : paint(d, i, d.value);
              return (
                <rect
                  key={part.key}
                  x={px}
                  y={cy - barH / 2}
                  width={Math.max(0, pw)}
                  height={barH}
                  rx={d.parts ? 0 : 3}
                  fill={p.fill}
                  {...markProps(marks, i, p.opacity)}
                />
              );
            })}
            {showValues && (
              <text x={left + w + 6} y={cy} dy="0.32em" className="chart__value">
                {fmt(d.value, true)}
              </text>
            )}
          </g>
        );
      })}
      {axes && (
        <>
          <text x={left + plotW / 2} y={svgH - 4} textAnchor="middle" className="chart__axis-name">
            {axes.y}
          </text>
          <text transform={`translate(10,${4 + (row * data.length) / 2}) rotate(-90)`} textAnchor="middle" className="chart__axis-name">
            {axes.x}
          </text>
        </>
      )}
    </svg>
  );
}

function Donut({
  data,
  width,
  height,
  fmt,
  labels,
  marks,
  paint,
  legend,
}: {
  data: ChartPoint[];
  width: number;
  height: number;
  fmt: Fmt;
  labels: NonNullable<ChartConfig["data_labels"]>;
  marks: Marks;
  paint: ReturnType<typeof painter>;
  legend: boolean;
}) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const legendW = legend && width > 420 ? Math.min(240, width * 0.42) : 0;
  const size = Math.min(height - 16, width - legendW - 16);
  const r = size / 2;
  const cx = (width - legendW) / 2;
  const cy = height / 2;
  const inner = r * 0.62;
  let angle = -Math.PI / 2;
  const arcs = data
    .filter((d) => d.value > 0)
    .map((d) => {
      const sweep = total ? (d.value / total) * Math.PI * 2 : 0;
      const a0 = angle;
      const a1 = angle + sweep;
      angle = a1;
      const large = sweep > Math.PI ? 1 : 0;
      const p = (a: number, rad: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
      // A full circle can't be drawn with one arc.
      const path =
        sweep >= Math.PI * 2 - 1e-6
          ? `M${p(0, r)}A${r},${r} 0 1 1 ${p(Math.PI, r)}A${r},${r} 0 1 1 ${p(0, r)}M${p(0, inner)}A${inner},${inner} 0 1 0 ${p(Math.PI, inner)}A${inner},${inner} 0 1 0 ${p(0, inner)}Z`
          : `M${p(a0, r)}A${r},${r} 0 ${large} 1 ${p(a1, r)}L${p(a1, inner)}A${inner},${inner} 0 ${large} 0 ${p(a0, inner)}Z`;
      return { d, path };
    });
  const legendValue = (d: ChartPoint) => (labels === "name" ? "" : labels === "none" ? "" : fmt(d.value, true));
  const paintOf = (d: ChartPoint) => paint(d, data.indexOf(d), d.value);
  return (
    <div className="donut">
      <svg width={width - legendW} height={height} role="img">
        {!total && r > 0 && (
          <circle className="donut__empty" cx={cx} cy={cy} r={(r + inner) / 2} fill="none" strokeWidth={r - inner} />
        )}
        {arcs.map(({ d, path }) => (
          <path key={d.key} d={path} fill={paintOf(d).fill} fillRule="evenodd" {...markProps(marks, data.indexOf(d), paintOf(d).opacity)} />
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" className="chart__total">
          {fmt(total, true)}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="chart__axis">
          Total
        </text>
      </svg>
      {legendW > 0 && (
        <ul className="donut__legend" style={{ width: legendW }}>
          {data
            .filter((d) => d.value > 0)
            .map((d) => (
              <li key={d.key}>
                <span className="donut__swatch" style={{ background: paintOf(d).fill, opacity: paintOf(d).opacity }} />
                <span className="donut__label">{d.label}</span>
                <span className="donut__value">{legendValue(d)}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ export

/** Copies each element's painted colors and text styles inline, so the SVG looks the same on its own. */
function inlineStyles(source: Element, target: Element) {
  const cs = getComputedStyle(source);
  const el = target as SVGElement;
  for (const prop of ["fill", "stroke", "opacity", "stroke-width", "font-size", "font-weight", "font-family"]) {
    const v = cs.getPropertyValue(prop);
    if (v) el.style.setProperty(prop, v);
  }
  [...source.children].forEach((child, i) => target.children[i] && inlineStyles(child, target.children[i]));
}

/** The chart drawn for a view as a standalone SVG: its plot, then its legend as swatches and names. */
function chartSvg(viewId: string): { svg: string; width: number; height: number } | null {
  const host = document.querySelector<HTMLElement>(`.chart[data-chart="${CSS.escape(viewId)}"]`);
  const plot = host?.querySelector("svg");
  if (!host || !plot) return null;
  const width = host.clientWidth;
  const clone = plot.cloneNode(true) as SVGSVGElement;
  inlineStyles(plot, clone);
  const plotH = plot.getBoundingClientRect().height;
  const items = [...host.querySelectorAll<HTMLElement>(".chart-legend li, .donut__legend li")];
  const legendX = items.length && host.querySelector(".donut__legend") ? plot.getBoundingClientRect().width + 8 : 0;
  const ns = "http://www.w3.org/2000/svg";
  const text = getComputedStyle(host).color;
  const font = getComputedStyle(host).fontFamily;
  let cursorX = 8;
  let cursorY = legendX ? 16 : plotH + 18;
  for (const li of items) {
    const swatch = li.querySelector<HTMLElement>("span");
    const label = li.innerText.replace(/\s+/g, " ").trim();
    const g = document.createElementNS(ns, "g");
    const rect = document.createElementNS(ns, "rect");
    const t = document.createElementNS(ns, "text");
    const x = legendX || cursorX;
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(cursorY - 9));
    rect.setAttribute("width", "10");
    rect.setAttribute("height", "10");
    rect.setAttribute("rx", "3");
    rect.setAttribute("fill", swatch ? getComputedStyle(swatch).backgroundColor : text);
    t.setAttribute("x", String(x + 16));
    t.setAttribute("y", String(cursorY));
    t.setAttribute("font-size", "12");
    t.setAttribute("font-family", font);
    t.setAttribute("fill", text);
    t.textContent = label;
    g.append(rect, t);
    clone.append(g);
    if (legendX) cursorY += 20;
    else cursorX += 28 + label.length * 6.5;
  }
  const height = Math.max(plotH + (items.length && !legendX ? 30 : 0), cursorY + 8);
  clone.setAttribute("xmlns", ns);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.style.overflow = "visible";
  return { svg: new XMLSerializer().serializeToString(clone), width, height };
}

/** "Exportar como PNG/SVG": downloads the chart a view draws. */
export async function exportChart(viewId: string, kind: "png" | "svg", name: string) {
  const out = chartSvg(viewId);
  if (!out) return false;
  const file = safeFileName(name, "grafico");
  if (kind === "svg") {
    downloadBlob(new Blob([out.svg], { type: "image/svg+xml" }), `${file}.svg`);
    return true;
  }
  const scale = 2;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(out.svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = out.width * scale;
  canvas.height = out.height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob) downloadBlob(blob, `${file}.png`);
  return !!blob;
}
