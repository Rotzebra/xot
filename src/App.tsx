import { useCallback, useEffect, useRef, useState, type CSSProperties, type SetStateAction } from "react";
import { WORKSPACE_ID, isWorkspaceRoot } from "./lib/model";
import { resolveWorkspace } from "./lib/workspace";
import { db } from "./lib/db";
import { createPage, getAncestors, redoLast, sweepTrash, undoLast } from "./lib/ops";
import { seedIfEmpty } from "./lib/seed";
import { getSettings, useSettings } from "./lib/settings";
import { desktop } from "./lib/desktop";
import { useUnreadCount } from "./lib/inbox";
import { keepStorage, sweepOrphanFiles } from "./lib/files";
import { importWorkspaceIfAvailable } from "./lib/workspaceImport";
import { importOpened, type OpenedFile } from "./lib/importFiles";
import { startReminders } from "./lib/reminders";
import { startAutomations } from "./lib/automations";
import { startVerificationChecks } from "./lib/wiki";
import {
  addRecentPage,
  markTraversal,
  navigate,
  OPEN_TAB_EVENT,
  pageTitle,
  toggleTheme,
  useBlock,
  useChildren,
  useRoute,
  useStoredState,
} from "./lib/hooks";
import { INBOX_PIN_EVENT, openPreferences, PREFERENCES_EVENT, RENAME_EVENT, Sidebar } from "./components/Sidebar";
import { InboxPanel } from "./components/Inbox";
import { HOME_ROUTE, HomeView } from "./components/HomeView";
import { SettingsModal } from "./components/SettingsModal";
import { workspaceTarget } from "./components/ImportDialog";
import { PageView } from "./components/PageView";
import { FindBar } from "./components/FindBar";
import { QuickFind } from "./components/QuickFind";
import { DESKTOP, newPageInWorkspace, TitleBar, type Tab } from "./components/TitleBar";
import { KeyboardShortcuts, SHORTCUTS_EVENT } from "./components/KeyboardShortcuts";
import { hasOpenPopover, installTooltips, toast } from "./components/ui";

const LAST_PAGE_KEY = "xotion:last-page";

const narrow = () => window.matchMedia("(max-width: 760px)").matches;

/**
 * The window's tabs (the macOS app). Each keeps its own page route and its own
 * back/forward history; the active one is the location hash. A reload keeps
 * them (sessionStorage), a closed tab reopens with its history (⌘⇧T), and the
 * last focused window's tabs reopen at launch (localStorage, "?restore=1").
 */
