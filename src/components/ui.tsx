import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { FileText, Sheet, Shuffle } from "lucide-react";
import type { EmojiMartData } from "@emoji-mart/data";
import type { Block } from "../lib/model";
import { trashBlock, undoLast } from "../lib/ops";
import { IconsTab } from "./IconsTab";
import { useCustomEmojis } from "../lib/customEmoji";

// Popovers stack: only the topmost reacts to Escape, and a click inside a
// popover opened later (a submenu) doesn't dismiss the ones beneath it.
const stack: HTMLElement[] = [];
export const hasOpenPopover = () => stack.length > 0;

export function Popover({
  anchor,
  onClose,
  children,
  width,
  align = "start",
  placement = "below",
  className = "",
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  align?: "start" | "end";
  /** "cover": opens over the anchor (cell editors), at least as wide as it.
   *  "flyout": a full-height panel against the right edge of the anchor's sidebar (the inbox). */
  placement?: "below" | "cover" | "flyout";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width?: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      // The untransformed size: the opening animation scales the box (0.96), and
      // measuring it mid-animation would place it off by that much.
      const pw = el.offsetWidth;
      const ph = el.offsetHeight;
      if (placement === "flyout") {
        // Top and bottom come from the stylesheet; it only follows the sidebar's edge.
        const edge = (anchor.closest(".sidebar") ?? anchor).getBoundingClientRect().right;
        setPos({ top: 0, left: Math.max(0, Math.min(edge, window.innerWidth - pw)) });
        return;
      }
      if (placement === "cover") {
        const w = Math.max(a.width, width ?? 240);
        const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
        let top = a.top;
        // Flips up (bottom edges aligned) only when it would leave the window.
        if (top + ph > window.innerHeight - 8) top = Math.max(8, a.bottom - ph);
        setPos({ top, left, width: w });
        return;
      }
      // Menus grow up to 70vh (or the cap their own class sets) and
      // never past the room left on the side they open to.
      el.style.maxHeight = "";
      const cap = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
      const natural = Math.min(el.scrollHeight, cap);
      const below = window.innerHeight - (a.bottom + 4) - 8;
      const above = a.top - 4 - 8;
      const flipUp = natural > below && above > below;
      const height = Math.min(natural, Math.max(160, flipUp ? above : below));
      if (height < natural) el.style.maxHeight = `${height}px`;
      let left = align === "end" ? a.right - pw : a.left;
      left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
      const top = flipUp ? Math.max(8, a.top - height - 4) : a.bottom + 4;
      setPos({ top, left });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, align, placement, width]);

  useEffect(() => {
    const el = ref.current!;
    stack.push(el);
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const index = stack.indexOf(el);
      if (stack.slice(index).some((p) => p.contains(target))) return;
      if (anchor?.contains(target)) return;
      closeRef.current();
    };

    // Keyboard navigation: ↑/↓ move a highlight over the
    // items, Enter runs the highlighted one. Typing in the menu's search keeps
    // the first match highlighted.
    let active = -1;
    const items = () => [...el.querySelectorAll<HTMLElement>(".menu-item:not(:disabled)")];
    const highlight = (i: number) => {
      const list = items();
      active = list.length ? Math.max(-1, Math.min(i, list.length - 1)) : -1;
      list.forEach((item, n) => item.classList.toggle("is-kbd", n === active));
      list[active]?.scrollIntoView({ block: "nearest" });
    };
    // The search text the highlight was last reset for.
    let lastQuery = "";
    const observer = new MutationObserver(() => {
      const focus = document.activeElement;
      const query = focus instanceof HTMLInputElement && focus.matches(".menu-search") && el.contains(focus) ? focus.value.trim() : "";
      // A new filter starts again at its first result; otherwise the highlight stays put.
      if (query !== lastQuery) highlight(query ? 0 : -1);
      else highlight(active);
      lastQuery = query;
    });
    observer.observe(el, { childList: true, subtree: true });
    const onPointer = (e: PointerEvent) => {
      const item = (e.target as HTMLElement).closest?.(".menu-item");
      if (active >= 0 && item && !item.classList.contains("is-kbd")) highlight(-1);
    };
    el.addEventListener("pointermove", onPointer);

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== el) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      // Other fields keep their own keys (Enter in a rename box, arrows in a textarea).
      const field = target.matches?.("input, textarea, select, [contenteditable='true']");
      if (field && !target.matches(".menu-search") && active < 0) return;
      if (e.key === "Enter") {
        const item = items()[active];
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        item.click();
        return;
      }
      const list = items();
      if (!list.length) return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === "ArrowDown" ? 1 : -1;
      highlight(active < 0 ? (step > 0 ? 0 : list.length - 1) : (active + step + list.length) % list.length);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      stack.splice(stack.indexOf(el), 1);
      observer.disconnect();
      el.removeEventListener("pointermove", onPointer);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className={`popover${placement === "flyout" ? " popover--flyout" : ""} ${className}`}
      style={{
        top: placement === "flyout" ? undefined : (pos?.top ?? -9999),
        left: pos?.left ?? -9999,
        width: pos?.width ?? width,
        // Placed before the first paint (layout effect), so it is never seen at -9999;
        // staying visible lets autoFocus fields inside it take the focus.
        transformOrigin: align === "end" ? "top right" : "top left",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * An anchor at the pointer, for menus opened with a right-click (they open
 * where you click). One hidden element, moved on each use.
 */
export function pointerAnchor(e: { clientX: number; clientY: number }): HTMLElement {
  let el = document.getElementById("xot-pointer-anchor");
  if (!el) {
    el = document.createElement("div");
    el.id = "xot-pointer-anchor";
    el.style.cssText = "position:fixed;width:0;height:0;pointer-events:none";
    document.body.append(el);
  }
  el.style.left = `${e.clientX}px`;
  el.style.top = `${e.clientY}px`;
  return el;
}

/** Anchor + open state for a popover triggered by a button. */
export function usePopover() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return {
    anchor,
    open: (el: HTMLElement) => setAnchor(el),
    toggle: (el: HTMLElement) => setAnchor((a) => (a ? null : el)),
    close: () => setAnchor(null),
  };
}

export function MenuItem({
  icon,
  children,
  right,
  danger,
  active,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  right?: ReactNode;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`menu-item${danger ? " menu-item--danger" : ""}${active ? " is-active" : ""} ${className}`}
      {...rest}
    >
      {icon && <span className="menu-item__icon">{icon}</span>}
      <span className="menu-item__label">{children}</span>
      {right && <span className="menu-item__right">{right}</span>}
    </button>
  );
}

