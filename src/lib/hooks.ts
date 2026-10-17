import { useEffect, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import type { Block, ParentTable } from "./model";

// ---------------------------------------------------------------- routing

const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): string | null {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  // "?b=<block>" after the id points at a block inside the page.
  const id = hash.replace(/^#\/?/, "").split("?")[0];
  return id || null;
}

export function navigate(id: string) {
  window.location.hash = `/${id}`;
}

// Back / forward (the browser's, or the macOS app tab's ⌘[ / ⌘]) return to a page where it
// was scrolled; any other way of opening it starts at the top. The page asks once per visit.
let traversing = false;
const nav = (window as { navigation?: EventTarget }).navigation;
nav?.addEventListener("navigate", (e) => {
  traversing = (e as Event & { navigationType?: string }).navigationType === "traverse";
});

/** The tab's own history moved (App's ⌘[ / ⌘], which replaces the window's entry). */
export const markTraversal = () => void (traversing = true);

/** Whether the page now opening came from back / forward; resets for the next navigation. */
export function takeTraversal() {
  const was = traversing;
  traversing = false;
  return was;
}

/** The macOS app's tabs (App.tsx): ⌘-click on a page link opens it in a new one. */
export const OPEN_TAB_EVENT = "xot:open-tab";

export function openInNewTab(route: string) {
  window.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, { detail: route }));
}

/** Only the macOS app (Electron) has tabs. */
export const HAS_TABS = navigator.userAgent.includes("Electron");

/** ⌘-click (Ctrl-click elsewhere) on a page link asks for a new tab. */
export const wantsNewTab = (e: { metaKey: boolean; ctrlKey: boolean }) => HAS_TABS && (e.metaKey || e.ctrlKey);

/**
 * Click handlers for a link to a page (sidebar, breadcrumbs, Quick Find, Inicio),
 * ⌘-click or a middle click opens it in a new tab, a plain
 * click runs `open` (navigates by default). `after` runs once a new tab opened.
 */
export function pageLinkProps(id: string, open: () => void = () => navigate(id), after?: () => void) {
  const toTab = () => {
    openInNewTab(id);
    after?.();
  };
  return {
    onClick: (e: ReactMouseEvent) => (wantsNewTab(e) ? toTab() : open()),
    onAuxClick: (e: ReactMouseEvent) => {
      if (!HAS_TABS || e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      toTab();
    },
  };
}

// ------------------------------------------------------------------ theme

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** Apariencia: follow the system, or force light or dark (⌘⇧L toggles). */
export type ThemeSetting = "system" | "light" | "dark";
const THEME_KEY = "xotion:theme";
const themeListeners = new Set<() => void>();
let themeSetting: ThemeSetting = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(THEME_KEY) ?? '"system"');
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch {
    return "system";
  }
})();

// The stylesheets keep their dark tokens in `prefers-color-scheme` media
// queries; a forced theme rewrites those conditions to always/never match.
const DARK = "(prefers-color-scheme: dark)";
const LIGHT = "(prefers-color-scheme: light)";
const ALWAYS = "(min-width: 0px)";
const NEVER = "(max-width: 0px)";
const originalMedia = new WeakMap<CSSMediaRule, string>();

// Printing always uses the light colours, whatever shows on screen.
let printing = false;

function applyTheme() {
  const root = document.documentElement;
  const setting = printing ? "light" : themeSetting;
  if (setting === "system") delete root.dataset.theme;
  else root.dataset.theme = setting;
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        const original = originalMedia.get(rule) ?? rule.media.mediaText;
        if (original.includes("prefers-color-scheme")) {
          originalMedia.set(rule, original);
          const dark = setting === "dark";
          const next =
            setting === "system"
              ? original
              : original.replaceAll(DARK, dark ? ALWAYS : NEVER).replaceAll(LIGHT, dark ? NEVER : ALWAYS);
          if (rule.media.mediaText !== next) rule.media.mediaText = next;
        }
      }
      if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      /* cross-origin stylesheet (fonts): no color rules */
    }
  }
  // The macOS app's menus, window background and traffic lights follow the same choice.
  if (sentTheme !== themeSetting) {
    sentTheme = themeSetting;
    (window as { xotDesktop?: { setTheme(mode: string): void } }).xotDesktop?.setTheme(themeSetting);
  }
}
let sentTheme: ThemeSetting | undefined;

