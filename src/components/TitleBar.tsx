import { useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, House, PanelLeft, Plus, SquarePen, X } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { WORKSPACE_ID, isWorkspaceRoot, type Block, type ParentTable } from "../lib/model";
import { createPage, getAncestors } from "../lib/ops";
import { navigate, pageTitle, useBlock } from "../lib/hooks";
import { HOME_ROUTE } from "./HomeView";
import { copyLink, MenuItem, MenuSeparator, PageIcon, pointerAnchor, Popover, usePopover } from "./ui";
import logo from "../assets/brand/logo-red.svg";

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** The macOS app (Electron) draws its own title bar. */
export const DESKTOP = navigator.userAgent.includes("Electron");

/** The top level of the workspace the sidebar shows (it keeps that choice in localStorage). */
export async function workspaceParent(): Promise<[ParentTable, string]> {
  let ws = "";
  try {
    ws = JSON.parse(localStorage.getItem("xotion:workspace") ?? '""');
  } catch {
    /* storage unavailable */
  }
  if (!ws) {
    const roots = await db.blocks.where("[parent_table+parent_id]").equals(["space", WORKSPACE_ID]).toArray();
    ws = roots.find((b) => b.alive && isWorkspaceRoot(b.id))?.id ?? WORKSPACE_ID;
  }
  return isWorkspaceRoot(ws) ? ["block", ws] : ["space", WORKSPACE_ID];
}

/** New page in the workspace the sidebar shows. */
export async function newPageInWorkspace(init: Partial<Block> = {}) {
  const [table, parent] = await workspaceParent();
  navigate(await createPage(table, parent, init));
}

/**
 * A tab of the window: its own page route (the hash without "#") and its own
 * history: the routes ← and → go back and forward to.
 */
export type Tab = {
  id: string;
  route: string;
  back?: string[];
  forward?: string[];
  /** "Fijar pestaña": compact, at the start, kept by ⌘W and "Cerrar las demás pestañas". */
  pinned?: boolean;
  /** The page it was pinned on ("Volver a la URL fijada"). */
  pinnedRoute?: string;
};

/** A tab dragged between windows travels as this type (its route, history and id: the window it leaves drops that id). */
export const TAB_MIME = "application/x-xot-tab";

/** The page id in a tab's route ("/<id>?b=<block>"). */
export const routeId = (route: string) => route.replace(/^\/?/, "").split("?")[0] || null;

/**
 * The 36px tab bar: the traffic lights, sidebar toggle and new-page
 * button over the sidebar, then back/forward (the active tab's history), the window's tabs and "+".
 * The bar itself drags the window; its buttons opt out.
 */
