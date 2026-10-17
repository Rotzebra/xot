import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Bold, Calendar, Code, Italic, Link, Strikethrough, Underline } from "lucide-react";
import type { Block, PropertyValue, RichRun } from "../../lib/model";
import { db } from "../../lib/db";
import { navigate, pageTitle } from "../../lib/hooks";
import { PageIcon } from "../ui";

type Style = NonNullable<RichRun["styles"]>[number];
const STYLE_CLASS: Record<Style, string> = { b: "is-bold", i: "is-italic", u: "is-underline", s: "is-strike", c: "is-code" };
const STYLE_TAG: Record<Style, string> = { b: "B", i: "I", u: "U", s: "S", c: "CODE" };
const STYLE_ORDER: Style[] = ["b", "i", "u", "s", "c"];

/** A text property's formatting, when it still matches its plain value (changed elsewhere, it shows plain). */
export function richRunsOf(row: Block, propertyId: string, value: PropertyValue | undefined): RichRun[] | null {
  const runs = row.rich?.[propertyId];
  if (!runs?.length || typeof value !== "string") return null;
  return runs.map((r) => r.text).join("") === value ? runs : null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** "16 de octubre de 2026", as date mentions read. */
const dateLabel = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric" });

/** A formatted text value: styles, links, and page and date mentions (pages show their live title and icon). */
export function RichTextValue({ runs }: { runs: RichRun[] }) {
  const ids = runs.flatMap((r) => (r.page ? [r.page] : []));
  const pages = useLiveQuery(async () => (ids.length ? db.blocks.bulkGet(ids) : []), [ids.join()]);
  const byId = new Map((pages ?? []).flatMap((p) => (p ? [[p.id, p] as const] : [])));
  return (
    <span className="rich-text">
      {runs.map((run, i) => {
        const cls = (run.styles ?? []).map((st) => STYLE_CLASS[st]).join(" ");
        if (run.page) {
          const page = byId.get(run.page);
          return (
            <span
              key={i}
              className={`mention mention--page${page?.alive ? "" : " mention--missing"}`}
              onClick={(e) => {
                if (!page?.alive) return;
                e.stopPropagation();
                navigate(page.id);
              }}
            >
              {page?.alive && <PageIcon block={page} size={16} />}
              <span className="mention__title">{page?.alive ? pageTitle(page) || "Sin título" : run.text}</span>
            </span>
          );
        }
        if (run.date)
          return (
            <span key={i} className="mention mention--date">
              @{dateLabel(run.date)}
            </span>
          );
        if (run.link) {
          const href = /^[a-z][\w+.-]*:/i.test(run.link) ? run.link : `https://${run.link}`;
          return (
            <a
              key={i}
              className={`rich-text__part rich-text__link ${cls}`}
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {run.text}
            </a>
          );
        }
        return (
          <span key={i} className={`rich-text__part ${cls}`}>
            {run.text}
          </span>
        );
      })}
    </span>
  );
}

// ------------------------------------------------------------- DOM <-> runs

function mentionNode(run: RichRun): HTMLElement {
  const el = document.createElement("span");
  el.contentEditable = "false";
  el.className = `mention ${run.page ? "mention--page" : "mention--date"}`;
  if (run.page) el.dataset.page = run.page;
  if (run.date) el.dataset.date = run.date;
  el.dataset.text = run.text;
  el.textContent = run.page ? run.text || "Sin título" : `@${dateLabel(run.date!)}`;
  return el;
}

function runsToDom(root: HTMLElement, runs: RichRun[]) {
  root.textContent = "";
  for (const run of runs) {
    if (run.page || run.date) {
      root.append(mentionNode(run));
      continue;
    }
    let node: Node = document.createDocumentFragment();
    run.text.split("\n").forEach((line, i) => {
      if (i) node.appendChild(document.createElement("br"));
      if (line) node.appendChild(document.createTextNode(line));
    });
    for (const st of STYLE_ORDER)
      if (run.styles?.includes(st)) {
        const el = document.createElement(STYLE_TAG[st]);
        el.append(node);
        node = el;
      }
    if (run.link) {
      const a = document.createElement("a");
      a.href = run.link;
      a.append(node);
      node = a;
    }
    root.append(node);
  }
}

const TAG_STYLE: Record<string, Style> = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", S: "s", STRIKE: "s", DEL: "s", CODE: "c" };

function domToRuns(root: HTMLElement): RichRun[] {
  const runs: RichRun[] = [];
  const push = (run: RichRun) => {
    const last = runs[runs.length - 1];
    const same = (a: RichRun, b: RichRun) =>
      !a.page && !a.date && !b.page && !b.date && a.link === b.link && (a.styles ?? []).join() === (b.styles ?? []).join();
    if (last && same(last, run)) last.text += run.text;
    else runs.push(run);
  };
  const walk = (node: Node, styles: Style[], link: string | undefined) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/ /g, " ").replace(/​/g, "");
      if (text) push({ text, ...(styles.length ? { styles: STYLE_ORDER.filter((s) => styles.includes(s)) } : {}), ...(link ? { link } : {}) });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.page) return void runs.push({ text: node.dataset.text ?? node.textContent ?? "", page: node.dataset.page });
    if (node.dataset.date) return void runs.push({ text: node.dataset.text ?? node.textContent ?? "", date: node.dataset.date });
    if (node.tagName === "BR") return push({ text: "\n" });
    // Chrome wraps new lines in <div>s: each starts a line.
    if ((node.tagName === "DIV" || node.tagName === "P") && node !== root && runs.length) push({ text: "\n" });
    const next = [...styles];
    const tagStyle = TAG_STYLE[node.tagName];
    if (tagStyle && !next.includes(tagStyle)) next.push(tagStyle);
    const css = node.style;
    if (css && (css.fontWeight === "bold" || Number(css.fontWeight) >= 600) && !next.includes("b")) next.push("b");
    if (css?.fontStyle === "italic" && !next.includes("i")) next.push("i");
    const href = node.tagName === "A" ? node.getAttribute("href") || undefined : link;
    node.childNodes.forEach((child) => walk(child, next, href));
  };
  root.childNodes.forEach((child) => walk(child, [], undefined));
  // A trailing line break is only the editor's placeholder.
  while (runs.length && !runs[runs.length - 1].page && !runs[runs.length - 1].date && runs[runs.length - 1].text.endsWith("\n")) {
    const last = runs[runs.length - 1];
    last.text = last.text.slice(0, -1);
    if (!last.text) runs.pop();
  }
  return runs;
}

