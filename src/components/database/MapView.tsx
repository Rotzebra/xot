import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Locate, MapPin, Minus, Plus, WifiOff } from "lucide-react";
import type { Block, Collection, CollectionView } from "../../lib/model";
import { db } from "../../lib/db";
import { addProperty, updateView } from "../../lib/ops";
import { cellValue } from "../../lib/query";
import { pageTitle } from "../../lib/hooks";
import { placeCoords } from "./PlaceCell";
import { tintClass, useRowColors } from "./ConditionalColor";

/** The map view shows up to 100 pins. */
export const MAP_PIN_LIMIT = 100;
const TILE = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 18;
const HEIGHT = 480;

/** Web Mercator: a point's position in pixels on the whole world at a zoom. */
function project(lat: number, lng: number, zoom: number) {
  const size = TILE * 2 ** zoom;
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
}

function unproject(x: number, y: number, zoom: number) {
  const size = TILE * 2 ** zoom;
  const lng = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng };
}

/** The tiles come from OpenStreetMap; without a connection the map keeps its pins over a plain grid. */
function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * "Mapa": a pin per page at its "Lugar" (the "Mapa por" property), over OpenStreetMap
 * tiles. Drag to move, wheel or +/− to zoom; a pin opens its page.
 */
export function MapView({
  view,
  collection,
  rows,
  onOpen,
}: {
  view: CollectionView;
  collection: Collection;
  rows: Block[];
  onOpen: (id: string) => void;
}) {
  // "Mapa por", else the database's first "Lugar".
  const firstPlace = Object.entries(collection.schema).find(([, s]) => s.type === "place")?.[0];
  const by = view.format.map_by && collection.schema[view.format.map_by]?.type === "place" ? view.format.map_by : firstPlace;
  const colors = useRowColors(view, collection, rows);
  const located = useMemo(
    () =>
      by
        ? rows
            .map((row) => ({ row, coords: placeCoords(row, by, cellValue(row, by, collection.schema[by])) }))
            .filter((p): p is { row: Block; coords: NonNullable<ReturnType<typeof placeCoords>> } => !!p.coords)
        : [],
    [rows, by, collection.schema],
  );
  const pins = located.slice(0, MAP_PIN_LIMIT);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [camera, setCamera] = useState<{ lat: number; lng: number; zoom: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [tileErrors, setTileErrors] = useState(0);
  const online = useOnline();
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  /** The view that fits every pin (the whole world without any). */
  const fit = () => {
    if (!width) return null;
    if (!pins.length) return { lat: 20, lng: 0, zoom: 2 };
    const lats = pins.map((p) => p.coords.lat);
    const lngs = pins.map((p) => p.coords.lng);
    const box = { n: Math.max(...lats), s: Math.min(...lats), e: Math.max(...lngs), w: Math.min(...lngs) };
    let zoom = MAX_ZOOM - 3;
    for (; zoom > MIN_ZOOM; zoom--) {
      const a = project(box.n, box.w, zoom);
      const b = project(box.s, box.e, zoom);
      if (b.x - a.x < width - 80 && b.y - a.y < HEIGHT - 80) break;
    }
    const c = project(box.n, box.w, zoom);
    const d = project(box.s, box.e, zoom);
    return { ...unproject((c.x + d.x) / 2, (c.y + d.y) / 2, zoom), zoom };
  };
  const key = pins.map((p) => `${p.row.id}:${p.coords.lat},${p.coords.lng}`).join();
  useEffect(() => {
    if (width && !camera) setCamera(fit());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);
  // New or moved pins bring the map back to them.
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current !== key && width) setCamera(fit());
    lastKey.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const cam = camera ?? { lat: 20, lng: 0, zoom: 2 };
  const center = project(cam.lat, cam.lng, cam.zoom);
  const origin = { x: center.x - width / 2, y: center.y - HEIGHT / 2 };
  const toScreen = (lat: number, lng: number) => {
    const p = project(lat, lng, cam.zoom);
    return { x: p.x - origin.x, y: p.y - origin.y };
  };
  const zoomBy = (d: number, at?: { x: number; y: number }) => {
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom + d));
    if (zoom === cam.zoom) return;
    // The point under the pointer stays put.
    const anchor = at ?? { x: width / 2, y: HEIGHT / 2 };
    const world = unproject(origin.x + anchor.x, origin.y + anchor.y, cam.zoom);
    const p = project(world.lat, world.lng, zoom);
    const c = unproject(p.x - anchor.x + width / 2, p.y - anchor.y + HEIGHT / 2, zoom);
    setCamera({ ...c, zoom });
  };

  const showTiles = online && tileErrors < 6;
  const tiles: { key: string; x: number; y: number; src: string }[] = [];
  if (showTiles && width) {
    const n = 2 ** cam.zoom;
    const x0 = Math.floor(origin.x / TILE);
    const y0 = Math.max(0, Math.floor(origin.y / TILE));
    const x1 = Math.floor((origin.x + width) / TILE);
    const y1 = Math.min(n - 1, Math.floor((origin.y + HEIGHT) / TILE));
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const wx = ((x % n) + n) % n;
        tiles.push({ key: `${cam.zoom}/${x}/${y}`, x: x * TILE - origin.x, y: y * TILE - origin.y, src: `https://tile.openstreetmap.org/${cam.zoom}/${wx}/${y}.png` });
      }
  }
  // Without tiles: a grid of meridians and parallels, so the pins keep their places.
  const grid: { key: string; d: string }[] = [];
  if (!showTiles && width) {
    const step = cam.zoom <= 3 ? 30 : cam.zoom <= 5 ? 10 : cam.zoom <= 7 ? 2 : cam.zoom <= 10 ? 0.5 : 0.05;
    const nw = unproject(origin.x, origin.y, cam.zoom);
    const se = unproject(origin.x + width, origin.y + HEIGHT, cam.zoom);
    for (let lng = Math.floor(nw.lng / step) * step; lng <= se.lng; lng += step) {
      const x = toScreen(0, lng).x;
      grid.push({ key: `m${lng}`, d: `M${x},0V${HEIGHT}` });
    }
    for (let lat = Math.floor(se.lat / step) * step; lat <= nw.lat; lat += step) {
      const y = toScreen(lat, 0).y;
      grid.push({ key: `p${lat}`, d: `M0,${y}H${width}` });
    }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: center.x, cy: center.y };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setCamera({ ...unproject(d.cx - (e.clientX - d.x), d.cy - (e.clientY - d.y), cam.zoom), zoom: cam.zoom });
  };
  const unlocated = rows.length - located.length;

  return (
    <div className="map-view">
      <div
        ref={ref}
        className={`map${showTiles ? "" : " map--offline"}`}
        style={{ height: HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => {
          const box = ref.current?.getBoundingClientRect();
          if (!box || Math.abs(e.deltaY) < 4) return;
          zoomBy(e.deltaY < 0 ? 1 : -1, { x: e.clientX - box.left, y: e.clientY - box.top });
        }}
      >
        {tiles.map((t) => (
          <img
            key={t.key}
            className="map__tile"
            src={t.src}
            alt=""
            draggable={false}
            style={{ left: t.x, top: t.y }}
            referrerPolicy="no-referrer"
            onError={() => setTileErrors((n) => n + 1)}
          />
        ))}
        {grid.length > 0 && (
          <svg className="map__grid" width={width} height={HEIGHT} aria-hidden>
            {grid.map((g) => (
              <path key={g.key} d={g.d} />
            ))}
          </svg>
        )}
        {pins.map(({ row, coords }) => {
          const p = toScreen(coords.lat, coords.lng);
          if (p.x < -40 || p.y < -40 || p.x > width + 40 || p.y > HEIGHT + 40) return null;
          const title = pageTitle(row) || "Sin título";
          return (
            <button
              type="button"
              key={row.id}
              className={`map__pin${hover === row.id ? " is-hover" : ""}${tintClass(colors.get(row.id)?.row)}`}
              style={{ left: p.x, top: p.y }}
              aria-label={title}
              onMouseEnter={() => setHover(row.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onOpen(row.id)}
            >
              <MapPin size={26} strokeWidth={2} />
              <span className="map__pin-label">{title}</span>
            </button>
          );
        })}
        <div className="map__controls">
          <button type="button" aria-label="Acercar" onClick={() => zoomBy(1)}>
            <Plus size={16} />
          </button>
          <button type="button" aria-label="Alejar" onClick={() => zoomBy(-1)}>
            <Minus size={16} />
          </button>
          <button type="button" aria-label="Ver todas las páginas" data-tooltip="Ver todas las páginas" onClick={() => setCamera(fit())}>
            <Locate size={16} />
          </button>
        </div>
        {!showTiles && (
          <div className="map__offline">
            <WifiOff size={14} /> Sin conexión: el mapa se muestra sin fondo
          </div>
        )}
        {showTiles && <div className="map__attribution">© Colaboradores de OpenStreetMap</div>}
        {!by && (
          <div className="map__nudge-scrim" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
            <div className="map__nudge" role="dialog" aria-label="Organizar con una vista de mapa">
              <span className="map__nudge-icon">
                <MapPin size={20} />
              </span>
              <p className="map__nudge-title">Organizar con una vista de mapa</p>
              <p className="map__nudge-text">Consulta los elementos de tu base de datos en un mapa en función de su propiedad «Lugar».</p>
              <button
                type="button"
                className="primary-btn map__nudge-btn"
                onClick={async () => {
                  const id = await addProperty(collection.id, "place");
                  const fresh = await db.views.get(view.id);
                  if (id && fresh) await updateView(view.id, { format: { ...fresh.format, map_by: id } });
                }}
              >
                Agregar propiedad Lugar
              </button>
            </div>
          </div>
        )}
      </div>
      {by && (
      <div className="map-view__foot">
        {located.length > MAP_PIN_LIMIT
          ? `Se muestran ${MAP_PIN_LIMIT} de ${located.length} páginas con ubicación`
          : `${located.length} ${located.length === 1 ? "página" : "páginas"} en el mapa`}
        {unlocated > 0 && ` · ${unlocated} sin ubicación`}
        {!located.length && rows.length > 0 && ` · Agrega un lugar en «${collection.schema[by!]?.name ?? "Lugar"}» para ubicarlas`}
      </div>
      )}
    </div>
  );
}