type Tabs = { list: Tab[]; active: number; closed: { tab: Tab; index: number }[] };
const TABS_KEY = "xot:tabs";
/** How many pages a tab remembers each way. */
const HISTORY_MAX = 50;
const hashRoute = () => window.location.hash.replace(/^#/, "");
const tabId = () => Math.random().toString(36).slice(2, 10);

function readTabs(store: () => Storage): Tabs | null {
  try {
    const t = JSON.parse(store().getItem(TABS_KEY) ?? "null") as Tabs | null;
    if (!t || !Array.isArray(t.list) || !t.list.length || !t.list[t.active]) return null;
    return { list: t.list, active: t.active, closed: Array.isArray(t.closed) ? t.closed : [] };
  } catch {
    return null;
  }
}

/** A tab moved here from another window ("?tab=", electron/main.cjs): the window starts with it alone. */
function movedTab(): Tab | null {
  try {
    const raw = new URLSearchParams(location.search).get("tab");
    const t = raw ? (JSON.parse(raw) as Partial<Tab>) : null;
    if (!t || typeof t.route !== "string") return null;
    return { ...t, id: tabId(), route: t.route };
  } catch {
    return null;
  }
}

function loadTabs(): Tabs {
  const moved = !readTabs(() => sessionStorage) && movedTab();
  if (moved) return { list: [moved], active: 0, closed: [] };
  const restore = new URLSearchParams(location.search).has("restore") && !hashRoute();
  const saved = readTabs(() => sessionStorage) ?? (restore ? readTabs(() => localStorage) : null);
  if (!saved) return { list: [{ id: tabId(), route: hashRoute() }], active: 0, closed: [] };
  const route = saved.list[saved.active].route;
  if (route && route !== hashRoute()) window.location.replace(`#${route}`);
  return saved;
}

function saveTabs(tabs: Tabs, everywhere: boolean) {
  try {
    const json = JSON.stringify({ ...tabs, closed: tabs.closed.slice(-20) });
    sessionStorage.setItem(TABS_KEY, json);
    if (everywhere) localStorage.setItem(TABS_KEY, json);
  } catch {
    /* storage unavailable */
  }
}

/** The windows tell each other when one takes a tab dragged from another (which then drops it). */
const tabChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("xot-tabs");

/** Shows a tab's page without adding a window history entry (each tab keeps its own history). */
const show = (route: string) => route !== hashRoute() && window.location.replace(`#${route}`);

// Markdown files opened with Xot.app (Finder, the Dock) become pages; registered once.
let fileListener = false;

/** Typing somewhere: the editor, the title or a field keeps ⌘Z for its own text. */
const isEditing = (el: Element | null) =>
  !!el && (el.matches("input, textarea, select, [contenteditable='true']") || !!el.closest(".bn-editor"));

export default function App() {
  const route = useRoute();
  const roots = useChildren("space", WORKSPACE_ID);
  // The docked sidebar's open state is the user's choice and is stored. In a
  // narrow window (≤760px) it becomes a temporary overlay with its own state,
  // never stored, so widening the window brings the choice back.
  const [storedOpen, setStoredOpen] = useStoredState("xotion:sidebar", true);
  const [isNarrow, setIsNarrow] = useState(narrow);
  const [overlayOpen, setOverlayOpen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const onChange = () => {
      setIsNarrow(query.matches);
      setOverlayOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const sidebarOpen = isNarrow ? overlayOpen : storedOpen;
  const setSidebarOpen = useCallback(
    (next: SetStateAction<boolean>) => (isNarrow ? setOverlayOpen(next) : setStoredOpen(next)),
    [isNarrow, setStoredOpen],
  );
  const [findOpen, setFindOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener(PREFERENCES_EVENT, open);
    return () => window.removeEventListener(PREFERENCES_EVENT, open);
  }, []);
  const [sidebarWidth, setSidebarWidth] = useStoredState("xotion:sidebar-width", 240);
  // "Bandeja de entrada" docked beside the page ("Fijar el panel").
  const [inboxPinned, setInboxPinned] = useStoredState("xotion:inbox:pinned", false);
  useEffect(() => {
    const pin = (e: Event) => setInboxPinned(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener(INBOX_PIN_EVENT, pin);
    return () => window.removeEventListener(INBOX_PIN_EVENT, pin);
  }, [setInboxPinned]);
  // A closed sidebar slides in over the page while the pointer is near it (hover peek).
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<number | undefined>(undefined);
  const showPeek = () => {
    window.clearTimeout(peekTimer.current);
    if (!sidebarOpen && !narrow()) setPeek(true);
  };
  const hidePeek = () => {
    window.clearTimeout(peekTimer.current);
    // A menu opened from the peeking sidebar keeps it open until it closes.
    const check = () => (hasOpenPopover() ? (peekTimer.current = window.setTimeout(check, 300)) : setPeek(false));
    peekTimer.current = window.setTimeout(check, 300);
  };

  useEffect(() => {
    if (sidebarOpen) setPeek(false);
  }, [sidebarOpen]);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);

  // The seed and the workspace import: the first page to open waits for both.
  const startup = useRef<Promise<void> | null>(null);
  useEffect(() => {
    startup.current = seedIfEmpty().then(importWorkspaceIfAvailable);
    // Pages 30 days in the trash are deleted for good; then the files no page uses any more.
    void startup.current.then(sweepTrash).then(() => sweepOrphanFiles());
    installTooltips();
    // In a browser, asks it not to clear the pages and files when the disk runs low.
    void keepStorage();
  }, []);

  // Preferencias > Zona horaria: the macOS app runs the pages in a zone chosen by hand.
  const { autoTimeZone, timeZone } = useSettings();
  useEffect(() => void desktop()?.setTimeZone?.(autoTimeZone ? "" : timeZone), [autoTimeZone, timeZone]);

  // The Dock's badge shows Bandeja de entrada's unread count.
  const unread = useUnreadCount();
  useEffect(() => void desktop()?.setBadge?.(unread), [unread]);

  // Ayuda > Atajos del teclado (⌘⌥/).
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    const open = () => setShortcutsOpen((o) => !o);
    window.addEventListener(SHORTCUTS_EVENT, open);
    return () => window.removeEventListener(SHORTCUTS_EVENT, open);
  }, []);

  // Reminders (date mentions and date properties) fire whatever page is open:
  // scheduled from Dexie at launch and after every change.
  useEffect(() => startReminders(toast), []);
  useEffect(() => startAutomations((message) => toast(message)), []);
  // Verified pages whose verification expired land in "Bandeja de entrada".
  useEffect(() => startVerificationChecks(), []);

  const [tabs, setTabs] = useState(loadTabs);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => saveTabs(tabs, document.hasFocus()), [tabs]);
  useEffect(() => {
    const onFocus = () => saveTabs(tabsRef.current, true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  // Navigating changes the active tab's page: the page it leaves goes on the
  // tab's back history and its forward history empties, as in a browser.
  useEffect(() => {
    const r = hashRoute();
    setTabs((t) => {
      const tab = t.list[t.active];
      if (tab.route === r) return t;
      const back = tab.route ? [...(tab.back ?? []), tab.route].slice(-HISTORY_MAX) : tab.back;
      const next = { ...tab, route: r, back, forward: [] };
      return { ...t, list: t.list.map((x, i) => (i === t.active ? next : x)) };
    });
  }, [route]);

  // The macOS app: every link, search result or menu replaces the window's
  // history entry instead of adding one, so the window's history never mixes
  // the tabs' pages (Chromium's Navigation API; ← → walk the tab's own).
  useEffect(() => {
    const nav = (window as { navigation?: EventTarget }).navigation;
    if (!DESKTOP || !nav) return;
    const onNavigate = (e: Event) => {
      const n = e as Event & { navigationType: string; hashChange: boolean; destination: { url: string } };
      if (n.navigationType !== "push" || !n.hashChange || !e.cancelable) return;
      e.preventDefault();
      window.location.replace(n.destination.url);
    };
    nav.addEventListener("navigate", onNavigate);
    return () => nav.removeEventListener("navigate", onNavigate);
  }, []);

  // Pictures of the tabs' pages for their hover previews (the macOS app takes them).
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const lastCapture = useRef(0);
  const capture = () => {
    const app = desktop();
    if (!app?.capturePage || Date.now() - lastCapture.current < 1500) return;
    lastCapture.current = Date.now();
    const id = tabsRef.current.list[tabsRef.current.active]?.id;
    void app.capturePage().then((image) => {
      if (image && id) setPreviews((p) => ({ ...p, [id]: image }));
    });
  };

  /** Pinned tabs stay first: the place a tab can take in `list`, between `min` and `max`. */
  const pinnedRange = (list: Tab[], tab: Tab) => {
    const pinned = list.filter((t) => t.pinned && t !== tab).length;
    return tab.pinned ? [0, pinned] : [pinned, list.length];
  };

  const tabActions = useRef({
    select(index: number) {
      const t = tabsRef.current;
      const i = index < 0 ? t.list.length - 1 : index;
      if (!t.list[i] || i === t.active) return;
      setTabs({ ...t, active: i });
      show(t.list[i].route);
    },
    step(by: number) {
      const t = tabsRef.current;
      tabActions.current.select((t.active + by + t.list.length) % t.list.length);
    },
    /** Atrás (-1) / Adelante (1) in the active tab's own history. */
    go(by: -1 | 1) {
      const t = tabsRef.current;
      const tab = t.list[t.active];
      const from = (by < 0 ? tab.back : tab.forward) ?? [];
      const route = from[from.length - 1];
      if (route === undefined) return;
      const here = hashRoute() || tab.route;
      const to = [...((by < 0 ? tab.forward : tab.back) ?? []), here].slice(-HISTORY_MAX);
      const next = by < 0 ? { ...tab, route, back: from.slice(0, -1), forward: to } : { ...tab, route, back: to, forward: from.slice(0, -1) };
      setTabs({ ...t, list: t.list.map((x, i) => (i === t.active ? next : x)) });
      show(route);
      markTraversal();
    },
    /**
     * ⌘T and "+": a new tab with Buscar open; with "Búsqueda en una
     * pestaña nueva" off, the new tab shows the start page (Abrir al iniciar) instead.
     */
    openNew() {
      const start = getSettings().startPage;
      if (getSettings().newTabSearch) return tabActions.current.open(`/${HOME_ROUTE}`, true);
      tabActions.current.open(`/${start === "last" ? HOME_ROUTE : start}`, false);
    },
    /** A new tab after the last one (or after tab `after`). */
    open(route: string, search: boolean, after?: number) {
      const t = tabsRef.current;
      const index = after === undefined ? t.list.length : after + 1;
      const list = [...t.list.slice(0, index), { id: tabId(), route }, ...t.list.slice(index)];
      setTabs({ ...t, list, active: index });
      show(route);
      if (search) setFindOpen(true);
    },
    /** False for the window's last tab: closing it closes the window. */
    close(index?: number) {
      const t = tabsRef.current;
      const i = index ?? t.active;
      if (t.list.length <= 1 || !t.list[i]) return false;
      const list = t.list.filter((_, j) => j !== i);
      const active = i < t.active ? t.active - 1 : i === t.active ? Math.min(i, list.length - 1) : t.active;
      setTabs({ list, active, closed: [...t.closed, { tab: t.list[i], index: i }].slice(-20) });
      show(list[active].route);
      return true;
    },
    reopen() {
      const t = tabsRef.current;
      const last = t.closed[t.closed.length - 1];
      if (!last) return;
      const index = Math.min(last.index, t.list.length);
      const list = [...t.list.slice(0, index), last.tab, ...t.list.slice(index)];
      setTabs({ list, active: index, closed: t.closed.slice(0, -1) });
      show(last.tab.route);
    },
    /** "Duplicar pestaña": the same page and history (pinned too), right after it, and active. */
    duplicate(index: number) {
      const t = tabsRef.current;
      const tab = t.list[index];
      if (!tab) return;
      const copy = { ...tab, id: tabId() };
      const list = [...t.list.slice(0, index + 1), copy, ...t.list.slice(index + 1)];
      setTabs({ ...t, list, active: index + 1 });
      show(copy.route);
    },
    /** Closes every tab but `keep` (reopenable with ⌘⇧T, last closed first). */
    closeWhere(keep: (i: number) => boolean, focus: number) {
      const t = tabsRef.current;
      if (!t.list[focus]) return;
      const gone = t.list.map((tab, index) => ({ tab, index })).filter(({ index }) => !keep(index));
      if (!gone.length) return;
      const list = t.list.filter((_, i) => keep(i));
      const kept = t.list[t.active] && keep(t.active) ? t.list[t.active] : t.list[focus];
      const active = list.indexOf(kept);
      setTabs({ list, active, closed: [...t.closed, ...gone.reverse()].slice(-20) });
      show(kept.route);
    },
    // Pinned tabs stay.
    closeOthers(index: number) {
      tabActions.current.closeWhere((i) => i === index || !!tabsRef.current.list[i]?.pinned, index);
    },
    closeRight(index: number) {
      tabActions.current.closeWhere((i) => i <= index || !!tabsRef.current.list[i]?.pinned, index);
    },
    /** "Fijar pestaña": compact at the end of the pinned ones (remembering its page); "Desfijar" puts it right after them. */
    pin(index: number, pinned: boolean) {
      const t = tabsRef.current;
      const tab = t.list[index];
      if (!tab || !!tab.pinned === pinned) return;
      const next: Tab = pinned ? { ...tab, pinned: true, pinnedRoute: tab.route } : { ...tab, pinned: false, pinnedRoute: undefined };
      const rest = t.list.filter((_, i) => i !== index);
      const at = rest.filter((x) => x.pinned).length;
      const list = [...rest.slice(0, at), next, ...rest.slice(at)];
      const active = t.list[t.active] === tab ? next : t.list[t.active];
      setTabs({ ...t, list, active: list.indexOf(active) });
    },
    /** "Volver a la URL fijada": the pinned tab shows its page again (and becomes the open one). */
    returnToPinned(index: number) {
      const t = tabsRef.current;
      const tab = t.list[index];
      if (!tab?.pinnedRoute) return;
      if (index !== t.active) {
        setTabs({ ...t, active: index });
        show(tab.route);
      }
      window.location.hash = tab.pinnedRoute;
    },
    /** "Reemplazar la URL fijada por la actual". */
    replacePinned(index: number) {
      const t = tabsRef.current;
      const tab = t.list[index];
      if (!tab?.pinned) return;
      setTabs({ ...t, list: t.list.map((x, i) => (i === index ? { ...x, pinnedRoute: x.route } : x)) });
    },
    /** Takes tab `index` out of this window (it moved to another one): not reopenable here; the last one closes the window. */
    detach(index: number) {
      const t = tabsRef.current;
      if (!t.list[index]) return;
      if (t.list.length <= 1) return void window.close();
      const list = t.list.filter((_, j) => j !== index);
      const active = index < t.active ? t.active - 1 : index === t.active ? Math.min(index, list.length - 1) : t.active;
      setTabs({ ...t, list, active });
      show(list[active].route);
    },
    /** "Mover la pestaña a una nueva ventana" (at a screen point: a tab dropped outside the windows). */
    toWindow(index: number, at?: { x: number; y: number }) {
      const t = tabsRef.current;
      const tab = t.list[index];
      const app = desktop();
      if (!tab || t.list.length <= 1 || !app?.moveTabToWindow) return;
      const { id: _id, ...moved } = tab;
      app.moveTabToWindow(moved, at);
      tabActions.current.detach(index);
    },
    /** A tab dragged in from another window, before tab `before`, and open; the window it left drops it. */
    insert(moved: Tab, before: number) {
      const t = tabsRef.current;
      if (t.list.some((x) => x.id === moved.id)) return;
      tabChannel?.postMessage({ taken: moved.id });
      const tab: Tab = { ...moved, id: tabId() };
      const [min, max] = pinnedRange(t.list, tab);
      const index = Math.max(min, Math.min(before, max));
      const list = [...t.list.slice(0, index), tab, ...t.list.slice(index)];
      setTabs({ ...t, list, active: index });
      show(tab.route);
    },
    /** Drags tab `from` to the gap before tab `before` (the list's length: the end); the active one stays active. */
    move(from: number, before: number) {
      const t = tabsRef.current;
      if (!t.list[from]) return;
      // A pinned tab moves among the pinned ones, the others after them.
      const [min, max] = pinnedRange(t.list, t.list[from]);
      const to = Math.max(min, Math.min(before > from ? before - 1 : before, max));
      if (to === from) return;
      const list = [...t.list];
      const [tab] = list.splice(from, 1);
      list.splice(Math.max(0, Math.min(to, list.length)), 0, tab);
      setTabs({ ...t, list, active: list.indexOf(t.list[t.active]) });
    },
  });

  // The app's menus and shortcuts (electron/main.cjs) drive the tabs through window.xotTab.
  useEffect(() => {
    const tabs = tabActions.current;
    type OpenArg = { route: string; newTab?: boolean };
    const w = window as { xotTab?: (action: string, arg: number | OpenArg | null) => boolean };
    w.xotTab = (action, arg) => {
      const n = typeof arg === "number" ? arg : null;
      if (action === "new") tabs.openNew();
      // ⌘W keeps a pinned tab (its own menu's "Cerrar pestaña" still closes it).
      else if (action === "close") return tabsRef.current.list[tabsRef.current.active]?.pinned ? true : tabs.close();
      else if (action === "reopen") tabs.reopen();
      else if (action === "select") tabs.select(n ?? 0);
      else if (action === "step") tabs.step(n ?? 1);
      // A page from outside the window (a xot:// link, Atajo de búsqueda): a pinned tab keeps its page.
      else if (action === "open" && arg && typeof arg === "object" && typeof arg.route === "string") {
        const t = tabsRef.current;
        if (arg.newTab || t.list[t.active]?.pinned) tabs.open(arg.route, false);
        else window.location.hash = arg.route;
      }
      else if (action === "back") tabs.go(-1);
      else if (action === "forward") tabs.go(1);
      else return false;
      return true;
    };
    // A tab of this window dropped on another window's tab bar: it lives there now.
    const onTaken = (e: MessageEvent<{ taken?: string }>) => {
      const index = tabsRef.current.list.findIndex((t) => t.id === e.data?.taken);
      if (index !== -1) tabs.detach(index);
    };
    tabChannel?.addEventListener("message", onTaken);
    // ⌘-click on a page link (Editor.tsx): the page in a new tab next to this one.
    const onOpen = (e: Event) => tabs.open(`/${(e as CustomEvent<string>).detail}`, false, tabsRef.current.active);
    window.addEventListener(OPEN_TAB_EVENT, onOpen);
    // A mouse's back/forward buttons walk the tab's history too.
    const onMouse = (e: MouseEvent) => {
      if (!DESKTOP || (e.button !== 3 && e.button !== 4)) return;
      e.preventDefault();
      if (e.type === "mouseup") tabs.go(e.button === 3 ? -1 : 1);
    };
    window.addEventListener("mousedown", onMouse);
    window.addEventListener("mouseup", onMouse);
    return () => {
      delete w.xotTab;
      tabChannel?.removeEventListener("message", onTaken);
      window.removeEventListener(OPEN_TAB_EVENT, onOpen);
      window.removeEventListener("mousedown", onMouse);
      window.removeEventListener("mouseup", onMouse);
    };
  }, []);

  // Xot.app's open-file: a file (Markdown, HTML, CSV, an exported workspace's .zip, Word, PDF…) or a
  // folder (an unzipped export) becomes pages and databases where ⌘N would put them, like Importar.
  useEffect(() => {
    const desktop = (window as { xotDesktop?: { onOpenFile?(cb: (file: OpenedFile) => void): void } }).xotDesktop;
    if (fileListener || !desktop?.onOpenFile) return;
    fileListener = true;
    desktop.onOpenFile((file) => {
      void workspaceTarget()
        .then((target) => importOpened(file, target))
        .then((id) => {
          if (id) navigate(id);
          toast(`Se importó «${file.name.normalize("NFC")}»`);
        })
        .catch((e) => toast(e instanceof Error ? e.message : "No se pudo importar el archivo"));
    });
  }, []);

  // The window is named after the open page (macOS shows it in the Window menu and Mission Control).
  const current = useBlock(route);
  useEffect(() => {
    document.title = route === HOME_ROUTE ? "Inicio" : current ? pageTitle(current) : "Xot";
  }, [current, route]);

  // Remember the open page, so the next launch reopens it.
  useEffect(() => {
    if (!route) return;
    try {
      localStorage.setItem(LAST_PAGE_KEY, route);
    } catch {
      /* storage unavailable */
    }
    // The sidebar's "Recientes"; a workspace root is a container, not a page.
    if (!isWorkspaceRoot(route) && route !== HOME_ROUTE) addRecentPage(route);
  }, [route]);

  // Start on the last page open, else the first one; an imported workspace root is a container, not a page.
  useEffect(() => {
    if (route || !roots?.length) return;
    let cancelled = false;
    void (async () => {
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_PAGE_KEY);
      } catch {
        /* storage unavailable */
      }
      // Configuración > "Abrir al iniciar": a chosen page, else the last one visited.
      const start = getSettings().startPage;
      if (start === HOME_ROUTE || (start === "last" && last === HOME_ROUTE)) return window.location.replace(`#/${HOME_ROUTE}`);
      const chosen = start !== "last" ? await db.blocks.get(start) : undefined;
      if (cancelled) return;
      if (chosen?.alive) return window.location.replace(`#/${chosen.id}`);
      const saved = last ? await db.blocks.get(last) : undefined;
      if (cancelled) return;
      if (saved?.alive && !isWorkspaceRoot(saved.id)) return window.location.replace(`#/${saved.id}`);
      // Nothing to reopen: the workspace the sidebar shows (an imported one
      // before the seeded local page), once the first import has landed.
      await startup.current?.catch(() => undefined);
      if (cancelled) return;
      const tops = (await db.blocks.where("[parent_table+parent_id]").equals(["space", WORKSPACE_ID]).toArray())
        .filter((b) => b.alive && !b.is_template && !b.format.inline)
        .sort((a, b) => a.order - b.order);
      if (cancelled) return;
      const ws = resolveWorkspace(tops);
      const root = tops.find((b) => (isWorkspaceRoot(ws) ? b.id === ws : !isWorkspaceRoot(b.id))) ?? tops[0] ?? roots[0];
      if (!isWorkspaceRoot(root.id)) return window.location.replace(`#/${root.id}`);
      const pages = await db.blocks.where("[parent_table+parent_id]").equals(["block", root.id]).toArray();
      if (cancelled) return;
      const first = pages.filter((b) => b.alive && !b.format.inline).sort((a, b) => a.order - b.order)[0];
      window.location.replace(`#/${(first ?? root).id}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [route, roots]);

  // On small screens the sidebar is an overlay: close it after navigating.
  useEffect(() => {
    if (isNarrow) setOverlayOpen(false);
  }, [route, isNarrow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // ⌘K on selected text adds a link (the editor's own shortcut); ⌘P always searches.
      const linking = e.key === "k" && isEditing(document.activeElement) && !window.getSelection()?.isCollapsed;
      if (mod && !e.shiftKey && !e.altKey && (e.key === "p" || (e.key === "k" && !linking))) {
        e.preventDefault();
        setFindOpen((o) => !o);
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      }
      // ⌘[ / ⌘]: back / forward in the tab (the app's Historial menu, which this handles first).
      if (DESKTOP && mod && !e.shiftKey && !e.altKey && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        tabActions.current.go(e.key === "[" ? -1 : 1);
        return;
      }
      // ⌘⌥/: Atajos del teclado.
      if (mod && e.altKey && !e.shiftKey && (e.code === "Slash" || e.key === "/")) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      // ⌘⇧L: light / dark.
      if (e.shiftKey && key === "l") {
        e.preventDefault();
        toggleTheme();
      }
      // ⌘,: Configuración.
      else if (!e.shiftKey && key === ",") {
        e.preventDefault();
        openPreferences();
      }
      // ⌘N: a new page in the workspace the sidebar shows.
      else if (!e.shiftKey && key === "n") {
        e.preventDefault();
        void newPageInWorkspace();
      }
      // ⌘⇧R: rename the open page (its sidebar row, else the title).
      else if (e.shiftKey && key === "r") {
        e.preventDefault();
        if (document.querySelector(".app__body > .sidebar .tree-row.is-active")) window.dispatchEvent(new Event(RENAME_EVENT));
        else document.querySelector<HTMLElement>(".page-header__title, .db-page-title__text")?.focus();
      }
      // ⌘⇧U: up to the parent page.
      else if (e.shiftKey && key === "u") {
        e.preventDefault();
        const id = window.location.hash.replace(/^#\/?/, "").split("?")[0];
        void db.blocks.get(id).then(async (block) => {
          const parent = block && (await getAncestors(block)).filter((b) => !isWorkspaceRoot(b.id)).pop();
          if (parent) navigate(parent.id);
        });
      }
      // ⌘Z / ⌘⇧Z outside text: page operations (trash, move).
      else if (key === "z" && !isEditing(document.activeElement)) {
        e.preventDefault();
        void (e.shiftKey ? redoLast() : undoLast()).then((label) => {
          if (label) toast(e.shiftKey ? `Rehecho: ${label}` : `Deshecho: ${label}`);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebarOpen]);

  return (
    <div
      className={`app${sidebarOpen ? " has-sidebar" : ""}`}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
    >
      {DESKTOP && (
        <TitleBar
          tabs={tabs.list}
          active={tabs.active}
          onSelectTab={(i) => tabActions.current.select(i)}
          onCloseTab={(i) => tabActions.current.close(i) || window.close()}
          onNewTab={() => tabActions.current.openNew()}
          onDuplicateTab={(i) => tabActions.current.duplicate(i)}
          onCloseOtherTabs={(i) => tabActions.current.closeOthers(i)}
          onCloseTabsRight={(i) => tabActions.current.closeRight(i)}
          onReopenTab={() => tabActions.current.reopen()}
          canReopenTab={tabs.closed.length > 0}
          onMoveTab={(from, to) => tabActions.current.move(from, to)}
          onPinTab={(i, pinned) => tabActions.current.pin(i, pinned)}
          onReturnToPinned={(i) => tabActions.current.returnToPinned(i)}
          onReplacePinned={(i) => tabActions.current.replacePinned(i)}
          onMoveTabToWindow={desktop()?.moveTabToWindow ? (i) => tabActions.current.toWindow(i) : undefined}
          onTabDropIn={(tab, before) => tabActions.current.insert(tab, before)}
          onTabDragOut={(i, at) => tabActions.current.toWindow(i, at)}
          previews={previews}
          onCapture={capture}
          onBack={() => tabActions.current.go(-1)}
          onForward={() => tabActions.current.go(1)}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onPeekSidebar={showPeek}
          onUnpeekSidebar={hidePeek}
        />
      )}
      <div className="app__body">
        {sidebarOpen ? (
          <>
            <Sidebar
              activeId={route}
              onCollapse={() => setSidebarOpen(false)}
              onSearch={() => setFindOpen(true)}
              onResize={setSidebarWidth}
            />
            <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
          </>
        ) : (
          <>
            <div className="sidebar-hotzone" onMouseEnter={showPeek} onMouseLeave={hidePeek} onClick={() => setSidebarOpen(true)} />
            {peek && (
              <div className="sidebar-peek" onMouseEnter={showPeek} onMouseLeave={hidePeek}>
                <Sidebar
                  activeId={route}
                  peek
                  onPin={() => {
                    setPeek(false);
                    setSidebarOpen(true);
                  }}
                  onCollapse={() => setPeek(false)}
                  onSearch={() => {
                    setPeek(false);
                    setFindOpen(true);
                  }}
                />
              </div>
            )}
          </>
        )}
        <main className="main">
          {route === HOME_ROUTE ? (
            <HomeView
              sidebarOpen={sidebarOpen}
              onOpenSidebar={() => setSidebarOpen(true)}
              onPeekSidebar={showPeek}
              onUnpeekSidebar={hidePeek}
            />
          ) : route ? (
            <PageView
              id={route}
              sidebarOpen={sidebarOpen}
              onOpenSidebar={() => setSidebarOpen(true)}
              onPeekSidebar={showPeek}
              onUnpeekSidebar={hidePeek}
            />
          ) : roots && roots.length === 0 ? (
            <div className="empty-workspace">
              <h1>Tu espacio está vacío</h1>
              <p>Crea una página para empezar.</p>
              <button
                type="button"
                className="primary-btn"
                onClick={async () => navigate(await createPage("space", WORKSPACE_ID))}
              >
                Nueva página
              </button>
            </div>
          ) : null}
        </main>
        {inboxPinned && (
          <aside className="inbox-dock" aria-label="Bandeja de entrada">
            <InboxPanel docked onClose={() => setInboxPinned(false)} />
          </aside>
        )}
      </div>
      {findOpen && <QuickFind onClose={() => setFindOpen(false)} />}
      <FindBar />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {shortcutsOpen && <KeyboardShortcuts onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