applyTheme();
window.addEventListener("load", applyTheme);
// The editor and the charts take their colours from React (useColorScheme): they re-render too.
const setPrinting = (on: boolean) => {
  printing = on;
  applyTheme();
  themeListeners.forEach((cb) => cb());
};
window.addEventListener("beforeprint", () => setPrinting(true));
window.addEventListener("afterprint", () => setPrinting(false));
// Stylesheets added later (lazy chunks, Vite's hot reload) get the same treatment.
new MutationObserver(() => themeSetting !== "system" && applyTheme()).observe(document.head, {
  childList: true,
  subtree: true,
  characterData: true,
});

export function setThemeSetting(next: ThemeSetting) {
  themeSetting = next;
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: keep it for this session */
  }
  applyTheme();
  themeListeners.forEach((cb) => cb());
}

/** ⌘⇧L: switches between light and dark from whatever shows now. */
export function toggleTheme() {
  const dark = themeSetting === "system" ? darkQuery.matches : themeSetting === "dark";
  setThemeSetting(dark ? "light" : "dark");
}

export function useThemeSetting() {
  return useSyncExternalStore(
    (cb) => {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
    () => (printing ? "light" : themeSetting),
  );
}

export function useColorScheme(): "light" | "dark" {
  const setting = useThemeSetting();
  const dark = useSyncExternalStore(
    (cb) => {
      darkQuery.addEventListener("change", cb);
      return () => darkQuery.removeEventListener("change", cb);
    },
    () => darkQuery.matches,
  );
  if (setting !== "system") return setting;
  return dark ? "dark" : "light";
}

// ------------------------------------------------------------------- data

export function useBlock(id: string | null | undefined) {
  return useLiveQuery(async () => (id ? ((await db.blocks.get(id)) ?? null) : null), [id]);
}

export function useChildren(parentTable: ParentTable, parentId: string) {
  return useLiveQuery(
    async () =>
      (
        await db.blocks
          .where("[parent_table+parent_id]")
          .equals([parentTable, parentId])
          .toArray()
      )
        // Database templates are rows only "Nuevo" offers, never shown in views.
        .filter((b) => b.alive && !b.is_template)
        .sort((a, b) => a.order - b.order),
    [parentTable, parentId],
  );
}

/** Whether a page body mentions `id` inline, or links to it with a "link to page" block. */
function refsTo(node: unknown, id: string, found = { mention: false, link: false }) {
  if (Array.isArray(node)) for (const item of node) refsTo(item, id, found);
  else if (node && typeof node === "object") {
    const o = node as { type?: unknown; props?: { pageId?: unknown } };
    if (o.props?.pageId === id) {
      if (o.type === "mention") found.mention = true;
      else if (o.type === "pageLink") found.link = true;
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") refsTo(value, id, found);
  }
  return found;
}

/**
 * Backlinks: pages that mention or link to this one. A parent's link to
 * its own subpage is just the subpage, so it doesn't count (nor do the subpages).
 */
export function useBacklinks(page: Block | null | undefined) {
  const id = page?.id;
  const parentId = page?.parent_id;
  return useLiveQuery(async () => {
    if (!id) return [];
    const marker = `%%xotion:${id}%%`;
    return db.blocks
      .filter((b) => {
        if (!b.alive || b.id === id || b.parent_id === id) return false;
        let found = { mention: false, link: false };
        if (b.content?.length) {
          if (JSON.stringify(b.content).includes(id)) found = refsTo(b.content, id);
        } else if (b.content_markdown?.includes(marker)) found.link = true;
        return found.mention || (found.link && b.id !== parentId);
      })
      .toArray();
  }, [id, parentId]);
}

/** A database's templates, in the collection's order. */
export function useTemplates(collectionId: string) {
  return useLiveQuery(async () => {
    const order = (await db.collections.get(collectionId))?.template_ids ?? [];
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    return (
      await db.blocks.where("[parent_table+parent_id]").equals(["collection", collectionId]).toArray()
    )
      .filter((b) => b.alive && b.is_template)
      .sort((a, b) => rank(a.id) - rank(b.id) || a.created_time - b.created_time);
  }, [collectionId]);
}

export function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

// -------------------------------------------------------------- favorites

// Favorites are a per-device list, shared by the sidebar and the page topbar.
const FAVORITES_KEY = "xotion:favorites";
const favoriteListeners = new Set<() => void>();
let favoritesCache: string[] | null = null;

function readFavorites(): string[] {
  if (favoritesCache) return favoritesCache;
  try {
    const raw = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    favoritesCache = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    favoritesCache = [];
  }
  return favoritesCache;
}

export function toggleFavorite(id: string) {
  const list = readFavorites();
  favoritesCache = list.includes(id) ? list.filter((f) => f !== id) : [...list, id];
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favoritesCache));
  } catch {
    /* storage unavailable: keep them for this session */
  }
  favoriteListeners.forEach((cb) => cb());
}

