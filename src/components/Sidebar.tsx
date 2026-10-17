import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleCheck,
  CopyPlus,
  CornerUpRight,
  EyeOff,
  Ellipsis,
  FileUp,
  House,
  Inbox,
  Link,
  PanelLeft,
  PenLine,
  Plus,
  RotateCcw,
  Search,
  LayoutTemplate,
  Settings,
  Sheet,
  SquarePen,
  Star,
  StarOff,
  SquareArrowOutUpRight,
  Trash,
  X,
} from "lucide-react";
import { db } from "../lib/db";
import { WORKSPACE_ID, isWorkspaceRoot, type Block, type ParentTable } from "../lib/model";
import {
  addRow,
  archivePage,
  createDatabase,
  createPage,
  duplicateDatabase,
  duplicatePage,
  getAncestors,
  insertPageLink,
  isArchived,
  movePage,
  purgeBlock,
  restoreBlock,
  setIcon,
  setTitle,
  TRASH_DAYS,
} from "../lib/ops";
import {
  navigate,
  openInNewTab,
  pageLinkProps,
  pageTitle,
  placeFavorite,
  toggleFavorite,
  useBlock,
  useChildren,
  useFavorites,
  useRecentPages,
  useStoredState,
} from "../lib/hooks";
import {
  LIMIT_CHOICES,
  moveSection,
  sectionLimit,
  setHidden,
  updateSidebarPrefs,
  useSidebarPrefs,
  SECTION_LABELS,
  type SectionId,
  type Shortcut,
} from "../lib/sidebar";
import {
  confirmDialog,
  confirmPurge,
  copyLink,
  EmojiPicker,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  PageIcon,
  pointerAnchor,
  Popover,
  toast,
  trashWithUndo,
  usePopover,
} from "./ui";
import { PagePicker } from "./PagePicker";
import { SidebarCustomizer, SidebarTabs } from "./SidebarCustomizer";
import { MovePicker } from "./MovePicker";
import { InboxPanel } from "./Inbox";
import { useUnreadCount } from "../lib/inbox";
import { LOCAL_WORKSPACE_EVENT, LOCAL_WORKSPACE_KEY, WORKSPACE_EVENT } from "../lib/workspace";
import { viewIcon } from "./database/DatabaseView";
import { HOME_ROUTE } from "./HomeView";
import { ImportDialog } from "./ImportDialog";
import { TemplateGallery } from "./TemplateGallery";
import { DESKTOP } from "./TitleBar";
import logo from "../assets/brand/logo-red.svg";

/**
 * Imported workspaces arrive as root blocks; pages created in
 * Xot before any import live directly in the local space. Each one is a
 * workspace in the switcher, and only its pages show in the tree. "Nuevo
 * espacio de trabajo" adds another root block the same way.
 */
interface Workspace {
  id: string;
  name: string;
  /** null for Xot's own local space. */
  block: Block | null;
  /** The local space's icon (the others keep theirs on their block). */
  icon?: string;
}

/** The local space's name and icon, which have no block to live on. */
const LOCAL_KEY = LOCAL_WORKSPACE_KEY;

/** Rows Recientes keeps at most. */
const RECENT_ALL = 20;

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";
const fullDate = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });

/** The page being dragged in the sidebar (dataTransfer can't be read during dragover). */
let draggingId: string | null = null;

/** PageIcon for an icon that has no block (the local space's). */
const iconOnly = (icon: string) => ({ type: "page", format: { icon }, properties: {} }) as unknown as Block;

/** Where a workspace keeps its top-level pages. */
const treeParent = (ws: Workspace): [ParentTable, string] => (ws.block ? ["block", ws.id] : ["space", WORKSPACE_ID]);

function WorkspaceAvatar({ ws }: { ws: Workspace }) {
  // A picture that can't load (offline, a dead link) falls back to the initial.
  const letter = <span className="ws-avatar ws-avatar--letter">{ws.name.trim().charAt(0).toUpperCase() || "X"}</span>;
  if (ws.block?.format.icon)
    return (
      <span className="ws-avatar">
        <PageIcon block={ws.block} size={20} fallback={letter} />
      </span>
    );
  if (ws.icon)
    return (
      <span className="ws-avatar">
        <PageIcon block={iconOnly(ws.icon)} size={20} fallback={letter} />
      </span>
    );
  return letter;
}

/** Preferencias… (⌘,) and "Configuración" open the settings dialog (App.tsx shows it). */
export const PREFERENCES_EVENT = "xot:preferences";
export function openPreferences() {
  window.dispatchEvent(new Event(PREFERENCES_EVENT));
}

/** ⌘⇧R: the open page's row in Privado answers with its "Cambiar nombre" popover. */
export const RENAME_EVENT = "xot:rename";

/** "Bandeja de entrada" pinned beside the page (App.tsx docks it). */
export const INBOX_PIN_EVENT = "xot:inbox-pin";

