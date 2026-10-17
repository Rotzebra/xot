import { useState } from "react";
import { ArrowUpRight, MapPin, Search } from "lucide-react";
import type { Block, PlaceCoords, PropertyValue } from "../../lib/model";
import { MenuItem, MenuSeparator } from "../ui";

// "Lugar": a place's name, and its latitude and longitude typed or pasted by
// hand, or looked up on OpenStreetMap when there's a connection. With
// coordinates it links to a map, and shows one when there's a connection.

/** The value's coordinates while they still belong to it (a name changed elsewhere drops them). */
export function placeCoords(row: Block, propertyId: string, value: PropertyValue | undefined): PlaceCoords | null {
  const c = row.places?.[propertyId];
  return c && typeof value === "string" && c.name === value ? c : null;
}

const validLat = (n: number) => Number.isFinite(n) && n >= -90 && n <= 90;
const validLng = (n: number) => Number.isFinite(n) && n >= -180 && n <= 180;

/** "4.711, -74.072", or a map link with them (Google Maps "@lat,lng", OpenStreetMap "mlat=…&mlon=…", "?q=lat,lng"). */
export function parseCoords(text: string): { lat: number; lng: number } | null {
  const t = text.trim();
  const pair =
    t.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/) ??
    t.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/) ??
    t.match(/[?&](?:q|ll|query)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/) ??
    t.match(/mlat=(-?\d{1,2}\.\d+).*?mlon=(-?\d{1,3}\.\d+)/);
  if (!pair) return null;
  const lat = Number(pair[1]);
  const lng = Number(pair[2]);
  return validLat(lat) && validLng(lng) ? { lat, lng } : null;
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;
export const coordsText = (c: { lat: number; lng: number }) => `${round(c.lat)}, ${round(c.lng)}`;
const osmUrl = (c: { lat: number; lng: number }) => `https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=16/${c.lat}/${c.lng}`;
const googleUrl = (c: { lat: number; lng: number }) => `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}`;
function embedUrl(c: { lat: number; lng: number }) {
  const d = 0.006;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${c.lng - d},${c.lat - d},${c.lng + d},${c.lat + d}&layer=mapnik&marker=${c.lat},${c.lng}`;
}

/** A place in a cell: the pin and its name; the coordinates in a tooltip. */
export function PlaceValue({ name, coords }: { name: string; coords: PlaceCoords | null }) {
  return (
    <span className="place-value" data-tooltip={coords ? coordsText(coords) : undefined}>
      <MapPin size={14} className={coords ? "place-value__pin is-located" : "place-value__pin"} />
      <span className="place-value__name">{name}</span>
    </span>
  );
}

/** The place editor: name, latitude and longitude (a pasted pair or map link fills both), a map and links to open it. */
export function PlaceEditor({
  name,
  coords,
  onChange,
  onClear,
}: {
  name: string;
  coords: PlaceCoords | null;
  onChange: (name: string, coords: { lat: number; lng: number } | undefined) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState({ name, lat: coords ? String(coords.lat) : "", lng: coords ? String(coords.lng) : "" });
  const lat = Number(draft.lat.replace(",", "."));
  const lng = Number(draft.lng.replace(",", "."));
  const hasLat = draft.lat.trim() !== "";
  const hasLng = draft.lng.trim() !== "";
  const located = hasLat && hasLng && validLat(lat) && validLng(lng) ? { lat, lng } : undefined;
  const invalid = (hasLat || hasLng) && !located;
  const save = (next = draft) => {
    const la = Number(next.lat.replace(",", "."));
    const lo = Number(next.lng.replace(",", "."));
    const c = next.lat.trim() && next.lng.trim() && validLat(la) && validLng(lo) ? { lat: la, lng: lo } : undefined;
    const n = next.name.trim() || (c ? coordsText(c) : "");
    onChange(n, c);
  };
  // Looking an address up (OpenStreetMap's Nominatim) needs a connection; offline the coordinates are typed.
  const [looking, setLooking] = useState<"idle" | "busy" | "none">("idle");
  const lookup = async () => {
    setLooking("busy");
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(draft.name.trim())}`,
        { headers: { "Accept-Language": "es" } },
      );
      const [hit] = (await res.json()) as { lat: string; lon: string }[];
      if (!hit) return setLooking("none");
      const next = { ...draft, lat: String(round(Number(hit.lat))), lng: String(round(Number(hit.lon))) };
      setDraft(next);
      save(next);
      setLooking("idle");
    } catch {
      setLooking("none");
    }
  };
  /** A pasted pair or map link in any field fills the coordinates (and the name, when it was empty). */
  const fill = (field: "name" | "lat" | "lng", text: string) => {
    const c = parseCoords(text);
    if (c && (field !== "name" || !draft.lat.trim())) {
      const next = { name: field === "name" ? (draft.name.trim() ? draft.name : coordsText(c)) : draft.name || coordsText(c), lat: String(c.lat), lng: String(c.lng) };
      setDraft(next);
      return true;
    }
    return false;
  };
  const field = (key: "name" | "lat" | "lng", label: string, placeholder: string) => (
    <label className="place-editor__field">
      <span>{label}</span>
      <input
        className={`field field--sm${key !== "name" && invalid ? " field--invalid" : ""}`}
        autoFocus={key === "name"}
        value={draft[key]}
        placeholder={placeholder}
        inputMode={key === "name" ? undefined : "decimal"}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onPaste={(e) => {
          if (fill(key, e.clipboardData.getData("text"))) e.preventDefault();
        }}
        onBlur={() => save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      />
    </label>
  );
  return (
    <div className="menu place-editor">
      <div className="place-editor__fields">
        {field("name", "Lugar", "Nombre o dirección")}
        <div className="place-editor__coords">
          {field("lat", "Latitud", "4.711")}
          {field("lng", "Longitud", "-74.0721")}
        </div>
        {invalid && <p className="place-editor__error">Latitud entre -90 y 90, longitud entre -180 y 180</p>}
        {!located && !invalid && <p className="place-editor__hint">Pega coordenadas o un enlace de Google Maps para ubicarlo en el mapa.</p>}
      </div>
      {!located && draft.name.trim() && (
        <MenuItem
          icon={<Search size={16} />}
          disabled={!navigator.onLine || looking === "busy"}
          onClick={() => void lookup()}
        >
          {!navigator.onLine
            ? "Sin conexión: escribe las coordenadas"
            : looking === "busy"
              ? "Buscando…"
              : looking === "none"
                ? "No se encontró; prueba con otra dirección"
                : "Buscar ubicación en el mapa"}
        </MenuItem>
      )}
      {located && (
        <div className="place-editor__map">
          <iframe title="Mapa" src={embedUrl(located)} loading="lazy" referrerPolicy="no-referrer" />
        </div>
      )}
      {located && (
        <>
          <MenuItem icon={<ArrowUpRight size={16} />} onClick={() => window.open(osmUrl(located), "_blank", "noopener")}>
            Abrir en OpenStreetMap
          </MenuItem>
          <MenuItem icon={<ArrowUpRight size={16} />} onClick={() => window.open(googleUrl(located), "_blank", "noopener")}>
            Abrir en Google Maps
          </MenuItem>
        </>
      )}
      {(name || coords) && (
        <>
          <MenuSeparator />
          <MenuItem onClick={onClear}>Borrar</MenuItem>
        </>
      )}
    </div>
  );
}
