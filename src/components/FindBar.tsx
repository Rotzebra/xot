import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, ChevronUp, X } from "lucide-react";
import type { EditorView } from "@tiptap/pm/view";

/**
 * ⌘F: a small search box at the top right of the window that
 * highlights every match on the page (the active one in orange), ↵ / ⇧↵ and
 * ⌘G / ⇧⌘G step through them and Esc closes it. Only Xot.app has it: in a
 * browser, ⌘F is the browser's own find bar.
 *
 * Matches are painted with the CSS Custom Highlight API, so the page's DOM
 * (the editor's above all) is never touched.
 */
const DESKTOP = navigator.userAgent.includes("Electron");

/** "open", "next" or "prev": the Editar menu's Buscar items (and tests) send it. */
export const FIND_EVENT = "xot:find";

const ALL = "xot-find";
const ACTIVE = "xot-find-active";

/** Lowercase without accents, one character per character, as Chromium's find matches. */
const foldChar = (c: string) => {
  const f = c.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return f.length === 1 ? f : c.toLowerCase().length === 1 ? c.toLowerCase() : c;
};

/**
 * The element whose line of text `el` sits in: its nearest ancestor that isn't inline. Text split
 * by formatting (bold, a link, a color) shares it, so a match can span those pieces, as in Chromium.
 */
function lineOf(el: Element, cache: Map<Element, Element>): Element {
  const hit = cache.get(el);
  if (hit) return hit;
  let line = el;
  while (line.parentElement && /^(inline|contents)$/.test(getComputedStyle(line).display)) line = line.parentElement;
  cache.set(el, line);
  return line;
}

