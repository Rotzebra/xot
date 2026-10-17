import { createPage, insertPageLink } from "./ops";
import { storeFile } from "./files";
import { readZip, type ZipFile } from "./zip";
import { decodeText, htmlToBlocks, importCsv, type ImportedBlock, type ImportTarget } from "./importFiles";
import { pdfToHtml, usefulTitle } from "./importPdf";

// The other importers, written by hand so they work offline: Word (.docx) and EPUB become
// pages (through HTML, like the HTML importer), Excel (.xlsx) and OpenDocument (.ods) sheets
// become databases (through CSV), OPML outlines (Workflowy, Dynalist…) become nested lists, and
// a PDF's text becomes a page (lib/importPdf.ts).

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const stem = (name: string) => name.replace(/\.[^.]+$/, "").trim() || "Sin título";

const parseXml = (text: string) => new DOMParser().parseFromString(text, "application/xml");

/** Elements by local name, whatever their namespace prefix. */
const all = (node: Document | Element, name: string) => Array.from(node.getElementsByTagNameNS("*", name));
const first = (node: Document | Element | null | undefined, name: string) => (node ? (all(node, name)[0] ?? null) : null);
const kids = (el: Element, name?: string) => Array.from(el.children).filter((c) => !name || c.localName === name);
/** An attribute by local name (w:val, r:id, table:name…). */
function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
}

const MEDIA: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  emf: "image/emf",
  wmf: "image/wmf",
};

