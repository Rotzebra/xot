import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { Modal } from "./ui";
import { DESKTOP } from "./TitleBar";

/** Ayuda > Atajos del teclado and ⌘⌥/ toggle the sheet (App.tsx). */
export const SHORTCUTS_EVENT = "xot:shortcuts";

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl";
const ALT = MAC ? "⌥" : "Alt";
const SHIFT = MAC ? "⇧" : "Shift";

type Shortcut = { description: string; keys: string[] };
type Section = { title?: string; shortcuts: Shortcut[] };
type Group = { id: string; label: string; sections: Section[]; desktop?: boolean };

const k = (...keys: string[]) => keys;

// The keyboard shortcuts dialog, with the shortcuts Xot has (es-LA wording).
const S = {
  quickFind: { description: "Activa la búsqueda o accede a una página vista recientemente", keys: k(MOD, "P") },
  search: { description: "Busca en la página actual", keys: k(MOD, "F") },
  link: { description: "Agrega un enlace al texto seleccionado", keys: k(MOD, "K") },
  copyLink: { description: "Copia la URL de una página", keys: k(MOD, "L") },
  goBack: { description: "Vuelve a la página anterior", keys: k(MOD, "[") },
  goForward: { description: "Pasa a la página siguiente", keys: k(MOD, "]") },
  goUp: { description: "Visita la página principal", keys: k(MOD, SHIFT, "U") },
  dark: { description: "Activa/desactiva el modo oscuro", keys: k(MOD, SHIFT, "L") },
  settings: { description: "Abrir configuración", keys: k(MOD, ",") },
  sidebar: { description: "Muestra u oculta la barra lateral", keys: k(MOD, "\\") },
  shortcuts: { description: "Muestra los atajos de teclado", keys: k(MOD, ALT, "/") },
  newPage: { description: "Crea una página nueva", keys: k(MOD, "N") },
  newTab: { description: "Crea una nueva pestaña de Xot", keys: k(MOD, "T") },
  closeTab: { description: "Cierra la pestaña", keys: k(MOD, "W") },
  reopenTab: { description: "Vuelve a abrir la última pestaña cerrada", keys: k(MOD, SHIFT, "T") },
  nextTab: { description: "Muestra la pestaña siguiente", keys: k("⌃", "Tab") },
  pickTab: { description: "Muestra la pestaña 1 a 8 (⌘9: la última)", keys: k(MOD, "1…9") },
  newWindow: { description: "Nueva ventana de Xot", keys: k(MOD, SHIFT, "N") },
  openLinkAsNewTab: { description: "Abrir enlace en una nueva pestaña", keys: k(MOD, "clic") },
  openPageAsNewWindow: { description: "Abrir página en una nueva ventana", keys: k(MOD, SHIFT, "clic") },
  commandSearch: { description: "Atajo de búsqueda, con Xot en segundo plano", keys: k(ALT, MOD, "K") },
  enter: { description: "Inserta una línea de texto", keys: k("↩") },
  shiftEnter: { description: "Salto de línea dentro del bloque de texto", keys: k(SHIFT, "↩") },
  comment: { description: "Crea un comentario", keys: k(MOD, SHIFT, "M") },
  bold: { description: "Aplica el formato negrita al texto seleccionado", keys: k(MOD, "B") },
  italics: { description: "Aplica el formato cursiva al texto seleccionado", keys: k(MOD, "I") },
  underline: { description: "Subraya el texto seleccionado", keys: k(MOD, "U") },
  strike: { description: "Tacha el texto seleccionado", keys: k(MOD, SHIFT, "S") },
  code: { description: "Crea código integrado", keys: k(MOD, "E") },
  equation: { description: "Convierte el texto seleccionado en una ecuación", keys: k(MOD, SHIFT, "E") },
  highlight: { description: "Resalta el texto seleccionado con el último color", keys: k(MOD, SHIFT, "H") },
  tab: { description: "Aplica sangría al contenido", keys: k("Tab") },
  untab: { description: "Quita la sangría al contenido", keys: k(SHIFT, "Tab") },
  turnInto: { description: "Convierte el tipo de bloque en uno diferente", keys: k(MOD, "/") },
  todo: { description: "Convierte en lista de tareas pendientes", keys: k(MOD, ALT, "4") },
  bullets: { description: "Convierte en lista con viñetas", keys: k(MOD, ALT, "5") },
  numbers: { description: "Convierte en lista numerada", keys: k(MOD, ALT, "6") },
  toggle: { description: "Convierte en lista desplegable", keys: k(MOD, ALT, "7") },
  codeBlock: { description: "Convierte en bloque de código", keys: k(MOD, ALT, "8") },
  toPage: { description: "Convierte en página", keys: k(MOD, ALT, "9") },
  zoomIn: { description: "Acerca", keys: k(MOD, "+") },
  zoomOut: { description: "Aleja", keys: k(MOD, "-") },
  duplicate: { description: "Duplica los bloques seleccionados", keys: k(MOD, "D") },
  esc: { description: "Selecciona el bloque actual", keys: k("Esc") },
  selectAll: { description: "Selecciona un bloque con el cursor", keys: k(MOD, "A") },
  space: { description: "Abre la imagen seleccionada a pantalla completa", keys: k("Espacio") },
  arrows: { description: "Selecciona un bloque diferente", keys: k("↑", "↓") },
  extend: { description: "Amplía la selección de bloques", keys: k(SHIFT, "↑", "↓") },
  backspace: { description: "Elimina los bloques seleccionados", keys: k("⌫") },
  moveTo: { description: "Mueve el bloque a una página diferente", keys: k(MOD, SHIFT, "P") },
  toggleAll: { description: "Expande/cierra todos los menús desplegables", keys: k(MOD, ALT, "T") },
  blockLink: { description: "Copia el enlace al bloque", keys: k(MOD, ALT, "L") },
  rename: { description: "Cambia el nombre de la página abierta", keys: k(MOD, SHIFT, "R") },
  undo: { description: "Deshace la última acción", keys: k(MOD, "Z") },
  find: { description: "Buscar y reemplazar", keys: k(MOD, ALT, "F") },
} satisfies Record<string, Shortcut>;

