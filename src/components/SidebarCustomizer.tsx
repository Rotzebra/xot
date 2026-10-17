import { useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  Clock,
  FileText,
  House,
  Inbox,
  LayoutGrid,
  PanelLeft,
  PenLine,
  Plus,
  RotateCcw,
  Settings2,
  Sheet,
  SquarePen,
  Star,
  Trash,
  X,
  ArrowUp,
} from "lucide-react";
import { db } from "../lib/db";
import { isWorkspaceRoot } from "../lib/model";
import { pageTitle } from "../lib/hooks";
import {
  addShortcut,
  addTab,
  deleteTab,
  MAX_TABS,
  moveSection,
  moveTab,
  NAV_LABELS,
  removeShortcut,
  renameTab,
  resetTab,
  SECTION_LABELS,
  setActiveTab,
  setHidden,
  TAB_PRESETS,
  useSidebarPrefs,
  useSidebarTabs,
  type NavId,
  type Shortcut,
  type SidebarTab,
  type TabPreset,
} from "../lib/sidebar";
import { viewIcon } from "./database/DatabaseView";
import { MenuItem, MenuLabel, MenuSeparator, Modal, PageIcon, Popover, Switch, toast, usePopover } from "./ui";

const NAV_ICONS: Record<NavId, ReactNode> = { home: <House size={18} />, inbox: <Inbox size={18} /> };

const TAB_ICONS: Record<TabPreset, typeof FileText> = {
  pages: FileText,
  favorites: Star,
  recent: Clock,
  tasks: CircleCheck,
  blank: LayoutGrid,
};

/** "Añadir pestaña": what the new tab should hold. */
function TabPresetMenu({ onDone }: { onDone: () => void }) {
  return (
    <div className="menu">
      <MenuLabel>Añadir pestaña</MenuLabel>
      {(Object.keys(TAB_PRESETS) as TabPreset[]).map((preset) => {
        const Icon = TAB_ICONS[preset];
        return (
          <MenuItem
            key={preset}
            icon={<Icon size={18} />}
            onClick={() => {
              onDone();
              if (!addTab(preset)) toast(`La barra lateral admite hasta ${MAX_TABS} pestañas`);
            }}
          >
            {TAB_PRESETS[preset]}
          </MenuItem>
        );
      })}
    </div>
  );
}

/**
 * The sidebar's tabs: each keeps its own rows, sections and
 * shortcuts. Clicking the open tab again (or right-clicking any) opens its
 * menu: "Personalizar barra lateral", "Restablecer pestaña", "Eliminar pestaña".
 */