export function TitleBar({
  tabs,
  active,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onDuplicateTab,
  onCloseOtherTabs,
  onCloseTabsRight,
  onReopenTab,
  canReopenTab,
  onMoveTab,
  onPinTab,
  onReturnToPinned,
  onReplacePinned,
  onMoveTabToWindow,
  onTabDropIn,
  onTabDragOut,
  previews,
  onCapture,
  onBack,
  onForward,
  sidebarOpen,
  onToggleSidebar,
  onPeekSidebar,
  onUnpeekSidebar,
}: {
  tabs: Tab[];
  active: number;
  onSelectTab: (index: number) => void;
  onCloseTab: (index: number) => void;
  onNewTab: () => void;
  onDuplicateTab: (index: number) => void;
  onCloseOtherTabs: (index: number) => void;
  onCloseTabsRight: (index: number) => void;
  onReopenTab: () => void;
  canReopenTab: boolean;
  /** Moves tab `from` to the gap before tab `before` (tabs.length: after the last). */
  onMoveTab: (from: number, before: number) => void;
  /** "Fijar pestaña" / "Desfijar pestaña". */
  onPinTab: (index: number, pinned: boolean) => void;
  onReturnToPinned: (index: number) => void;
  onReplacePinned: (index: number) => void;
  /** "Mover la pestaña a una nueva ventana" (undefined: the window's only tab). */
  onMoveTabToWindow?: (index: number) => void;
  /** A tab dragged in from another window, dropped before tab `before`. */
  onTabDropIn: (tab: Tab, before: number) => void;
  /** Tab `index` was dropped outside every window, at the screen point `at`: it moves to a new window. */
  onTabDragOut: (index: number, at: { x: number; y: number }) => void;
  /** Pictures of the tabs' pages (by tab id), for their hover previews. */
  previews: Record<string, string>;
  /** The pointer reached the tabs: the open tab's picture is taken now. */
  onCapture?: () => void;
  onBack: () => void;
  onForward: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onPeekSidebar?: () => void;
  onUnpeekSidebar?: () => void;
}) {
  const tab = tabs[active];
  // Dragging a tab: where it came from, and the gap it would drop into.
  const dragFrom = useRef<number | null>(null);
  // Whether the dragged tab landed in this window's bar (the drop runs before dragend).
  const droppedHere = useRef(false);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const gapAt = (e: DragEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(".titlebar__tab")];
    const i = items.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2;
    });
    return i === -1 ? items.length : i;
  };
  const endDrag = () => {
    dragFrom.current = null;
    setDropAt(null);
  };
  return (
    <header className="titlebar">
      <div className="titlebar__side">
        <button
          type="button"
          className="titlebar__btn"
          aria-label={sidebarOpen ? "Ocultar barra lateral" : "Mostrar barra lateral"}
          data-tooltip={sidebarOpen ? "Ocultar barra lateral" : "Mostrar barra lateral"}
          data-shortcut={`${mod}\\`}
          onClick={onToggleSidebar}
          onMouseEnter={sidebarOpen ? undefined : onPeekSidebar}
          onMouseLeave={sidebarOpen ? undefined : onUnpeekSidebar}
        >
          <PanelLeft size={20} />
        </button>
        {/* The brand sits in the tab bar so the sidebar starts right below it. */}
        <img className="titlebar__logo" src={logo} alt="Xot" />
        <button
          type="button"
          className="titlebar__btn titlebar__new"
          aria-label="Nueva página"
          data-tooltip="Nueva página"
          data-shortcut={`${mod}N`}
          onClick={() => void newPageInWorkspace()}
        >
          <SquarePen size={20} />
        </button>
      </div>
      <div className="titlebar__nav">
        <button
          type="button"
          className="titlebar__btn titlebar__btn--nav"
          aria-label="Atrás"
          data-tooltip="Atrás"
          data-shortcut={`${mod}[`}
          disabled={!tab?.back?.length}
          onClick={onBack}
        >
          <ChevronLeft size={20} />
        </button>
        <button
          type="button"
          className="titlebar__btn titlebar__btn--nav"
          aria-label="Adelante"
          data-tooltip="Adelante"
          data-shortcut={`${mod}]`}
          disabled={!tab?.forward?.length}
          onClick={onForward}
        >
          <ChevronRight size={20} />
        </button>
      </div>
      <div
        className="titlebar__tabs"
        role="tablist"
        onMouseEnter={onCapture}
        onDragOver={(e) => {
          // A tab of this window, or one dragged in from another Xot window.
          const foreign = dragFrom.current === null;
          if (foreign && !e.dataTransfer.types.includes(TAB_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const gap = gapAt(e);
          // Dropping a tab next to itself leaves it where it is: no line.
          const shown = !foreign && (gap === dragFrom.current || gap === dragFrom.current! + 1) ? null : gap;
          if (shown !== dropAt) setDropAt(shown);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
        }}
        onDrop={(e) => {
          const from = dragFrom.current;
          if (from === null) {
            setDropAt(null);
            let tab: Tab | null = null;
            try {
              tab = JSON.parse(e.dataTransfer.getData(TAB_MIME));
            } catch {
              /* not a tab */
            }
            if (!tab || typeof tab.route !== "string") return;
            e.preventDefault();
            onTabDropIn(tab, gapAt(e));
            return;
          }
          e.preventDefault();
          droppedHere.current = true;
          onMoveTab(from, gapAt(e));
          endDrag();
        }}
      >
        {tabs.map((tab, i) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={i === active}
            preview={i === active ? undefined : previews[tab.id]}
            dropEdge={dropAt === i ? "before" : dropAt === tabs.length && i === tabs.length - 1 ? "after" : null}
            onSelect={() => onSelectTab(i)}
            onClose={() => onCloseTab(i)}
            onDragStart={(e) => {
              dragFrom.current = i;
              droppedHere.current = false;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/xot-tab", tab.id);
              // Another window takes the tab with its history (tabs move between windows).
              e.dataTransfer.setData(TAB_MIME, JSON.stringify(tab));
            }}
            onDragEnd={(e) => {
              const here = droppedHere.current;
              endDrag();
              // Taken by another window: that one says so (App's "xot-tabs" channel). Dropped where
              // nothing takes it, outside the window: a new window.
              if (here || e.dataTransfer.dropEffect !== "none") return;
              const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
              if (outside) onTabDragOut(i, { x: e.screenX, y: e.screenY });
            }}
            menu={{
              onNew: onNewTab,
              onDuplicate: () => onDuplicateTab(i),
              onPin: () => onPinTab(i, !tab.pinned),
              onReturnToPinned: tab.pinned && tab.pinnedRoute !== undefined && tab.pinnedRoute !== tab.route ? () => onReturnToPinned(i) : undefined,
              onReplacePinned: tab.pinned && tab.pinnedRoute !== tab.route ? () => onReplacePinned(i) : undefined,
              onMoveToWindow: onMoveTabToWindow && tabs.length > 1 ? () => onMoveTabToWindow(i) : undefined,
              // Pinned tabs stay (closing other tabs or tabs to the right skips them).
              onCloseOthers: tabs.some((t, j) => j !== i && !t.pinned) ? () => onCloseOtherTabs(i) : undefined,
              onCloseRight: tabs.some((t, j) => j > i && !t.pinned) ? () => onCloseTabsRight(i) : undefined,
              onReopen: canReopenTab ? onReopenTab : undefined,
            }}
          />
        ))}
      </div>
      <button
        type="button"
        className="titlebar__btn titlebar__add"
        aria-label="Nueva pestaña"
        data-tooltip="Nueva pestaña"
        data-shortcut={`${mod}T`}
        onClick={onNewTab}
      >
        <Plus size={20} />
      </button>
    </header>
  );
}