// ------------------------------------------------------------------ editor

interface MentionChoice {
  key: string;
  label: string;
  page?: Block;
  date?: string;
}

/**
 * The text property editor: a floating box over the cell where text can be
 * bold (⌘B), italic (⌘I), underlined (⌘U), struck (⌘⇧S), code (⌘E) or a link (⌘K),
 * and "@" mentions a page or a date. Enter saves (Shift+Enter is a new line), Escape cancels.
 */
export function RichCellEditor({
  anchor,
  runs,
  onCommit,
  onCancel,
}: {
  anchor: HTMLElement;
  runs: RichRun[];
  onCommit: (text: string, runs: RichRun[] | undefined) => void;
  onCancel: () => void;
}) {
  const [box, setBox] = useState<{ rect: DOMRect; style: React.CSSProperties } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [linkDraft, setLinkDraft] = useState<{ range: Range; url: string } | null>(null);
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (!commit || !ref.current) return onCancel();
    const next = domToRuns(ref.current);
    const text = next.map((r) => r.text).join("");
    const plain = next.every((r) => !r.styles?.length && !r.link && !r.page && !r.date);
    onCommit(text, plain ? undefined : next);
  };

  useLayoutEffect(() => {
    const cs = getComputedStyle(anchor);
    const style: React.CSSProperties = { padding: cs.padding, lineHeight: cs.lineHeight, fontSize: cs.fontSize };
    const place = () => setBox({ rect: anchor.getBoundingClientRect(), style });
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  const ready = box !== null;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    runsToDom(el, runs);
    el.focus();
    const sel = getSelection();
    sel?.selectAllChildren(el);
    sel?.collapseToEnd();
    // Only once the box is placed: later renders keep what's being typed.
  }, [ready]);

  useEffect(() => {
    const onSelection = () => {
      const sel = getSelection();
      const el = ref.current;
      setHasSelection(!!(el && sel && sel.rangeCount && !sel.isCollapsed && el.contains(sel.anchorNode)));
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, []);

  const q = mention?.query.toLowerCase() ?? "";
  const choices = useLiveQuery(async (): Promise<MentionChoice[]> => {
    if (!mention) return [];
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const dates: MentionChoice[] = [
      { key: "today", label: "Hoy", date: isoDay(today) },
      { key: "tomorrow", label: "Mañana", date: isoDay(tomorrow) },
      { key: "yesterday", label: "Ayer", date: isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)) },
    ].filter((d) => !q || d.label.toLowerCase().startsWith(q));
    // A typed date: "@16/10/2026" or "@2026-10-16".
    const m = q.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/) ?? q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const [y, mo, d] = m[1].length === 4 ? [+m[1], +m[2], +m[3]] : [+m[3], +m[2], +m[1]];
      const typed = new Date(y, mo - 1, d);
      if (typed.getMonth() === mo - 1) dates.unshift({ key: "typed", label: "Fecha", date: isoDay(typed) });
    }
    const pages: Block[] = [];
    await db.blocks
      .filter((b) => b.alive && !b.is_template && !b.format.archived && (pageTitle(b) || "").toLowerCase().includes(q))
      .until(() => pages.length >= 6)
      .each((b) => void pages.push(b));
    const pageChoices = pages.map((page) => ({ key: page.id, label: pageTitle(page) || "Sin título", page }));
    // A query that names a date ("@mañana", "@16/10/2026") puts it first.
    return q ? [...dates, ...pageChoices] : [...pageChoices, ...dates];
  }, [mention?.query, !!mention]);

  /** The "@query" just typed before the caret, if any. */
  const mentionContext = () => {
    const sel = getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !ref.current?.contains(node)) return null;
    const before = (node.textContent ?? "").slice(0, sel.anchorOffset);
    const m = before.match(/(^|\s)@([^\s@]{0,30})$/);
    return m ? { node: node as Text, start: sel.anchorOffset - m[2].length - 1, end: sel.anchorOffset, query: m[2] } : null;
  };

  const insertMention = (choice: MentionChoice) => {
    const ctx = mentionContext();
    setMention(null);
    if (!ctx) return;
    const range = document.createRange();
    range.setStart(ctx.node, ctx.start);
    range.setEnd(ctx.node, ctx.end);
    range.deleteContents();
    const el = mentionNode(choice.page ? { text: choice.label, page: choice.page.id } : { text: `@${dateLabel(choice.date!)}`, date: choice.date });
    const space = document.createTextNode(" ");
    range.insertNode(space);
    range.insertNode(el);
    const sel = getSelection();
    sel?.removeAllRanges();
    const after = document.createRange();
    after.setStart(space, 1);
    after.collapse(true);
    sel?.addRange(after);
  };

  const toggleCode = () => {
    const sel = getSelection();
    const el = ref.current;
    if (!sel?.rangeCount || sel.isCollapsed || !el) return;
    const range = sel.getRangeAt(0);
    let node: Node | null = range.commonAncestorContainer;
    while (node && node !== el && !(node instanceof HTMLElement && node.tagName === "CODE")) node = node.parentNode;
    if (node && node !== el) {
      const code = node as HTMLElement;
      code.replaceWith(...code.childNodes);
      return;
    }
    const code = document.createElement("code");
    code.append(range.extractContents());
    range.insertNode(code);
    sel.selectAllChildren(code);
  };

  const startLink = () => {
    const sel = getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    setLinkDraft({ range: sel.getRangeAt(0).cloneRange(), url: "" });
  };
  const applyLink = () => {
    if (!linkDraft) return;
    const url = linkDraft.url.trim();
    const sel = getSelection();
    ref.current?.focus();
    sel?.removeAllRanges();
    sel?.addRange(linkDraft.range);
    if (url) document.execCommand("createLink", false, /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`);
    else document.execCommand("unlink");
    setLinkDraft(null);
  };

  const format = (style: Style | "link") => {
    if (style === "c") return toggleCode();
    if (style === "link") return startLink();
    document.execCommand({ b: "bold", i: "italic", u: "underline", s: "strikeThrough" }[style]);
  };

  if (!box) return null;
  const { rect } = box;
  const list = choices ?? [];
  return createPortal(
    <div
      className="cell-editor rich-cell-editor"
      role="dialog"
      aria-label="Editar valor"
      style={{ ...box.style, top: rect.top, left: rect.left, minWidth: rect.width, maxWidth: Math.max(rect.width, 500) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        ref={ref}
        className="cell-editor__input rich-cell-editor__input"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={(e) => {
          // Clicks on the toolbar, the link field or the mention menu keep editing.
          if (e.relatedTarget instanceof Node && e.currentTarget.parentElement?.contains(e.relatedTarget)) return;
          if (linkDraft || mention) return;
          finish(true);
        }}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
        onInput={() => {
          const ctx = mentionContext();
          setMention(ctx ? { query: ctx.query, index: 0 } : null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (mention && list.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setMention({ ...mention, index: (mention.index + step + list.length) % list.length });
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              insertMention(list[Math.min(mention.index, list.length - 1)]);
              return;
            }
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            if (mention) return setMention(null);
            return finish(false);
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) document.execCommand("insertLineBreak");
            else finish(true);
            return;
          }
          if (!(e.metaKey || e.ctrlKey)) return;
          const key = e.key.toLowerCase();
          const style: Style | "link" | null =
            key === "b" ? "b" : key === "i" ? "i" : key === "u" ? "u" : key === "e" ? "c" : key === "k" ? "link" : e.shiftKey && (key === "s" || key === "x") ? "s" : null;
          if (style) {
            // ⌘K and the others are app shortcuts too (search…): here they format.
            e.preventDefault();
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            format(style);
          }
        }}
      />
      {(hasSelection || linkDraft) && (
        <div className="rich-cell-editor__toolbar" onMouseDown={(e) => e.preventDefault()}>
          {linkDraft ? (
            <input
              className="field field--sm rich-cell-editor__link"
              autoFocus
              placeholder="Pega un enlace…"
              value={linkDraft.url}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => setLinkDraft({ ...linkDraft, url: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyLink();
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setLinkDraft(null);
                  ref.current?.focus();
                }
              }}
              onBlur={() => setLinkDraft(null)}
            />
          ) : (
            (
              [
                ["b", Bold, "Negrita", "⌘B"],
                ["i", Italic, "Cursiva", "⌘I"],
                ["u", Underline, "Subrayado", "⌘U"],
                ["s", Strikethrough, "Tachado", "⌘⇧S"],
                ["c", Code, "Código", "⌘E"],
                ["link", Link, "Enlace", "⌘K"],
              ] as const
            ).map(([style, Icon, label, shortcut]) => (
              <button
                key={style}
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label={label}
                data-tooltip={label}
                data-shortcut={shortcut}
                onClick={() => format(style)}
              >
                <Icon size={15} />
              </button>
            ))
          )}
        </div>
      )}
      {mention && list.length > 0 && (
        <div className="menu rich-cell-editor__mentions" onMouseDown={(e) => e.preventDefault()}>
          {list.map((c, i) => (
            <button
              type="button"
              key={c.key}
              className={`menu-item${i === mention.index ? " is-highlighted" : ""}`}
              onMouseEnter={() => setMention({ ...mention, index: i })}
              onClick={() => insertMention(c)}
            >
              <span className="menu-item__icon">{c.page ? <PageIcon block={c.page} size={16} /> : <Calendar size={16} />}</span>
              <span className="menu-item__label">{c.date ? `${c.label} · ${dateLabel(c.date)}` : c.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