export function SidebarTabs({ onCustomize }: { onCustomize: () => void }) {
  const { tabs, active } = useSidebarTabs();
  const menu = usePopover();
  const addPop = usePopover();
  const [menuTab, setMenuTab] = useState<string>(active);
  const [renaming, setRenaming] = useState(false);
  const tab = tabs.find((t) => t.id === menuTab);
  const openMenu = (id: string, el: HTMLElement) => {
    setActiveTab(id);
    setMenuTab(id);
    setRenaming(false);
    menu.toggle(el);
  };
  return (
    <div className="sidebar__tabs" role="tablist" aria-label="Pestañas de la barra lateral">
      {tabs.map((t) => {
        const Icon = TAB_ICONS[t.preset];
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            aria-label={t.name}
            data-tab={t.id}
            className={`sidebar__tab${on ? " is-active" : ""}`}
            data-tooltip={on ? undefined : t.name}
            onClick={(e) => (on ? openMenu(t.id, e.currentTarget) : setActiveTab(t.id))}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(t.id, e.currentTarget);
            }}
          >
            <Icon size={16} />
            {on && <span className="sidebar__tab-name">{t.name}</span>}
          </button>
        );
      })}
      {tabs.length < MAX_TABS && (
        <button
          type="button"
          className="icon-btn icon-btn--sm sidebar__tab-add"
          aria-label="Añadir pestaña"
          data-tooltip="Añadir pestaña"
          onClick={(e) => addPop.toggle(e.currentTarget)}
        >
          <Plus size={16} />
        </button>
      )}
      {menu.anchor && tab && (
        <Popover anchor={menu.anchor} onClose={menu.close} width={240}>
          {renaming ? (
            <form
              className="menu sidebar__tab-rename"
              onSubmit={(e) => {
                e.preventDefault();
                renameTab(tab.id, new FormData(e.currentTarget).get("name") as string);
                menu.close();
              }}
            >
              <input className="menu-search" name="name" autoFocus defaultValue={tab.name} aria-label="Nombre de la pestaña" />
            </form>
          ) : (
            <div className="menu">
              <MenuLabel>{tab.name}</MenuLabel>
              <MenuItem
                icon={<Settings2 size={18} />}
                onClick={() => {
                  menu.close();
                  onCustomize();
                }}
              >
                Personalizar barra lateral
              </MenuItem>
              <MenuItem icon={<PenLine size={18} />} onClick={() => setRenaming(true)}>
                Cambiar nombre
              </MenuItem>
              <MenuItem
                icon={<RotateCcw size={18} />}
                onClick={() => {
                  menu.close();
                  resetTab(tab.id);
                  toast("Pestaña restablecida");
                }}
              >
                Restablecer pestaña
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Trash size={18} />}
                danger
                disabled={tabs.length <= 1}
                onClick={() => {
                  menu.close();
                  deleteTab(tab.id);
                }}
              >
                Eliminar pestaña
              </MenuItem>
            </div>
          )}
        </Popover>
      )}
      {addPop.anchor && (
        <Popover anchor={addPop.anchor} onClose={addPop.close} width={240}>
          <TabPresetMenu onDone={addPop.close} />
        </Popover>
      )}
    </div>
  );
}

