import { useEffect, useState } from "react";

// The macOS app's bridge (electron/preload.cjs) for its own preferences and windows.

/** Preferencias > App de escritorio, kept by the app (they work with every window closed). */
export interface DesktopPrefs {
  /** "Usar Atajo de búsqueda": the system-wide shortcut and the menu bar icon. */
  commandSearch: boolean;
  /** An Electron accelerator ("Alt+CommandOrControl+K"). */
  searchShortcut: string;
  /** "Mostrar Xot en la barra de menú". */
  menuBarIcon: boolean;
  /** "Abrir Xot al iniciar sesión". */
  openAtLogin: boolean;
  /** False when another app holds the shortcut. */
  shortcutActive: boolean;
  /** Set by setPrefs when a shortcut can't be used: no modifier, or another app's. */
  error?: "modifier" | "in-use";
}

export interface MovedTab {
  route: string;
  back?: string[];
  forward?: string[];
  pinned?: boolean;
  pinnedRoute?: string;
}

interface DesktopBridge {
  getPrefs?(): Promise<DesktopPrefs>;
  setPrefs?(patch: Partial<DesktopPrefs>): Promise<DesktopPrefs>;
  onPrefs?(cb: (prefs: DesktopPrefs) => void): () => void;
  onSearchShown?(cb: () => void): void;
  hideSearch?(): void;
  openRoute?(route: string, newTab?: boolean): void;
  setBadge?(count: number): void;
  moveTabToWindow?(tab: MovedTab, at?: { x: number; y: number }): void;
  capturePage?(): Promise<string | null>;
  setTimeZone?(tz: string): void;
}

export const desktop = () => (window as { xotDesktop?: DesktopBridge }).xotDesktop;

/** The app's preferences, kept current (null outside the macOS app, or until they arrive). */
export function useDesktopPrefs(): [DesktopPrefs | null, (patch: Partial<DesktopPrefs>) => Promise<DesktopPrefs | null>] {
  const [prefs, setPrefs] = useState<DesktopPrefs | null>(null);
  useEffect(() => {
    const app = desktop();
    if (!app?.getPrefs) return;
    let live = true;
    void app.getPrefs().then((p) => live && p && setPrefs(p));
    const off = app.onPrefs?.((p) => setPrefs(p));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  const update = async (patch: Partial<DesktopPrefs>) => {
    const next = (await desktop()?.setPrefs?.(patch)) ?? null;
    if (next) setPrefs(next);
    return next;
  };
  return [prefs, update];
}

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** "⌥⌘K" for "Alt+CommandOrControl+K", as macOS menus write shortcuts. */
export function shortcutLabel(accelerator: string) {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  const symbols: [RegExp, string, string][] = [
    [/^(Control|Ctrl)$/i, "⌃", "Ctrl+"],
    [/^(Alt|Option)$/i, "⌥", "Alt+"],
    [/^Shift$/i, "⇧", "Shift+"],
    [/^(Command|Cmd|CommandOrControl|CmdOrCtrl|Super|Meta)$/i, "⌘", "Ctrl+"],
  ];
  const mods = symbols.filter(([re]) => parts.some((p) => re.test(p))).map(([, mac, other]) => (MAC ? mac : other));
  const name = { Space: "Espacio", Return: "↩", Enter: "↩", Escape: "Esc", Up: "↑", Down: "↓", Left: "←", Right: "→" }[key] ?? key;
  return `${mods.join("")}${name}`;
}

/** The accelerator for a key press in the shortcut field ("" while only modifiers are down). */
export function acceleratorFor(e: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) {
  if (["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"].includes(e.key)) return "";
  // The physical key: Option changes the character it types ("K" while ⌥ gives "˚").
  let key = "";
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else
    key =
      {
        Space: "Space",
        Enter: "Return",
        Escape: "Escape",
        ArrowUp: "Up",
        ArrowDown: "Down",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        Slash: "/",
        Period: ".",
        Comma: ",",
        Semicolon: ";",
        Minus: "-",
        Equal: "=",
        BracketLeft: "[",
        BracketRight: "]",
        Backquote: "`",
        Quote: "'",
        Backslash: "\\",
      }[e.code] ?? "";
  if (!key) return "";
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "CommandOrControl"].filter(Boolean);
  return [...mods, key].join("+");
}