/** A centered dialog over the dimmed app (Exportar, Historial de versiones, Configuración). Esc closes it. */
/** Open dialogs, innermost last. */
const openModals: object[] = [];

export function Modal({
  onClose,
  children,
  className = "",
  label,
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // A dialog opened from another (Configuración > Exportar) takes Esc first.
    const token = {};
    openModals.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || hasOpenPopover() || openModals[openModals.length - 1] !== token) return;
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      openModals.splice(openModals.indexOf(token), 1);
    };
  }, []);
  return createPortal(
    <div className="xot-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`xot-modal ${className}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** The small on/off switch, shown on the right of menu items. */
export const Switch = ({ on }: { on: boolean }) => (
  <span className={`switch${on ? " is-on" : ""}`} aria-hidden>
    <span className="switch__knob" />
  </span>
);

/** A short confirmation at the bottom of the window ("Enlace copiado…"), optionally with an action. */
export function toast(message: string, action?: { label: string; run: () => void }) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast__action";
    btn.textContent = action.label;
    btn.onclick = () => {
      el.remove();
      action.run();
    };
    el.append(btn);
  }
  document.body.append(el);
  const life = action ? 5000 : 2200;
  setTimeout(() => el.classList.add("is-leaving"), life);
  setTimeout(() => el.remove(), life + 300);
}

/** Trashes a page and offers to undo it ("Moved to trash · Undo"). */
export async function trashWithUndo(id: string) {
  await trashBlock(id);
  toast("Página movida a la papelera", { label: "Deshacer", run: () => void undoLast() });
}

/**
 * The centred confirmation: a short question over "Continuar"/"Cancelar",
 * or, for destructive actions, a red full-width button stacked above "Cancelar".
 * Enter confirms, Esc cancels; menus open beneath it stay open.
 */