const GROUPS: Group[] = [
  {
    id: "popular",
    label: "Popular",
    sections: [
      {
        shortcuts: [S.search, S.quickFind, S.link, S.copyLink, S.goBack, S.goForward, S.goUp, S.dark, S.settings, S.sidebar, S.shortcuts],
      },
    ],
  },
  {
    id: "desktop",
    label: "Versión de escritorio",
    desktop: true,
    sections: [
      {
        shortcuts: [
          S.newPage,
          S.newTab,
          S.closeTab,
          S.reopenTab,
          S.nextTab,
          S.pickTab,
          S.openPageAsNewWindow,
          S.openLinkAsNewTab,
          S.newWindow,
          S.commandSearch,
          S.zoomIn,
          S.zoomOut,
        ],
      },
    ],
  },
  {
    id: "create",
    label: "Crear y dar formato",
    sections: [
      {
        shortcuts: [
          S.enter,
          S.shiftEnter,
          S.comment,
          S.bold,
          S.italics,
          S.underline,
          S.strike,
          S.link,
          S.code,
          S.equation,
          S.highlight,
          S.tab,
          S.untab,
          S.todo,
          S.bullets,
          S.numbers,
          S.toggle,
          S.codeBlock,
          S.toPage,
          S.rename,
          S.find,
        ],
      },
    ],
  },
  {
    id: "edit",
    label: "Editar y mover",
    sections: [
      {
        shortcuts: [
          S.esc,
          S.selectAll,
          S.arrows,
          S.extend,
          S.space,
          S.backspace,
          S.duplicate,
          S.turnInto,
          S.moveTo,
          S.toggleAll,
          S.blockLink,
          S.undo,
        ],
      },
    ],
  },
  {
    id: "markdown",
    label: "Markdown",
    sections: [
      {
        title: "Estilo markdown",
        shortcuts: [
          { description: "Texto en negrita (entre **)", keys: ["**texto**"] },
          { description: "Texto en cursiva (entre *)", keys: ["*texto*"] },
          { description: "Código integrado (entre `)", keys: ["`código`"] },
          { description: "Tachado (entre ~)", keys: ["~texto~"] },
          { description: "Crea un encabezado E1", keys: ["# + espacio"] },
          { description: "Crea un encabezado E2", keys: ["## + espacio"] },
          { description: "Crea un encabezado E3", keys: ["### + espacio"] },
          { description: "Crea una lista con viñetas", keys: ["- / * / + + espacio"] },
          { description: "Crea una lista numerada", keys: ["1. + espacio"] },
          { description: "Crea una casilla de verificación de tareas", keys: ["[] + espacio"] },
          { description: "Crea una lista desplegable", keys: ["> + espacio"] },
          { description: "Crea un bloque de cita", keys: ['" + espacio'] },
          { description: "Crea un divisor", keys: ["---"] },
          { description: "Crea un bloque de código", keys: ["``` + espacio"] },
        ],
      },
    ],
  },
  {
    id: "commands",
    label: "Comandos",
    sections: [
      {
        title: "Comandos @",
        shortcuts: [
          { description: "Menciona a una persona", keys: ["@persona"] },
          { description: "Menciona una página", keys: ["@página"] },
          { description: "Menciona una fecha", keys: ["@fecha"] },
          { description: "Agrega un recordatorio", keys: ["@recordar"] },
        ],
      },
      {
        title: "Comandos entre corchetes",
        shortcuts: [{ description: "Enlace a una página", keys: ["[[nombre de la página"] }],
      },
      {
        title: "Comandos de barra",
        shortcuts: [
          { description: "Abre el menú de bloques", keys: ["/"] },
          { description: "Abre el selector de emojis", keys: [":nombre"] },
        ],
      },
    ],
  },
];

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Atajos del teclado: the shortcuts by topic, as pills on top, with a search. */
export function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  const groups = useMemo(() => GROUPS.filter((g) => !g.desktop || DESKTOP), []);
  const [active, setActive] = useState(groups[0].id);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const q = fold(query.trim());
  // Searching looks through every topic but Popular (its rows repeat the others').
  const shown = q
    ? groups
        .filter((g) => g.id !== "popular")
        .map((g) => ({
          ...g,
          sections: g.sections
            .map((s) => ({ ...s, shortcuts: s.shortcuts.filter((x) => fold(x.description).includes(q) || fold(x.keys.join(" ")).includes(q)) }))
            .filter((s) => s.shortcuts.length),
        }))
        .filter((g) => g.sections.length)
    : groups.filter((g) => g.id === active);
  return (
    <Modal onClose={onClose} className="shortcuts" label="Atajos del teclado">
      <h2 className="shortcuts__title">Atajos del teclado</h2>
      <button type="button" className="icon-btn shortcuts__close" aria-label="Cerrar" onClick={onClose}>
        <X size={18} />
      </button>
      <div className="shortcuts__bar">
        {!searching && (
          <div className="shortcuts__pills" role="tablist">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={g.id === active}
                className={`shortcuts__pill${g.id === active ? " is-active" : ""}`}
                onClick={() => setActive(g.id)}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}
        <div className={`shortcuts__search${searching ? " is-open" : ""}`}>
          {searching ? (
            <>
              <Search size={16} />
              <input
                autoFocus
                aria-label="Buscar atajos"
                placeholder="Buscar…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  e.stopPropagation();
                  setQuery("");
                  setSearching(false);
                }}
              />
              <button
                type="button"
                className="shortcuts__search-close"
                aria-label="Cerrar búsqueda"
                onClick={() => {
                  setQuery("");
                  setSearching(false);
                }}
              >
                <X size={14} />
              </button>
            </>
          ) : (
            <button type="button" className="shortcuts__search-btn" aria-label="Buscar…" data-tooltip="Buscar…" onClick={() => setSearching(true)}>
              <Search size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="shortcuts__content">
        {shown.length ? (
          shown.map((g) => (
            <section key={g.id} className="shortcuts__group">
              {q && <h3 className="shortcuts__group-title">{g.label}</h3>}
              {g.sections.map((s, i) => (
                <div key={i} className="shortcuts__section">
                  {s.title && <h4 className="shortcuts__section-title">{s.title}</h4>}
                  {s.shortcuts.map((x) => (
                    <div key={x.description} className="shortcuts__row">
                      <span className="shortcuts__desc">{x.description}</span>
                      <span className="shortcuts__keys">
                        {x.keys.map((key) => (
                          <kbd key={key} className="shortcuts__key">
                            {key}
                          </kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))
        ) : (
          <div className="shortcuts__empty">
            <div className="shortcuts__empty-title">No se encontraron resultados</div>
            <div className="shortcuts__empty-text">Intenta buscar con una palabra clave diferente o explora las categorías anteriores.</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
