import katex from "katex";
import { db } from "./db";
import type { Block, Collection, FileRef, PageRef, PropertySchema, PropertyValue } from "./model";
import { evaluate, PERCENT_AGGREGATIONS } from "./compute";
import { cellValue } from "./query";
import { formatNumber } from "./format";
import { downloadBlob, FILE_SCHEME, safeFileName } from "./files";
import { makeZip, type ZipEntry } from "./zip";
import { isWorkspaceRoot } from "./model";
import { LOCAL_USER, type StoredThread } from "./comments";

// Plain readers over the stored BlockNote document, so the page menu can
// count words and export (Markdown, HTML, PDF, CSV) without mounting an editor.

interface Inline {
  type: string;
  text?: string;
  href?: string;
  styles?: Record<string, unknown>;
  content?: Inline[];
}

interface DocBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: Inline[] | { type: "tableContent"; rows: { cells: unknown[] }[] };
  children?: DocBlock[];
}

/** Inline content as a list: BlockNote's `content: "text"` shorthand (templates) is plain text. */
const inlineList = (items: unknown): Inline[] =>
  Array.isArray(items) ? (items as Inline[]) : typeof items === "string" ? [{ type: "text", text: items, styles: {} }] : [];

function inlineMarkdown(items: Inline[] | undefined): string {
  return inlineList(items)
    .map((item) => {
      if (item.type === "link") return `[${inlineMarkdown(item.content)}](${item.href ?? ""})`;
      if (item.type === "inlineEquation") return `$${String((item as { props?: { latex?: string } }).props?.latex ?? "")}$`;
      let text = item.text ?? "";
      if (!text.trim()) return text;
      const s = item.styles ?? {};
      if (s.code) text = `\`${text}\``;
      if (s.bold) text = `**${text}**`;
      if (s.italic) text = `*${text}*`;
      if (s.strike) text = `~~${text}~~`;
      return text;
    })
    .join("");
}

function inlineText(items: Inline[] | undefined): string {
  return inlineList(items).map((i) => (i.type === "link" ? inlineText(i.content) : (i.text ?? ""))).join("");
}

function cellText(cell: unknown): string {
  if (Array.isArray(cell)) return inlineText(cell as Inline[]);
  const content = (cell as { content?: Inline[] } | null)?.content;
  return inlineText(content);
}

function blocksOf(block: Block): DocBlock[] {
  return Array.isArray(block.content) ? (block.content as DocBlock[]) : [];
}

/** Words in a text: runs with a letter or a digit. */
export const countWords = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
/** Characters in a text (spaces included, line breaks not). */
export const countChars = (text: string) => [...text.replace(/[\r\n]+/g, "")].length;

/** Words in the page body ("Recuento de palabras"). */
export function wordCount(block: Block): number {
  return countWords(bodyText(block));
}

/** Characters in the page body. */
export function charCount(block: Block): number {
  return countChars(bodyText(block).trim());
}

function bodyText(block: Block): string {
  let text = "";
  const walk = (list: DocBlock[]) => {
    for (const b of list) {
      if (Array.isArray(b.content)) text += `\n${inlineText(b.content)}`;
      else if (b.content?.type === "tableContent")
        for (const row of b.content.rows) for (const cell of row.cells) text += `\n${cellText(cell)}`;
      walk(b.children ?? []);
    }
  };
  if (block.content?.length) walk(blocksOf(block));
  else text = block.content_markdown ?? "";
  return text;
}

/** A Markdown block; consecutive list items join without a blank line (tight lists). */
type MarkdownChunk = { text: string; list: boolean };

const LIST_TYPES = new Set(["bulletListItem", "toggleListItem", "numberedListItem", "checkListItem"]);

function joinMarkdown(chunks: MarkdownChunk[]) {
  return chunks.map((c, i) => (i === 0 ? "" : c.list && chunks[i - 1].list ? "\n" : "\n\n") + c.text).join("");
}

async function toMarkdown(list: DocBlock[], depth: number, ctx: ExportContext = PLAIN): Promise<MarkdownChunk[]> {
  const out: MarkdownChunk[] = [];
  const pad = "    ".repeat(depth);
  let number = 0;
  for (const b of list) {
    const text = Array.isArray(b.content) ? inlineMarkdown(b.content) : "";
    const push = (line: string) => out.push({ text: line, list: LIST_TYPES.has(b.type) });
    number = b.type === "numberedListItem" ? number + 1 : 0;
    switch (b.type) {
      case "heading":
        push(`${"#".repeat(Number(b.props?.level ?? 1))} ${text}`);
        break;
      case "bulletListItem":
      case "toggleListItem":
        push(`${pad}- ${text}`);
        break;
      case "numberedListItem":
        push(`${pad}${number}. ${text}`);
        break;
      case "checkListItem":
        push(`${pad}- [${b.props?.checked ? "x" : " "}] ${text}`);
        break;
      case "quote":
        push(`> ${text}`);
        break;
      case "codeBlock":
        push(`\`\`\`${String(b.props?.language ?? "")}\n${inlineText(b.content as Inline[])}\n\`\`\``);
        break;
      case "divider":
        push("---");
        break;
      case "equation":
        push(`$$\n${String(b.props?.latex ?? "")}\n$$`);
        break;
      case "image":
      case "video":
      case "audio":
      case "file": {
        if (!ctx.files) continue;
        const url = await ctx.fileUrl(String(b.props?.url ?? ""), String(b.props?.name ?? ""));
        const label = String(b.props?.caption || b.props?.name || "");
        push(b.type === "image" ? `![${label}](${encodeURI(url)})` : `[${label || url}](${encodeURI(url)})`);
        break;
      }
      case "pageLink":
      case "database": {
        const id = String(b.props?.pageId ?? b.props?.blockId ?? "");
        const target = id ? await db.blocks.get(id) : undefined;
        if (target) push(`[${String(target.properties.title || "Sin título")}](${encodeURI(ctx.linkTo(id))})`);
        break;
      }
      case "table":
        if (b.content && !Array.isArray(b.content)) {
          const rows = b.content.rows.map((r) => `| ${r.cells.map(cellText).join(" | ")} |`);
          if (rows.length) rows.splice(1, 0, `|${" --- |".repeat(b.content.rows[0].cells.length)}`);
          push(rows.join("\n"));
        }
        break;
      case "columnList":
      case "column":
        out.push(...(await toMarkdown(b.children ?? [], depth, ctx)));
        continue;
      case "synced": {
        const synced = await db.synced.get(String(b.props?.sourceId ?? ""));
        if (synced) out.push(...(await toMarkdown(synced.content as DocBlock[], depth, ctx)));
        continue;
      }
      default:
        push(`${pad}${text}`);
    }
    if (b.children?.length) out.push(...(await toMarkdown(b.children, depth + 1, ctx)));
  }
  return out;
}


