import { useSyncExternalStore } from "react";

// Configuración > Preferencias, per device.

export interface Settings {
  /** Calendars start their weeks on Monday ("Iniciar la semana el lunes"). */
  weekStartsMonday: boolean;
  /** "Abrir al iniciar": the last page visited, or a chosen page id. */
  startPage: "last" | string;
  /** "Nombre preferido": how Inicio greets you ("Buenas tardes, Diego"). */
  name: string;
  /** "Búsqueda en una pestaña nueva" (the macOS app): ⌘T opens Buscar; off, the new tab shows the start page. */
  newTabSearch: boolean;
  /** "Contraste alto": follow the system's "Aumentar contraste", or always standard or high. */
  contrast: "system" | "standard" | "high";
  /** "Establece automáticamente la zona horaria según tu ubicación": the device's zone, else `timeZone`. */
  autoTimeZone: boolean;
  /** "Zona horaria" chosen by hand (an IANA zone), for dates, "Hoy" and reminders. */
  timeZone: string;
}

const KEY = "xotion:settings";
const DEFAULTS: Settings = {
  weekStartsMonday: true,
  startPage: "last",
  name: "",
  newTabSearch: true,
  contrast: "system",
  autoTimeZone: true,
  timeZone: "",
};
const listeners = new Set<() => void>();

let current: Settings = (() => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>) };
  } catch {
    return DEFAULTS;
  }
})();

export const getSettings = () => current;

/** "Contraste alto" on the page: html[data-contrast] picks the tokens (styles.css; "auto" follows prefers-contrast). */
function applyContrast() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.contrast = current.contrast === "system" ? "auto" : current.contrast;
}
applyContrast();
// Other windows of the app (and tabs of the browser) change with this one.
window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  try {
    current = { ...DEFAULTS, ...(JSON.parse(e.newValue ?? "{}") as Partial<Settings>) };
  } catch {
    return;
  }
  applyContrast();
  listeners.forEach((cb) => cb());
});

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: keep it for this session */
  }
  applyContrast();
  listeners.forEach((cb) => cb());
}

export function useSettings() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