export function ConfirmDialog({
  text,
  confirm = "Continuar",
  cancel = "Cancelar",
  danger = false,
  onDone,
}: {
  text: ReactNode;
  confirm?: string;
  cancel?: string;
  danger?: boolean;
  onDone: (ok: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const el = ref.current!;
    // On the popover stack: clicks in it don't dismiss the menu it was opened from,
    // and that menu's Esc/Enter handling waits until it closes.
    stack.push(el);
    const key = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== el) return;
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      doneRef.current(e.key === "Enter");
    };
    window.addEventListener("keydown", key, true);
    return () => {
      stack.splice(stack.indexOf(el), 1);
      window.removeEventListener("keydown", key, true);
    };
  }, []);
  return createPortal(
    <div ref={ref} className="modal-backdrop modal-backdrop--confirm" onMouseDown={() => onDone(false)}>
      <div
        className={`modal${danger ? " modal--danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal__text">{text}</div>
        <div className="modal__actions">
          {danger ? (
            <>
              <button type="button" className="danger-btn" onClick={() => onDone(true)} autoFocus>
                {confirm}
              </button>
              <button type="button" className="xot-btn" onClick={() => onDone(false)}>
                {cancel}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ghost-btn" onClick={() => onDone(false)}>
                {cancel}
              </button>
              <button type="button" className="primary-btn" onClick={() => onDone(true)} autoFocus>
                {confirm}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Opens a ConfirmDialog from anywhere and resolves with the answer. */
export function confirmDialog(options: { text: ReactNode; confirm?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      // Unmounting inside the click that answered it would cut React's own event short.
      queueMicrotask(() => {
        root.unmount();
        host.remove();
      });
      resolve(ok);
    };
    root.render(<ConfirmDialog {...options} onDone={done} />);
  });
}

/** Asks before deleting for good. */
export function confirmPurge() {
  return confirmDialog({
    text: "¿Seguro que quieres eliminar esta página de forma permanente?",
    confirm: "Sí. Eliminar esta página",
    danger: true,
  });
}

export async function copyLink(id: string) {
  // The macOS app's links open from other apps (Slack, Mail, a browser) through the xot:// scheme.
  const url = navigator.userAgent.includes("Electron") ? `xot://${id}` : `${location.origin}${location.pathname}#/${id}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Enlace copiado al portapapeles");
  } catch {
    toast("No se pudo copiar el enlace");
  }
}

/**
 * Dark tooltips: any element with data-tooltip (and optionally
 * data-shortcut) shows one after a short hover. Installed once for the app.
 */
let tooltipsInstalled = false;
export function installTooltips() {
  if (tooltipsInstalled) return;
  tooltipsInstalled = true;
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.setAttribute("role", "tooltip");
  let target: HTMLElement | null = null;
  let timer: number | undefined;

  const hide = () => {
    window.clearTimeout(timer);
    target = null;
    tip.remove();
  };
  const show = (el: HTMLElement) => {
    if (!el.isConnected || !el.dataset.tooltip) return;
    // "\n" breaks lines; "**word**" is the bright action word, the rest dimmer (two-tone tips).
    const text = el.dataset.tooltip;
    tip.textContent = "";
    tip.classList.toggle("tooltip--rich", text.includes("**"));
    text.split("\n").forEach((line, i) => {
      if (i) tip.append(document.createElement("br"));
      line.split("**").forEach((part, j) => {
        if (j % 2 === 0) {
          if (part) tip.append(part);
          return;
        }
        const em = document.createElement("span");
        em.className = "tooltip__em";
        em.textContent = part;
        tip.append(em);
      });
    });
    if (el.dataset.shortcut) {
      const kbd = document.createElement("span");
      kbd.className = "tooltip__kbd";
      kbd.textContent = el.dataset.shortcut;
      tip.append(kbd);
    }
    document.body.append(tip);
    const a = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let top = a.bottom + 6;
    if (top + t.height > window.innerHeight - 4) top = a.top - t.height - 6;
    const left = Math.max(4, Math.min(a.left + a.width / 2 - t.width / 2, window.innerWidth - t.width - 4));
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  };

  document.addEventListener("pointerover", (e) => {
    const el = (e.target as Element).closest?.<HTMLElement>("[data-tooltip]") ?? null;
    if (el === target) return;
    hide();
    if (!el || e.pointerType === "touch") return;
    target = el;
    timer = window.setTimeout(() => target === el && show(el), 400);
  });
  document.addEventListener("pointerout", (e) => {
    if (target && !target.contains(e.relatedTarget as Node | null)) hide();
  });
  document.addEventListener("mousedown", hide, true);
  document.addEventListener("keydown", hide, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
}

export const MenuSeparator = () => <div className="menu-separator" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <div className="menu-label">{children}</div>
);

