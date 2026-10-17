import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Archive, Check, ChevronDown, Clock, House, Inbox, Search, Settings, Trash, X } from "lucide-react";
import { db } from "../lib/db";
import { isWorkspaceRoot, type Block, type Collection } from "../lib/model";
import { inWorkspace, resolveWorkspace } from "../lib/workspace";
import { navigate, openInNewTab, pageLinkProps, pageTitle, readVisits, wantsNewTab } from "../lib/hooks";
import { INBOX_PIN_EVENT, openPreferences } from "./Sidebar";
import { PagePicker } from "./PagePicker";
import { HOME_ROUTE } from "./HomeView";
import { MenuItem, MenuSeparator, PageIcon, Popover, usePopover } from "./ui";

const LIMIT = 50;
/** The macOS app: ⌘↵ and ⌘-click open a result in a new tab. */
const HAS_TABS = navigator.userAgent.includes("Electron");
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const DAY = 86_400_000;

/** Plain text of a page (body and row properties), cached until the page is edited again. */
const textCache = new Map<string, { edited: number; text: string }>();

/** Block props that hold visible text (button labels, captions…). */
const TEXT_PROPS = ["label", "caption", "name", "title"];

function collectText(node: unknown, out: string[]) {
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (typeof o.text === "string") out.push(o.text);
  const props = o.props as Record<string, unknown> | undefined;
  if (props) for (const key of TEXT_PROPS) if (typeof props[key] === "string") out.push(props[key] as string);
  // A block written as `content: "text"` (seeded pages, BlockNote's shorthand).
  if (typeof o.content === "string") out.push(o.content);
  collectText(o.content, out);
  collectText(o.children, out);
  collectText(o.rows, out);
  collectText(o.cells, out);
}