// ---------------------------------------------------------------- export

/** How links and files are written: Xot links for a single page, relative paths inside an export. */
interface ExportContext {
  files: boolean;
  /** "Incluir comentarios": the page's inline threads, by the block they're on. */
  threads?: Map<string, StoredThread[]>;
  linkTo: (pageId: string) => string;
  fileUrl: (url: string, name: string) => Promise<string>;
}

/**
 * A page outside the export: its absolute link, which opens it in Xot from anywhere
 * (xot:// in the desktop app, this address on the web), like "Copiar enlace".
 */
export const appLink = (id: string) =>
  navigator.userAgent.includes("Electron") ? `xot://${id}` : `${location.origin}${location.pathname}#/${id}`;

const PLAIN: ExportContext = {
  files: true,
  linkTo: appLink,
  fileUrl: async (url) => url,
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const longDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" });

/** Equations as MathML, which browsers draw without KaTeX's stylesheet and fonts. */
const mathHtml = (latex: string, displayMode: boolean) =>
  latex ? katex.renderToString(latex, { displayMode, output: "mathml", throwOnError: false, strict: false }) : "";

function inlineHtml(items: Inline[] | undefined, ctx: ExportContext): string {
  return inlineList(items)
    .map((item) => {
      if (item.type === "link")
        return `<a href="${escapeHtml(item.href ?? "")}">${inlineHtml(item.content, ctx)}</a>`;
      if (item.type === "inlineEquation") return mathHtml(String((item as { props?: { latex?: string } }).props?.latex ?? ""), false);
      if (item.type === "mention") {
        const p = (item as { props?: Record<string, string> }).props ?? {};
        if (p.date) return `<span class="mention">@${escapeHtml(longDate.format(new Date(`${p.date.split("/")[0].slice(0, 10)}T00:00`)))}</span>`;
        return `<a class="mention" href="${escapeHtml(ctx.linkTo(p.pageId ?? ""))}">${escapeHtml(p.title || "Página")}</a>`;
      }
      let html = escapeHtml(item.text ?? "").replace(/\n/g, "<br>");
      const s = item.styles ?? {};
      if (s.code) html = `<code>${html}</code>`;
      if (s.bold) html = `<strong>${html}</strong>`;
      if (s.italic) html = `<em>${html}</em>`;
      if (s.underline) html = `<u>${html}</u>`;
      if (s.strike) html = `<s>${html}</s>`;
      if (s.commented) html = `<span class="commented">${html}</span>`;
      if (typeof s.textColor === "string" && s.textColor !== "default") html = `<span class="color-${s.textColor}">${html}</span>`;
      if (typeof s.backgroundColor === "string" && s.backgroundColor !== "default")
        html = `<span class="bg-${s.backgroundColor}">${html}</span>`;
      return html;
    })
    .join("");
}

/** Page titles for mentions, filled before rendering (inlineHtml is synchronous). */
async function fillMentionTitles(list: DocBlock[]) {
  const walk = async (items: Inline[] | undefined) => {
    for (const item of items ?? []) {
      const p = (item as { props?: Record<string, string> }).props;
      if (item.type === "mention" && p?.pageId) {
        const page = await db.blocks.get(p.pageId);
        if (page) p.title = String(page.properties.title || "Sin título");
      }
      if (item.content) await walk(item.content);
    }
  };
  for (const b of list) {
    if (Array.isArray(b.content)) await walk(b.content);
    await fillMentionTitles(b.children ?? []);
  }
}

const LIST_TAGS: Record<string, string> = { bulletListItem: "ul", numberedListItem: "ol", checkListItem: "ul" };

function blockClasses(b: DocBlock) {
  const out: string[] = [];
  const bg = b.props?.backgroundColor;
  const fg = b.props?.textColor;
  if (typeof bg === "string" && bg !== "default") out.push(`block-bg-${bg}`);
  if (typeof fg === "string" && fg !== "default") out.push(`color-${fg}`);
  return out.length ? ` class="${out.join(" ")}"` : "";
}

async function toHtml(list: DocBlock[], ctx: ExportContext): Promise<string> {
  let html = "";
  // A block's comments go right after it (each case below ends with "continue").
  let pending = "";
  for (let i = 0; i < list.length; i++) {
    html += pending;
    pending = "";
    const b = list[i];
    const listTag = LIST_TAGS[b.type];
    if (!listTag) pending = await threadsHtml(b, ctx);
    if (listTag) {
      // Consecutive items of one kind share a list.
      const items: DocBlock[] = [];
      while (i < list.length && list[i].type === b.type) items.push(list[i++]);
      i--;
      const cls = b.type === "checkListItem" ? ' class="to-do-list"' : "";
      html += `<${listTag}${cls}>`;
      for (const item of items) {
        const text = inlineHtml(item.content as Inline[], ctx);
        const box = item.type === "checkListItem" ? `<input type="checkbox" disabled${item.props?.checked ? " checked" : ""}> ` : "";
        const done = item.type === "checkListItem" && item.props?.checked ? ' class="checked"' : "";
        html += `<li${blockClasses(item)}>${box}<span${done}>${text}</span>${await threadsHtml(item, ctx)}${item.children?.length ? await toHtml(item.children, ctx) : ""}</li>`;
      }
      html += `</${listTag}>`;
      continue;
    }
    const text = Array.isArray(b.content) ? inlineHtml(b.content, ctx) : "";
    const children = b.children?.length ? await toHtml(b.children, ctx) : "";
    const cls = blockClasses(b);
    switch (b.type) {
      case "heading": {
        const level = Math.min(Number(b.props?.level ?? 1), 4);
        html += b.props?.isToggleable
          ? `<details open${cls}><summary><h${level}>${text}</h${level}></summary>${children}</details>`
          : `<h${level}${cls}>${text}</h${level}>${children}`;
        continue;
      }
      case "toggleListItem":
        html += `<details open${cls}><summary>${text}</summary>${children}</details>`;
        continue;
      case "quote":
        html += `<blockquote${cls}>${text}${children}</blockquote>`;
        continue;
      case "codeBlock":
        html += `<pre class="code"><code>${escapeHtml(inlineText(b.content as Inline[]))}</code></pre>`;
        continue;
      case "divider":
        html += "<hr>";
        continue;
      case "equation":
        html += `<div class="equation">${mathHtml(String(b.props?.latex ?? ""), true)}</div>`;
        continue;
      case "callout":
        html += `<div class="callout${b.props?.backgroundColor && b.props.backgroundColor !== "default" ? ` block-bg-${b.props.backgroundColor}` : ""}"><span class="callout-icon">${escapeHtml(String(b.props?.icon ?? ""))}</span><div>${text}${children}</div></div>`;
        continue;
      case "image":
      case "video":
      case "audio":
      case "file": {
        if (!ctx.files) continue;
        const url = escapeHtml(await ctx.fileUrl(String(b.props?.url ?? ""), String(b.props?.name ?? "")));
        const caption = String(b.props?.caption ?? "");
        const media =
          b.type === "image"
            ? `<img src="${url}" alt="${escapeHtml(caption)}">`
            : b.type === "video"
              ? `<video src="${url}" controls></video>`
              : b.type === "audio"
                ? `<audio src="${url}" controls></audio>`
                : `<a href="${url}">${escapeHtml(String(b.props?.name || url))}</a>`;
        html += `<figure>${media}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
        continue;
      }
      case "bookmark": {
        const url = escapeHtml(String(b.props?.url ?? ""));
        if (url) html += `<a class="bookmark" href="${url}">${escapeHtml(String(b.props?.title || url))}<br><small>${url}</small></a>`;
        continue;
      }
      case "pageLink": {
        const id = String(b.props?.pageId ?? "");
        const target = id ? await db.blocks.get(id) : undefined;
        if (target)
          html += `<p><a class="page-link" href="${escapeHtml(ctx.linkTo(id))}">${escapeHtml(pageIcon(target))}${escapeHtml(String(target.properties.title || "Sin título"))}</a></p>`;
        continue;
      }
      case "database": {
        const id = String(b.props?.blockId ?? "");
        const target = id ? await db.blocks.get(id) : undefined;
        if (!target) continue;
        const table = await databaseTable(target);
        html += `<h3>${escapeHtml(String(target.properties.title || "Sin título"))}</h3>${table ? tableHtml(table, ctx) : ""}`;
        continue;
      }
      case "table":
        if (b.content && !Array.isArray(b.content)) {
          html += "<table class=\"simple-table\"><tbody>";
          for (const row of b.content.rows)
            html += `<tr>${row.cells.map((cell) => `<td>${escapeHtml(cellText(cell))}</td>`).join("")}</tr>`;
          html += "</tbody></table>";
        }
        continue;
      case "columnList": {
        html += `<div class="columns">`;
        for (const col of b.children ?? [])
          html += `<div class="column" style="flex: ${Number(col.props?.width) || 1}">${await toHtml(col.children ?? [], ctx)}</div>`;
        html += "</div>";
        continue;
      }
      case "synced": {
        const synced = await db.synced.get(String(b.props?.sourceId ?? ""));
        if (synced) html += await toHtml(synced.content as DocBlock[], ctx);
        continue;
      }
      case "tableOfContents":
      case "breadcrumb":
      case "button":
        continue;
      default:
        html += `<p${cls}>${text || "&nbsp;"}</p>${children ? `<div class="indented">${children}</div>` : ""}`;
    }
  }
  return html + pending;
}

// -------------------------------------------------------------- comments

const commentDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** A thread as text: each comment's author, time and text; resolved ones say so. */
async function threadHtml(thread: StoredThread, ctx: ExportContext, quote = "") {
  let html = `<div class="comment-thread${thread.resolved ? " is-resolved" : ""}">`;
  if (quote) html += `<div class="comment-quote">${escapeHtml(quote)}</div>`;
  for (const c of thread.comments) {
    if (c.deletedAt) continue;
    const body = Array.isArray(c.body) ? structuredClone(c.body as DocBlock[]) : [];
    await fillMentionTitles(body);
    html += `<div class="comment"><div class="comment-head"><span class="comment-author">${escapeHtml(LOCAL_USER.username)}</span> <time datetime="${new Date(c.createdAt).toISOString()}">${escapeHtml(commentDate.format(new Date(c.createdAt)))}</time></div><div class="comment-body">${await toHtml(body, { ...ctx, threads: undefined })}</div></div>`;
  }
  if (thread.resolved) html += `<div class="comment-resolved">Resuelto</div>`;
  return `${html}</div>`;
}

/** The text a thread's mark covers (anchor offsets count characters, and 1 per mention or equation). */
function quotedText(items: Inline[], from: number, to: number) {
  let at = 0;
  let out = "";
  const walk = (list: Inline[]) => {
    for (const item of list) {
      if (item.type === "link") {
        walk(inlineList(item.content));
        continue;
      }
      const text = item.type === "text" ? (item.text ?? "") : "\uFFFC";
      const start = at;
      at += text.length;
      if (at <= from || start >= to) continue;
      out += text.slice(Math.max(0, from - start), Math.min(text.length, to - start)).replace("\uFFFC", "");
    }
  };
  walk(items);
  return out;
}

/** Marks the text that inline threads point to, so the export highlights it. */
function markCommented(list: DocBlock[], threads: Map<string, StoredThread[]>) {
  for (const b of list) {
    // Resolved threads keep their comments but not the highlight, as in the page.
    const anchors = (b.id && threads.get(b.id)?.flatMap((t) => (t.anchor && !t.resolved ? [t.anchor] : []))) || [];
    if (anchors.length && (Array.isArray(b.content) || typeof b.content === "string")) {
      const split = (items: Inline[], offset: { at: number }): Inline[] =>
        items.flatMap((item) => {
          if (item.type === "link") return [{ ...item, content: split(inlineList(item.content), offset) }];
          if (item.type !== "text") {
            offset.at += 1;
            return [item];
          }
          const text = item.text ?? "";
          const start = offset.at;
          offset.at += text.length;
          const cuts = new Set([0, text.length]);
          for (const a of anchors)
            for (const p of [a.from - start, a.to - start]) if (p > 0 && p < text.length) cuts.add(p);
          const points = [...cuts].sort((x, y) => x - y);
          const parts: Inline[] = [];
          for (let k = 0; k < points.length - 1; k++) {
            const from = start + points[k];
            const inside = anchors.some((a) => from >= a.from && from < a.to);
            parts.push({ ...item, text: text.slice(points[k], points[k + 1]), styles: inside ? { ...item.styles, commented: true } : item.styles });
          }
          return parts;
        });
      b.content = split(inlineList(b.content), { at: 0 });
    }
    if (b.children?.length) markCommented(b.children, threads);
  }
}

/** A block's inline threads (with the text they point to), right after it. */
async function threadsHtml(b: DocBlock, ctx: ExportContext) {
  const threads = b.id ? ctx.threads?.get(b.id) : undefined;
  if (!threads?.length) return "";
  let html = '<aside class="comments">';
  for (const t of threads) html += await threadHtml(t, ctx, t.anchor ? quotedText(inlineList(b.content), t.anchor.from, t.anchor.to) : "");
  return `${html}</aside>`;
}

/** The page's discussions (and comments on its properties) under its title. */
async function discussionsHtml(threads: StoredThread[], ctx: ExportContext, collection?: Collection | null) {
  if (!threads.length) return "";
  let html = '<section class="discussions"><div class="discussions-title">Comentarios</div>';
  for (const t of threads) {
    const property = (t.metadata as { property?: string } | undefined)?.property;
    const name = property ? collection?.schema[property]?.name : undefined;
    html += await threadHtml(t, ctx, name ? `Comentario en «${name}»` : "");
  }
  return `${html}</section>`;
}

const pageIcon = (b: Block) => {
  const icon = b.format.icon;
  // Emoji icons only: image icons don't travel with the file.
  return icon && !/^(https?:|data:|\/)/.test(icon) ? `${icon} ` : "";
};

/** The export stylesheet: the page's typography on a centered column. */
const EXPORT_CSS = `
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #2c2c2b; background: #fff; font: 16px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif; }
article { max-width: 708px; margin: 0 auto; padding: 48px 32px 96px; }
article + article { page-break-before: always; break-before: page; }
.page-title { font-size: 40px; line-height: 1.2; font-weight: 700; margin: 0 0 24px; }
.page-icon { font-size: 64px; line-height: 1; margin-bottom: 12px; }
.page-cover { display: block; width: 100%; height: 240px; object-fit: cover; border-radius: 4px; margin-bottom: 24px; }
h1 { font-size: 1.875em; margin: 1.6em 0 4px; line-height: 1.3; }
h2 { font-size: 1.5em; margin: 1.4em 0 4px; line-height: 1.3; }
h3 { font-size: 1.25em; margin: 1em 0 4px; line-height: 1.3; }
h4 { font-size: 1.1em; margin: 1em 0 4px; }
p { margin: 2px 0; min-height: 1.5em; }
a { color: inherit; text-decoration: underline; text-decoration-color: rgba(55,53,47,.4); }
ul, ol { margin: 2px 0; padding-left: 1.7em; }
.to-do-list { list-style: none; padding-left: 0.2em; }
.to-do-list input { margin: 0 6px 0 0; }
.to-do-list .checked { text-decoration: line-through; opacity: .5; }
blockquote { margin: 4px 0; padding: 3px 14px; border-left: 3px solid currentColor; font-size: 1.2em; }
details summary { cursor: pointer; }
details summary h1, details summary h2, details summary h3, details summary h4 { display: inline; }
hr { border: none; border-top: 1px solid rgba(55,53,47,.16); margin: 12px 0; }
code { font-family: Menlo, Courier, monospace; font-size: 85%; background: rgba(135,131,120,.15); color: #eb5757; padding: 0.2em 0.4em; border-radius: 4px; }
pre.code { background: #f7f6f3; border-radius: 4px; padding: 32px 16px; overflow: auto; font-size: 85%; white-space: pre-wrap; }
pre.code code { background: none; color: inherit; padding: 0; }
figure { margin: 8px 0; }
figure img, figure video { max-width: 100%; border-radius: 2px; }
figcaption { color: #7d7a75; font-size: 14px; padding-top: 6px; }
.callout { display: flex; gap: 8px; padding: 16px 16px 16px 12px; border-radius: 4px; background: #f1f1ef; margin: 4px 0; }
.callout-icon { font-size: 1.2em; line-height: 1.3; }
.columns { display: flex; gap: 46px; }
.column { min-width: 0; }
.indented { padding-left: 1.5em; }
.page-link { display: inline-block; font-weight: 500; text-decoration: none; border-bottom: 1px solid rgba(55,53,47,.16); }
.mention { font-weight: 500; }
.commented { background: rgba(255, 212, 0, .14); border-bottom: 2px solid rgba(255, 212, 0, .8); }
.discussions { margin: 0 0 16px; padding-bottom: 8px; border-bottom: 1px solid rgba(55,53,47,.16); }
.discussions-title { color: #7d7a75; font-size: 14px; font-weight: 500; margin-bottom: 6px; }
.comments { margin: 4px 0 8px 24px; }
.comment-thread { border-left: 2px solid rgba(255, 212, 0, .8); padding: 2px 0 2px 12px; margin: 6px 0; font-size: 14px; }
.comment-thread.is-resolved { border-left-color: rgba(55,53,47,.16); color: #7d7a75; }
.comment-quote { color: #7d7a75; font-size: 13px; margin-bottom: 4px; }
.comment-quote::before { content: "“"; } .comment-quote::after { content: "”"; }
.comment { margin: 4px 0; }
.comment-head { font-size: 13px; }
.comment-author { font-weight: 600; }
.comment-head time { color: #7d7a75; margin-left: 4px; }
.comment-body p { min-height: 0; }
.comment-resolved { color: #448361; font-size: 12px; font-weight: 500; }
.equation { text-align: center; padding: 4px 0; font-size: 1.15em; }
.bookmark { display: block; border: 1px solid rgba(55,53,47,.16); border-radius: 4px; padding: 12px 14px; margin: 4px 0; text-decoration: none; }
.bookmark small { color: #7d7a75; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 14px; }
th, td { border: 1px solid #e9e9e7; padding: 6px 8px; text-align: left; vertical-align: top; }
th { color: #7d7a75; font-weight: 500; background: #f7f6f3; }
.tag { display: inline-block; padding: 0 6px; border-radius: 3px; background: rgba(84,72,49,.08); margin: 0 4px 2px 0; }
.color-gray { color: #787774; } .color-brown { color: #9f6b53; } .color-orange { color: #d9730d; } .color-yellow { color: #cb912f; }
.color-green { color: #448361; } .color-blue { color: #337ea9; } .color-purple { color: #9065b0; } .color-pink { color: #c14c8a; } .color-red { color: #d44c47; }
.bg-gray, .block-bg-gray { background: #f1f1ef; } .bg-brown, .block-bg-brown { background: #f4eeee; } .bg-orange, .block-bg-orange { background: #fbecdd; }
.bg-yellow, .block-bg-yellow { background: #fbf3db; } .bg-green, .block-bg-green { background: #edf3ec; } .bg-blue, .block-bg-blue { background: #e7f3f8; }
.bg-purple, .block-bg-purple { background: rgba(244,240,247,.8); } .bg-pink, .block-bg-pink { background: rgba(249,238,243,.8); } .bg-red, .block-bg-red { background: #fdebec; }
@page { margin: 16mm 0; }
@media print { article { padding-top: 0; } }
`;

const htmlDocument = (title: string, body: string) =>
  `<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n<style>${EXPORT_CSS}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

// ------------------------------------------------------------- databases

interface DbTable {
  headers: string[];
  /** Plain text per cell; `tags` keeps option names apart for the HTML table. */
  rows: { cells: (string | string[])[]; id: string }[];
}

const exportDay = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" });

/** A stored date as the export writes it: "January 1, 2025", "June 1, 2025 6:40 AM", ranges with " → ". */
function exportDate(value: string) {
  return value
    .split("/")
    .map((point) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(point);
      if (!m) return point;
      const day = exportDay.format(new Date(+m[1], +m[2] - 1, +m[3]));
      if (m[4] === undefined) return day;
      const h = +m[4];
      return `${day} ${h % 12 || 12}:${m[5]} ${h < 12 ? "AM" : "PM"}`;
    })
    .join(" → ");
}

const isStoredDate = (v: string) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?(\/|$)/.test(v);

/** A number as its cell shows it: its format and decimals; percentage rollups as "7%". */
function exportNumber(value: number, prop: PropertySchema) {
  if (prop.type === "rollup" && !prop.number_format && prop.rollup && PERCENT_AGGREGATIONS.includes(prop.rollup.aggregation))
    return prop.decimals === undefined ? `${Math.round(value * 100)}%` : formatNumber(value, "percent", false, prop.decimals);
  return formatNumber(value, prop.number_format, false, prop.decimals);
}

/** A formula's or rollup's result as its cell shows it (Yes/No, dates, numbers in their format). */
function computedText(value: PropertyValue, prop: PropertySchema): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return exportNumber(value, prop);
  if (typeof value === "string") return isStoredDate(value) ? exportDate(value) : value;
  if (Array.isArray(value))
    return value
      .map((v) => (typeof v === "string" ? (isStoredDate(v) ? exportDate(v) : v) : typeof v === "object" && v && "name" in v ? String(v.name) : String(v)))
      .join(", ");
  return String(value ?? "");
}

async function cellExportText(row: Block, propertyId: string, prop: PropertySchema, collection: Collection): Promise<string | string[]> {
  const value: PropertyValue | undefined =
    prop.type === "formula" || prop.type === "rollup" ? await evaluate(row, propertyId, collection) : cellValue(row, propertyId, prop);
  if (prop.type === "checkbox") return value === true || value === "true" ? "Yes" : "No";
  if (value === undefined || value === null || value === "") return "";
  switch (prop.type) {
    case "formula":
    case "rollup":
      return computedText(value, prop);
    case "created_time":
    case "last_edited_time":
      return exportDate(String(value));
    case "select":
    case "status":
      return [prop.options?.find((o) => o.id === value)?.value ?? String(value)];
    case "multi_select":
      return (value as string[]).map((v) => prop.options?.find((o) => o.id === v)?.value ?? v);
    case "number":
      return typeof value === "number" ? exportNumber(value, prop) : String(value);
    case "date":
      return exportDate(String(value));
    case "file":
      return (value as FileRef[]).map((f) => (f.url.startsWith(FILE_SCHEME) || f.url.startsWith("data:") ? f.name : f.url)).join(", ");
    case "relation": {
      const refs = value as PageRef[];
      const pages = await db.blocks.bulkGet(refs.map((r) => r.id));
      return refs.map((r, i) => String(pages[i]?.properties.title || r.name || "Sin título")).join(", ");
    }
    default:
      if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : v.name)).join(", ");
      return String(value);
  }
}

/** A database's rows as text, in its first view's property order (hidden properties too). */
async function databaseTable(block: Block): Promise<DbTable | null> {
  const collectionId = block.collection_id;
  const collection = collectionId ? await db.collections.get(collectionId) : undefined;
  if (!collection) return null;
  const view = block.view_ids?.[0] ? await db.views.get(block.view_ids[0]) : undefined;
  const ordered = (view?.format.properties ?? []).map((p) => p.property).filter((id) => collection.schema[id]);
  const ids = ["title", ...ordered.filter((id) => id !== "title"), ...Object.keys(collection.schema).filter((id) => id !== "title" && !ordered.includes(id))].filter(
    (id) => collection.schema[id],
  );
  const rows = (await db.blocks.where("[parent_table+parent_id]").equals(["collection", collection.id]).toArray())
    .filter((r) => r.alive && !r.is_template)
    .sort((a, b) => a.order - b.order);
  return {
    headers: ids.map((id) => collection.schema[id].name),
    rows: await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        cells: await Promise.all(
          ids.map((id) => (id === "title" ? String(row.properties.title ?? "") : cellExportText(row, id, collection.schema[id], collection))),
        ),
      })),
    ),
  };
}

/** A row's values under its title, as the Markdown export writes them ("Status: Done"), the empty ones left out. */
async function rowProperties(row: Block): Promise<string> {
  const collection = await db.collections.get(row.parent_id);
  if (!collection) return "";
  // In the row page's order, without the ones it never shows.
  const ordered = collection.page_properties ?? [];
  const ids = [...ordered, ...Object.keys(collection.schema).filter((id) => !ordered.includes(id))].filter(
    (id, i, all) => id !== "title" && collection.schema[id] && all.indexOf(id) === i && collection.property_visibility?.[id] !== "hide",
  );
  const lines: string[] = [];
  for (const id of ids) {
    const prop = collection.schema[id];
    if (prop.type === "button") continue;
    const text = await cellExportText(row, id, prop, collection);
    const value = Array.isArray(text) ? text.join(", ") : text;
    if (value) lines.push(`${prop.name}: ${value}`);
  }
  return lines.join("\n");
}

const csvCell = (v: string | string[]) => {
  const text = Array.isArray(v) ? v.join(", ") : v;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function tableCsv(table: DbTable) {
  // A BOM so spreadsheet apps read the accents right.
  return `﻿${[table.headers, ...table.rows.map((r) => r.cells)].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function tableHtml(table: DbTable, ctx: ExportContext) {
  const cell = (v: string | string[]) =>
    Array.isArray(v) ? v.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("") : escapeHtml(v);
  return `<table><thead><tr>${table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${table.rows
    .map(
      (r) =>
        `<tr>${r.cells.map((c, i) => `<td>${i === 0 ? `<a href="${escapeHtml(ctx.linkTo(r.id))}">${cell(c)}</a>` : cell(c)}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

// ----------------------------------------------------------------- pages

export type ExportFormat = "markdown" | "html" | "pdf";

export interface ExportOptions {
  format: ExportFormat;
  /** false: "Sin archivos ni imágenes". */
  files: boolean;
  subpages: boolean;
  /** Subpages go in a folder named after their parent page. */
  folders: boolean;
  /** HTML and PDF: page discussions and inline comments (resolved ones too), with the text they point to. */
  comments?: boolean;
  /** PDF only: "Formato de página" and "Porcentaje de escala" (10-200). */
  pageFormat?: PageFormat;
  scale?: number;
}

/** PDF page sizes, as Chromium's printer names them. */
export type PageFormat = "A4" | "Letter" | "Legal" | "A3" | "Tabloid";

const title = (b: Block) => String(b.properties.title || "Sin título");

/** The page and, with subpages, every page under it (database rows included), parents first. */
async function collectPages(roots: Block[], subpages: boolean, limit = 2000): Promise<{ block: Block; parent: string | null }[]> {
  const out: { block: Block; parent: string | null }[] = roots.map((block) => ({ block, parent: null }));
  if (!subpages) return out;
  const seen = new Set(roots.map((r) => r.id));
  for (let i = 0; i < out.length && out.length < limit; i++) {
    const page = out[i].block;
    const children = page.collection_id
      ? await db.blocks.where("[parent_table+parent_id]").equals(["collection", page.collection_id]).toArray()
      : await db.blocks.where("[parent_table+parent_id]").equals(["block", page.id]).toArray();
    for (const child of children.sort((a, b) => a.order - b.order))
      if (child.alive && !child.is_template && !seen.has(child.id)) {
        seen.add(child.id);
        out.push({ block: child, parent: page.id });
      }
  }
  return out;
}

const readBlob = (blob: Blob) => blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });

/** "Exportar": the page (and its subpages) as Markdown and CSV, HTML or PDF. */
export function exportPage(root: Block, options: ExportOptions) {
  return exportPages([root], options, title(root));
}

/**
 * Settings > "Exportar todo el contenido del espacio de trabajo": every page and database, with
 * their subpages, as one .zip of HTML or Markdown and CSV files (the workspace export).
 * An imported workspace's root is a folder, not a page.
 */
export async function exportWorkspace(options: Pick<ExportOptions, "format" | "files" | "folders" | "comments">) {
  const top = (await db.blocks.filter((b) => b.parent_table === "space" && b.alive && !b.is_template).toArray()).sort(
    (a, b) => a.order - b.order,
  );
  const containers = new Set(top.filter((b) => isWorkspaceRoot(b.id)).map((b) => b.id));
  // A single workspace needs no folder of its own.
  let roots = top;
  if (containers.size === 1 && top.length === 1) {
    roots = await childPages(top[0]);
    containers.clear();
  }
  if (!roots.length) throw new Error("No hay páginas que exportar");
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return exportPages(roots, { ...options, subpages: true }, `Xot exportación ${day}`, containers, true);
}

/** A page's live subpages (database rows included), in order. */
async function childPages(page: Block) {
  const children = page.collection_id
    ? await db.blocks.where("[parent_table+parent_id]").equals(["collection", page.collection_id]).toArray()
    : await db.blocks.where("[parent_table+parent_id]").equals(["block", page.id]).toArray();
  return children.filter((c) => c.alive && !c.is_template).sort((a, b) => a.order - b.order);
}

async function exportPages(roots: Block[], options: ExportOptions, base: string, containers = new Set<string>(), zip = false) {
  const pages = await collectPages(roots, options.subpages, zip ? Infinity : 2000);
  // HTML pages carry their files inside when downloaded alone; in a .zip the files go next to them.
  const separateFiles = options.format === "markdown" || (options.format === "html" && (zip || pages.length - containers.size > 1));
  const ext = options.format === "markdown" ? "md" : "html";
  // Paths first, so pages can link to each other inside the export.
  const paths = new Map<string, string>();
  const dirs = new Map<string, string>();
  const taken = new Set<string>();
  const unique = (path: string) => {
    let candidate = path;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = path.replace(/(\.[^./]+)?$/, ` (${n})$1`);
    taken.add(candidate.toLowerCase());
    return candidate;
  };
  // A database is written once: its linked views (the same collection) point at that file.
  const databases = new Map<string, string>();
  const linked = new Set<string>();
  for (const { block, parent } of pages) {
    const dir = options.folders && parent ? dirs.get(parent) ?? "" : "";
    const name = safeFileName(title(block), "Sin título");
    const isDb = block.type === "collection_view_page";
    // A workspace root has no file: just the folder its pages go in.
    if (containers.has(block.id)) {
      dirs.set(block.id, `${unique(name)}/`);
      continue;
    }
    const exported = isDb && block.collection_id ? databases.get(block.collection_id) : undefined;
    if (exported) {
      paths.set(block.id, exported);
      linked.add(block.id);
      continue;
    }
    const path = unique(`${dir}${name}.${isDb && options.format === "markdown" ? "csv" : ext}`);
    paths.set(block.id, path);
    dirs.set(block.id, `${dir}${name}/`);
    if (isDb && block.collection_id) databases.set(block.collection_id, path);
  }
  const extra: ZipEntry[] = [];
  const relative = (from: string, to: string) => {
    const up = from.split("/").length - 1;
    const target = `${"../".repeat(up)}${to}`;
    // HTML links are URLs: "#", "%" and the like in a page's name are escaped (Markdown encodes its own).
    return options.format === "markdown" ? target : target.split("/").map((part) => (part === ".." ? part : encodeURIComponent(part))).join("/");
  };

  const rendered: { path: string; title: string; body: string }[] = [];
  for (const { block } of pages) {
    if (containers.has(block.id) || linked.has(block.id)) continue;
    const path = paths.get(block.id)!;
    const ctx: ExportContext = {
      files: options.files,
      linkTo: (id) => (paths.has(id) ? relative(path, paths.get(id)!) : appLink(id)),
      fileUrl: async (url, name) => {
        // Uploaded files and the app's own (served from a path on its origin) travel with
        // the export; web links stay links.
        let blob: Blob | undefined;
        if (url.startsWith(FILE_SCHEME)) {
          const stored = await db.files.get(url.slice(FILE_SCHEME.length));
          blob = stored?.blob;
          name ||= stored?.name ?? "";
        } else if (url.startsWith("/") && !url.startsWith("//")) {
          blob = await fetch(url).then((r) => (r.ok ? r.blob() : undefined), () => undefined);
          name ||= url.split("/").pop() ?? "";
        } else return url;
        if (!blob) return url;
        // A lone HTML page and PDF carry the file inside; otherwise it goes next to the page.
        if (!separateFiles) return blobToDataUrl(blob);
        const file = unique(`${dirs.get(block.id)}${safeFileName(name, "archivo")}`);
        extra.push({ path: file, data: await readBlob(blob) });
        return relative(path, file);
      },
    };
    if (block.type === "collection_view_page") {
      const table = await databaseTable(block);
      if (options.format === "markdown") {
        rendered.push({ path, title: title(block), body: table ? tableCsv(table) : "" });
        continue;
      }
      rendered.push({
        path,
        title: title(block),
        body: `<article><h1 class="page-title">${escapeHtml(pageIcon(block))}${escapeHtml(title(block))}</h1>${table ? tableHtml(table, ctx) : ""}</article>`,
      });
      continue;
    }
    const list = withInlineContent(structuredClone(blocksOf(block)));
    if (options.format === "markdown") {
      const body = list.length ? joinMarkdown(await toMarkdown(list, 0, ctx)) : (block.content_markdown ?? "");
      const props = block.parent_table === "collection" ? await rowProperties(block) : "";
      rendered.push({ path, title: title(block), body: `# ${title(block)}\n\n${props ? `${props}\n\n` : ""}${body}\n` });
      continue;
    }
    await fillMentionTitles(list);
    let discussions = "";
    if (options.comments) {
      const threads = (await db.threads.where("page_id").equals(block.id).toArray())
        .filter((t) => t.comments.some((c) => !c.deletedAt))
        .sort((a, b) => new Date(a.comments[0].createdAt).getTime() - new Date(b.comments[0].createdAt).getTime());
      const inline = new Map<string, StoredThread[]>();
      const page: StoredThread[] = [];
      for (const t of threads) {
        if (t.anchor && !(t.metadata as { page?: boolean } | undefined)?.page) inline.set(t.anchor.block, [...(inline.get(t.anchor.block) ?? []), t]);
        else page.push(t);
      }
      // Inline threads whose block is gone show with the page's discussions.
      const ids = new Set<string>();
      const collect = (l: DocBlock[]) => {
        for (const b of l) {
          if (b.id) ids.add(b.id);
          collect(b.children ?? []);
        }
      };
      collect(list);
      for (const [id, orphans] of inline)
        if (!ids.has(id)) {
          page.push(...orphans);
          inline.delete(id);
        }
      ctx.threads = inline;
      markCommented(list, inline);
      const collection = block.parent_table === "collection" ? await db.collections.get(block.parent_id) : null;
      discussions = await discussionsHtml(page, ctx, collection);
    }
    const body = list.length
      ? await toHtml(list, ctx)
      : (block.content_markdown ?? "")
          .split(/\n{2,}/)
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("");
    const icon = pageIcon(block).trim();
    const cover =
      options.files && block.format.cover && !block.format.cover.startsWith("gradient:")
        ? `<img class="page-cover" src="${escapeHtml(await ctx.fileUrl(block.format.cover, ""))}" alt="" style="object-position: center ${(block.format.cover_position ?? 0.5) * 100}%">`
        : "";
    rendered.push({
      path,
      title: title(block),
      body: `<article>${cover}${icon ? `<div class="page-icon">${escapeHtml(icon)}</div>` : ""}<h1 class="page-title">${escapeHtml(title(block))}</h1>${discussions}${body}</article>`,
    });
  }

  base = safeFileName(base, "Sin título");
  if (options.format === "pdf") {
    // One document, each page on new sheets.
    const pageFormat = options.pageFormat ?? "A4";
    const scale = Math.min(200, Math.max(10, Math.round(options.scale ?? 100)));
    await printHtml(htmlDocument(title(roots[0]), rendered.map((r) => r.body).join("\n")), `${base}.pdf`, {
      pageSize: pageFormat,
      scale: scale / 100,
    });
    return;
  }
  const files: ZipEntry[] = [
    ...rendered.map((r) => ({ path: r.path, data: options.format === "html" ? htmlDocument(r.title, r.body) : r.body })),
    ...extra,
  ];
  if (files.length === 1 && !zip) {
    const [file] = files;
    const type = file.path.endsWith(".csv") ? "text/csv" : options.format === "html" ? "text/html" : "text/markdown";
    downloadBlob(new Blob([file.data as BlobPart], { type: `${type};charset=utf-8` }), file.path.split("/").pop()!);
    return;
  }
  downloadBlob(makeZip(files), `${base}.zip`);
}

/** CSS page sizes for each format. */
const PAGE_SIZES: Record<PageFormat, string> = {
  A4: "A4",
  Letter: "letter",
  Legal: "legal",
  A3: "A3",
  Tabloid: "11in 17in",
};

type PrintOptions = { pageSize: PageFormat; scale: number };
type Desktop = { printToPDF?: (html: string, options?: PrintOptions) => Promise<Uint8Array> };

/** PDF: the macOS app writes the file itself; the browser prints the document (Guardar como PDF). */
async function printHtml(html: string, fileName: string, options: PrintOptions) {
  const desktop = (window as { xotDesktop?: Desktop }).xotDesktop;
  if (desktop?.printToPDF) {
    const pdf = await desktop.printToPDF(html, options);
    downloadBlob(new Blob([pdf as BlobPart], { type: "application/pdf" }), fileName);
    return;
  }
  // The browser's print dialog takes the size and scale from the document.
  html = html.replace(
    "</head>",
    `<style>@page { size: ${PAGE_SIZES[options.pageSize]}; } body { zoom: ${options.scale}; }</style>\n</head>`,
  );
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  await new Promise((r) => setTimeout(r, 300));
  await Promise.all(
    [...doc.images].map((img) => (img.complete ? null : new Promise((r) => img.addEventListener("load", r, { once: true })))),
  );
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  setTimeout(() => frame.remove(), 1000);
}

/** The page as a Markdown file download (Compartir > Exportar como Markdown). */
export function exportMarkdown(block: Block) {
  return exportPage(block, { format: "markdown", files: true, subpages: false, folders: false });
}

/** Blocks written as `content: "text"` (BlockNote's shorthand) as styled text, so they export too. */
function withInlineContent(list: DocBlock[]): DocBlock[] {
  return list.map((b) => {
    const raw = b as unknown as { content?: unknown };
    const content = typeof raw.content === "string" ? [{ type: "text", text: raw.content, styles: {} }] : b.content;
    return { ...b, content, children: b.children ? withInlineContent(b.children) : b.children } as DocBlock;
  });
}

/** The page body as Markdown, for "Copiar contenido de la página" (the title stays out). */
export async function pageMarkdown(block: Block): Promise<string> {
  const list = withInlineContent(structuredClone(blocksOf(block)));
  if (!list.length) return (block.content_markdown ?? "").replace(/%%xotion[^%]*%%/g, "").trim();
  return joinMarkdown(await toMarkdown(list, 0));
}