export function Sidebar({
  activeId,
  onCollapse,
  onSearch,
  onResize,
  peek = false,
  onPin,
}: {
  activeId: string | null;
  onCollapse: () => void;
  onSearch: () => void;
  /** Dragging the right edge sets the width; without it (the hover peek) the edge is fixed. */
  onResize?: (width: number) => void;
  /** The floating sidebar: its top button docks it again ("Mantener abierta"). */
  peek?: boolean;
  onPin?: () => void;
}) {
  const active = useBlock(activeId);
  const ancestors = useLiveQuery(
    async () => (active ? (await getAncestors(active)).map((b) => b.id) : []),
    [active?.id, active?.parent_id],
  );
  const roots = useChildren("space", WORKSPACE_ID);
  const favorites = useFavorites();
  const prefs = useSidebarPrefs();
  const [storedWs, setStoredWs] = useStoredState("xotion:workspace", "");
  // After useStoredState has written it: Inicio and the inbox follow the switch.
  useEffect(() => {
    window.dispatchEvent(new Event(WORKSPACE_EVENT));
  }, [storedWs]);
  const [local, setLocal] = useStoredState<{ name?: string; icon?: string }>(LOCAL_KEY, {});
  // Configuración › General renames the local space too.
  useEffect(() => {
    const reload = () => {
      try {
        setLocal(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}"));
      } catch {
        /* storage unavailable */
      }
    };
    window.addEventListener(LOCAL_WORKSPACE_EVENT, reload);
    return () => window.removeEventListener(LOCAL_WORKSPACE_EVENT, reload);
  }, [setLocal]);
  const switcher = usePopover();
  const switcherBtn = useRef<HTMLButtonElement>(null);
  const wsRename = usePopover();
  const trashPop = usePopover();
  const [trashOver, setTrashOver] = useState(false);
  const sectionMenu = usePopover();
  const [menuSection, setMenuSection] = useState<SectionId>("private");
  const morePanel = usePopover();
  const [moreSection, setMoreSection] = useState<SectionId>("private");
  const [customizing, setCustomizing] = useState(false);
  // "Bandeja de entrada": fired reminders, with the unread count beside it.
  const inbox = usePopover();
  const unread = useUnreadCount();
  const [importing, setImporting] = useState(false);
  // "Plantillas": the local template gallery.
  const [gallery, setGallery] = useState(false);
  const [favOpen, setFavOpen] = useStoredState("xotion:section:favorites", true);
  const [privateOpen, setPrivateOpen] = useStoredState("xotion:section:private", true);
  const [recentOpen, setRecentOpen] = useStoredState("xotion:section:recent", true);
  const [favDrop, setFavDrop] = useState(false);
  const recents = useRecentPages();
  // The page list scrolls under the fixed Buscar/Inicio/Bandeja rows; once it
  // has scrolled, a divider separates them.
  const sectionRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    // Opening a page deep in the tree scrolls the list to its row (TreeItem),
    // which doesn't always arrive as a scroll event: check once it has settled.
    const check = () => setScrolled((sectionRef.current?.scrollTop ?? 0) > 0);
    const frame = requestAnimationFrame(check);
    const timer = window.setTimeout(check, 400);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [activeId]);

  const spaces = (roots ?? []).filter((b) => isWorkspaceRoot(b.id));
  const hasLoosePages = (roots ?? []).some((b) => !isWorkspaceRoot(b.id));
  const localWs: Workspace = { id: WORKSPACE_ID, name: local.name?.trim() || "Xot", block: null, icon: local.icon };
  const workspaces: Workspace[] = [
    ...spaces.map((b) => ({ id: b.id, name: pageTitle(b), block: b })),
    ...(hasLoosePages || spaces.length === 0 ? [localWs] : []),
  ];
  const workspace = workspaces.find((w) => w.id === storedWs) ?? workspaces[0] ?? localWs;

  // Recently opened pages of this workspace, newest first.
  const recentBlocks = useLiveQuery(async () => {
    const out: Block[] = [];
    for (const b of await db.blocks.bulkGet(recents)) {
      if (!b?.alive || b.is_template || (b.type !== "page" && b.type !== "collection_view_page")) continue;
      const chain = await getAncestors(b);
      const root = chain[0] ?? b;
      const inWorkspace = workspace.block ? root.id === workspace.id : !isWorkspaceRoot(root.id);
      if (inWorkspace && !isArchived(b, chain)) out.push(b);
    }
    return out;
  }, [recents, workspace.id]);

  // Favoritos of this workspace only; archived pages (and pages inside them)
  // leave Favoritos and Recientes too.
  const favoriteBlocks = useLiveQuery(async () => {
    const out: Block[] = [];
    for (const b of await db.blocks.bulkGet(favorites)) {
      if (!b?.alive) continue;
      const chain = await getAncestors(b);
      const root = chain[0] ?? b;
      const inWorkspace = workspace.block ? root.id === workspace.id : !isWorkspaceRoot(root.id);
      if (inWorkspace && !isArchived(b, chain)) out.push(b);
    }
    return out;
  }, [favorites, workspace.id]);

  // Opening a page from another workspace (a link, search) switches to it.
  const activeRoot = useLiveQuery(
    async () => (active ? ((await getAncestors(active))[0]?.id ?? active.id) : null),
    [active?.id, active?.parent_id],
  );
  useEffect(() => {
    if (activeRoot) setStoredWs(isWorkspaceRoot(activeRoot) ? activeRoot : WORKSPACE_ID);
  }, [activeRoot, setStoredWs]);

  const switchTo = async (ws: Workspace) => {
    switcher.close();
    setStoredWs(ws.id);
    const [table, parent] = treeParent(ws);
    const first = (await db.blocks.where("[parent_table+parent_id]").equals([table, parent]).toArray())
      .filter((b) => b.alive && !b.format.inline && !isWorkspaceRoot(b.id))
      .sort((a, b) => a.order - b.order)[0];
    navigate(first ? first.id : HOME_ROUTE);
  };

  const newPage = async () => navigate(await createPage(...treeParent(workspace)));
  const newDatabase = async () => navigate((await createDatabase(...treeParent(workspace))).blockId);

  /** "Nuevo espacio de trabajo": a root block like an imported workspace, with a first page in it. */
  const newWorkspace = async () => {
    switcher.close();
    const id = await createPage("space", WORKSPACE_ID, {
      id: `space-${crypto.randomUUID()}`,
      properties: { title: "Nuevo espacio de trabajo" },
    });
    setStoredWs(id);
    navigate(await createPage("block", id));
    window.setTimeout(() => switcherBtn.current && wsRename.open(switcherBtn.current), 300);
  };

  /** "Eliminar espacio de trabajo": it and every page in it, for good (asks first). */
  const deleteWorkspace = async () => {
    switcher.close();
    const ok = await confirmDialog({
      text: (
        <>
          ¿Eliminar el espacio de trabajo <strong>{workspace.name}</strong> y todas sus páginas? Esta acción no se puede
          deshacer.
        </>
      ),
      confirm: "Eliminar espacio de trabajo",
      danger: true,
    });
    if (!ok) return;
    if (workspace.block) await purgeBlock(workspace.id);
    else for (const b of roots ?? []) if (!isWorkspaceRoot(b.id)) await purgeBlock(b.id);
    const next = workspaces.find((w) => w.id !== workspace.id);
    if (next) await switchTo(next);
    toast("Espacio de trabajo eliminado");
  };

  // Dragging a page onto the trash button trashes it.
  const trashDrop = {
    onDragOver: (e: DragEvent) => {
      if (!draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setTrashOver(true);
    },
    onDragLeave: () => setTrashOver(false),
    onDrop: (e: DragEvent) => {
      const id = draggingId;
      draggingId = null;
      setTrashOver(false);
      if (!id) return;
      e.preventDefault();
      void trashWithUndo(id);
    },
  };

  const openSectionMenu = (section: SectionId, el: HTMLElement) => {
    setMenuSection(section);
    sectionMenu.toggle(el);
  };
  const openMore = (section: SectionId, el: HTMLElement) => {
    setMoreSection(section);
    morePanel.open(el);
  };

  const sectionActions = (section: SectionId, plus?: ReactNode) => (
    <span className="sidebar__label-actions">
      <button
        type="button"
        className="icon-btn"
        aria-label="Más opciones"
        data-tooltip="Más opciones"
        onClick={(e) => {
          e.stopPropagation();
          openSectionMenu(section, e.currentTarget);
        }}
      >
        <Ellipsis size={16} />
      </button>
      {plus}
    </span>
  );

  const visible = prefs.order.filter((s) => !prefs.hidden.includes(s));
  const privateLimit = sectionLimit(prefs, "private");
  const favLimit = sectionLimit(prefs, "favorites");
  const recentLimit = sectionLimit(prefs, "recent");

  const renderSection = (section: SectionId) => {
    if (section === "favorites") {
      if (!favoriteBlocks || favoriteBlocks.length === 0) return null;
      const shown = favLimit ? favoriteBlocks.slice(0, favLimit) : favoriteBlocks;
      return (
        <div className="sidebar__group" key="favorites" data-section="favorites">
          <div
            className={`sidebar__label${favDrop ? " is-drop-target" : ""}`}
            onClick={() => setFavOpen(!favOpen)}
            // Dropping a page on the label adds it to the end of Favoritos.
            onDragOver={(e) => {
              if (!draggingId) return;
              e.preventDefault();
              setFavDrop(true);
            }}
            onDragLeave={() => setFavDrop(false)}
            onDrop={(e) => {
              setFavDrop(false);
              if (!draggingId) return;
              e.preventDefault();
              placeFavorite(draggingId, favorites.length);
              draggingId = null;
            }}
          >
            <span>Favoritos</span>
            {sectionActions("favorites")}
          </div>
          {favOpen && (
            <>
              {shown.map((b) => (
                <TreeItem key={b.id} block={b} depth={0} scope="fav" activeId={activeId} ancestors={[]} />
              ))}
              {shown.length < favoriteBlocks.length && <MoreRow label="Más" onClick={(el) => openMore("favorites", el)} />}
            </>
          )}
        </div>
      );
    }
    if (section === "private")
      return (
        <div className="sidebar__group" key="private" data-section="private">
          <div className="sidebar__label" onClick={() => setPrivateOpen(!privateOpen)}>
            <span>Privado</span>
            {sectionActions(
              "private",
              <button
                type="button"
                className="icon-btn"
                aria-label="Nueva página"
                data-tooltip="Añadir una página"
                onClick={(e) => {
                  e.stopPropagation();
                  setPrivateOpen(true);
                  void newPage();
                }}
              >
                <Plus size={16} />
              </button>,
            )}
          </div>
          {privateOpen && (
            <PageTree
              parentTable={treeParent(workspace)[0]}
              parentId={treeParent(workspace)[1]}
              depth={0}
              scope=""
              activeId={activeId}
              ancestors={ancestors ?? []}
              limit={privateLimit || undefined}
              sort={prefs.privateSort}
              onShowAll={(el) => openMore("private", el)}
            />
          )}
        </div>
      );
    if (!recentBlocks || recentBlocks.length === 0) return null;
    const shownRecent = recentBlocks.slice(0, recentLimit || RECENT_ALL);
    return (
      <div className="sidebar__group" key="recent" data-section="recent">
        <div className="sidebar__label" onClick={() => setRecentOpen(!recentOpen)}>
          <span>Recientes</span>
          {sectionActions("recent")}
        </div>
        {recentOpen &&
          shownRecent.map((b) => (
            <TreeItem key={b.id} block={b} depth={0} scope="recent" activeId={activeId} ancestors={[]} />
          ))}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__top">
        <img className="workspace__logo" src={logo} alt="Xot" />
        <div className="sidebar__top-actions">
          {peek ? (
            <button
              type="button"
              className="icon-btn sidebar__collapse"
              aria-label="Mantener abierta la barra lateral"
              data-tooltip="Mantener abierta la barra lateral"
              data-shortcut={`${mod}\\`}
              onClick={onPin}
            >
              <ChevronsRight size={20} />
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn sidebar__collapse"
              aria-label="Ocultar barra lateral"
              data-tooltip="Ocultar barra lateral"
              data-shortcut={`${mod}\\`}
              onClick={onCollapse}
            >
              <ChevronsLeft size={20} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Nueva página"
            data-tooltip="Nueva página"
            data-shortcut={`${mod}N`}
            onClick={() => void newPage()}
          >
            <SquarePen size={18} />
          </button>
        </div>
      </div>

      <SidebarTabs onCustomize={() => setCustomizing(true)} />

      <button type="button" className="sidebar__search" onClick={onSearch}>
        <span>Buscar</span>
        <kbd>{`${mod}K`}</kbd>
      </button>

      <div className="sidebar__nav">
        {!prefs.hidden.includes("home") && (
          <button
            type="button"
            className={`sidebar__nav-item${activeId === HOME_ROUTE ? " is-active" : ""}`}
            onClick={() => navigate(HOME_ROUTE)}
          >
            <span className="sidebar__nav-icon">
              <House size={20} />
            </span>
            <span>Inicio</span>
          </button>
        )}
        {!prefs.hidden.includes("inbox") && (
          <button
            type="button"
            className={`sidebar__nav-item${inbox.anchor ? " is-active" : ""}`}
            onClick={(e) => inbox.toggle(e.currentTarget)}
          >
            <span className="sidebar__nav-icon">
              <Inbox size={20} />
            </span>
            <span>Bandeja de entrada</span>
            {unread > 0 && <span className="sidebar__badge">{unread > 99 ? "99+" : unread}</span>}
          </button>
        )}
        {prefs.shortcuts.map((s) => (
          <ShortcutRow key={s.id} shortcut={s} activeId={activeId} onNewPage={() => void newPage()} />
        ))}
      </div>
      {inbox.anchor && (
        <Popover anchor={inbox.anchor} onClose={inbox.close} width={380} placement="flyout">
          <InboxPanel
            onClose={inbox.close}
            onPin={() => {
              inbox.close();
              window.dispatchEvent(new CustomEvent(INBOX_PIN_EVENT, { detail: true }));
            }}
          />
        </Popover>
      )}

      <div
        ref={sectionRef}
        className={`sidebar__section${scrolled ? " is-scrolled" : ""}`}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        {visible.map(renderSection)}
      </div>

      <div className="sidebar__bottom">
        <button type="button" className="ws-switcher" ref={switcherBtn} onClick={(e) => switcher.toggle(e.currentTarget)}>
          <WorkspaceAvatar ws={workspace} />
          <span className="ws-switcher__name">{workspace.name}</span>
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Configuración"
          data-tooltip="Configuración"
          data-shortcut={`${mod},`}
          onClick={openPreferences}
        >
          <Settings size={20} />
        </button>
        <button
          type="button"
          className="icon-btn sidebar__templates"
          aria-label="Plantillas"
          data-tooltip="Plantillas"
          onClick={() => setGallery(true)}
        >
          <LayoutTemplate size={20} />
        </button>
        <button
          type="button"
          className={`icon-btn sidebar__trash${trashOver ? " is-drop-target" : ""}`}
          aria-label="Papelera"
          data-tooltip="Papelera"
          onClick={(e) => trashPop.toggle(e.currentTarget)}
          {...trashDrop}
        >
          <Trash size={20} />
        </button>
      </div>

      {sectionMenu.anchor && (
        <Popover anchor={sectionMenu.anchor} onClose={sectionMenu.close} width={256}>
          <SectionMenu
            section={menuSection}
            onClose={sectionMenu.close}
            onNewPage={() => void newPage()}
            onNewDatabase={() => void newDatabase()}
            onImport={() => setImporting(true)}
            onCustomize={() => setCustomizing(true)}
          />
        </Popover>
      )}
      {morePanel.anchor && (
        <Popover anchor={morePanel.anchor} onClose={morePanel.close} width={320} placement="flyout">
          <SectionPanel
            section={moreSection}
            pages={
              moreSection === "favorites"
                ? (favoriteBlocks ?? [])
                : null
            }
            parent={treeParent(workspace)}
            sort={prefs.privateSort}
            onClose={morePanel.close}
          />
        </Popover>
      )}
      {customizing && <SidebarCustomizer onClose={() => setCustomizing(false)} />}
      {gallery && <TemplateGallery parent={treeParent(workspace)} onClose={() => setGallery(false)} />}
      {importing && (
        <ImportDialog
          target={(([table, id]) => ({ table, id }))(treeParent(workspace))}
          onClose={() => setImporting(false)}
        />
      )}
      {switcher.anchor && (
        <Popover anchor={switcher.anchor} onClose={switcher.close} width={280}>
          <div className="menu ws-menu">
            <div className="ws-menu__head">
              <WorkspaceAvatar ws={workspace} />
              <span className="ws-menu__name">{workspace.name}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Cambiar nombre e icono"
                data-tooltip="Cambiar nombre e icono"
                onClick={() => {
                  switcher.close();
                  if (switcherBtn.current) wsRename.open(switcherBtn.current);
                }}
              >
                <PenLine size={16} />
              </button>
            </div>
            <MenuSeparator />
            <div className="menu-label">Espacios de trabajo</div>
            {workspaces.map((ws) => (
              <MenuItem
                key={ws.id}
                icon={<WorkspaceAvatar ws={ws} />}
                right={ws.id === workspace.id ? <Check size={16} /> : null}
                onClick={() => void switchTo(ws)}
              >
                {ws.name}
              </MenuItem>
            ))}
            <MenuItem icon={<Plus size={18} />} onClick={() => void newWorkspace()}>
              Nuevo espacio de trabajo
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<PanelLeft size={18} />}
              onClick={() => {
                switcher.close();
                setCustomizing(true);
              }}
            >
              Personalizar barra lateral
            </MenuItem>
            <MenuItem
              icon={<Settings size={18} />}
              right={`${mod},`}
              onClick={() => {
                switcher.close();
                openPreferences();
              }}
            >
              Configuración
            </MenuItem>
            {workspaces.length > 1 && (
              <>
                <MenuSeparator />
                <MenuItem danger icon={<Trash size={18} />} onClick={() => void deleteWorkspace()}>
                  Eliminar espacio de trabajo
                </MenuItem>
              </>
            )}
          </div>
        </Popover>
      )}
      {wsRename.anchor && (
        <Popover anchor={wsRename.anchor} onClose={wsRename.close} width={320} className="rename-pop">
          {workspace.block ? (
            <RenameForm block={workspace.block} onDone={wsRename.close} />
          ) : (
            <LocalRenameForm value={local} onChange={setLocal} onDone={wsRename.close} />
          )}
        </Popover>
      )}
      {trashPop.anchor && (
        <Popover anchor={trashPop.anchor} onClose={trashPop.close} width={414}>
          <TrashPanel workspace={workspace} onNavigate={trashPop.close} />
        </Popover>
      )}
      {onResize && <ResizeHandle onResize={onResize} onCollapse={onCollapse} />}
    </aside>
  );
}

/** A section's "..." menu: Ordenar, Mostrar, Mover hacia arriba/abajo and Ocultar sección. */
function SectionMenu({
  section,
  onClose,
  onNewPage,
  onNewDatabase,
  onImport,
  onCustomize,
}: {
  section: SectionId;
  onClose: () => void;
  onNewPage: () => void;
  onNewDatabase: () => void;
  onImport: () => void;
  onCustomize: () => void;
}) {
  const prefs = useSidebarPrefs();
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const limit = sectionLimit(prefs, section);
  const visible = prefs.order.filter((s) => !prefs.hidden.includes(s));
  const at = visible.indexOf(section);
  return (
    <div className="menu section-menu">
      {section === "private" && (
        <>
          <MenuItem icon={<SquarePen size={18} />} onClick={run(onNewPage)}>
            Nueva página
          </MenuItem>
          <MenuItem icon={<Sheet size={18} />} onClick={run(onNewDatabase)}>
            Nueva base de datos
          </MenuItem>
          <MenuItem icon={<FileUp size={18} />} onClick={run(onImport)}>
            Importar
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Ordenar</MenuLabel>
          {(
            [
              ["manual", "Manual"],
              ["edited", "Última edición"],
            ] as const
          ).map(([id, label]) => (
            <MenuItem
              key={id}
              right={prefs.privateSort === id ? <Check size={16} /> : undefined}
              onClick={() => updateSidebarPrefs({ privateSort: id })}
            >
              {label}
            </MenuItem>
          ))}
          <MenuSeparator />
        </>
      )}
      <MenuLabel>Mostrar</MenuLabel>
      {LIMIT_CHOICES.map((n) => (
        <MenuItem
          key={n}
          right={limit === n ? <Check size={16} /> : undefined}
          onClick={() => updateSidebarPrefs((p) => ({ limits: { ...p.limits, [section]: n } }))}
        >
          {n} elementos
        </MenuItem>
      ))}
      {section !== "recent" && (
        <MenuItem
          right={limit === 0 ? <Check size={16} /> : undefined}
          onClick={() => updateSidebarPrefs((p) => ({ limits: { ...p.limits, [section]: 0 } }))}
        >
          Todos
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem icon={<ArrowUp size={18} />} disabled={at <= 0} onClick={run(() => moveSection(section, -1))}>
        Mover hacia arriba
      </MenuItem>
      <MenuItem
        icon={<ArrowDown size={18} />}
        disabled={at === -1 || at >= visible.length - 1}
        onClick={run(() => moveSection(section, 1))}
      >
        Mover hacia abajo
      </MenuItem>
      <MenuItem
        icon={<EyeOff size={18} />}
        onClick={run(() => {
          setHidden(section, true);
          toast(`Sección «${SECTION_LABELS[section]}» oculta`, { label: "Deshacer", run: () => setHidden(section, false) });
        })}
      >
        Ocultar sección
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<PanelLeft size={18} />} onClick={run(onCustomize)}>
        Personalizar barra lateral
      </MenuItem>
    </div>
  );
}

/**
 * "Más" under Favoritos or Privado: every page of the section in a panel beside
 * the sidebar, with a search box (a flyout).
 */
function SectionPanel({
  section,
  pages,
  parent,
  sort,
  onClose,
}: {
  section: SectionId;
  /** The section's pages; null lists the workspace's top level (Privado). */
  pages: Block[] | null;
  parent: [ParentTable, string];
  sort: "manual" | "edited";
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const top = useChildren(...parent);
  const list =
    pages ??
    (top ?? [])
      .filter((b) => !b.format.inline && !isWorkspaceRoot(b.id) && !b.format.archived)
      .sort((a, b) => (sort === "edited" ? b.last_edited_time - a.last_edited_time : 0));
  const q = query.trim().toLowerCase();
  const shown = list.filter((b) => pageTitle(b).toLowerCase().includes(q));
  return (
    <div className="section-panel">
      <div className="section-panel__search">
        <Search size={16} />
        <input
          autoFocus
          placeholder={`Buscar en ${SECTION_LABELS[section]}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="section-panel__list">
        {shown.length === 0 && <div className="menu-empty">Sin resultados</div>}
        {shown.map((b) => (
          <MenuItem
            key={b.id}
            icon={<PageIcon block={b} size={20} />}
            {...pageLinkProps(b.id, () => {
              onClose();
              navigate(b.id);
            }, onClose)}
          >
            {pageTitle(b)}
          </MenuItem>
        ))}
      </div>
    </div>
  );
}

/** A row added with "Personalizar barra lateral": Nueva página, Mis tareas or a database view. */
function ShortcutRow({ shortcut, activeId, onNewPage }: { shortcut: Shortcut; activeId: string | null; onNewPage: () => void }) {
  const target = useLiveQuery(async () => {
    if (shortcut.kind !== "view") return null;
    const [block, view] = await Promise.all([db.blocks.get(shortcut.databaseId), db.views.get(shortcut.viewId)]);
    return block?.alive && view ? { block, view } : null;
  }, [shortcut]);
  const menu = usePopover();
  const remove = (
    <>
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} width={240}>
          <div className="menu">
            <MenuItem
              icon={<X size={18} />}
              onClick={() => {
                menu.close();
                updateSidebarPrefs((p) => ({ shortcuts: p.shortcuts.filter((s) => s.id !== shortcut.id) }));
              }}
            >
              Quitar de la barra lateral
            </MenuItem>
          </div>
        </Popover>
      )}
    </>
  );
  const row = (icon: ReactNode, label: ReactNode, onClick: () => void, isActive = false) => (
    <>
      <button
        type="button"
        className={`sidebar__nav-item sidebar__shortcut${isActive ? " is-active" : ""}`}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          menu.open(pointerAnchor(e));
        }}
      >
        <span className="sidebar__nav-icon">{icon}</span>
        <span className="sidebar__shortcut-label">{label}</span>
      </button>
      {remove}
    </>
  );
  if (shortcut.kind === "new-page") return row(<SquarePen size={20} />, "Nueva página", onNewPage);
  if (shortcut.kind === "my-tasks")
    return row(<CircleCheck size={20} />, "Mis tareas", () => (window.location.hash = `/${HOME_ROUTE}?tasks`));
  if (!target) return null;
  // The database's icon and name, then the view's name.
  return row(
    <PageIcon block={target.block} size={20} />,
    <>
      {pageTitle(target.block)}
      <span className="sidebar__shortcut-view"> · {target.view.name || "Sin título"}</span>
    </>,
    () => (window.location.hash = `/${target.block.id}?v=${target.view.id}`),
    activeId === target.block.id,
  );
}

/** The local space's "Cambiar nombre": its icon and name (kept on this device). */
function LocalRenameForm({
  value,
  onChange,
  onDone,
}: {
  value: { name?: string; icon?: string };
  onChange: (v: { name?: string; icon?: string }) => void;
  onDone: () => void;
}) {
  const iconPop = usePopover();
  return (
    <div className="rename">
      <button type="button" className="rename__icon" aria-label="Cambiar icono" onClick={(e) => iconPop.toggle(e.currentTarget)}>
        {value.icon ? <PageIcon block={iconOnly(value.icon)} size={20} /> : <span className="ws-avatar ws-avatar--letter">{(value.name ?? "Xot").trim().charAt(0).toUpperCase() || "X"}</span>}
      </button>
      <input
        className="field rename__input"
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={value.name ?? "Xot"}
        placeholder="Xot"
        onChange={(e) => onChange({ ...value, name: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onDone();
          }
        }}
      />
      {iconPop.anchor && (
        <Popover anchor={iconPop.anchor} onClose={iconPop.close} width={408}>
          <EmojiPicker
            onPick={(emoji) => {
              onChange({ ...value, icon: emoji });
              iconPop.close();
            }}
            onRemove={
              value.icon
                ? () => {
                    onChange({ ...value, icon: undefined });
                    iconPop.close();
                  }
                : undefined
            }
          />
        </Popover>
      )}
    </div>
  );
}

/** The sidebar edge: drag to resize (240–480px), click to collapse. */
function ResizeHandle({ onResize, onCollapse }: { onResize: (width: number) => void; onCollapse: () => void }) {
  return (
    <div
      className="sidebar__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Cambiar el ancho de la barra lateral"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const handle = e.currentTarget;
        const left = handle.parentElement?.getBoundingClientRect().left ?? 0;
        const startX = e.clientX;
        let moved = false;
        handle.setPointerCapture(e.pointerId);
        document.body.classList.add("is-resizing-sidebar");
        const onMove = (ev: PointerEvent) => {
          if (!moved && Math.abs(ev.clientX - startX) < 3) return;
          moved = true;
          onResize(Math.round(Math.min(480, Math.max(240, ev.clientX - left))));
        };
        const onUp = (ev: PointerEvent) => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          document.body.classList.remove("is-resizing-sidebar");
          if (!moved && ev.type === "pointerup") onCollapse();
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      }}
    />
  );
}

/** "Más": the row under a capped section that opens the rest in a panel. */
function MoreRow({ onClick, label = "Más" }: { onClick: (el: HTMLElement) => void; label?: string }) {
  return (
    <div className="tree-row tree-row--more" onClick={(e) => onClick(e.currentTarget)}>
      <span className="tree-row__icon">
        <Ellipsis size={20} />
      </span>
      <span className="tree-row__title">{label}</span>
    </div>
  );
}

function PageTree({
  parentTable,
  parentId,
  depth,
  scope,
  activeId,
  ancestors,
  limit,
  sort = "manual",
  onShowAll,
}: {
  parentTable: ParentTable;
  parentId: string;
  depth: number;
  /** Keeps expand state apart when a page shows in more than one section. */
  scope: string;
  activeId: string | null;
  ancestors: string[];
  /** Rows shown before "Más" (Privado's top level only). */
  limit?: number;
  /** Privado's "Ordenar": "edited" lists the last edited first. */
  sort?: "manual" | "edited";
  onShowAll?: (el: HTMLElement) => void;
}) {
  // Databases shown inside a page live in its content, not in the sidebar;
  // archived pages leave it with everything inside them.
  let children = useChildren(parentTable, parentId)?.filter(
    (b) => !b.format.inline && !isWorkspaceRoot(b.id) && !b.format.archived,
  );
  if (children && sort === "edited") children = [...children].sort((a, b) => b.last_edited_time - a.last_edited_time);
  if (!children) return null;
  if (children.length === 0 && depth > 0)
    return (
      <div className="tree-empty" style={{ paddingLeft: 38 + depth * 14 }}>
        No hay páginas dentro
      </div>
    );
  const capped = limit !== undefined && children.length > limit;
  let shown = capped ? children.slice(0, limit) : children;
  // The open page's branch stays in view even when it falls past the cap.
  const open = capped ? children.slice(limit).find((c) => c.id === activeId || ancestors.includes(c.id)) : undefined;
  if (open) shown = [...shown, open];
  return (
    <>
      {shown.map((child) => (
        <TreeItem
          key={child.id}
          block={child}
          depth={depth}
          scope={scope}
          activeId={activeId}
          ancestors={ancestors}
        />
      ))}
      {capped && onShowAll && <MoreRow onClick={onShowAll} />}
    </>
  );
}

function TreeItem({
  block,
  depth,
  scope,
  activeId,
  ancestors,
}: {
  block: Block;
  depth: number;
  scope: string;
  activeId: string | null;
  ancestors: string[];
}) {
  const [expanded, setExpanded] = useStoredState(`xotion:open:${scope ? `${scope}:` : ""}${block.id}`, false);
  const menu = usePopover();
  const rename = usePopover();
  const move = usePopover();
  const rowRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<"before" | "after" | "inside" | null>(null);
  const favorites = useFavorites();
  const isFavorite = favorites.includes(block.id);
  const isAncestor = ancestors.includes(block.id);
  const isDatabase = block.type === "collection_view_page";
  // Favoritos reorders the favorites (or adds the page dropped there); Recientes
  // keeps its own order, so a drop there only nests the page in that row's page.
  const droppable = scope !== "recent" || !isDatabase;

  useEffect(() => {
    if (isAncestor && !isDatabase) setExpanded(true);
  }, [isAncestor, isDatabase, setExpanded]);

  // The open page's row scrolls into view once its ancestors have expanded.
  // Only Privado's copy does it, so Favoritos and Recientes don't fight over it.
  useEffect(() => {
    if (activeId === block.id && scope === "") rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId, block.id, scope]);

  // ⌘⇧R renames the open page from its row.
  const openRename = useRef(rename.open);
  openRename.current = rename.open;
  useEffect(() => {
    if (activeId !== block.id || scope !== "") return;
    const onRename = () => rowRef.current && openRename.current(rowRef.current);
    window.addEventListener(RENAME_EVENT, onRename);
    return () => window.removeEventListener(RENAME_EVENT, onRename);
  }, [activeId, block.id, scope]);

  const addChild = async () => {
    // In a database the "+" adds a row to it.
    if (isDatabase) {
      if (block.collection_id) navigate(await addRow(block.collection_id));
      return;
    }
    const id = await createPage("block", block.id);
    await insertPageLink(block.id, id);
    setExpanded(true);
    navigate(id);
  };

  // Drag and drop: the top or bottom quarter of a row reorders, the middle nests (pages only).
  const zoneAt = (e: DragEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (scope === "recent") return "inside";
    if (isDatabase) return y < 0.5 ? "before" : "after";
    return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
  };
  const onDrop = async (zone: "before" | "after" | "inside") => {
    const id = draggingId;
    draggingId = null;
    if (!id || id === block.id) return;
    if (scope === "fav" && zone !== "inside") {
      const at = favorites.indexOf(block.id);
      placeFavorite(id, zone === "before" ? at : at + 1);
      return;
    }
    if (zone === "inside") {
      await movePage(id, "block", block.id);
      setExpanded(true);
      return;
    }
    const siblings = (
      await db.blocks.where("[parent_table+parent_id]").equals([block.parent_table, block.parent_id]).toArray()
    )
      .filter((b) => b.alive && !b.format.inline && !b.is_template && b.id !== id)
      .sort((a, b) => a.order - b.order);
    const i = siblings.findIndex((b) => b.id === block.id);
    const neighbour = siblings[zone === "before" ? i - 1 : i + 1];
    const order = neighbour ? (block.order + neighbour.order) / 2 : block.order + (zone === "before" ? -1 : 1);
    await movePage(id, block.parent_table, block.parent_id, order);
  };

  return (
    <>
      <div
        ref={rowRef}
        className={`tree-row${activeId === block.id ? " is-active" : ""}${
          menu.anchor || rename.anchor || move.anchor ? " is-menu-open" : ""
        }${drop ? ` is-drop-${drop}` : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        {...pageLinkProps(block.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          menu.open(pointerAnchor(e));
        }}
        draggable
        onDragStart={(e) => {
          draggingId = block.id;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/xot-page", block.id);
        }}
        onDragEnd={() => {
          draggingId = null;
          setDrop(null);
        }}
        onDragOver={(e) => {
          // Blocks dragged from the editor (their ⋮⋮ handle) drop onto a page: they move there (Editor.tsx).
          if (!draggingId && !isDatabase && e.dataTransfer.types.includes("blocknote/html")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (drop !== "inside") setDrop("inside");
            return;
          }
          if (!droppable || !draggingId || draggingId === block.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const zone = zoneAt(e);
          if (zone !== drop) setDrop(zone);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
        }}
        onDrop={(e) => {
          if (!draggingId && !isDatabase && e.dataTransfer.types.includes("blocknote/html")) {
            e.preventDefault();
            setDrop(null);
            window.dispatchEvent(new CustomEvent("xot:blocks-to-page", { detail: block.id }));
            return;
          }
          if (!droppable || !draggingId) return;
          e.preventDefault();
          setDrop(null);
          void onDrop(zoneAt(e));
        }}
      >
        <span className="tree-row__icon has-toggle">
          <PageIcon block={block} size={20} />
          <button
            type="button"
            className="tree-row__toggle"
            aria-label={expanded ? "Contraer" : "Expandir"}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            <ChevronRight size={12} strokeWidth={2.4} className={expanded ? "rotate-90" : ""} />
          </button>
        </span>
        <span className="tree-row__title">{pageTitle(block)}</span>
        <span className="tree-row__actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Más acciones"
            data-tooltip="Eliminar, duplicar y más…"
            onClick={(e) => {
              e.stopPropagation();
              menu.toggle(e.currentTarget);
            }}
          >
            <Ellipsis size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={isDatabase ? "Nueva página" : "Añadir subpágina"}
            data-tooltip={isDatabase ? "Nueva página" : "Añadir una página dentro"}
            onClick={(e) => {
              e.stopPropagation();
              void addChild();
            }}
          >
            <Plus size={16} />
          </button>
        </span>
      </div>
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} width={256}>
          <div className="menu">
            <MenuItem
              icon={isFavorite ? <StarOff size={18} /> : <Star size={18} />}
              onClick={() => {
                menu.close();
                toggleFavorite(block.id);
              }}
            >
              {isFavorite ? "Quitar de favoritos" : "Añadir a favoritos"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Link size={18} />}
              onClick={() => {
                menu.close();
                void copyLink(block.id);
              }}
            >
              Copiar enlace
            </MenuItem>
            <MenuItem
              icon={<CopyPlus size={18} />}
              right={`${mod}D`}
              onClick={async () => {
                menu.close();
                const id = await (isDatabase ? duplicateDatabase(block.id) : duplicatePage(block.id));
                if (id) navigate(id);
              }}
            >
              Duplicar
            </MenuItem>
            <MenuItem
              icon={<PenLine size={18} />}
              right={`${mod}⇧R`}
              onClick={() => {
                menu.close();
                if (rowRef.current) rename.open(rowRef.current);
              }}
            >
              Cambiar nombre
            </MenuItem>
            {block.parent_table !== "collection" && (
              <MenuItem
                icon={<CornerUpRight size={18} />}
                right={`${mod}⇧P`}
                onClick={() => {
                  menu.close();
                  if (rowRef.current) move.open(rowRef.current);
                }}
              >
                Mover a
              </MenuItem>
            )}
            {block.parent_table !== "collection" && (
              <MenuItem
                icon={<Archive size={18} />}
                onClick={() => {
                  menu.close();
                  void archivePage(block.id, true).then(() =>
                    toast("Página archivada", { label: "Deshacer", run: () => void archivePage(block.id, false) }),
                  );
                }}
              >
                Archivar
              </MenuItem>
            )}
            <MenuItem
              danger
              icon={<Trash size={18} />}
              onClick={() => {
                menu.close();
                void trashWithUndo(block.id);
              }}
            >
              Mover a la papelera
            </MenuItem>
            {DESKTOP && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={<SquareArrowOutUpRight size={18} />}
                  onClick={() => {
                    menu.close();
                    openInNewTab(block.id);
                  }}
                >
                  Abrir en una pestaña nueva
                </MenuItem>
              </>
            )}
            {block.last_edited_time > 0 && (
              <>
                <MenuSeparator />
                <div className="menu-meta">Última edición: {fullDate.format(block.last_edited_time)}</div>
              </>
            )}
          </div>
        </Popover>
      )}
      {rename.anchor && (
        <Popover anchor={rename.anchor} onClose={rename.close} width={320} className="rename-pop">
          <RenameForm block={block} onDone={rename.close} />
        </Popover>
      )}
      {move.anchor && (
        <Popover anchor={move.anchor} onClose={move.close} width={320}>
          <MovePicker block={block} onDone={move.close} />
        </Popover>
      )}
      {expanded && isDatabase && <ViewTree block={block} depth={depth + 1} />}
      {expanded && !isDatabase && (
        <PageTree
          parentTable="block"
          parentId={block.id}
          depth={depth + 1}
          scope={scope}
          activeId={activeId}
          ancestors={ancestors}
        />
      )}
    </>
  );
}

/** An expanded database in the sidebar lists its views; each opens the database on it. */
function ViewTree({ block, depth }: { block: Block; depth: number }) {
  const viewOrder = (block.view_ids ?? []).join(",");
  const views = useLiveQuery(async () => {
    const list = await db.views.where("parent_id").equals(block.id).toArray();
    const order = viewOrder.split(",");
    return list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [block.id, viewOrder]);
  if (!views) return null;
  return (
    <>
      {views.map((v) => {
        const Icon = viewIcon(v);
        return (
          <div
            key={v.id}
            className="tree-row tree-row--view"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (window.location.hash = `/${block.id}?v=${v.id}`)}
          >
            <span className="tree-row__icon">
              <Icon size={16} />
            </span>
            <span className="tree-row__title">{v.name || "Sin título"}</span>
          </div>
        );
      })}
    </>
  );
}

/** The "Cambiar nombre" popover: the icon and an input under the row. */
function RenameForm({ block, onDone }: { block: Block; onDone: () => void }) {
  const [title, setLocal] = useState(String(block.properties.title ?? ""));
  const iconPop = usePopover();
  return (
    <div className="rename">
      <button type="button" className="rename__icon" aria-label="Cambiar icono" onClick={(e) => iconPop.toggle(e.currentTarget)}>
        <PageIcon block={block} size={20} />
      </button>
      <input
        className="field rename__input"
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={title}
        placeholder="Sin título"
        onChange={(e) => {
          setLocal(e.target.value);
          void setTitle(block.id, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onDone();
          }
        }}
      />
      {iconPop.anchor && (
        <Popover anchor={iconPop.anchor} onClose={iconPop.close} width={408}>
          <EmojiPicker
            onPick={(emoji) => {
              void setIcon(block.id, emoji);
              iconPop.close();
            }}
            onRemove={
              block.format.icon
                ? () => {
                    void setIcon(block.id, undefined);
                    iconPop.close();
                  }
                : undefined
            }
          />
        </Popover>
      )}
    </div>
  );
}

/**
 * The trash: the pages trashed in this workspace, newest first, each with
 * the place it was in underneath. "En" keeps the ones that were inside a page;
 * what stays more than 30 days is deleted for good (sweepTrash, at launch).
 */
function TrashPanel({ workspace, onNavigate }: { workspace: Workspace; onNavigate: () => void }) {
  const [query, setQuery] = useState("");
  const [inPage, setInPage] = useState<Block | null>(null);
  const inPop = usePopover();
  const trashed = useLiveQuery(async () => {
    const out: { block: Block; path: string; ancestors: string[] }[] = [];
    const dead = (await db.blocks.filter((b) => !b.alive).toArray()).sort(
      (a, b) => (b.trashed_time ?? b.last_edited_time) - (a.trashed_time ?? a.last_edited_time),
    );
    for (const b of dead) {
      const ancestors = await getAncestors(b);
      const root = ancestors[0] ?? b;
      const inWorkspace = workspace.block ? root.id === workspace.id : !isWorkspaceRoot(root.id);
      if (!inWorkspace) continue;
      // The workspace root itself isn't a place; its pages sit at the top level.
      const path = ancestors
        .filter((a) => !isWorkspaceRoot(a.id))
        .map((a) => pageTitle(a))
        .join(" / ");
      out.push({ block: b, path, ancestors: ancestors.map((a) => a.id) });
    }
    return out;
  }, [workspace.id]);
  const q = query.trim().toLowerCase();
  const list = (trashed ?? []).filter(
    ({ block, ancestors }) => pageTitle(block).toLowerCase().includes(q) && (!inPage || ancestors.includes(inPage.id)),
  );
  return (
    <div className="trash">
      <input
        className="field"
        autoFocus
        placeholder="Buscar en la papelera"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="trash__filters">
        <button
          type="button"
          className={`find__chip${inPage ? " is-active" : ""}`}
          onClick={(e) => inPop.toggle(e.currentTarget)}
        >
          {inPage ? (
            <>
              <PageIcon block={inPage} size={14} />
              <span className="find__chip-text">En: {pageTitle(inPage)}</span>
            </>
          ) : (
            "En"
          )}
          <ChevronDown size={14} />
        </button>
      </div>
      {inPop.anchor && (
        <Popover anchor={inPop.anchor} onClose={inPop.close} width={320}>
          {inPage && (
            <div className="menu">
              <MenuItem
                icon={<X size={18} />}
                onClick={() => {
                  setInPage(null);
                  inPop.close();
                }}
              >
                Quitar filtro
              </MenuItem>
              <MenuSeparator />
            </div>
          )}
          <PagePicker
            placeholder="Buscar páginas…"
            onPick={(p) => {
              setInPage(p);
              inPop.close();
            }}
          />
        </Popover>
      )}
      <div className="trash__list">
        {list.length === 0 && (
          <p className="rule-panel__empty">{trashed?.length ? "Sin resultados" : "La papelera está vacía."}</p>
        )}
        {list.map(({ block: b, path }) => (
          <div
            key={b.id}
            className="trash__row"
            onClick={() => {
              navigate(b.id);
              onNavigate();
            }}
          >
            <PageIcon block={b} size={16} />
            <span className="trash__text">
              <span className="trash__title">{pageTitle(b)}</span>
              {path && <span className="trash__path">{path}</span>}
            </span>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Restaurar"
              data-tooltip="Restaurar"
              onClick={(e) => {
                e.stopPropagation();
                void restoreBlock(b.id);
              }}
            >
              <RotateCcw size={15} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Eliminar definitivamente"
              data-tooltip="Eliminar definitivamente"
              onClick={(e) => {
                e.stopPropagation();
                void confirmPurge().then((ok) => {
                  if (ok) void purgeBlock(b.id);
                });
              }}
            >
              <Trash size={15} />
            </button>
          </div>
        ))}
      </div>
      <div className="trash__footer">
        Las páginas que lleven más de {TRASH_DAYS} días en la papelera se eliminarán automáticamente.
      </div>
    </div>
  );
}