/** A tab in "Personalizar barra lateral": its name, its place and "Eliminar pestaña". */
function TabLine({ tab, index, count, active }: { tab: SidebarTab; index: number; count: number; active: boolean }) {
  const Icon = TAB_ICONS[tab.preset];
  return (
    <div className={`sidebar-custom__row${active ? " is-active" : ""}`} data-tab={tab.id}>
      <span className="sidebar-custom__icon">
        <Icon size={18} />
      </span>
      <input
        className="sidebar-custom__tab-name"
        key={tab.name}
        defaultValue={tab.name}
        aria-label="Nombre de la pestaña"
        onFocus={() => setActiveTab(tab.id)}
        onBlur={(e) => renameTab(tab.id, e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Mover a la izquierda"
        data-tooltip="Mover a la izquierda"
        disabled={index === 0}
        onClick={() => moveTab(tab.id, -1)}
      >
        <ArrowLeft size={15} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Mover a la derecha"
        data-tooltip="Mover a la derecha"
        disabled={index === count - 1}
        onClick={() => moveTab(tab.id, 1)}
      >
        <ArrowRight size={15} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Eliminar pestaña"
        data-tooltip="Eliminar pestaña"
        disabled={count <= 1}
        onClick={() => deleteTab(tab.id)}
      >
        <X size={15} />
      </button>
    </div>
  );
}

/**
 * "Personalizar barra lateral": show or hide the top rows and the sections,
 * reorder the sections, and add shortcuts (Nueva página, Mis tareas, a
 * database view) under Inicio, in the open tab; add, rename, reorder and delete
 * tabs. "Restablecer" brings the open tab back as it came.
 */
export function SidebarCustomizer({ onClose }: { onClose: () => void }) {
  const prefs = useSidebarPrefs();
  const { tabs, active } = useSidebarTabs();
  const addPop = usePopover();
  const tabPop = usePopover();
  const [picking, setPicking] = useState(false);
  return (
    <Modal onClose={onClose} className="sidebar-custom" label="Personalizar barra lateral">
      <div className="sidebar-custom__head">
        <span className="sidebar-custom__title">Personalizar barra lateral</span>
        <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="sidebar-custom__body">
        <div className="sidebar-custom__label">Pestañas</div>
        {tabs.map((t, i) => (
          <TabLine key={t.id} tab={t} index={i} count={tabs.length} active={t.id === active} />
        ))}
        {tabs.length < MAX_TABS && (
          <button type="button" className="sidebar-custom__row sidebar-custom__add" onClick={(e) => tabPop.toggle(e.currentTarget)}>
            <span className="sidebar-custom__icon">
              <Plus size={18} />
            </span>
            <span className="sidebar-custom__name">Añadir pestaña</span>
          </button>
        )}

        <div className="sidebar-custom__label">Elementos · {prefs.name}</div>
        {(Object.keys(NAV_LABELS) as NavId[]).map((id) => {
          const on = !prefs.hidden.includes(id);
          return (
            <button key={id} type="button" className="sidebar-custom__row" onClick={() => setHidden(id, on)}>
              <span className="sidebar-custom__icon">{NAV_ICONS[id]}</span>
              <span className="sidebar-custom__name">{NAV_LABELS[id]}</span>
              <Switch on={on} />
            </button>
          );
        })}

        <div className="sidebar-custom__label">Accesos directos</div>
        {prefs.shortcuts.length === 0 && <div className="sidebar-custom__empty">Añade páginas y vistas que usas a menudo.</div>}
        {prefs.shortcuts.map((s) => (
          <ShortcutLine key={s.id} shortcut={s} />
        ))}
        <button type="button" className="sidebar-custom__row sidebar-custom__add" onClick={(e) => addPop.toggle(e.currentTarget)}>
          <span className="sidebar-custom__icon">
            <Plus size={18} />
          </span>
          <span className="sidebar-custom__name">Añadir a la barra lateral</span>
        </button>

        <div className="sidebar-custom__label">Secciones</div>
        {prefs.order.map((id, i) => {
          const on = !prefs.hidden.includes(id);
          return (
            <div key={id} className="sidebar-custom__row" data-section={id}>
              <span className="sidebar-custom__name">{SECTION_LABELS[id]}</span>
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label="Mover hacia arriba"
                data-tooltip="Mover hacia arriba"
                disabled={i === 0}
                onClick={() => moveSection(id, -1)}
              >
                <ArrowUp size={15} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label="Mover hacia abajo"
                data-tooltip="Mover hacia abajo"
                disabled={i === prefs.order.length - 1}
                onClick={() => moveSection(id, 1)}
              >
                <ArrowDown size={15} />
              </button>
              <button
                type="button"
                className="sidebar-custom__switch"
                aria-label={on ? `Ocultar ${SECTION_LABELS[id]}` : `Mostrar ${SECTION_LABELS[id]}`}
                onClick={() => setHidden(id, on)}
              >
                <Switch on={on} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="xot-modal__actions sidebar-custom__actions">
        <button
          type="button"
          className="xot-btn"
          onClick={() => {
            resetTab(active);
            toast("Pestaña restablecida");
          }}
        >
          Restablecer pestaña
        </button>
        <button type="button" className="xot-btn xot-btn--primary" onClick={onClose}>
          Listo
        </button>
      </div>
      {tabPop.anchor && (
        <Popover anchor={tabPop.anchor} onClose={tabPop.close} width={240}>
          <TabPresetMenu onDone={tabPop.close} />
        </Popover>
      )}
      {addPop.anchor && (
        <Popover
          anchor={addPop.anchor}
          onClose={() => {
            addPop.close();
            setPicking(false);
          }}
          width={300}
        >
          {picking ? (
            <ViewPicker
              onPick={(databaseId, viewId) => {
                addShortcut({ kind: "view", databaseId, viewId });
                addPop.close();
                setPicking(false);
              }}
            />
          ) : (
            <div className="menu">
              <MenuItem
                icon={<SquarePen size={18} />}
                onClick={() => {
                  addShortcut({ kind: "new-page" });
                  addPop.close();
                }}
              >
                Nueva página
              </MenuItem>
              <MenuItem
                icon={<CircleCheck size={18} />}
                onClick={() => {
                  addShortcut({ kind: "my-tasks" });
                  addPop.close();
                }}
              >
                Mis tareas
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Sheet size={18} />} onClick={() => setPicking(true)}>
                Vista de base de datos…
              </MenuItem>
            </div>
          )}
        </Popover>
      )}
    </Modal>
  );
}

function ShortcutLine({ shortcut }: { shortcut: Shortcut }) {
  const view = useLiveQuery(
    async () =>
      shortcut.kind === "view"
        ? { block: await db.blocks.get(shortcut.databaseId), view: await db.views.get(shortcut.viewId) }
        : null,
    [shortcut],
  );
  let icon: ReactNode = <SquarePen size={18} />;
  let name = "Nueva página";
  if (shortcut.kind === "my-tasks") {
    icon = <CircleCheck size={18} />;
    name = "Mis tareas";
  } else if (shortcut.kind === "view") {
    const Icon = view?.view ? viewIcon(view.view) : Sheet;
    icon = <Icon size={18} />;
    name = view?.view ? `${pageTitle(view.block)} · ${view.view.name || "Sin título"}` : "Vista eliminada";
  }
  return (
    <div className="sidebar-custom__row">
      <span className="sidebar-custom__icon">{icon}</span>
      <span className="sidebar-custom__name">{name}</span>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Quitar de la barra lateral"
        data-tooltip="Quitar de la barra lateral"
        onClick={() => removeShortcut(shortcut.id)}
      >
        <X size={15} />
      </button>
    </div>
  );
}

/** The databases (full-page and inline) with their views, to pin one in the sidebar. */
export function ViewPicker({ onPick }: { onPick: (databaseId: string, viewId: string) => void }) {
  const [query, setQuery] = useState("");
  const data = useLiveQuery(async () => {
    const dbs = await db.blocks
      .filter((b) => b.alive && b.type === "collection_view_page" && !b.is_template && !isWorkspaceRoot(b.id))
      .toArray();
    const views = await db.views.toArray();
    return dbs
      .map((block) => ({
        block,
        views: views
          .filter((v) => v.parent_id === block.id)
          .sort((a, b) => (block.view_ids ?? []).indexOf(a.id) - (block.view_ids ?? []).indexOf(b.id)),
      }))
      .filter((d) => d.views.length)
      .sort((a, b) => b.block.last_edited_time - a.block.last_edited_time);
  });
  const q = query.trim().toLowerCase();
  const shown = (data ?? []).filter(
    (d) => pageTitle(d.block).toLowerCase().includes(q) || d.views.some((v) => v.name.toLowerCase().includes(q)),
  );
  return (
    <div className="menu view-picker">
      <input
        className="menu-search"
        autoFocus
        placeholder="Buscar una vista…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="view-picker__list">
        {shown.length === 0 && <div className="menu-empty">Sin resultados</div>}
        {shown.slice(0, 40).map((d) => (
          <div key={d.block.id}>
            <MenuLabel>
              <span className="view-picker__db">
                <PageIcon block={d.block} size={14} />
                {pageTitle(d.block)}
              </span>
            </MenuLabel>
            {d.views.map((v) => {
              const Icon = viewIcon(v);
              return (
                <MenuItem key={v.id} icon={<Icon size={18} />} onClick={() => onPick(d.block.id, v.id)}>
                  {v.name || "Sin título"}
                </MenuItem>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Agregar a la barra lateral" in a database view's menu: the view becomes a sidebar shortcut. */
export function AddViewToSidebarItem({ databaseId, viewId, onDone }: { databaseId: string; viewId: string; onDone: () => void }) {
  return (
    <MenuItem
      icon={<PanelLeft size={16} />}
      onClick={() => {
        onDone();
        addShortcut({ kind: "view", databaseId, viewId });
        toast("Vista agregada a la barra lateral");
      }}
    >
      Agregar a la barra lateral
    </MenuItem>
  );
}