/**
 * Puts a page at `index` of the favorites (adding it when it isn't one), as
 * dragging a row into Favoritos does. `index` counts the list before the move.
 */
export function placeFavorite(id: string, index: number) {
  const list = readFavorites();
  const from = list.indexOf(id);
  const rest = list.filter((f) => f !== id);
  const at = Math.max(0, Math.min(rest.length, from !== -1 && from < index ? index - 1 : index));
  favoritesCache = [...rest.slice(0, at), id, ...rest.slice(at)];
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favoritesCache));
  } catch {
    /* storage unavailable: keep them for this session */
  }
  favoriteListeners.forEach((cb) => cb());
}

/** Adds pages to the favorites (on import), keeping the current order first. */
export function addFavorites(ids: string[]) {
  const list = readFavorites();
  const added = ids.filter((id) => !list.includes(id));
  if (!added.length) return;
  favoritesCache = [...list, ...added];
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favoritesCache));
  } catch {
    /* storage unavailable: keep them for this session */
  }
  favoriteListeners.forEach((cb) => cb());
}

export function useFavorites() {
  return useSyncExternalStore((cb) => {
    favoriteListeners.add(cb);
    return () => favoriteListeners.delete(cb);
  }, readFavorites);
}

// ---------------------------------------------------------------- recents

// Pages opened on this device, newest first: the sidebar's "Recientes".
const RECENTS_KEY = "xotion:recent-pages";
const RECENTS_MAX = 20;
const recentListeners = new Set<() => void>();
let recentsCache: string[] | null = null;

export function readRecents(): string[] {
  if (recentsCache) return recentsCache;
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    recentsCache = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    recentsCache = [];
  }
  return recentsCache;
}

// When each page was last opened here (Buscar groups its empty list by visit: Hoy, Ayer…).
const VISITS_KEY = "xotion:page-visits";
let visitsCache: Record<string, number> | null = null;

export function readVisits(): Record<string, number> {
  if (visitsCache) return visitsCache;
  try {
    const raw = JSON.parse(localStorage.getItem(VISITS_KEY) ?? "{}");
    visitsCache = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, number>) : {};
  } catch {
    visitsCache = {};
  }
  return visitsCache;
}

export function addRecentPage(id: string) {
  // Keep the last ~200 visits; older pages fall back to their last edit.
  const visits = Object.entries({ ...readVisits(), [id]: Date.now() })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200);
  visitsCache = Object.fromEntries(visits);
  try {
    localStorage.setItem(VISITS_KEY, JSON.stringify(visitsCache));
  } catch {
    /* storage unavailable */
  }
  const list = readRecents();
  if (list[0] === id) return;
  recentsCache = [id, ...list.filter((r) => r !== id)].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recentsCache));
  } catch {
    /* storage unavailable: keep them for this session */
  }
  recentListeners.forEach((cb) => cb());
}

export function useRecentPages() {
  return useSyncExternalStore((cb) => {
    recentListeners.add(cb);
    return () => recentListeners.delete(cb);
  }, readRecents);
}

export function pageTitle(block: Pick<Block, "properties"> | undefined | null) {
  const title = block?.properties.title;
  return typeof title === "string" && title.trim() ? title : "Sin título";
}
