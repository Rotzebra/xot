import { useSyncExternalStore } from "react";

// The sidebar's layout, per device: its tabs and, in each one,
// which rows and sections show, in what order, how many pages each lists, and
// the shortcuts added to it.

export type SectionId = "favorites" | "private" | "recent";
export type NavId = "home" | "inbox";

/** A row added under Buscar / Inicio / Bandeja ("Añadir a la barra lateral"). */
export type Shortcut =
  | { id: string; kind: "new-page" }
  | { id: string; kind: "my-tasks" }
  | { id: string; kind: "view"; databaseId: string; viewId: string };

export interface SidebarPrefs {
  order: SectionId[];
  /** Hidden sections and top rows. */
  hidden: (SectionId | NavId)[];
  /** Pages a section lists before "Más"; 0 lists them all. */
  limits: Partial<Record<SectionId, number>>;
  /** Privado's order: the sidebar's own (drag and drop) or last edited first. */
  privateSort: "manual" | "edited";
  shortcuts: Shortcut[];
}

export const SECTION_LABELS: Record<SectionId, string> = {
  favorites: "Favoritos",
  private: "Privado",
  recent: "Recientes",
};
export const NAV_LABELS: Record<NavId, string> = {
  home: "Inicio",
  inbox: "Bandeja de entrada",
};

export const DEFAULT_LIMITS: Record<SectionId, number> = { favorites: 10, private: 10, recent: 5 };
/** The "Mostrar" choices in a section's menu. */
export const LIMIT_CHOICES = [5, 10, 15, 20];

/** What a new tab starts with ("Añadir pestaña"); "Restablecer pestaña" brings it back. */
export type TabPreset = "pages" | "favorites" | "recent" | "tasks" | "blank";

/** A sidebar tab: its own rows, sections and shortcuts. */
export interface SidebarTab extends SidebarPrefs {
  id: string;
  preset: TabPreset;
  name: string;
}

export const TAB_PRESETS: Record<TabPreset, string> = {
  pages: "Páginas",
  favorites: "Favoritos",
  recent: "Recientes",
  tasks: "Tareas",
  blank: "Pestaña vacía",
};
/** A sidebar holds at most six tabs. */
export const MAX_TABS = 6;

const KEY = "xotion:sidebar-prefs";
const DEFAULTS: SidebarPrefs = {
  order: ["favorites", "private", "recent"],
  hidden: [],
  limits: {},
  privateSort: "manual",
  shortcuts: [],
};
const ALL_SECTIONS: SectionId[] = ["favorites", "private", "recent"];

const newId = () => Math.random().toString(36).slice(2, 10);

function presetLayout(preset: TabPreset): SidebarPrefs {
  const only = (keep: SectionId[]): (SectionId | NavId)[] => ALL_SECTIONS.filter((s) => !keep.includes(s));
  switch (preset) {
    case "favorites":
      return { ...DEFAULTS, hidden: only(["favorites"]), limits: { favorites: 0 } };
    case "recent":
      return { ...DEFAULTS, hidden: only(["recent"]), limits: { recent: 0 } };
    case "tasks":
      return {
        ...DEFAULTS,
        hidden: ["home", ...only([])],
        shortcuts: [
          { id: newId(), kind: "my-tasks" },
          { id: newId(), kind: "new-page" },
        ],
      };
    case "blank":
      return { ...DEFAULTS, hidden: ["home", "inbox", ...only([])] };
    default:
      return { ...DEFAULTS };
  }
}

const makeTab = (preset: TabPreset, id = newId()): SidebarTab => ({
  ...presetLayout(preset),
  id,
  preset,
  name: preset === "blank" ? "Nueva pestaña" : TAB_PRESETS[preset],
});

/** Sections added later go last; unknown ones drop out. */
function normalize(t: SidebarTab): SidebarTab {
  const order = (t.order ?? DEFAULTS.order).filter((s) => DEFAULTS.order.includes(s));
  return { ...DEFAULTS, ...t, order: [...order, ...DEFAULTS.order.filter((s) => !order.includes(s))] };
}

interface Stored {
  tabs: SidebarTab[];
  active: string;
}

const listeners = new Set<() => void>();