/**
 * One of the window's tabs: up to 200px, the sidebar's background and the
 * secondary text color until it is the active one, and a close button on hover.
 * A page without an icon shows none, its title starts at the padding.
 * A pinned tab is 36px wide with the page's icon only, and no close button.
 */
function TabItem({
  tab,
  active,
  preview,
  dropEdge,
  onSelect,
  onClose,
  onDragStart,
  onDragEnd,
  menu: actions,
}: {
  tab: Tab;
  active: boolean;
  /** A picture of the tab's page, for the hover preview. */
  preview?: string;
  /** A dragged tab would land on this edge: a 2px accent line. */
  dropEdge: "before" | "after" | null;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: (e: DragEvent<HTMLDivElement>) => void;
  /** The right-click menu's actions; a missing one shows disabled (or hidden). */
  menu: {
    onNew: () => void;
    onDuplicate: () => void;
    onPin: () => void;
    onReturnToPinned?: () => void;
    onReplacePinned?: () => void;
    onMoveToWindow?: () => void;
    onCloseOthers?: () => void;
    onCloseRight?: () => void;
    onReopen?: () => void;
  };
}) {
  const menu = usePopover();
  const run = (action?: () => void) => () => {
    menu.close();
    action?.();
  };
  const { route, pinned } = tab;
  const id = routeId(route);
  const block = useBlock(id === HOME_ROUTE ? null : id);
  const title = id === HOME_ROUTE ? "Inicio" : block ? pageTitle(block) : block === null ? "Nueva pestaña" : "";
  // Hovering a tab that isn't the open one shows its preview.
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const leave = () => {
    window.clearTimeout(hoverTimer.current);
    setHover(false);
  };
  const previewing = hover && !active && !menu.anchor;
  // The menu sits beside the tab, not in it: React events bubble out of a portal,
  // and a click in the menu must not reach the tab's own handlers.
  return (
    <>
      <div
        ref={ref}
        className={`titlebar__tab${active ? " is-active" : ""}${pinned ? " is-pinned" : ""}${dropEdge ? ` is-drop-${dropEdge}` : ""}`}
        role="tab"
        aria-selected={active}
        aria-label={title || undefined}
        // The open tab keeps the plain tooltip; the others show their preview.
        data-tooltip={active && title ? title : undefined}
        draggable
        onDragStart={(e) => {
          leave();
          onDragStart(e);
        }}
        onDragEnd={onDragEnd}
        onMouseEnter={() => {
          window.clearTimeout(hoverTimer.current);
          hoverTimer.current = window.setTimeout(() => setHover(true), 400);
        }}
        onMouseLeave={leave}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          leave();
          onSelect();
        }}
        // A middle click closes the tab, as in a browser (a pinned one stays).
        onAuxClick={(e) => e.button === 1 && !pinned && onClose()}
        onContextMenu={(e) => {
          e.preventDefault();
          leave();
          menu.open(pointerAnchor(e));
        }}
      >
        {id === HOME_ROUTE ? (
          <House size={16} />
        ) : block?.format.icon ? (
          <PageIcon block={block} size={16} />
        ) : (
          pinned && <span className="titlebar__pin-letter">{(title || "·").trim().charAt(0).toUpperCase()}</span>
        )}
        {!pinned && <span className="titlebar__title">{title}</span>}
        {!pinned && (
          <button
            type="button"
            className="titlebar__close"
            aria-label="Cerrar pestaña"
            data-tooltip="Cerrar pestaña"
            data-shortcut={`${mod}W`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        )}
      </div>
      {previewing && ref.current && <TabPreview anchor={ref.current} pageId={id === HOME_ROUTE ? null : id} title={title} image={preview} />}
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} width={300}>
          <div className="menu">
            <MenuItem right={`${mod}T`} onClick={run(actions.onNew)}>
              Nueva pestaña
            </MenuItem>
            <MenuItem disabled={!block} onClick={run(() => block && void copyLink(block.id))}>
              Copiar enlace
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={run(actions.onDuplicate)}>Duplicar pestaña</MenuItem>
            <MenuItem onClick={run(actions.onPin)}>{pinned ? "Desfijar pestaña" : "Fijar pestaña"}</MenuItem>
            {actions.onReturnToPinned && <MenuItem onClick={run(actions.onReturnToPinned)}>Volver a la URL fijada</MenuItem>}
            {actions.onReplacePinned && (
              <MenuItem onClick={run(actions.onReplacePinned)}>Reemplazar la URL fijada por la actual</MenuItem>
            )}
            <MenuItem disabled={!actions.onMoveToWindow} onClick={run(actions.onMoveToWindow)}>
              Mover la pestaña a una nueva ventana
            </MenuItem>
            <MenuItem right={`${mod}⇧T`} disabled={!actions.onReopen} onClick={run(actions.onReopen)}>
              Reabrir la última pestaña cerrada
            </MenuItem>
            <MenuSeparator />
            <MenuItem right={pinned ? undefined : `${mod}W`} onClick={run(onClose)}>
              Cerrar pestaña
            </MenuItem>
            <MenuItem disabled={!actions.onCloseOthers} onClick={run(actions.onCloseOthers)}>
              Cerrar las demás pestañas
            </MenuItem>
            <MenuItem disabled={!actions.onCloseRight} onClick={run(actions.onCloseRight)}>
              Cerrar pestañas a la derecha
            </MenuItem>
          </div>
        </Popover>
      )}
    </>
  );
}