/** Image icons: URLs and local files ("/…"); anything else is an emoji. */
export function iconUrl(icon: string) {
  if (/^https?:\/\//.test(icon) || icon.startsWith("data:image/")) return icon;
  if (icon.startsWith("/")) return icon;
  return null;
}

/** A glyph icon ("…/icons/name_color.svg"): drawn at the emoji's size, not as a picture. */
export const isGlyphIcon = (icon: string) => /\/icons\/[\w-]+\.svg$/.test(icon.split(/[?#]/)[0]);

export function PageIcon({
  block,
  size = 18,
  fallback,
}: {
  block: Block | null | undefined;
  size?: number;
  /** Shown instead of the page glyph when the icon's picture can't load (offline, a dead link). */
  fallback?: ReactNode;
}) {
  const url = block?.format.icon ? iconUrl(block.format.icon) : null;
  const [broken, setBroken] = useState<string | null>(null);
  if (url && broken !== url)
    return (
      <span className="page-icon" style={{ width: size, height: size }}>
        {/* Menu-sized icons load at once: a lazy one leaves a blank slot as a menu opens. */}
        <img src={url} alt="" width={size} height={size} loading={size > 20 ? "lazy" : "eager"} onError={() => setBroken(url)} />
      </span>
    );
  if (url && fallback) return <>{fallback}</>;
  if (block?.format.icon && !url)
    return (
      <span className="page-icon page-icon--emoji" style={{ fontSize: size * 0.95, width: size, height: size }}>
        {block.format.icon}
      </span>
    );
  const Icon = block?.type === "collection_view_page" ? Sheet : FileText;
  return (
    <span className="page-icon" style={{ width: size, height: size }}>
      <Icon size={size * 0.9} strokeWidth={1.7} />
    </span>
  );
}

// Shown before the full set loads (and as the "Aleatorio" pool until then).
const EMOJIS =
  "📄 📝 📌 📎 📚 📖 📒 📓 🗂️ 🗃️ 📊 📈 📉 🗓️ 📅 ⏰ ✅ ☑️ 🎯 🚀 💡 🔥 ⭐ ✨ 💎 🏆 🎉 🎨 🎬 🎵 🎮 🧩 🧠 💼 🏢 🏠 🌍 🌱 🌸 🍀 ☀️ 🌙 ⚡ 🌈 ❄️ 🍎 ☕ 🍕 🧪 🔬 🛠️ ⚙️ 🔧 🔒 🔑 💬 📣 📬 💰 💳 🛒 🎁 ✈️ 🚗 🏃 🧘 ❤️ 💙 💚 💛 💜 🖤 👋 👍 🙌 👀 🤝 🐱 🐶 🦊 🐼 🦄"
    .split(" ");

/** The category names in Spanish, in order (emoji-mart ids). */
const EMOJI_CATEGORIES: Record<string, string> = {
  people: "Personas",
  nature: "Animales y naturaleza",
  foods: "Comida y bebida",
  activity: "Actividades",
  places: "Viajes y lugares",
  objects: "Objetos",
  symbols: "Símbolos",
  flags: "Banderas",
};
const SKIN_TONES = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];
const RECENT_KEY = "xotion:recent-emojis";

// The full emoji set ships with BlockNote's dependencies; loaded on first use.
let emojiData: EmojiMartData | null = null;
let emojiLoad: Promise<EmojiMartData> | null = null;
export const loadEmojis = () =>
  (emojiLoad ??= import("@emoji-mart/data").then((m) => {
    emojiData = (m as unknown as { default: EmojiMartData }).default;
    return emojiData;
  }));

/** Any emoji at random, for "Agregar icono" and "Aleatorio". */
export function randomEmoji() {
  if (!emojiData) {
    void loadEmojis();
    return EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  }
  const ids = emojiData.categories.filter((c) => c.id !== "flags").flatMap((c) => c.emojis);
  return emojiData.emojis[ids[Math.floor(Math.random() * ids.length)]].skins[0].native;
}

function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((e) => typeof e === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

function rememberEmoji(emoji: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, 12)));
  } catch {
    /* storage unavailable */
  }
}