let state: Stored = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<SidebarPrefs> & Partial<Stored>;
    if (Array.isArray(saved.tabs) && saved.tabs.length) {
      const tabs = saved.tabs.map(normalize);
      return { tabs, active: tabs.some((t) => t.id === saved.active) ? saved.active! : tabs[0].id };
    }
    // Saved before tabs: that layout becomes the first tab, "Páginas".
    const flat: Partial<SidebarPrefs> = { ...saved };
    delete (flat as Partial<Stored>).tabs;
    delete (flat as Partial<Stored>).active;
    const first = normalize({ ...makeTab("pages", "pages"), ...flat });
    return { tabs: [first], active: first.id };
  } catch {
    const first = makeTab("pages", "pages");
    return { tabs: [first], active: first.id };
  }
})();

const activeTab = () => state.tabs.find((t) => t.id === state.active) ?? state.tabs[0];

function commit(next: Stored) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: keep it for this session */
  }
  listeners.forEach((cb) => cb());
}

/** The open tab's layout. */
export const getSidebarPrefs = (): SidebarTab => activeTab();

/** Changes the open tab's layout. */
export function updateSidebarPrefs(patch: Partial<SidebarPrefs> | ((p: SidebarPrefs) => Partial<SidebarPrefs>)) {
  const cur = activeTab();
  const next = { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) };
  commit({ ...state, tabs: state.tabs.map((t) => (t.id === cur.id ? next : t)) });
}

/** "Restablecer": the sidebar as it comes (a single "Páginas" tab). */
export const resetSidebarPrefs = () => {
  const first = makeTab("pages", "pages");
  commit({ tabs: [first], active: first.id });
};

/** "Restablecer pestaña": the tab goes back to the rows and sections it came with. */
export function resetTab(id: string) {
  commit({
    ...state,
    tabs: state.tabs.map((t) => (t.id === id ? { ...makeTab(t.preset, t.id), name: t.name } : t)),
  });
}

export const setActiveTab = (id: string) => {
  if (state.active !== id && state.tabs.some((t) => t.id === id)) commit({ ...state, active: id });
};

/** "Añadir pestaña": a new tab from a preset, opened. Returns false when the sidebar is full. */
export function addTab(preset: TabPreset): boolean {
  if (state.tabs.length >= MAX_TABS) return false;
  const tab = makeTab(preset);
  commit({ tabs: [...state.tabs, tab], active: tab.id });
  return true;
}

/** "Eliminar pestaña": the last remaining tab can't go. */
export function deleteTab(id: string) {
  if (state.tabs.length <= 1) return;
  const i = state.tabs.findIndex((t) => t.id === id);
  const tabs = state.tabs.filter((t) => t.id !== id);
  commit({ tabs, active: state.active === id ? tabs[Math.max(0, i - 1)].id : state.active });
}

export function renameTab(id: string, name: string) {
  commit({ ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)) });
}

/** Moves a tab one place left (-1) or right (1). */
export function moveTab(id: string, by: -1 | 1) {
  const tabs = [...state.tabs];
  const i = tabs.findIndex((t) => t.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= tabs.length) return;
  [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
  commit({ ...state, tabs });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** The open tab's layout. */
export function useSidebarPrefs(): SidebarTab {
  return useSyncExternalStore(subscribe, activeTab);
}

/** Every tab and which one is open. */
export function useSidebarTabs(): Stored {
  return useSyncExternalStore(subscribe, () => state);
}

export const sectionLimit = (p: SidebarPrefs, s: SectionId) => p.limits[s] ?? DEFAULT_LIMITS[s];

export function setHidden(id: SectionId | NavId, hidden: boolean) {
  updateSidebarPrefs((p) => ({ hidden: hidden ? [...p.hidden.filter((h) => h !== id), id] : p.hidden.filter((h) => h !== id) }));
}

/** Moves a section one place up (-1) or down (1). */
export function moveSection(id: SectionId, by: -1 | 1) {
  updateSidebarPrefs((p) => {
    const order = [...p.order];
    const i = order.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return {};
    [order[i], order[j]] = [order[j], order[i]];
    return { order };
  });
}

type NewShortcut = Shortcut extends infer S ? (S extends Shortcut ? Omit<S, "id"> : never) : never;

export function addShortcut(s: NewShortcut) {
  updateSidebarPrefs((p) => {
    const exists = p.shortcuts.some((x) =>
      s.kind === "view" ? x.kind === "view" && x.viewId === s.viewId : x.kind === s.kind,
    );
    if (exists) return {};
    return { shortcuts: [...p.shortcuts, { ...s, id: newId() } as Shortcut] };
  });
}

export const removeShortcut = (id: string) => updateSidebarPrefs((p) => ({ shortcuts: p.shortcuts.filter((s) => s.id !== id) }));