/** The page path above a tab's preview: its parents' titles. */
function usePagePath(id: string | null) {
  return useLiveQuery(async () => {
    const block = id ? await db.blocks.get(id) : undefined;
    if (!block) return "";
    const chain = await getAncestors(block);
    return chain
      .filter((b) => !isWorkspaceRoot(b.id))
      .map(pageTitle)
      .join(" / ");
  }, [id]);
}

/**
 * The tab preview: a card under a hovered tab with its page's path, title and a
 * picture of the page as it was last shown (the macOS app takes it; elsewhere, no picture).
 */
function TabPreview({ anchor, pageId, title, image }: { anchor: HTMLElement; pageId: string | null; title: string; image?: string }) {
  const block = useBlock(pageId);
  const path = usePagePath(pageId);
  const r = anchor.getBoundingClientRect();
  const width = 260;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  return createPortal(
    <div className="tab-preview" role="tooltip" style={{ left, top: r.bottom + 6, width }}>
      {path && <div className="tab-preview__path">{path}</div>}
      <div className="tab-preview__title">
        {pageId === null ? <House size={16} /> : block?.format.icon && <PageIcon block={block} size={16} />}
        <span>{title || "Nueva pestaña"}</span>
      </div>
      {image && <img className="tab-preview__image" src={image} alt="" />}
    </div>,
    document.body,
  );
}