/** Uploaded icons are stored inline, scaled down to 280px. */
function fileToIcon(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const src = String(reader.result);
      if (file.type === "image/gif" || file.type === "image/svg+xml") return resolve(src);
      const img = new Image();
      img.onerror = () => resolve(src);
      img.onload = () => {
        const scale = Math.min(1, 280 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

/** The icon popover: Emoji (search, random, skin tone, categories), Iconos (colored outlines) and Subir. */
export function EmojiPicker({
  onPick,
  onRemove,
  emojiOnly,
}: {
  onPick: (emoji: string) => void;
  onRemove?: () => void;
  /** Reactions: emoji only, without the Iconos and Subir tabs. */
  emojiOnly?: boolean;
}) {
  const [tab, setTab] = useState<"emoji" | "icons" | "upload">("emoji");
  const [data, setData] = useState(emojiData);
  const [query, setQuery] = useState("");
  const [skin, setSkin] = useState(() => {
    try {
      return Math.min(5, Math.max(0, Number(localStorage.getItem("xotion:emoji-skin")) || 0));
    } catch {
      return 0;
    }
  });
  const [recent] = useState(readRecent);
  const fileRef = useRef<HTMLInputElement>(null);
  // The workspace's custom emoji (Configuración > Emoji), as pictures.
  const custom = useCustomEmojis();

  useEffect(() => {
    if (!data) void loadEmojis().then(setData);
  }, [data]);

  const pick = (emoji: string) => {
    if (!emoji.startsWith("data:")) rememberEmoji(emoji);
    onPick(emoji);
  };
  const native = (e: EmojiMartData["emojis"][string]) => (e.skins[skin] ?? e.skins[0]).native;
  const q = query.trim().toLowerCase();
  const sections: { id: string; label: string; emojis: string[] }[] = [];
  const own = custom.filter((c) => !q || c.name.includes(q));
  if (own.length && !emojiOnly) sections.push({ id: "custom", label: "Personalizados", emojis: own.map((c) => c.src) });
  if (data) {
    if (q) {
      const found = Object.values(data.emojis)
        // Word starts: "cat" finds 🐱 but not "education".
        .filter((e) =>
          [e.id, e.name.toLowerCase(), ...e.name.toLowerCase().split(/[\s_-]+/), ...e.keywords].some((word) => word.startsWith(q)),
        )
        .map(native);
      sections.push({ id: "search", label: "Resultados", emojis: found });
    } else {
      if (recent.length) sections.push({ id: "recent", label: "Recientes", emojis: recent });
      for (const c of data.categories)
        sections.push({
          id: c.id,
          label: EMOJI_CATEGORIES[c.id] ?? c.id,
          emojis: c.emojis.map((id) => native(data.emojis[id])),
        });
    }
  } else sections.push({ id: "basic", label: "Emoji", emojis: EMOJIS });

  return (
    <div className="emoji-picker">
      <div className="emoji-picker__tabs">
        <button
          type="button"
          className={`emoji-picker__tab${tab === "emoji" ? " is-active" : ""}`}
          onClick={() => setTab("emoji")}
        >
          Emoji
        </button>
        {!emojiOnly && (
          <>
            <button
              type="button"
              className={`emoji-picker__tab${tab === "icons" ? " is-active" : ""}`}
              onClick={() => setTab("icons")}
            >
              Iconos
            </button>
            <button
              type="button"
              className={`emoji-picker__tab${tab === "upload" ? " is-active" : ""}`}
              onClick={() => setTab("upload")}
            >
              Subir
            </button>
          </>
        )}
        {onRemove && (
          <button type="button" className="emoji-picker__remove" onClick={onRemove}>
            Quitar
          </button>
        )}
      </div>
      {tab === "emoji" ? (
        <>
          <div className="emoji-picker__bar">
            <input
              className="menu-search emoji-picker__search"
              placeholder="Filtrar…"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="emoji-picker__tool"
              aria-label="Aleatorio"
              data-tooltip="Aleatorio"
              onClick={() => pick(randomEmoji())}
            >
              <Shuffle size={16} />
            </button>
            <button
              type="button"
              className="emoji-picker__tool emoji-picker__skin"
              aria-label="Tono de piel"
              data-tooltip="Tono de piel"
              onClick={() => {
                const next = (skin + 1) % SKIN_TONES.length;
                setSkin(next);
                try {
                  localStorage.setItem("xotion:emoji-skin", String(next));
                } catch {
                  /* storage unavailable */
                }
              }}
            >
              {SKIN_TONES[skin]}
            </button>
          </div>
          <div className="emoji-picker__body">
            {sections.map((section) => (
              <section key={section.id} className="emoji-picker__section">
                <div className="emoji-picker__label">{section.label}</div>
                {section.emojis.length ? (
                  <div className="emoji-picker__grid">
                    {section.emojis.map((e, i) => (
                      <button type="button" key={`${e}-${i}`} className="emoji-picker__item" onClick={() => pick(e)}>
                        {e.startsWith("data:") ? <img src={e} alt="" /> : e}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="emoji-picker__empty">Sin resultados</div>
                )}
              </section>
            ))}
          </div>
        </>
      ) : tab === "icons" ? (
        <IconsTab onPick={onPick} />
      ) : (
        <div className="emoji-picker__upload">
          <button type="button" className="emoji-picker__upload-btn" onClick={() => fileRef.current?.click()}>
            Subir un archivo
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                onPick(await fileToIcon(file));
              } catch {
                toast("No se pudo leer la imagen");
              }
            }}
          />
          <p className="emoji-picker__note">Tamaño recomendado: 280 × 280 píxeles</p>
        </div>
      )}
    </div>
  );
}