function pageText(b: Block) {
  const hit = textCache.get(b.id);
  if (hit && hit.edited === b.last_edited_time) return hit.text;
  const out: string[] = [];
  if (b.content) collectText(b.content, out);
  else if (b.content_markdown) out.push(b.content_markdown.replace(/%%xotion[^%]*%%/g, " ").replace(/[*_`#>|~]+/g, ""));
  for (const [key, value] of Object.entries(b.properties)) {
    if (key === "title") continue;
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) if (typeof v === "string") out.push(v);
  }
  const text = out.join(" ").replace(/\s+/g, " ").trim();
  textCache.set(b.id, { edited: b.last_edited_time, text });
  return text;
}

/**
 * Lowercase without accents ("Búsqueda" finds "busqueda"), unit by unit so the
 * result keeps the text's length and a match's index still points into the original.
 */
function fold(text: string) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const f = c.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    out += f.length === 1 ? f : c.toLowerCase().length === 1 ? c.toLowerCase() : c;
  }
  return out;
}

/** Search groups recent pages by when they were edited. */
function groupOf(time: number, today: number) {
  if (time >= today) return "Hoy";
  if (time >= today - DAY) return "Ayer";
  if (time >= today - 7 * DAY) return "Últimos 7 días";
  if (time >= today - 30 * DAY) return "Últimos 30 días";
  return "Más antiguo";
}

const shortDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });
const longDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });
const timeOnly = new Intl.DateTimeFormat("es", { hour: "numeric", minute: "2-digit" });

function rowDate(time: number, today: number) {
  if (time >= today) return timeOnly.format(time);
  return new Date(time).getFullYear() === new Date().getFullYear() ? shortDate.format(time) : longDate.format(time);
}

/** ~60 characters around the match, with the match itself emphasised. */
function snippet(text: string, at: number, length: number): ReactNode {
  const start = Math.max(0, at - 24);
  const end = Math.min(text.length, at + length + 36);
  return (
    <>
      {start > 0 && "…"}
      {text.slice(start, at)}
      <mark>{text.slice(at, at + length)}</mark>
      {text.slice(at + length, end)}
      {end < text.length && "…"}
    </>
  );
}

/** The "Ordenar" chip. */
type SortBy = "best" | "edited-desc" | "edited-asc" | "created-desc" | "created-asc";
const SORTS: { id: SortBy; label: string }[] = [
  { id: "best", label: "Mejor coincidencia" },
  { id: "edited-desc", label: "Última edición: más reciente primero" },
  { id: "edited-asc", label: "Última edición: más antiguo primero" },
  { id: "created-desc", label: "Creado: más reciente primero" },
  { id: "created-asc", label: "Creado: más antiguo primero" },
];

/** The "Fecha" chip: pages last edited (or created) within a range, or between two dates. */
type DateRange = "any" | "today" | "7d" | "30d" | "custom";
type DateField = "edited" | "created";
const DATES: { id: DateRange; label: string }[] = [
  { id: "today", label: "Hoy" },
  { id: "7d", label: "Últimos 7 días" },
  { id: "30d", label: "Últimos 30 días" },
];
const dayDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });
/** "2026-10-01" (a date input) at local midnight. */
const parseDay = (v: string) => (v ? new Date(`${v}T00:00:00`).getTime() : NaN);

/** Typing these goes to a place of the app instead of a page. */
const PLACES: { id: string; label: string; words: string[]; icon: ReactNode }[] = [
  { id: "home", label: "Inicio", words: ["inicio", "home"], icon: <House size={20} /> },
  {
    id: "settings",
    label: "Configuración",
    words: ["configuracion", "ajustes", "preferencias", "settings"],
    icon: <Settings size={20} />,
  },
  { id: "inbox", label: "Bandeja de entrada", words: ["bandeja de entrada", "inbox", "notificaciones"], icon: <Inbox size={20} /> },
  { id: "trash", label: "Papelera", words: ["papelera", "trash"], icon: <Trash size={20} /> },
];

/** The last searches that opened something, newest first ("Búsquedas recientes"). */
const SEARCHES_KEY = "xotion:recent-searches";
function readSearches(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SEARCHES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((q): q is string => typeof q === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}
function saveSearch(q: string) {
  q = q.trim();
  if (!q) return;
  try {
    localStorage.setItem(SEARCHES_KEY, JSON.stringify([q, ...readSearches().filter((x) => x !== q)].slice(0, 5)));
  } catch {
    /* storage unavailable */
  }
}

/** "Quoted phrases" match as they are; the rest are words matched by their beginning. */
function parseQuery(q: string) {
  const phrases: string[] = [];
  const rest = q.replace(/"([^"]*)"?/g, (_, p: string) => {
    if (p.trim()) phrases.push(p.trim());
    return " ";
  });
  return { phrases, words: rest.split(/\s+/).filter(Boolean) };
}

interface Result {
  block: Block;
  path: string;
  /** Ids of the pages above it, for the "En" filter. */
  ancestors: string[];
  /** Where the query appears in the body, when it isn't in the title. */
  hit?: { text: string; at: number; length: number };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Words match by their beginning: "crono" finds "Cronograma" but not
 * "asíncrono". Group 1 is what precedes the word, so a hit starts at
 * index + group length. A term that starts with a symbol matches anywhere.
 */
const wordStart = (term: string) =>
  new RegExp(`${/^[\p{L}\p{N}]/u.test(term) ? "(^|[^\\p{L}\\p{N}])" : "()"}${escapeRegExp(term)}`, "u");

/** Where `re` (a wordStart) first matches in `text`, or -1. */
function wordHit(text: string, re: RegExp) {
  const m = re.exec(text);
  return m ? m.index + m[1].length : -1;
}

/**
 * How well a folded title matches, best first: the whole title, its first word,
 * its start, the start of a word for every term. -1 when a term doesn't start a word.
 */
function titleScore(title: string, q: string, wordStarts: RegExp[]) {
  if (!wordStarts.every((r) => r.test(title))) return -1;
  title = title.trim();
  if (title === q) return 0;
  if (title.startsWith(q)) return /^[\p{L}\p{N}]/u.test(title.slice(q.length)) ? 2 : 1;
  return 3;
}

export function QuickFind({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const data = useLiveQuery(async () => {
    const [blocks, collections] = await Promise.all([db.blocks.toArray(), db.collections.toArray()]);
    return { blocks, collections };
  });
  const [searches] = useState(readSearches);
  const [visits] = useState(readVisits);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(fold(query.trim())), 120);
    return () => clearTimeout(t);
  }, [query]);

  // The pages of the current workspace, newest first, each with its path.
  const pages = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.blocks.map((b) => [b.id, b]));
    const collections = new Map<string, Collection>(data.collections.map((c) => [c.id, c]));
    const parentOf = (b: Block) =>
      b.parent_table === "block"
        ? byId.get(b.parent_id)
        : b.parent_table === "collection"
          ? byId.get(collections.get(b.parent_id)?.parent_id ?? "")
          : undefined;
    const ws = resolveWorkspace(data.blocks);
    const out: { block: Block; path: string; ancestors: string[]; archived: boolean }[] = [];
    for (const b of data.blocks) {
      if (!b.alive || b.is_template || isWorkspaceRoot(b.id)) continue;
      if (b.type !== "page" && b.type !== "collection_view_page") continue;
      const chain: Block[] = [];
      let root = b;
      for (let p = parentOf(b), guard = 0; p && guard < 50; p = parentOf(p), guard++) {
        chain.unshift(p);
        root = p;
      }
      if (!inWorkspace(root, ws)) continue;
      const path = chain
        .filter((a) => !isWorkspaceRoot(a.id))
        .map(pageTitle)
        .join(" / ");
      const archived = !!b.format.archived || chain.some((a) => !!a.format.archived);
      out.push({ block: b, path, ancestors: chain.map((a) => a.id), archived });
    }
    return out.sort((a, b) => b.block.last_edited_time - a.block.last_edited_time);
  }, [data]);

  // The filter chips under the input.
  const [sortBy, setSortBy] = useState<SortBy>("best");
  const [titlesOnly, setTitlesOnly] = useState(false);
  const [inPage, setInPage] = useState<Block | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>("any");
  const [dateField, setDateField] = useState<DateField>("edited");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Archived pages only show with "Archivadas" on ("Incluir páginas archivadas").
  const [withArchived, setWithArchived] = useState(false);
  const sortPop = usePopover();
  const inPop = usePopover();
  const datePop = usePopover();
  const sortTime = (b: Block) => (sortBy.startsWith("created") ? b.created_time : b.last_edited_time);
  // With nothing typed and no filter, the list is the pages visited here, last visited first.
  const filtered = sortBy !== "best" || titlesOnly || !!inPage || dateRange !== "any" || withArchived;
  const byVisit = !debounced && !filtered;

  const results = useMemo<Result[]>(() => {
    const q = debounced;
    const today = new Date().setHours(0, 0, 0, 0);
    let since = dateRange === "today" ? today : dateRange === "7d" ? today - 7 * DAY : dateRange === "30d" ? today - 30 * DAY : 0;
    let until = Infinity;
    if (dateRange === "custom") {
      const f = parseDay(from);
      const t = parseDay(to);
      since = Number.isNaN(f) ? 0 : f;
      until = Number.isNaN(t) ? Infinity : t + DAY;
    }
    const dateOf = (b: Block) => (dateField === "created" ? b.created_time : b.last_edited_time);
    let pool = pages.filter(
      (p) =>
        (withArchived || !p.archived) &&
        (!inPage || p.ancestors.includes(inPage.id)) &&
        (!since || dateOf(p.block) >= since) &&
        dateOf(p.block) < until,
    );
    if (!q && !filtered) {
      const visited = pool.filter((p) => visits[p.block.id]).sort((a, b) => visits[b.block.id] - visits[a.block.id]);
      return (visited.length ? visited : pool).slice(0, LIMIT);
    }
    if (sortBy !== "best" && sortBy !== "edited-desc") {
      const field = sortBy.startsWith("created") ? "created_time" : "last_edited_time";
      const dir = sortBy.endsWith("asc") ? 1 : -1;
      pool = [...pool].sort((a, b) => dir * (a.block[field] - b.block[field]));
    }
    if (!q) return pool.slice(0, LIMIT);
    // Every term has to appear ("plan sem" finds "Plan semanal"); a
    // "quoted phrase" has to appear as it is.
    const { phrases, words: terms } = parseQuery(q);
    if (!terms.length && !phrases.length) return pool.slice(0, LIMIT);
    const wordStarts = terms.map(wordStart);
    const plain = terms.join(" ");
    const wholeStart = plain ? wordStart(plain) : null;
    const titled: (Result & { score: number })[] = [];
    const bodied: Result[] = [];
    for (const p of pool) {
      const title = fold(pageTitle(p.block));
      const phrasesInTitle = phrases.every((ph) => title.includes(ph));
      const score = phrasesInTitle ? (terms.length ? titleScore(title, plain, wordStarts) : 3) : -1;
      if (score >= 0) titled.push({ ...p, score });
      else if (!titlesOnly && titled.length < LIMIT) {
        const text = pageText(p.block);
        const folded = fold(text);
        // Terms may split between the title and the body; the snippet shows the first one in the body.
        const hits = wordStarts.map((r) => wordHit(folded, r));
        if (!wordStarts.every((r, i) => hits[i] !== -1 || r.test(title))) continue;
        const phraseHits = phrases.map((ph) => folded.indexOf(ph));
        if (!phrases.every((ph, i) => phraseHits[i] !== -1 || title.includes(ph))) continue;
        const firstPhrase = phraseHits.findIndex((h) => h !== -1);
        if (firstPhrase !== -1) {
          bodied.push({ ...p, hit: { text, at: phraseHits[firstPhrase], length: phrases[firstPhrase].length } });
          continue;
        }
        const whole = wholeStart ? wordHit(folded, wholeStart) : -1;
        const first = hits.findIndex((h) => h !== -1);
        const at = whole !== -1 ? whole : first !== -1 ? hits[first] : -1;
        if (at !== -1) bodied.push({ ...p, hit: { text, at, length: whole !== -1 ? plain.length : terms[first].length } });
      }
    }
    // Pages arrive newest first and the sort is stable, so ties stay by last edit.
    if (sortBy !== "best") {
      const rank = new Map(pool.map((p, i) => [p.block.id, i]));
      return [...titled, ...bodied].sort((a, b) => rank.get(a.block.id)! - rank.get(b.block.id)!).slice(0, LIMIT);
    }
    titled.sort((a, b) => a.score - b.score);
    return [...titled, ...bodied].slice(0, LIMIT);
  }, [pages, debounced, sortBy, titlesOnly, inPage, dateRange, dateField, from, to, withArchived, filtered, visits]);

  // Places of the app the query names ("inicio", "configuración"…), above the pages.
  const places = useMemo(
    () =>
      debounced.length >= 3
        ? PLACES.filter((p) => p.words.some((w) => w.startsWith(debounced)))
        : [],
    [debounced],
  );
  const recentSearches = !query.trim() && !filtered ? searches : [];
  type Item = { kind: "place"; place: (typeof PLACES)[number] } | { kind: "search"; text: string } | { kind: "page"; r: Result };
  const items: Item[] = [
    ...places.map((place) => ({ kind: "place" as const, place })),
    ...recentSearches.map((text) => ({ kind: "search" as const, text })),
    ...results.map((r) => ({ kind: "page" as const, r })),
  ];

  useEffect(() => setIndex(0), [debounced, sortBy, titlesOnly, inPage, dateRange, dateField, from, to, withArchived]);

  useEffect(() => {
    listRef.current?.querySelector(".find__row.is-highlighted")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const open = (id: string) => {
    saveSearch(query);
    navigate(id);
    onClose();
  };
  const goPlace = (id: string) => {
    saveSearch(query);
    onClose();
    if (id === "home") navigate(HOME_ROUTE);
    else if (id === "settings") openPreferences();
    else if (id === "inbox") window.dispatchEvent(new CustomEvent(INBOX_PIN_EVENT, { detail: true }));
    else if (id === "trash") document.querySelector<HTMLElement>(".app__body > .sidebar .sidebar__trash")?.click();
  };
  const choose = (item: Item, newTab = false) => {
    if (item.kind === "place") goPlace(item.place.id);
    else if (item.kind === "search") {
      setQuery(item.text);
      inputRef.current?.focus();
    } else if (newTab) {
      saveSearch(query);
      openInNewTab(item.r.block.id);
      onClose();
    } else open(item.r.block.id);
  };

  const today = new Date().setHours(0, 0, 0, 0);
  let lastGroup = "";
  const dateLabel =
    dateRange === "any"
      ? "Fecha"
      : `${dateField === "created" ? "Creado" : "Editado"}: ${
          dateRange === "custom"
            ? `${from ? dayDate.format(parseDay(from)) : "…"} – ${to ? dayDate.format(parseDay(to)) : "…"}`
            : DATES.find((o) => o.id === dateRange)?.label
        }`;

  return (
    <div className="find-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* Escape closes it from anywhere inside (the input or a filter chip). */}
      <div className="find" role="dialog" aria-label="Buscar" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="find__input">
          <Search size={18} />
          <input
            ref={inputRef}
            autoFocus
            placeholder="Busca páginas o contenido…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, items.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              }
              // ⌘↵ opens the highlighted page in a new tab (the macOS app).
              if (e.key === "Enter" && items[index]) choose(items[index], wantsNewTab(e));
            }}
          />
        </div>
        <div className="find__filters">
          <button
            type="button"
            className={`find__chip${sortBy !== "best" ? " is-active" : ""}`}
            onClick={(e) => sortPop.toggle(e.currentTarget)}
          >
            {sortBy === "best" ? "Ordenar" : SORTS.find((o) => o.id === sortBy)?.label}
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            className={`find__chip${titlesOnly ? " is-active" : ""}`}
            aria-pressed={titlesOnly}
            onClick={() => setTitlesOnly(!titlesOnly)}
          >
            Solo títulos
          </button>
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
          <button
            type="button"
            className={`find__chip${dateRange !== "any" ? " is-active" : ""}`}
            onClick={(e) => datePop.toggle(e.currentTarget)}
          >
            <span className="find__chip-text">{dateLabel}</span>
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            className={`find__chip${withArchived ? " is-active" : ""}`}
            aria-pressed={withArchived}
            onClick={() => setWithArchived(!withArchived)}
          >
            <Archive size={14} />
            Archivadas
          </button>
        </div>
        {sortPop.anchor && (
          <Popover anchor={sortPop.anchor} onClose={sortPop.close} width={300}>
            <div className="menu">
              {SORTS.map((o) => (
                <MenuItem
                  key={o.id}
                  right={sortBy === o.id ? <Check size={16} /> : undefined}
                  onClick={() => {
                    setSortBy(o.id);
                    sortPop.close();
                  }}
                >
                  {o.label}
                </MenuItem>
              ))}
            </div>
          </Popover>
        )}
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
        {datePop.anchor && (
          <Popover anchor={datePop.anchor} onClose={datePop.close} width={280}>
            <div className="menu find-date">
              <div className="find-date__field" role="radiogroup" aria-label="Fecha de">
                {(
                  [
                    ["edited", "Última edición"],
                    ["created", "Creado"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={dateField === id}
                    className={dateField === id ? "is-active" : ""}
                    onClick={() => setDateField(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <MenuItem
                right={dateRange === "any" ? <Check size={16} /> : undefined}
                onClick={() => {
                  setDateRange("any");
                  datePop.close();
                }}
              >
                Cualquier fecha
              </MenuItem>
              <MenuSeparator />
              {DATES.map((o) => (
                <MenuItem
                  key={o.id}
                  right={dateRange === o.id ? <Check size={16} /> : undefined}
                  onClick={() => {
                    setDateRange(o.id);
                    datePop.close();
                  }}
                >
                  {o.label}
                </MenuItem>
              ))}
              <MenuSeparator />
              <div className="find-date__range">
                <label>
                  <span>Desde</span>
                  <input
                    type="date"
                    className="field"
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value);
                      setDateRange("custom");
                    }}
                  />
                </label>
                <label>
                  <span>Hasta</span>
                  <input
                    type="date"
                    className="field"
                    value={to}
                    onChange={(e) => {
                      setTo(e.target.value);
                      setDateRange("custom");
                    }}
                  />
                </label>
              </div>
            </div>
          </Popover>
        )}
        <div className="find__results" ref={listRef}>
          {data && items.length === 0 && <p className="find__empty">Sin resultados</p>}
          {items.map((item, i) => {
            const group =
              item.kind === "place"
                ? "Ir a"
                : item.kind === "search"
                  ? "Búsquedas recientes"
                  : byVisit
                    ? groupOf(visits[item.r.block.id] ?? item.r.block.last_edited_time, today)
                    : debounced && sortBy === "best"
                      ? "Mejores coincidencias"
                      : groupOf(sortTime(item.r.block), today);
            const header = group !== lastGroup;
            lastGroup = group;
            const q = debounced;
            const cls = `find__row${i === index ? " is-highlighted" : ""}`;
            if (item.kind !== "page")
              return (
                <Fragment key={`${item.kind}:${item.kind === "place" ? item.place.id : item.text}`}>
                  {header && <div className="find__group">{group}</div>}
                  <button
                    type="button"
                    className={`${cls} find__row--${item.kind}`}
                    onMouseMove={() => i !== index && setIndex(i)}
                    onClick={() => choose(item)}
                  >
                    <span className="find__row-icon">{item.kind === "place" ? item.place.icon : <Clock size={18} />}</span>
                    <span className="find__main">
                      <span className="find__line">
                        <span className="find__title">{item.kind === "place" ? item.place.label : item.text}</span>
                      </span>
                    </span>
                  </button>
                </Fragment>
              );
            const r = item.r;
            return (
              <Fragment key={r.block.id}>
                {header && <div className="find__group">{group}</div>}
                <button
                  type="button"
                  className={cls}
                  onMouseMove={() => i !== index && setIndex(i)}
                  {...pageLinkProps(r.block.id, () => open(r.block.id), onClose)}
                >
                  <PageIcon block={r.block} size={20} />
                  <span className="find__main">
                    <span className="find__line">
                      <span className="find__title">{pageTitle(r.block)}</span>
                      {r.path && <span className="find__path">— {r.path}</span>}
                    </span>
                    {r.hit && q && <span className="find__snippet">{snippet(r.hit.text, r.hit.at, r.hit.length)}</span>}
                  </span>
                  <span className="find__date">
                    {rowDate(byVisit ? (visits[r.block.id] ?? r.block.last_edited_time) : sortTime(r.block), today)}
                  </span>
                </button>
              </Fragment>
            );
          })}
        </div>
        <div className="find__footer">
          <span>
            <kbd>↑↓</kbd> Seleccionar
          </span>
          <span>
            <kbd>↵</kbd> Abrir
          </span>
          {HAS_TABS && (
            <span>
              <kbd>{mod}↵</kbd> Abrir en una pestaña nueva
            </span>
          )}
          <span>
            <kbd>esc</kbd> Cerrar
          </span>
        </div>
      </div>
    </div>
  );
}