/** Every visible occurrence of `query` in the page's content, in document order. */
function findRanges(query: string): Range[] {
  const needle = [...query].map(foldChar).join("");
  const root = document.querySelector(".main");
  if (!needle.trim() || !root) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const el = node.parentElement;
      // Not the top bar's path, nor a field's own text (a <textarea>'s text node is its first value, not what it shows).
      if (!el || !node.nodeValue?.trim() || el.closest("[hidden], script, style, textarea, input, .topbar, .find-bar"))
        return NodeFilter.FILTER_REJECT;
      return el.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  // Runs of text nodes on one line, searched as one string.
  const cache = new Map<Element, Element>();
  const lines: Text[][] = [];
  let last: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const line = lineOf(node.parentElement!, cache);
    if (line === last) lines[lines.length - 1].push(node as Text);
    else lines.push([node as Text]);
    last = line;
  }
  for (const nodes of lines) {
    // Folded text, with each folded character's node and offset in the original.
    let folded = "";
    const at: [Text, number][] = [];
    for (const node of nodes) {
      const text = node.nodeValue!;
      for (let i = 0; i < text.length; ) {
        const ch = String.fromCodePoint(text.codePointAt(i)!);
        const f = foldChar(ch);
        folded += f;
        for (let k = 0; k < f.length; k++) at.push([node, i]);
        i += ch.length;
      }
    }
    const end = nodes[nodes.length - 1];
    at.push([end, end.nodeValue!.length]);
    for (let from = folded.indexOf(needle); from !== -1; from = folded.indexOf(needle, from + needle.length)) {
      const range = document.createRange();
      range.setStart(...at[from]);
      // The end: just after the last matched character, in its own node.
      const [lastNode, lastAt] = at[from + needle.length - 1];
      const ch = String.fromCodePoint(lastNode.nodeValue!.codePointAt(lastAt)!);
      range.setEnd(lastNode, lastAt + ch.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** The editor a match can be replaced in (page text, not a mention's label nor a locked page), or null. */
function editableView(r: Range): EditorView | null {
  const el = r.startContainer.parentElement;
  const dom = el?.closest<HTMLElement & { editor?: { view: EditorView } }>(".ProseMirror");
  const view = dom?.editor?.view;
  if (!view || !view.editable) return null;
  for (const node of [r.startContainer, r.endContainer])
    if (node.parentElement?.closest('[contenteditable="false"]')?.closest(".ProseMirror") === dom) return null;
  return r.endContainer.parentElement?.closest(".ProseMirror") === dom ? view : null;
}

/**
 * Replaces the matches that are text of the page's editors (one edit each, so ⌘Z undoes it); the title,
 * database cells and locked pages stay as they are. Returns how many were replaced.
 */
function replaceRanges(ranges: Range[], text: string): number {
  const edits = new Map<EditorView, { from: number; to: number }[]>();
  for (const r of ranges) {
    const view = editableView(r);
    if (!view) continue;
    try {
      const from = view.posAtDOM(r.startContainer, r.startOffset);
      const to = view.posAtDOM(r.endContainer, r.endOffset);
      if (to > from) edits.set(view, [...(edits.get(view) ?? []), { from, to }]);
    } catch {
      // Not in the editor's document.
    }
  }
  let n = 0;
  for (const [view, list] of edits) {
    // Last first, so the earlier positions stay where they were.
    let tr = view.state.tr;
    for (const { from, to } of list.sort((a, b) => b.from - a.from)) {
      tr = text ? tr.insertText(text, from, to) : tr.delete(from, to);
      n++;
    }
    view.dispatch(tr);
  }
  return n;
}

const highlights = () => (typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null);

function paint(ranges: Range[], active: number) {
  const registry = highlights();
  if (!registry) return;
  registry.set(ALL, new Highlight(...ranges));
  if (ranges[active]) registry.set(ACTIVE, new Highlight(ranges[active]));
  else registry.delete(ACTIVE);
}

function clear() {
  highlights()?.delete(ALL);
  highlights()?.delete(ACTIVE);
}

/** Scrolls the match into view when it is off screen (or under the topbar). */
function reveal(range: Range | undefined) {
  if (!range) return;
  const r = range.getBoundingClientRect();
  if (r.top < 90 || r.bottom > window.innerHeight - 20) range.startContainer.parentElement?.scrollIntoView({ block: "center" });
}

export function FindBar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState({ active: 0, total: 0 });
  // "Reemplazar": the second row, with what the matches become.
  const [replacing, setReplacing] = useState(false);
  const [replacement, setReplacement] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const state = useRef({ query: "", active: 0, ranges: [] as Range[] });

  /** Searches again (the page may have changed) and shows the match `step` places from the active one. */
  const search = (step: number, text = state.current.query, at?: number) => {
    const ranges = findRanges(text);
    const prev = state.current;
    let active = 0;
    const cur = prev.ranges[prev.active];
    if (ranges.length && step !== 0) {
      // From where the active match is now (the page may have changed around it), wrapping at either end.
      const order = (r: Range) => (cur ? r.compareBoundaryPoints(Range.START_TO_START, cur) : 0);
      if (step > 0) active = cur ? Math.max(0, ranges.findIndex((r) => order(r) > 0)) : 0;
      else {
        const after = cur ? ranges.findIndex((r) => order(r) >= 0) : -1;
        active = after <= 0 ? ranges.length - 1 : after - 1;
      }
    }
    if (step === 0 && at !== undefined) active = Math.min(at, Math.max(0, ranges.length - 1));
    state.current = { query: text, active, ranges };
    paint(ranges, active);
    reveal(ranges[active]);
    setCount({ active: ranges.length ? active + 1 : 0, total: ranges.length });
  };

  /** The active match (or every one) becomes the replacement; the next one is then active. */
  const replace = (all: boolean) => {
    // Found again first: the page may have changed since.
    search(0, state.current.query, state.current.active);
    const fresh = state.current.ranges;
    // The active match, or the first one after it that can be replaced (wrapping): the button never does nothing.
    let at = state.current.active;
    if (!all) {
      const order = [...fresh.keys()].slice(at).concat([...fresh.keys()].slice(0, at));
      const next = order.find((i) => editableView(fresh[i]));
      if (next === undefined) return;
      at = next;
    }
    replaceRanges(all ? fresh : [fresh[at]], replacement);
    window.setTimeout(() => search(0, state.current.query, all ? 0 : at), 0);
  };

  const close = () => {
    setOpen(false);
    clear();
    state.current = { query: state.current.query, active: 0, ranges: [] };
  };

  const run = (command: string) => {
    if (command === "open" || command === "replace") {
      setOpen(true);
      if (command === "replace") setReplacing(true);
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
      if (state.current.query) search(0);
    } else if (command === "next" || command === "prev") {
      if (!state.current.query) return run("open");
      setOpen(true);
      search(command === "next" ? 1 : -1);
    } else if (command === "close") close();
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const onFind = (e: Event) => runRef.current((e as CustomEvent<string>).detail);
    // Xot.app: ⌘F, ⌘G and ⇧⌘G (the Editar menu sends the same keys when its items are clicked).
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!DESKTOP || !(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      // ⌥⌘F: find and replace.
      if (e.altKey) {
        if (e.code !== "KeyF" || e.shiftKey) return;
        runRef.current("replace");
      } else if (key === "f" && !e.shiftKey) runRef.current("open");
      else if (key === "g") runRef.current(e.shiftKey ? "prev" : "next");
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener(FIND_EVENT, onFind);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener(FIND_EVENT, onFind);
      window.removeEventListener("keydown", onKey, true);
      clear();
    };
  }, []);

  // Another page: its matches (once it has rendered).
  useEffect(() => {
    if (!open) return;
    const onRoute = () => window.setTimeout(() => state.current.query && search(0), 400);
    window.addEventListener("hashchange", onRoute);
    return () => window.removeEventListener("hashchange", onRoute);
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      search(e.shiftKey ? -1 : 1);
    }
  };

  return (
    <div className={`find-bar${replacing ? " find-bar--replace" : ""}`} role="search">
      <button
        type="button"
        className="icon-btn find-bar__btn find-bar__toggle"
        aria-label={replacing ? "Ocultar reemplazar" : "Reemplazar"}
        aria-expanded={replacing}
        data-tooltip="Reemplazar"
        onClick={() => setReplacing((r) => !r)}
      >
        <ChevronRight size={16} />
      </button>
      <input
        ref={input}
        className="find-bar__input"
        placeholder="Buscar en la página"
        value={query}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          state.current = { ...state.current, ranges: [], active: 0 };
          search(0, e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <span className="find-bar__count">{query.trim() ? `${count.active}/${count.total}` : ""}</span>
      <button type="button" className="icon-btn find-bar__btn" aria-label="Anterior" disabled={!count.total} onClick={() => search(-1)}>
        <ChevronUp size={16} />
      </button>
      <button type="button" className="icon-btn find-bar__btn" aria-label="Siguiente" disabled={!count.total} onClick={() => search(1)}>
        <ChevronDown size={16} />
      </button>
      <button type="button" className="icon-btn find-bar__btn" aria-label="Cerrar" onClick={close}>
        <X size={16} />
      </button>
      {replacing && (
        <div className="find-bar__replace">
          <input
            className="find-bar__input"
            placeholder="Reemplazar con"
            aria-label="Reemplazar con"
            value={replacement}
            spellCheck={false}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                replace(e.metaKey || e.ctrlKey);
              }
            }}
          />
          <button type="button" className="find-bar__action" disabled={!count.total} onClick={() => replace(false)}>
            Reemplazar
          </button>
          <button type="button" className="find-bar__action" disabled={!count.total} onClick={() => replace(true)}>
            Reemplazar todo
          </button>
        </div>
      )}
    </div>
  );
}