/** A file of an archive kept like an uploaded one; null when it isn't there. */
async function keep(files: Map<string, ZipFile>, path: string): Promise<string | null> {
  const entry = files.get(path);
  if (!entry) return null;
  const name = path.split("/").pop()!;
  const type = MEDIA[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
  return storeFile(new File([entry.data as BlobPart], name, { type }));
}

/** "a/b/../c.png" relative to "dir" as an archive path. */
function joinPath(dir: string, href: string) {
  let path = href.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* as written */
  }
  const parts = path.startsWith("/") ? [] : dir ? dir.split("/") : [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

async function zipFiles(buffer: ArrayBuffer) {
  const entries = await readZip(buffer);
  return new Map(entries.map((e) => [e.path, e]));
}

const text = (files: Map<string, ZipFile>, path: string) => {
  const entry = files.get(path);
  return entry ? decodeText(entry.data.slice().buffer) : null;
};

/** A package's relationships (rId → target path), from its _rels file. */
function relationships(files: Map<string, ZipFile>, part: string) {
  const rels = new Map<string, { target: string; external: boolean }>();
  const xml = text(files, `${dirOf(part) ? `${dirOf(part)}/` : ""}_rels/${part.split("/").pop()}.rels`);
  if (!xml) return rels;
  for (const rel of all(parseXml(xml), "Relationship")) {
    const target = attr(rel, "Target") ?? "";
    const external = attr(rel, "TargetMode") === "External";
    rels.set(attr(rel, "Id") ?? "", { target: external ? target : joinPath(dirOf(part), target), external });
  }
  return rels;
}

// ------------------------------------------------------------------ Word

const isOn = (el: Element | null) => !!el && !/^(0|false|off|none)$/i.test(attr(el, "val") ?? "");

/** A Word document as HTML (headings, lists, tables, links, images, styles), and its title. */
export async function docxToHtml(buffer: ArrayBuffer): Promise<{ title: string | null; html: string }> {
  const files = await zipFiles(buffer);
  const main = "word/document.xml";
  const xml = text(files, main);
  if (!xml) throw new Error("El archivo de Word no es válido");
  const doc = parseXml(xml);
  const rels = relationships(files, main);

  // Style names ("heading 1", "Title", "Quote"), by style id ("Ttulo1" in a Spanish Word).
  const styles = new Map<string, { name: string; outline: number | null }>();
  const stylesXml = text(files, "word/styles.xml");
  if (stylesXml)
    for (const s of all(parseXml(stylesXml), "style")) {
      const outline = attr(first(s, "outlineLvl"), "val");
      styles.set(attr(s, "styleId") ?? "", { name: (attr(first(s, "name"), "val") ?? "").toLowerCase(), outline: outline === null ? null : Number(outline) });
    }
  // Numbered lists vs bullets: numId → abstract numbering → format per level.
  const listFormat = new Map<string, Map<number, string>>();
  const numberingXml = text(files, "word/numbering.xml");
  if (numberingXml) {
    const numbering = parseXml(numberingXml);
    const abstract = new Map<string, Map<number, string>>();
    for (const a of all(numbering, "abstractNum")) {
      const levels = new Map<number, string>();
      for (const lvl of kids(a, "lvl")) levels.set(Number(attr(lvl, "ilvl") ?? 0), attr(first(lvl, "numFmt"), "val") ?? "bullet");
      abstract.set(attr(a, "abstractNumId") ?? "", levels);
    }
    for (const num of all(numbering, "num")) {
      const levels = abstract.get(attr(first(num, "abstractNumId"), "val") ?? "");
      if (levels) listFormat.set(attr(num, "numId") ?? "", levels);
    }
  }
  const images = new Map<string, string | null>();
  for (const [id, rel] of rels)
    if (!rel.external && /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(rel.target)) images.set(id, await keep(files, rel.target));

  const runs = (p: Element): string => {
    let html = "";
    for (const node of Array.from(p.children)) {
      if (node.localName === "hyperlink") {
        const rel = rels.get(attr(node, "id") ?? "");
        const anchor = attr(node, "anchor");
        const inner = runs(node);
        html += rel?.external ? `<a href="${escapeHtml(rel.target)}">${inner}</a>` : anchor ? inner : inner;
        continue;
      }
      if (node.localName === "ins" || node.localName === "smartTag" || node.localName === "sdt" || node.localName === "sdtContent" || node.localName === "fldSimple") {
        html += runs(node);
        continue;
      }
      if (node.localName !== "r") continue;
      const pr = first(node, "rPr");
      let out = "";
      for (const c of Array.from(node.children)) {
        if (c.localName === "t") out += escapeHtml(c.textContent ?? "");
        else if (c.localName === "tab") out += "\t";
        else if (c.localName === "br" || c.localName === "cr") out += "<br>";
        else if (c.localName === "drawing" || c.localName === "pict") {
          const blip = first(c, "blip") ?? first(c, "imagedata");
          const src = images.get(attr(blip, "embed") ?? attr(blip, "id") ?? "");
          const alt = attr(first(c, "docPr"), "descr") ?? "";
          if (src) out += `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
        }
      }
      if (!out) continue;
      if (pr) {
        const vert = attr(first(pr, "vertAlign"), "val");
        if (vert === "superscript") out = `<sup>${out}</sup>`;
        if (vert === "subscript") out = `<sub>${out}</sub>`;
        if (isOn(first(pr, "b"))) out = `<strong>${out}</strong>`;
        if (isOn(first(pr, "i"))) out = `<em>${out}</em>`;
        if (first(pr, "u") && attr(first(pr, "u"), "val") !== "none") out = `<u>${out}</u>`;
        if (isOn(first(pr, "strike")) || isOn(first(pr, "dstrike"))) out = `<s>${out}</s>`;
        const font = attr(first(pr, "rFonts"), "ascii") ?? "";
        if (/courier|consolas|mono|menlo/i.test(font)) out = `<code>${out}</code>`;
      }
      html += out;
    }
    return html;
  };

  let title = usefulTitle(text(files, "docProps/core.xml")?.match(/<dc:title>([^<]*)<\/dc:title>/)?.[1]);
  let html = "";
  // Open lists, innermost last, so consecutive items nest by their level.
  const open: { tag: string; level: number }[] = [];
  const closeLists = (level = -1) => {
    while (open.length && open[open.length - 1].level > level) html += `</li></${open.pop()!.tag}>`;
  };

  const paragraph = (p: Element) => {
    const pr = first(p, "pPr");
    const styleId = attr(first(pr, "pStyle"), "val") ?? "";
    const style = styles.get(styleId);
    const name = style?.name ?? styleId.toLowerCase();
    const content = runs(p);
    const num = first(pr, "numPr");
    const numId = attr(first(num, "numId"), "val");
    if (num && numId && numId !== "0") {
      const level = Number(attr(first(num, "ilvl"), "val") ?? 0);
      const format = listFormat.get(numId)?.get(level) ?? "bullet";
      const tag = format === "bullet" || format === "none" ? "ul" : "ol";
      const top = open[open.length - 1];
      if (top && top.level > level) closeLists(level);
      const same = open[open.length - 1];
      if (same && same.level === level) {
        if (same.tag === tag) html += "</li>";
        else {
          html += `</li></${open.pop()!.tag}><${tag}>`;
          open.push({ tag, level });
        }
      } else {
        html += `<${tag}>`;
        open.push({ tag, level });
      }
      html += `<li>${content}`;
      return;
    }
    closeLists();
    // "heading 1" by name, or "heading1" (a style id, when styles.xml is missing).
    const heading = /^heading ?(\d)/.exec(name) ?? /^(?:t[ií]tulo|ttulo) ?(\d)/.exec(name);
    const level = heading ? Number(heading[1]) : style?.outline !== null && style?.outline !== undefined && style.outline < 9 ? style.outline + 1 : 0;
    if (name === "title" || name === "título" || name === "titulo") {
      const plain = p.textContent?.trim() ?? "";
      if (!title && plain && !html.replace(/<[^>]+>/g, "").trim()) {
        title = plain;
        return;
      }
      html += `<h1>${content}</h1>`;
    } else if (level) html += `<h${Math.min(level, 3)}>${content}</h${Math.min(level, 3)}>`;
    else if (/quote|cita/.test(name)) html += `<blockquote>${content}</blockquote>`;
    else if (content && !content.replace(/<img[^>]*>/g, "")) html += content;
    else {
      // Headings written as big bold text (no heading style): 20pt and up, 16pt, 14pt.
      const sizes = all(p, "r").filter((r) => r.textContent?.trim()).map((r) => [Number(attr(first(r, "sz"), "val") ?? 0), isOn(first(r, "b"))] as const);
      const plain = p.textContent?.trim() ?? "";
      const big = sizes.length && plain.length < 120 ? Math.min(...sizes.map(([sz]) => sz)) : 0;
      const bold = sizes.length > 0 && sizes.every(([, b]) => b);
      const h = big >= 40 ? 1 : big >= 32 ? 2 : big >= 28 && bold ? 3 : 0;
      html += h ? `<h${h}>${content.replace(/<\/?strong>/g, "")}</h${h}>` : `<p>${content}</p>`;
    }
  };

  const table = (tbl: Element) => {
    closeLists();
    html += "<table>";
    for (const tr of kids(tbl, "tr")) {
      html += "<tr>";
      for (const tc of kids(tr, "tc")) {
        const span = Number(attr(first(tc, "gridSpan"), "val") ?? 1);
        html += `<td${span > 1 ? ` colspan="${span}"` : ""}>${all(tc, "p")
          .map((p) => runs(p))
          .filter(Boolean)
          .join("<br>")}</td>`;
      }
      html += "</tr>";
    }
    html += "</table>";
  };

  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      if (el.localName === "p") paragraph(el);
      else if (el.localName === "tbl") table(el);
      else if (el.localName === "sdt") walk(first(el, "sdtContent") ?? el);
      else if (el.localName === "customXml" || el.localName === "sdtContent") walk(el);
    }
  };
  const body = first(doc, "body");
  if (body) walk(body);
  closeLists();
  return { title, html: `<!doctype html><html><body>${html}</body></html>` };
}

// ------------------------------------------------------------ spreadsheets

type Sheet = { name: string; rows: string[][] };

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n");

/** Rows without trailing empty cells and rows, and every row as wide as the widest. */
function trimRows(rows: string[][]) {
  const out = rows.map((r) => {
    let end = r.length;
    while (end > 0 && !r[end - 1]?.trim()) end--;
    return r.slice(0, end).map((v) => v ?? "");
  });
  while (out.length && !out[out.length - 1].length) out.pop();
  while (out.length && !out[0].length) out.shift();
  const width = Math.max(0, ...out.map((r) => r.length));
  return out.map((r) => [...r, ...Array(width - r.length).fill("")]);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** An Excel serial date (days since 1899-12-30) as "YYYY-MM-DD" (with the time when it has one). */
function serialDate(serial: number, date1904: boolean) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  const day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (serial < 1) return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return minutes ? `${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : day;
}

/** Built-in and custom number formats that show dates. */
function isDateFormat(id: number, code: string | undefined) {
  if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return true;
  if (!code) return false;
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  return /[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

/** Column letters ("AB") as a 0-based index. */
function columnIndex(ref: string) {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/** An Excel workbook's sheets as rows of text (dates as ISO dates, booleans as true/false). */
export async function xlsxSheets(buffer: ArrayBuffer): Promise<Sheet[]> {
  const files = await zipFiles(buffer);
  const book = "xl/workbook.xml";
  const xml = text(files, book);
  if (!xml) throw new Error("El archivo de Excel no es válido");
  const workbook = parseXml(xml);
  const date1904 = /^(1|true)$/i.test(attr(first(workbook, "workbookPr"), "date1904") ?? "");
  const rels = relationships(files, book);
  const shared: string[] = [];
  const sst = text(files, "xl/sharedStrings.xml");
  if (sst)
    for (const si of all(parseXml(sst), "si"))
      shared.push(
        all(si, "t")
          .filter((t) => t.parentElement?.localName !== "rPh")
          .map((t) => t.textContent ?? "")
          .join(""),
      );
  const dateStyles: boolean[] = [];
  const stylesXml = text(files, "xl/styles.xml");
  if (stylesXml) {
    const styles = parseXml(stylesXml);
    const custom = new Map(all(styles, "numFmt").map((f) => [Number(attr(f, "numFmtId")), attr(f, "formatCode") ?? ""]));
    const xfs = first(styles, "cellXfs");
    for (const xf of xfs ? kids(xfs, "xf") : []) {
      const id = Number(attr(xf, "numFmtId") ?? 0);
      dateStyles.push(isDateFormat(id, custom.get(id)));
    }
  }
  const sheets: Sheet[] = [];
  for (const sheet of all(workbook, "sheet")) {
    if (attr(sheet, "state") === "hidden" || attr(sheet, "state") === "veryHidden") continue;
    const path = rels.get(attr(sheet, "id") ?? "")?.target;
    const sheetXml = path ? text(files, path) : null;
    if (!sheetXml) continue;
    const rows: string[][] = [];
    for (const row of all(parseXml(sheetXml), "row")) {
      const r = Number(attr(row, "r") ?? rows.length + 1) - 1;
      if (r > 100000) break;
      const cells: string[] = [];
      for (const c of kids(row, "c")) {
        const col = attr(c, "r") ? columnIndex(attr(c, "r")!) : cells.length;
        if (col > 1000) continue;
        const type = attr(c, "t");
        const v = first(c, "v")?.textContent ?? "";
        let value: string;
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = all(c, "t").map((t) => t.textContent ?? "").join("");
        else if (type === "b") value = v === "1" ? "true" : "false";
        else if (type === "str" || type === "e") value = v;
        else if (v !== "" && dateStyles[Number(attr(c, "s") ?? 0)]) value = serialDate(Number(v), date1904);
        else value = v;
        cells[col] = value;
      }
      rows[r] = Array.from(cells, (x) => x ?? "");
    }
    sheets.push({ name: attr(sheet, "name") ?? `Hoja ${sheets.length + 1}`, rows: trimRows(Array.from(rows, (x) => x ?? [])) });
  }
  return sheets;
}

/** An OpenDocument spreadsheet's sheets as rows of text. */
export async function odsSheets(buffer: ArrayBuffer): Promise<Sheet[]> {
  const files = await zipFiles(buffer);
  const xml = text(files, "content.xml");
  if (!xml) throw new Error("El archivo .ods no es válido");
  const doc = parseXml(xml);
  const cellText = (cell: Element) =>
    kids(cell, "p")
      .map((p) => {
        let out = "";
        const walk = (n: Node) => {
          for (const c of Array.from(n.childNodes)) {
            if (c.nodeType === Node.TEXT_NODE) out += c.textContent ?? "";
            else if (c instanceof Element) {
              if (c.localName === "s") out += " ".repeat(Number(attr(c, "c") ?? 1));
              else if (c.localName === "tab") out += "\t";
              else if (c.localName === "line-break") out += "\n";
              else if (c.localName !== "annotation") walk(c);
            }
          }
        };
        walk(p);
        return out;
      })
      .join("\n");
  const sheets: Sheet[] = [];
  for (const table of all(doc, "table")) {
    if (table.parentElement?.localName !== "spreadsheet") continue;
    const rows: string[][] = [];
    const rowEls = all(table, "table-row");
    for (const row of rowEls) {
      const cells: string[] = [];
      for (const cell of kids(row).filter((c) => c.localName === "table-cell" || c.localName === "covered-table-cell")) {
        const repeat = Math.min(Number(attr(cell, "number-columns-repeated") ?? 1), 1000);
        const type = attr(cell, "value-type");
        let value = cellText(cell);
        if (type === "float" || type === "currency") value = attr(cell, "value") ?? value;
        else if (type === "percentage") value = `${Number(attr(cell, "value") ?? 0) * 100}%`;
        else if (type === "date") value = (attr(cell, "date-value") ?? value).replace("T", " ").replace(/ 00:00(:00)?$/, "").slice(0, 16);
        else if (type === "boolean") value = attr(cell, "boolean-value") ?? value;
        // Trailing empty cells repeat to the sheet's edge: only those with something count.
        for (let i = 0; i < (value ? repeat : Math.min(repeat, 1000)); i++) cells.push(value);
        if (cells.length > 1000) break;
      }
      const repeatRows = Number(attr(row, "number-rows-repeated") ?? 1);
      const empty = cells.every((v) => !v);
      for (let i = 0; i < (empty ? Math.min(repeatRows, 1) : Math.min(repeatRows, 10000)); i++) rows.push(cells);
      if (rows.length > 100000) break;
    }
    sheets.push({ name: attr(table, "name") ?? `Hoja ${sheets.length + 1}`, rows: trimRows(rows) });
  }
  return sheets;
}

/** Each sheet with data becomes a database; resolves with the first one's id. */
async function importSheets(fileName: string, sheets: Sheet[], target: ImportTarget): Promise<string> {
  const filled = sheets.filter((s) => s.rows.length);
  if (!filled.length) throw new Error("La hoja de cálculo está vacía");
  let firstId: string | null = null;
  for (const sheet of filled) {
    const name = filled.length === 1 ? stem(fileName) : `${stem(fileName)} - ${sheet.name}`;
    const id = await importCsv(toCsv(sheet.rows), name, target, { delimiter: "," });
    firstId ??= id;
  }
  return firstId!;
}

// ------------------------------------------------------------------ EPUB

/** An EPUB book: its title page holds one subpage per chapter (its table of contents' names). */
async function importEpub(fileName: string, buffer: ArrayBuffer, target: ImportTarget): Promise<string> {
  const files = await zipFiles(buffer);
  const container = text(files, "META-INF/container.xml");
  const opfPath = container ? attr(first(parseXml(container), "rootfile"), "full-path") : null;
  const opfXml = opfPath ? text(files, opfPath) : null;
  if (!opfPath || !opfXml) throw new Error("El archivo EPUB no es válido");
  const opf = parseXml(opfXml);
  const base = dirOf(opfPath);
  const title = first(opf, "title")?.textContent?.trim() || stem(fileName);
  const manifest = new Map(all(opf, "item").map((i) => [attr(i, "id") ?? "", { href: joinPath(base, attr(i, "href") ?? ""), type: attr(i, "media-type") ?? "", props: attr(i, "properties") ?? "" }]));
  // Chapter names from the table of contents (EPUB 3's nav, else EPUB 2's NCX).
  const names = new Map<string, string>();
  const nav = [...manifest.values()].find((i) => i.props.split(" ").includes("nav"));
  const navXml = nav ? text(files, nav.href) : null;
  if (nav && navXml)
    for (const a of Array.from(new DOMParser().parseFromString(navXml, "text/html").querySelectorAll("nav a[href]"))) {
      const path = joinPath(dirOf(nav.href), a.getAttribute("href")!);
      if (!names.has(path) && a.textContent?.trim()) names.set(path, a.textContent.trim());
    }
  const ncx = manifest.get(attr(first(opf, "spine"), "toc") ?? "");
  const ncxXml = ncx ? text(files, ncx.href) : null;
  if (ncx && ncxXml)
    for (const point of all(parseXml(ncxXml), "navPoint")) {
      const src = attr(first(point, "content"), "src");
      const label = first(point, "text")?.textContent?.trim();
      const path = src ? joinPath(dirOf(ncx.href), src) : "";
      if (path && label && !names.has(path)) names.set(path, label);
    }

  const chapters: { title: string; blocks: ImportedBlock[] }[] = [];
  for (const ref of all(opf, "itemref")) {
    const item = manifest.get(attr(ref, "idref") ?? "");
    if (!item || !/html/.test(item.type)) continue;
    const source = text(files, item.href);
    if (!source) continue;
    const page = new DOMParser().parseFromString(source, "text/html");
    const dir = dirOf(item.href);
    for (const img of Array.from(page.querySelectorAll("img[src], image"))) {
      const src = img.getAttribute("src") ?? img.getAttribute("xlink:href") ?? img.getAttribute("href");
      const url = src ? await keep(files, joinPath(dir, src)) : null;
      if (img.localName === "image") {
        // SVG covers: an <img> in their place.
        const el = page.createElement("img");
        if (url) el.setAttribute("src", url);
        img.closest("svg")?.replaceWith(el);
      } else if (url) img.setAttribute("src", url);
      else img.remove();
    }
    // Links inside the book go nowhere once it's split into pages.
    for (const a of Array.from(page.querySelectorAll("a[href]")))
      if (!/^(https?:|mailto:)/i.test(a.getAttribute("href")!)) a.removeAttribute("href");
    // The table of contents' name is the page's title: a leading heading stays in the chapter.
    const navName = names.get(item.href);
    if (navName) {
      const header = page.createElement("header");
      const h1 = page.createElement("h1");
      h1.className = "page-title";
      h1.textContent = navName;
      header.append(h1);
      page.body.prepend(header);
    }
    const { title: heading, blocks } = htmlToBlocks(`<!doctype html>${page.documentElement.outerHTML}`);
    if (!blocks.length && !heading) continue;
    chapters.push({ title: names.get(item.href) ?? heading ?? `Capítulo ${chapters.length + 1}`, blocks });
  }
  if (!chapters.length) throw new Error("El libro no tiene contenido que importar");
  if (chapters.length === 1) return importBlocks(title, chapters[0].blocks, target);
  const bookId = await importBlocks(title, [], target);
  for (const chapter of chapters) {
    const id = await createPage("block", bookId, { properties: { title: chapter.title }, content: chapter.blocks.length ? chapter.blocks : null });
    await insertPageLink(bookId, id);
  }
  return bookId;
}

// ------------------------------------------------------------------ OPML

/** An OPML outline as nested bulleted lists (each outline's note under it). */
export function opmlToHtml(source: string): { title: string | null; html: string } {
  const doc = parseXml(source);
  if (doc.querySelector("parsererror")) throw new Error("El archivo OPML no es válido");
  const list = (parent: Element): string => {
    const items = kids(parent, "outline");
    if (!items.length) return "";
    return `<ul>${items
      .map((o) => {
        const label = escapeHtml(attr(o, "text") ?? attr(o, "title") ?? "");
        const url = attr(o, "url") ?? attr(o, "htmlUrl") ?? attr(o, "xmlUrl");
        const done = attr(o, "_complete") === "true";
        let item = url ? `<a href="${escapeHtml(url)}">${label || escapeHtml(url)}</a>` : label;
        if (done) item = `<s>${item}</s>`;
        const note = attr(o, "_note");
        return `<li>${item}${note ? `<p>${escapeHtml(note).replace(/\n/g, "<br>")}</p>` : ""}${list(o)}</li>`;
      })
      .join("")}</ul>`;
  };
  const body = first(doc, "body");
  return { title: first(doc, "title")?.textContent?.trim() || null, html: `<!doctype html><html><body>${body ? list(body) : ""}</body></html>` };
}

// ------------------------------------------------------------- importing

async function importBlocks(title: string, blocks: ImportedBlock[], target: ImportTarget) {
  const id = await createPage(target.table, target.id, { properties: { title }, content: blocks.length ? blocks : null });
  if (target.table === "block") await insertPageLink(target.id, id);
  return id;
}

async function importHtml(fileName: string, { title, html }: { title: string | null; html: string }, target: ImportTarget) {
  // A known title goes where exported HTML keeps it, so a leading heading stays in the page.
  const parsed = htmlToBlocks(title ? html.replace("<body>", `<body><header><h1 class="page-title">${escapeHtml(title)}</h1></header>`) : html);
  return importBlocks(parsed.title || stem(fileName), parsed.blocks, target);
}

/** A Word, Excel, OpenDocument, EPUB, OPML or PDF file as a page or database; resolves with its id. */
export async function importOffice(file: File, target: ImportTarget): Promise<string> {
  const ext = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase();
  const buffer = await file.arrayBuffer();
  switch (ext) {
    case "docx": {
      // Named after the file (unless it has a real title), so a leading heading stays in the page.
      const doc = await docxToHtml(buffer);
      return importHtml(file.name, { ...doc, title: doc.title ?? stem(file.name) }, target);
    }
    case "xlsx":
      return importSheets(file.name, await xlsxSheets(buffer), target);
    case "ods":
      return importSheets(file.name, await odsSheets(buffer), target);
    case "epub":
      return importEpub(file.name, buffer, target);
    case "opml":
      return importHtml(file.name, opmlToHtml(decodeText(buffer)), target);
    case "pdf": {
      const { title, html } = await pdfToHtml(buffer);
      if (html) return importHtml(file.name, { title, html }, target);
      // No text to read (a scan, or an encrypted file): the PDF itself, shown in the page.
      const url = await storeFile(new File([buffer], file.name, { type: "application/pdf" }));
      return importBlocks(title || stem(file.name), [{ id: crypto.randomUUID(), type: "pdf", props: { url, name: file.name }, children: [] }], target);
    }
    default:
      throw new Error(`No se puede importar «${file.name}»`);
  }
}
