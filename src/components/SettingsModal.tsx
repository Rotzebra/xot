import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Building2, Check, ChevronDown, House, Import, Settings2, Smile, Trash2, X } from "lucide-react";
import { addCustomEmoji, emojiName, removeCustomEmoji, useCustomEmojis } from "../lib/customEmoji";
import { exportBackup, readBackup, restoreBackup } from "../lib/backup";
import { WorkspaceExportDialog } from "./ExportDialog";
import { formatBytes, pickFiles, storageUsage, sweepOrphanFiles } from "../lib/files";
import { acceleratorFor, shortcutLabel, useDesktopPrefs } from "../lib/desktop";
import { localTimeZone, timeZones, zoneName } from "../lib/timezones";
import { DESKTOP } from "./TitleBar";
import { setThemeSetting, useBlock, useThemeSetting, pageTitle, type ThemeSetting } from "../lib/hooks";
import { updateSettings, useSettings, type Settings } from "../lib/settings";
import { HOME_ROUTE } from "./HomeView";
import { ImportSources } from "./ImportDialog";
import { PagePicker } from "./PagePicker";
import { confirmDialog, EmojiPicker, MenuItem, MenuSeparator, Modal, PageIcon, Popover, Switch, toast, usePopover } from "./ui";
import { isWorkspaceRoot, type Block } from "../lib/model";
import { setIcon, setTitle } from "../lib/ops";
import { LOCAL_WORKSPACE_EVENT, LOCAL_WORKSPACE_KEY, loadWorkspace, useStoredWorkspace } from "../lib/workspace";

type Section = "preferences" | "workspace" | "emoji" | "import";

const SECTIONS: { id: Section; group: string; label: string; icon: ReactNode }[] = [
  { id: "preferences", group: "Cuenta", label: "Preferencias", icon: <Settings2 size={18} /> },
  { id: "workspace", group: "Espacio de trabajo", label: "General", icon: <Building2 size={18} /> },
  { id: "emoji", group: "Espacio de trabajo", label: "Emoji", icon: <Smile size={18} /> },
  { id: "import", group: "Espacio de trabajo", label: "Importar", icon: <Import size={18} /> },
];

const THEMES: [ThemeSetting, string][] = [
  ["system", "Usar la configuración del sistema"],
  ["light", "Claro"],
  ["dark", "Oscuro"],
];

/** A setting: name and description on the left, its control on the right. */
function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="app-settings-row">
      <div className="app-settings-row__text">
        <div className="app-settings-row__title">{title}</div>
        <div className="app-settings-row__desc">{description}</div>
      </div>
      <div className="app-settings-row__control">{children}</div>
    </div>
  );
}

function ThemeSelect() {
  const theme = useThemeSetting();
  const pop = usePopover();
  return (
    <>
      <button type="button" className="xot-select" onClick={(e) => pop.toggle(e.currentTarget)}>
        <span>{THEMES.find(([id]) => id === theme)?.[1]}</span>
        <ChevronDown size={14} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={240} align="end">
          <div className="menu">
            {THEMES.map(([id, label]) => (
              <MenuItem
                key={id}
                right={theme === id ? <Check size={16} /> : undefined}
                onClick={() => {
                  setThemeSetting(id);
                  pop.close();
                }}
              >
                {label}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Contraste alto: the system's "Aumentar contraste", or always standard or high. */
const CONTRASTS: [Settings["contrast"], string][] = [
  ["system", "Usar la configuración del sistema"],
  ["standard", "Contraste estándar"],
  ["high", "Contraste alto"],
];

function ContrastSelect() {
  const { contrast } = useSettings();
  const pop = usePopover();
  return (
    <>
      <button type="button" className="xot-select" aria-label="Contraste alto" onClick={(e) => pop.toggle(e.currentTarget)}>
        <span>{CONTRASTS.find(([id]) => id === contrast)?.[1]}</span>
        <ChevronDown size={14} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={260} align="end">
          <div className="menu">
            {CONTRASTS.map(([id, label]) => (
              <MenuItem
                key={id}
                right={contrast === id ? <Check size={16} /> : undefined}
                onClick={() => {
                  updateSettings({ contrast: id });
                  pop.close();
                }}
              >
                {label}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** "Zona horaria": every IANA zone, by city and offset, with a search. */
function TimeZoneSelect({ disabled }: { disabled: boolean }) {
  const { timeZone, autoTimeZone } = useSettings();
  const current = autoTimeZone || !timeZone ? localTimeZone() : timeZone;
  const pop = usePopover();
  const [query, setQuery] = useState("");
  const zones = useMemo(() => timeZones().map((tz) => ({ tz, name: zoneName(tz) })), []);
  const q = query.trim().toLowerCase();
  const shown = q ? zones.filter((z) => z.tz.toLowerCase().includes(q) || z.name.toLowerCase().includes(q)) : zones;
  const close = () => {
    pop.close();
    setQuery("");
  };
  return (
    <>
      <button type="button" className="xot-select" aria-label="Zona horaria" disabled={disabled} onClick={(e) => pop.toggle(e.currentTarget)}>
        <span className="xot-select__text">{zoneName(current)}</span>
        <ChevronDown size={14} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={close} width={300} align="end">
          <div className="tz-picker">
            <input className="field" autoFocus placeholder="Elige tu zona horaria" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="menu tz-picker__list">
              {shown.length ? (
                shown.slice(0, 400).map(({ tz, name }) => (
                  <MenuItem
                    key={tz}
                    right={tz === current ? <Check size={16} /> : undefined}
                    onClick={() => {
                      updateSettings({ timeZone: tz });
                      close();
                    }}
                  >
                    {name}
                  </MenuItem>
                ))
              ) : (
                <div className="tz-picker__empty">No se encontró la zona horaria</div>
              )}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

/** A switch button for a setting row. */
function SettingSwitch({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="app-settings-switch" aria-pressed={on} aria-label={label} disabled={disabled} onClick={onToggle}>
      <Switch on={on} />
    </button>
  );
}

/** "Atajo de Atajo de búsqueda": a field that takes the next key combination pressed. */
function ShortcutField({ value, onChange }: { value: string; onChange: (accelerator: string) => Promise<string | null> }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="shortcut-field">
      <button
        type="button"
        className={`xot-select shortcut-field__btn${recording ? " is-recording" : ""}`}
        aria-label="Atajo de Atajo de búsqueda"
        onClick={() => {
          setError("");
          setRecording(true);
        }}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") return setRecording(false);
          const accelerator = acceleratorFor(e);
          if (!accelerator) return;
          setRecording(false);
          void onChange(accelerator).then((problem) => setError(problem ?? ""));
        }}
      >
        {recording ? "Pulsa el atajo…" : shortcutLabel(value)}
      </button>
      {error && <div className="shortcut-field__error">{error}</div>}
    </div>
  );
}

/** Preferencias > App de escritorio (the macOS app). */
function DesktopSection() {
  const settings = useSettings();
  const [prefs, setPrefs] = useDesktopPrefs();
  if (!prefs) return null;
  return (
    <>
      <h3 className="app-settings__subtitle">App de escritorio</h3>
      <SettingRow title="Abrir Xot al iniciar sesión" description="Xot se abre solo cuando inicias sesión en este Mac.">
        <SettingSwitch on={prefs.openAtLogin} label="Abrir Xot al iniciar sesión" onToggle={() => void setPrefs({ openAtLogin: !prefs.openAtLogin })} />
      </SettingRow>
      <SettingRow
        title="Búsqueda en una pestaña nueva"
        description="Abre la búsqueda cuando abras una nueva pestaña. Si esta opción está desactivada, las pestañas nuevas aplicarán la configuración de Abrir al iniciar."
      >
        <SettingSwitch
          on={settings.newTabSearch}
          label="Búsqueda en una pestaña nueva"
          onToggle={() => updateSettings({ newTabSearch: !settings.newTabSearch })}
        />
      </SettingRow>
      <SettingRow title="Usar Atajo de búsqueda" description="Abre la búsqueda de Xot con un atajo, incluso cuando la aplicación no esté activa.">
        <SettingSwitch on={prefs.commandSearch} label="Usar Atajo de búsqueda" onToggle={() => void setPrefs({ commandSearch: !prefs.commandSearch })} />
      </SettingRow>
      <SettingRow
        title="Atajo de Atajo de búsqueda"
        description={
          prefs.commandSearch && !prefs.shortcutActive
            ? `${shortcutLabel(prefs.searchShortcut)} ya está en uso: elige otro.`
            : "Personaliza el atajo designado para activar el Atajo de búsqueda."
        }
      >
        <ShortcutField
          value={prefs.searchShortcut}
          onChange={async (accelerator) => {
            const next = await setPrefs({ searchShortcut: accelerator });
            if (next?.error === "modifier") return "Usa “Opción”, “Control” o “Comando” para los atajos generales del teclado";
            if (next?.error === "in-use") return `${shortcutLabel(accelerator)} ya está en uso`;
            return null;
          }}
        />
      </SettingRow>
      <SettingRow title="Mostrar Xot en la barra de menú" description="Accede a Xot más rápido desde la parte superior derecha de la pantalla.">
        <SettingSwitch
          on={prefs.menuBarIcon}
          disabled={!prefs.commandSearch}
          label="Mostrar Xot en la barra de menú"
          onToggle={() => void setPrefs({ menuBarIcon: !prefs.menuBarIcon })}
        />
      </SettingRow>
    </>
  );
}

function StartPageSelect() {
  const { startPage } = useSettings();
  const home = startPage === HOME_ROUTE;
  const page = useBlock(startPage === "last" || home ? null : startPage);
  const pop = usePopover();
  const [picking, setPicking] = useState(false);
  const close = () => {
    pop.close();
    setPicking(false);
  };
  return (
    <>
      <button type="button" className="xot-select" onClick={(e) => pop.toggle(e.currentTarget)}>
        {home ? (
          <>
            <House size={16} />
            <span className="xot-select__text">Inicio</span>
          </>
        ) : page ? (
          <>
            <PageIcon block={page} size={16} />
            <span className="xot-select__text">{pageTitle(page)}</span>
          </>
        ) : (
          <span>Última página visitada</span>
        )}
        <ChevronDown size={14} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={close} width={picking ? 320 : 240} align="end">
          {picking ? (
            <PagePicker
              placeholder="Buscar una página…"
              onPick={(p) => {
                updateSettings({ startPage: p.id });
                close();
              }}
            />
          ) : (
            <div className="menu">
              <MenuItem
                right={!page && !home ? <Check size={16} /> : undefined}
                onClick={() => {
                  updateSettings({ startPage: "last" });
                  close();
                }}
              >
                Última página visitada
              </MenuItem>
              <MenuItem
                right={home ? <Check size={16} /> : undefined}
                onClick={() => {
                  updateSettings({ startPage: HOME_ROUTE });
                  close();
                }}
              >
                Inicio
              </MenuItem>
              <MenuSeparator />
              <MenuItem right={page ? <Check size={16} /> : undefined} onClick={() => setPicking(true)}>
                {page ? pageTitle(page) : "Elegir una página…"}
              </MenuItem>
            </div>
          )}
        </Popover>
      )}
    </>
  );
}

function Preferences() {
  const settings = useSettings();
  return (
    <>
      <h2 className="app-settings__title">Preferencias</h2>
      <SettingRow title="Nombre preferido" description="Cómo te saluda Xot en Inicio.">
        <input
          className="field app-settings__name"
          aria-label="Nombre preferido"
          placeholder="Tu nombre"
          value={settings.name}
          onChange={(e) => updateSettings({ name: e.target.value })}
        />
      </SettingRow>
      <SettingRow title="Apariencia" description="Personaliza el aspecto de Xot en tu dispositivo.">
        <ThemeSelect />
      </SettingRow>
      <SettingRow title="Contraste alto" description="Aumenta el contraste para mejorar la visibilidad">
        <ContrastSelect />
      </SettingRow>
      <SettingRow title="Abrir al iniciar" description="Elige lo que se muestra cuando abres Xot.">
        <StartPageSelect />
      </SettingRow>
      <h3 className="app-settings__subtitle">Fecha y hora</h3>
      <SettingRow
        title="Iniciar la semana el lunes"
        description="Esto cambiará el aspecto de todos los calendarios de tu aplicación."
      >
        <button
          type="button"
          className="app-settings-switch"
          aria-pressed={settings.weekStartsMonday}
          aria-label="Iniciar la semana el lunes"
          onClick={() => updateSettings({ weekStartsMonday: !settings.weekStartsMonday })}
        >
          <Switch on={settings.weekStartsMonday} />
        </button>
      </SettingRow>
      {/* The macOS app runs its pages in the zone; a browser tab keeps the system's. */}
      {DESKTOP && (
        <>
          <SettingRow
            title="Establece automáticamente la zona horaria según tu ubicación"
            description="Los recordatorios y las fechas se mostrarán teniendo en cuenta tu zona horaria"
          >
            <SettingSwitch
              on={settings.autoTimeZone}
              label="Establece automáticamente la zona horaria según tu ubicación"
              onToggle={() =>
                updateSettings({ autoTimeZone: !settings.autoTimeZone, timeZone: settings.timeZone || localTimeZone() })
              }
            />
          </SettingRow>
          <SettingRow title="Zona horaria" description="Elige tu zona horaria">
            <TimeZoneSelect disabled={settings.autoTimeZone} />
          </SettingRow>
        </>
      )}
      {DESKTOP && <DesktopSection />}
    </>
  );
}

/** Configuración > General > Almacenamiento: what Xot keeps on this device, and freeing what nothing uses. */
function StorageSection() {
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof storageUsage>> | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => void storageUsage().then(setUsage);
  useEffect(refresh, []);
  // Files uploaded in the last minute stay (their page may not have saved them yet).
  const free = async () => {
    setBusy(true);
    try {
      const { count, bytes } = await sweepOrphanFiles(Date.now() + 24 * 3600 * 1000 - 60 * 1000);
      toast(count ? `Se liberaron ${formatBytes(bytes)} (${count.toLocaleString("es")} ${count === 1 ? "archivo" : "archivos"})` : "No hay archivos sin usar");
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h3 className="app-settings__subtitle">Almacenamiento</h3>
      <SettingRow
        title="Espacio usado en este dispositivo"
        description={
          usage
            ? [
                usage.total !== null ? `${formatBytes(usage.total)} en total` : null,
                `${formatBytes(usage.files)} en ${usage.fileCount.toLocaleString("es")} ${usage.fileCount === 1 ? "archivo adjunto" : "archivos adjuntos"}`,
                usage.persisted === false ? "el navegador puede borrarlos si falta espacio" : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : "Calculando…"
        }
      >
        <span className="storage-usage">{usage?.total != null ? formatBytes(usage.total) : usage ? formatBytes(usage.files) : ""}</span>
      </SettingRow>
      <SettingRow
        title="Liberar espacio"
        description="Elimina los archivos subidos que ya no usa ninguna página (ni las de la papelera), versión ni comentario."
      >
        <button type="button" className="xot-btn" disabled={busy} onClick={() => void free()}>
          Liberar espacio
        </button>
      </SettingRow>
    </>
  );
}

type LocalWorkspace = { name?: string; icon?: string };

function readLocalWorkspace(): LocalWorkspace {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_WORKSPACE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/**
 * The top of General: the open workspace's name and icon. They write
 * what the switcher's "Cambiar nombre" writes: the workspace block's title and
 * icon, or the local space's {name, icon}.
 */
function WorkspaceIdentity() {
  const stored = useStoredWorkspace();
  const wsId = useLiveQuery(() => loadWorkspace(), [stored]);
  const block = useBlock(wsId && isWorkspaceRoot(wsId) ? wsId : null);
  const [local, setLocalState] = useState(readLocalWorkspace);
  const [title, setTitleText] = useState<string | null>(null);
  const iconPop = usePopover();
  if (wsId === undefined || (isWorkspaceRoot(wsId) && !block)) return null;
  const setLocal = (next: LocalWorkspace) => {
    setLocalState(next);
    try {
      localStorage.setItem(LOCAL_WORKSPACE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new Event(LOCAL_WORKSPACE_EVENT));
  };
  const name = block ? (title ?? String(block.properties.title ?? "")) : (local.name ?? "Xot");
  const icon = block ? block.format.icon : local.icon;
  const pickIcon = (emoji: string | undefined) => {
    if (block) void setIcon(block.id, emoji);
    else setLocal({ ...local, icon: emoji });
    iconPop.close();
  };
  return (
    <>
      <SettingRow title="Nombre" description="Puedes usar el nombre de tu empresa u organización.">
        <input
          className="field app-settings__name"
          aria-label="Nombre del espacio de trabajo"
          value={name}
          placeholder={block ? "Sin título" : "Xot"}
          onChange={(e) => {
            if (block) {
              setTitleText(e.target.value);
              void setTitle(block.id, e.target.value);
            } else setLocal({ ...local, name: e.target.value });
          }}
        />
      </SettingRow>
      <SettingRow title="Ícono" description="Sube una imagen o elige un emoji. Aparecerá en la barra lateral.">
        <button
          type="button"
          className="app-settings__ws-icon"
          aria-label="Cambiar ícono del espacio de trabajo"
          onClick={(e) => iconPop.toggle(e.currentTarget)}
        >
          {icon ? (
            <PageIcon block={block ?? ({ type: "page", format: { icon }, properties: {} } as unknown as Block)} size={32} />
          ) : (
            <span className="app-settings__ws-letter">{name.trim().charAt(0).toUpperCase() || "X"}</span>
          )}
        </button>
      </SettingRow>
      {iconPop.anchor && (
        <Popover anchor={iconPop.anchor} onClose={iconPop.close} width={408} align="end">
          <EmojiPicker onPick={(emoji) => pickIcon(emoji)} onRemove={icon ? () => pickIcon(undefined) : undefined} />
        </Popover>
      )}
    </>
  );
}

function Workspace() {
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      toast(e instanceof Error ? e.message : "No se pudo completar la acción");
    } finally {
      setBusy(false);
    }
  };
  const restore = () =>
    run(async () => {
      const [file] = await pickFiles(".json,application/json");
      if (!file) return;
      const backup = await readBackup(file);
      const when = new Date(backup.exported_time).toLocaleString("es");
      const ok = await confirmDialog({
        text: `¿Restaurar la copia de seguridad del ${when}? Las páginas que contiene reemplazarán a las de este equipo.`,
        confirm: "Restaurar",
      });
      if (!ok) return;
      const count = await restoreBackup(backup);
      toast(`Copia de seguridad restaurada: ${count.toLocaleString("es")} bloques`);
    });
  return (
    <>
      <h2 className="app-settings__title">General</h2>
      <WorkspaceIdentity />
      <h3 className="app-settings__subtitle">Exportar</h3>
      <SettingRow
        title="Exportar todo el contenido del espacio de trabajo"
        description="Todas las páginas y bases de datos en un archivo .zip, en HTML o en Markdown y CSV."
      >
        <button type="button" className="xot-btn" disabled={busy} onClick={() => setExporting(true)}>
          Exportar todo
        </button>
      </SettingRow>
      {exporting && <WorkspaceExportDialog onClose={() => setExporting(false)} />}
      <SettingRow
        title="Copia de seguridad"
        description="Una copia (.json) con todas las páginas, bases de datos, comentarios, versiones y archivos de este equipo, para restaurarla en Xot."
      >
        <button type="button" className="xot-btn" disabled={busy} onClick={() => void run(async () => void (await exportBackup()))}>
          Descargar copia
        </button>
      </SettingRow>
      <SettingRow
        title="Importar copia de seguridad"
        description="Restaura una copia exportada desde Xot. No se elimina nada que no esté en la copia."
      >
        <button type="button" className="xot-btn" disabled={busy} onClick={() => void restore()}>
          Importar
        </button>
      </SettingRow>
      <StorageSection />
    </>
  );
}

/** Emoji: the workspace's custom emoji (a picture and a name), for page icons and ":nombre" in the text. */
function EmojiSection() {
  const emojis = useCustomEmojis();
  const [file, setFile] = useState<{ blob: File; src: string } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    const [picked] = await pickFiles("image/*");
    if (!picked) return;
    setFile({ blob: picked, src: URL.createObjectURL(picked) });
    setName(emojiName(picked.name));
  };
  const add = async () => {
    if (!file || !emojiName(name)) return;
    setBusy(true);
    try {
      const saved = await addCustomEmoji(file.blob, name);
      toast(`Emoji :${saved}: añadido`);
      setFile(null);
      setName("");
    } catch {
      toast("No se pudo leer la imagen");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2 className="app-settings__title">Emoji</h2>
      <p className="app-settings__lead">
        Emoji personalizados de este espacio de trabajo. Úsalos como icono de una página o en el texto: escribe «:» y su nombre.
      </p>
      <div className="custom-emoji-add">
        <button type="button" className="custom-emoji-add__pick" onClick={() => void choose()} aria-label="Elegir imagen">
          {file ? <img src={file.src} alt="" /> : <Smile size={20} />}
        </button>
        <input
          className="field"
          placeholder="Nombre del emoji"
          aria-label="Nombre del emoji"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <button type="button" className="xot-btn xot-btn--primary" disabled={busy || !file || !emojiName(name)} onClick={() => void add()}>
          Añadir emoji
        </button>
      </div>
      {emojis.length ? (
        <ul className="custom-emoji-list">
          {emojis.map((e) => (
            <li key={e.name}>
              <img src={e.src} alt="" />
              <span>:{e.name}:</span>
              <button type="button" className="icon-btn" aria-label={`Eliminar :${e.name}:`} onClick={() => void removeCustomEmoji(e.name)}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="app-settings__lead">Todavía no hay emoji personalizados.</p>
      )}
    </>
  );
}

/** Importar: the sources Xot reads, each one into the workspace's top level. */
function ImportSection({ onClose }: { onClose: () => void }) {
  return (
    <>
      <h2 className="app-settings__title">Importar</h2>
      <p className="app-settings__lead">
        Importa archivos desde tu equipo como páginas privadas. Cada CSV se convierte en una base de datos.
      </p>
      <ImportSources onDone={onClose} />
    </>
  );
}

/** Configuración: a 240px menu on the left, the chosen section on the right. */
export function SettingsModal({ onClose, initial = "preferences" }: { onClose: () => void; initial?: Section }) {
  const [section, setSection] = useState<Section>(initial);
  return (
    <Modal onClose={onClose} className="app-settings" label="Configuración">
      <nav className="app-settings__nav">
        {SECTIONS.map((s, i) => (
          <div key={s.id}>
            {(i === 0 || SECTIONS[i - 1].group !== s.group) && <div className="app-settings__group">{s.group}</div>}
            <button
              type="button"
              className={`app-settings__tab${section === s.id ? " is-active" : ""}`}
              onClick={() => setSection(s.id)}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          </div>
        ))}
      </nav>
      <div className="app-settings__body">
        <button type="button" className="icon-btn app-settings__close" aria-label="Cerrar" onClick={onClose}>
          <X size={18} />
        </button>
        {section === "preferences" ? (
          <Preferences />
        ) : section === "import" ? (
          <ImportSection onClose={onClose} />
        ) : section === "emoji" ? (
          <EmojiSection />
        ) : (
          <Workspace />
        )}
      </div>
    </Modal>
  );
}
