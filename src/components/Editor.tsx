import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BlockNoteSchema,
  createCodeBlockSpec,
  createExtension,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
  isTableCellSelection,
  type PartialBlock,
} from "@blocknote/core";
import {
  FilePanelExtension,
  ShowSelectionExtension,
  SideMenuExtension,
  SuggestionMenu,
} from "@blocknote/core/extensions";
import { syntaxHighlighter } from "@blocknote/code-block";
import { Extension, InputRule, markInputRule, textInputRule } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { CommentsExtension } from "@blocknote/core/comments";
import {
  getMultiColumnSlashMenuItems,
  insertColumnList,
  locales as multiColumnLocales,
  multiColumnDropCursor,
  withMultiColumn,
} from "@blocknote/xl-multi-column";
import { es } from "@blocknote/core/locales";
import {
  AddBlockButton,
  AddCommentButton,
  BasicTextStyleButton,
  BlockTypeSelect,
  blockTypeSelectItems,
  createReactBlockSpec,
  createReactInlineContentSpec,
  DragHandleMenu,
  FileCaptionButton,
  FileDeleteButton,
  FileDownloadButton,
  FileReplaceButton,
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  RemoveBlockItem,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  TableCellMergeButton,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
  useDictionary,
  useEditorChange,
  useEditorState,
  useExtension,
  useExtensionState,
  usePortalElement,
  useSelectedBlocks,
  type BlockTypeSelectItem,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import {
  AlarmClock,
  AppWindow,
  AtSign,
  Bookmark,
  CalendarDays,
  Check,
  ChevronsRight,
  Code,
  Columns2,
  Columns3,
  Columns4,
  Copy,
  CornerUpRight,
  Crop,
  ExternalLink,
  Type,
  Captions,
  Download,
  Ellipsis,
  FilePlus,
  FileText,
  FileType,
  Globe,
  Heading4,
  PanelTop,
  PanelLeft,
  Lightbulb,
  Link,
  Link2,
  Link2Off,
  ListOrdered,
  ListTree,
  Maximize2,
  MessageSquareText,
  MousePointerClick,
  Paintbrush,
  PanelsTopLeft,
  Plus,
  Radical,
  RefreshCw,
  Repeat,
  Search,
  Sheet,
  Sigma,
  Table2,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Trash2,
  WrapText,
} from "lucide-react";
import { isWorkspaceRoot, OPTION_COLOR_LABELS, OPTION_COLORS, type Block, type ViewType } from "../lib/model";
import { db } from "../lib/db";
import { pickFiles, resolveFileUrl, storeFile } from "../lib/files";
import {
  createDatabase,
  createDatabaseView,
  addRow,
  createPage,
  duplicateDatabase,
  duplicatePage,
  getAncestors,
  linkBlockFor,
  PAGE_ALIVE_EVENT,
  restoreBlock,
  shortId,
  trashBlock,
  updateBlock,
  undoLast,
  uuid,
  type PageAliveDetail,
} from "../lib/ops";
import { DatabaseEmbed, PageContext } from "./DatabaseEmbed";
import { VIEW_ICONS } from "./database/DatabaseView";
import { setDatabaseInline } from "../lib/databaseConvert";
import { XotButton } from "./XotButton";
import { withMentions } from "../lib/actions";
import { dynamicLabel, isDynamicDate } from "../lib/templates";
import { BlockEquation, InlineEquation, newEquation } from "./Equation";
import { renderMermaid } from "../lib/mermaid";
import { listCustomEmojis } from "../lib/customEmoji";
import { navigate, openInNewTab, pageLinkProps, pageTitle, readRecents, useBlock, useColorScheme } from "../lib/hooks";
import { inWorkspace, resolveWorkspace, rootFinder } from "../lib/workspace";
import {
  copyLink,
  EmojiPicker,
  hasOpenPopover,
  iconUrl,
  loadEmojis,
  MenuItem,
  Modal,
  PageIcon,
  pointerAnchor,
  Popover,
  toast,
  usePopover,
} from "./ui";
import { PagePicker } from "./PagePicker";
import { DatePicker } from "./database/properties";
import { askNotificationPermission, useOverdue } from "../lib/reminders";
import { LOCAL_USER, LocalThreadStore, type CommentAnchor, type StoredThread } from "../lib/comments";

/** A link to a child page: a `page` block inside content. */
const PageLinkBlock = createReactBlockSpec(
  {
    type: "pageLink",
    propSchema: { pageId: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) =>
      block.props.pageId ? (
        <PageLink pageId={block.props.pageId} />
      ) : (
        <PageLinkChooser onPick={(pageId) => editor.updateBlock(block, { props: { pageId } })} />
      ),
  },
);

/** "Enlace a una página": a page picker in place until a page is chosen. */
function PageLinkChooser({ onPick }: { onPick: (pageId: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const pageId = useContext(PageContext);
  useEffect(() => setAnchor(ref.current), []);
  return (
    <div
      ref={ref}
      className="page-link page-link--missing"
      contentEditable={false}
      // The picker is portaled, but its clicks still bubble here through React.
      onClick={(e) => ref.current?.contains(e.target as Node) && setAnchor(ref.current)}
    >
      <Link2 size={16} /> Enlace a una página
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={320}>
          <PagePicker
            placeholder="Busca una página para enlazar…"
            exclude={[pageId]}
            onPick={(page) => {
              setAnchor(null);
              onPick(page.id);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

type InlineNode = { type: string; text?: string; content?: InlineNode[] };

/** Inline content cut at a text offset (ProseMirror's: a mention or an equation counts 1), links split too. */
function splitInline(content: InlineNode[], at: number): [InlineNode[], InlineNode[]] {
  const before: InlineNode[] = [];
  const after: InlineNode[] = [];
  let pos = 0;
  for (const node of content) {
    const len =
      node.type === "text" ? (node.text ?? "").length : node.type === "link" ? textOf(node.content).length : 1;
    if (pos + len <= at) before.push(node);
    else if (pos >= at) after.push(node);
    else if (node.type === "link") {
      const [b, a] = splitInline(node.content ?? [], at - pos);
      before.push({ ...node, content: b });
      after.push({ ...node, content: a });
    } else {
      before.push({ ...node, text: node.text!.slice(0, at - pos) });
      after.push({ ...node, text: node.text!.slice(at - pos) });
    }
    pos += len;
  }
  return [before, after];
}

/** The blocks where "> " and '" ' at the start turn the line into a toggle or a quote. */
const TEXT_SHORTCUT_TYPES = new Set(["paragraph", "bulletListItem", "numberedListItem", "checkListItem", "heading"]);
const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? (content as InlineNode[]).map((i) => (i.type === "link" ? textOf(i.content) : (i.text ?? ""))).join("")
    : "";

export type Heading = { id: string; level: number; text: string };

/** The blocks whose headings count: not those in toggles, lists or tabs. */
const HEADING_CONTAINERS = new Set(["columnList", "column", "callout", "synced"]);

export function headingsOf(blocks: AnyBlock[], out: Heading[] = []): Heading[] {
  for (const b of blocks) {
    if (b.type === "heading")
      out.push({ id: b.id, level: Number((b.props as { level?: number }).level) || 1, text: textOf(b.content) });
    if (HEADING_CONTAINERS.has(b.type)) headingsOf(b.children, out);
  }
  return out;
}

/**
 * Each heading's indent in the "Índice": how many higher levels are open above it,
 * so a lone H2 isn't indented and an H3 right after an H1 goes one step in.
 */
export function headingDepths(headings: Heading[]): number[] {
  const open = new Set<number>();
  return headings.map(({ level }) => {
    if (![...open].some((l) => l < level)) open.clear();
    open.add(level);
    return [...open].filter((l) => l < level).length;
  });
}

const scrollToBlock = (id: string) =>
  document.querySelector(`.bn-block[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });

/** "Índice": the page's headings, live, indented by level; a click scrolls to one. */
const TableOfContentsBlock = createReactBlockSpec(
  { type: "tableOfContents", propSchema: {}, content: "none" },
  { render: ({ editor }) => <TableOfContents editor={editor as unknown as XotEditor} /> },
);

function TableOfContents({ editor }: { editor: XotEditor }) {
  const [headings, setHeadings] = useState(() => headingsOf(editor.document as AnyBlock[]));
  useEffect(() => editor.onChange(() => setHeadings(headingsOf(editor.document as AnyBlock[]))), [editor]);
  if (!headings.length)
    return (
      <p className="toc toc--empty" contentEditable={false}>
        Agrega encabezados para crear una tabla de contenido.
      </p>
    );
  const depths = headingDepths(headings);
  return (
    <nav className="toc" contentEditable={false} aria-label="Índice">
      {headings.map((h, i) => (
        <button
          type="button"
          key={h.id}
          className="toc__item"
          style={{ paddingLeft: 2 + depths[i] * 24 }}
          onClick={() => scrollToBlock(h.id)}
        >
          <span>{h.text || "Sin título"}</span>
        </button>
      ))}
    </nav>
  );
}

/** "Ruta de navegación": the page's path, like the top bar's. */
const BreadcrumbBlock = createReactBlockSpec(
  { type: "breadcrumb", propSchema: {}, content: "none" },
  { render: () => <Breadcrumb /> },
);

function Breadcrumb() {
  const pageId = useContext(PageContext);
  const crumbs = useLiveQuery(async () => {
    const page = await db.blocks.get(pageId);
    if (!page) return [];
    return [...(await getAncestors(page)).filter((a) => a.id !== page.id && !isWorkspaceRoot(a.id)), page];
  }, [pageId]);
  return (
    <nav className="crumbs breadcrumb-block" contentEditable={false} aria-label="Ruta de navegación">
      {(crumbs ?? []).map((b, i, all) => (
        <span className="crumbs__item" key={b.id}>
          <button type="button" className="crumb" onClick={() => navigate(b.id)}>
            <PageIcon block={b} size={16} />
            <span>{pageTitle(b)}</span>
          </button>
          {i < all.length - 1 && <span className="crumbs__sep">/</span>}
        </span>
      ))}
    </nav>
  );
}

/**
 * "Marcador web": a link card with the page's title, description, icon and picture (read by the
 * macOS app, electron/linkPreview.cjs). Without them (offline, in the browser) its title is the site's name.
 */
const BookmarkBlock = createReactBlockSpec(
  {
    type: "bookmark",
    propSchema: { url: { default: "" }, title: { default: "" }, description: { default: "" }, image: { default: "" }, icon: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const preview = (url: string) =>
        void linkPreview(url).then((p) => {
          const current = editor.getBlock(block.id);
          if (p && current?.type === "bookmark" && current.props.url === url)
            editor.updateBlock(block.id, {
              props: { title: p.title || hostOf(url), description: p.description, image: p.image, icon: p.icon },
            });
        });
      return (
        <WebBookmark
          {...block.props}
          onPreview={() => preview(block.props.url)}
          onChange={(url) => {
            editor.updateBlock(block, { props: { url, title: hostOf(url), description: "", image: "", icon: "" } });
            preview(url);
            // Back to writing, on the line below the card.
            const next = editor.getNextBlock(block.id);
            const line =
              next && Array.isArray(next.content) ? next : editor.insertBlocks([{ type: "paragraph" } as never], block.id, "after")[0];
            editor.setTextCursorPosition(line.id, "start");
            editor.focus();
          }}
        />
      );
    },
  },
);

type LinkPreview = { title: string; description: string; image: string; icon: string };
/** Links already looked up this session: an old card (or one whose page has no tags) asks once. */
const previewed = new Set<string>();
async function linkPreview(url: string): Promise<LinkPreview | null> {
  previewed.add(url);
  const app = (window as { xotDesktop?: { linkPreview?(url: string): Promise<LinkPreview | null> } }).xotDesktop;
  try {
    return (await app?.linkPreview?.(url)) ?? null;
  } catch {
    return null;
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Set by the slash menu: the next empty bookmark to mount is a new one and asks for its link. */
const newBookmark = { pending: false };

function WebBookmark({
  url,
  title,
  description,
  image,
  icon,
  onChange,
  onPreview,
}: {
  url: string;
  title: string;
  description: string;
  image: string;
  icon: string;
  onChange: (url: string) => void;
  onPreview: () => void;
}) {
  const [badIcon, setBadIcon] = useState(false);
  const [badImage, setBadImage] = useState(false);
  // A card made before the app read pages (or in the browser) gets its details once.
  useEffect(() => {
    if (url && !description && !icon && !image && !previewed.has(url)) onPreview();
  }, [url]);
  if (!url)
    return (
      <UrlPrompt icon={<Bookmark size={20} />} label="Agregar un marcador web" action="Crear marcador" pending={newBookmark} onSubmit={onChange} />
    );
  let favicon = icon;
  if (!favicon)
    try {
      favicon = new URL("/favicon.ico", url).href;
    } catch {
      favicon = "";
    }
  return (
    <a className="bookmark" href={url} target="_blank" rel="noreferrer" contentEditable={false}>
      <span className="bookmark__body">
        <span className="bookmark__title">{title || hostOf(url)}</span>
        {description && <span className="bookmark__description">{description}</span>}
        <span className="bookmark__url">
          {favicon && !badIcon ? <img className="bookmark__icon" src={favicon} alt="" onError={() => setBadIcon(true)} /> : <Globe size={16} />}
          <span>{url}</span>
        </span>
      </span>
      {image && !badImage && (
        <span className="bookmark__image">
          <img src={image} alt="" onError={() => setBadImage(true)} />
        </span>
      )}
    </a>
  );
}

/** An empty link block ("Agregar un marcador web", "Insertar"): its gray row, and the link field in a popover. */
function UrlPrompt({
  icon,
  label,
  action,
  pending,
  onSubmit,
}: {
  icon: ReactNode;
  label: string;
  action: string;
  /** Set by the slash menu: the block being added asks for its link right away. */
  pending: { pending: boolean };
  onSubmit: (url: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const rowRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // A new block asks for its link right away; one left empty just shows its placeholder row.
  useEffect(() => {
    if (!pending.pending) return;
    // Next frame: the block mounts while BlockNote is still rendering its node view.
    const raf = requestAnimationFrame(() => {
      pending.pending = false;
      setOpen(true);
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div
      ref={rowRef}
      className="bookmark-empty"
      contentEditable={false}
      // The popover is portaled, but its clicks still bubble here through React.
      onClick={(e) => rowRef.current?.contains(e.target as Node) && setOpen(true)}
    >
      {icon}
      <span>{label}</span>
      {open && rowRef.current && (
        <Popover anchor={rowRef.current} onClose={() => setOpen(false)} width={400}>
          <form
            className="bookmark-input"
            onSubmit={(e) => {
              e.preventDefault();
              const value = draft.trim();
              if (!value) return;
              setOpen(false);
              onSubmit(/^[a-z][\w+.-]*:/i.test(value) ? value : `https://${value}`);
            }}
          >
            <input
              autoFocus
              className="field"
              placeholder="Pega el enlace…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
            />
            <button type="submit" className="xot-btn xot-btn--primary">
              {action}
            </button>
          </form>
        </Popover>
      )}
    </div>
  );
}

/** "Insertar": a web page (YouTube, Vimeo, Loom, Figma, Maps…) shown in a frame. */
const EmbedBlock = createReactBlockSpec(
  { type: "embed", propSchema: { url: { default: "" }, height: { default: 0 } }, content: "none" },
  {
    render: ({ block, editor }) =>
      block.props.url ? (
        <WebEmbed
          url={block.props.url}
          height={block.props.height}
          onResize={editor.isEditable ? (height) => editor.updateBlock(block, { props: { height } }) : undefined}
        />
      ) : (
        <UrlPrompt
          icon={<AppWindow size={20} />}
          label="Insertar cualquier cosa (PDF, Google Drive, Figma, YouTube…)"
          action="Insertar enlace"
          pending={newEmbed}
          onSubmit={(url) => editor.updateBlock(block, { props: { url } })}
        />
      ),
  },
);

const newEmbed = { pending: false };

/** The address a link can be framed at: video and design sites have their own player pages. */
function embedSrc(url: string): { src: string; video: boolean } {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return { src: `https://www.youtube.com/embed/${u.pathname.slice(1)}`, video: true };
    if (host.endsWith("youtube.com")) {
      const id = u.searchParams.get("v") ?? /\/(?:shorts|embed|live)\/([\w-]+)/.exec(u.pathname)?.[1];
      if (id) return { src: `https://www.youtube.com/embed/${id}`, video: true };
    }
    if (host === "vimeo.com" && /^\/\d+/.test(u.pathname)) return { src: `https://player.vimeo.com/video${u.pathname}`, video: true };
    if (host === "loom.com") return { src: url.replace("/share/", "/embed/"), video: true };
    if (host.endsWith("figma.com")) return { src: `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(url)}`, video: false };
    // Other embeds: each site's own embeddable page.
    let m: RegExpExecArray | null;
    if ((host === "twitter.com" || host === "x.com") && (m = /\/status(?:es)?\/(\d+)/.exec(u.pathname)))
      return { src: `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}&dnt=true`, video: false };
    if (host === "gist.github.com" && /^\/[^/]+\/[0-9a-f]+\/?$/i.test(u.pathname))
      return { src: `https://gist.github.com${u.pathname.replace(/\/$/, "")}.pibb`, video: false };
    if (host === "drive.google.com" && (m = /\/file\/d\/([\w-]+)/.exec(u.pathname)))
      return { src: `https://drive.google.com/file/d/${m[1]}/preview`, video: false };
    if (host === "drive.google.com" && (m = /\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/.exec(u.pathname)))
      return { src: `https://drive.google.com/embeddedfolderview?id=${m[1]}#list`, video: false };
    if (host === "docs.google.com" && (m = /^\/(document|spreadsheets|presentation|forms)\/d\/(e\/)?([\w-]+)/.exec(u.pathname)))
      return { src: `https://docs.google.com/${m[1]}/d/${m[2] ?? ""}${m[3]}/${m[1] === "forms" ? "viewform?embedded=true" : "preview"}`, video: false };
    if ((host === "google.com" || host.startsWith("google.") || host === "maps.google.com") && u.pathname.startsWith("/maps")) {
      // A place or a search: its name (or the coordinates after "@") in Google's embeddable map.
      const place = /\/maps\/(?:place|search)\/([^/]+)/.exec(u.pathname)?.[1];
      const at = /@(-?[\d.]+),(-?[\d.]+)/.exec(u.pathname);
      const q = place ? decodeURIComponent(place.replace(/\+/g, " ")) : at ? `${at[1]},${at[2]}` : u.searchParams.get("q") ?? "";
      if (q) return { src: `https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed`, video: false };
    }
    if (host === "goo.gl" && u.pathname.startsWith("/maps")) return { src: url, video: false };
    if (host === "codepen.io" && (m = /^\/(.+?)\/(?:pen|full|details)\/([\w-]+)/.exec(u.pathname)))
      return { src: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`, video: false };
    if (host === "codesandbox.io" && (m = /^\/(?:s|p\/sandbox)\/([\w-]+)/.exec(u.pathname)))
      return { src: `https://codesandbox.io/embed/${m[1]}`, video: false };
    if (host.endsWith("typeform.com") && (m = /\/to\/([\w-]+)/.exec(u.pathname)))
      return { src: `https://form.typeform.com/to/${m[1]}?typeform-embed=embed-widget`, video: false };
    if (host === "open.spotify.com" && !u.pathname.startsWith("/embed"))
      return { src: `https://open.spotify.com/embed${u.pathname.replace(/^\/intl-[\w-]+/, "")}`, video: false };
    if (host === "soundcloud.com") return { src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}`, video: false };
    if (host === "miro.com" && (m = /\/app\/board\/([\w=-]+)/.exec(u.pathname)))
      return { src: `https://miro.com/app/live-embed/${m[1]}/`, video: false };
    if (host === "dailymotion.com" && (m = /\/video\/([\w]+)/.exec(u.pathname)))
      return { src: `https://www.dailymotion.com/embed/video/${m[1]}`, video: true };
    if (host === "twitch.tv" && (m = /^\/videos\/(\d+)/.exec(u.pathname)))
      return { src: `https://player.twitch.tv/?video=${m[1]}&parent=${location.hostname || "localhost"}`, video: true };
  } catch {
    /* not a URL: framed as it is */
  }
  return { src: url, video: false };
}

/** Whether a pasted link has its own player (offered as "Insertar vídeo"). */
const isVideoLink = (url: string) => embedSrc(url).video;

/** The frame of "Insertar"; its bottom edge drags to resize it (the height is kept). */
function WebEmbed({ url, height, onResize }: { url: string; height?: number; onResize?: (height: number) => void }) {
  const { src, video } = embedSrc(url);
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? height;
  const startResize = (e: React.PointerEvent) => {
    if (!onResize || !ref.current) return;
    e.preventDefault();
    e.stopPropagation();
    // Captured: moving over the frame would otherwise send the moves to the framed page.
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const start = { y: e.clientY, h: ref.current.getBoundingClientRect().height };
    let last = start.h;
    // From the press on, the frame lets the moves through (see .is-resizing).
    setDragging(last);
    const onMove = (ev: PointerEvent) => {
      last = Math.max(120, Math.min(2000, Math.round(start.h + ev.clientY - start.y)));
      setDragging(last);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(null);
      onResize(last);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return (
    <div
      ref={ref}
      className={`embed-block${video ? " embed-block--video" : ""}${dragging !== null ? " is-resizing" : ""}`}
      style={shown ? { height: shown, aspectRatio: "auto" } : undefined}
      contentEditable={false}
    >
      {onResize && (
        // The press mustn't start the editor's block drag (or text selection) instead.
        <div className="embed-block__resize" onPointerDown={startResize} onMouseDown={(e) => (e.preventDefault(), e.stopPropagation())} aria-hidden />
      )}
      <iframe
        src={src}
        title={hostOf(url)}
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"
        allow="fullscreen; encrypted-media; picture-in-picture; clipboard-write"
      />
    </div>
  );
}

/** "PDF": a file from this device, shown in the browser's PDF viewer. */
const PdfBlock = createReactBlockSpec(
  { type: "pdf", propSchema: { url: { default: "" }, name: { default: "" } }, content: "none" },
  {
    render: ({ block, editor }) => (
      <PdfView
        url={block.props.url}
        editable={editor.isEditable}
        onPick={(url, name) => editor.updateBlock(block, { props: { url, name } })}
      />
    ),
  },
);

function PdfView({ url, editable, onPick }: { url: string; editable: boolean; onPick: (url: string, name: string) => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!url) return;
    let alive = true;
    let owned = "";
    void resolveFileUrl(url).then(async (resolved) => {
      // Small files are stored inline; the viewer wants a blob: URL.
      if (resolved.startsWith("data:")) resolved = owned = URL.createObjectURL(await (await fetch(resolved)).blob());
      if (alive) setSrc(resolved);
    });
    return () => {
      alive = false;
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [url]);
  if (!url)
    return (
      <div
        className="bookmark-empty"
        contentEditable={false}
        onClick={() =>
          editable &&
          void pickFiles("application/pdf").then(async ([file]) => file && onPick(await storeFile(file), file.name))
        }
      >
        <FileType size={20} />
        <span>Agregar un PDF</span>
      </div>
    );
  return <div className="pdf-block" contentEditable={false}>{src && <embed src={src} type="application/pdf" />}</div>;
}

function PageLink({ pageId }: { pageId: string }) {
  const page = useBlock(pageId);
  const parentId = useContext(PageContext);
  if (page === undefined) return <div className="page-link" />;
  // A trashed subpage takes its block with it (the editor removes it); a link to a page elsewhere shows it's gone.
  if (page && !page.alive && page.parent_table === "block" && page.parent_id === parentId) return <div className="page-link" hidden />;
  if (!page || !page.alive)
    return (
      <div className="page-link page-link--missing" contentEditable={false}>
        <FileText size={16} /> Página eliminada
      </div>
    );
  return (
    <div className="page-link" contentEditable={false} {...pageLinkProps(page.id)}>
      <PageIcon block={page} size={19} />
      <span className="page-link__title">{pageTitle(page)}</span>
    </div>
  );
}

/** A database (inline or linked view) shown inside the page. */
const DatabaseBlock = createReactBlockSpec(
  {
    type: "database",
    propSchema: { blockId: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <DatabaseEmbed
        blockId={block.props.blockId}
        onLink={(id) => editor.updateBlock(block, { props: { blockId: id } })}
      />
    ),
  },
);

/** Button: runs its actions (add a page, open a page or link, confirm). */
const ButtonBlock = createReactBlockSpec(
  {
    type: "button",
    propSchema: {
      label: { default: "Botón" },
      icon: { default: "" },
      color: { default: "default" },
      /** JSON list of ButtonAction; empty means the simple "add a page" setup below. */
      actions: { default: "" },
      databaseId: { default: "" },
      pageTitle: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <XotButton
        props={block.props}
        onChange={(props) => editor.updateBlock(block, { props })}
        onInsert={(content, position, pageId) => {
          const parsed = typeof content === "string" ? editor.tryParseMarkdownToBlocks(content) : (content as typeof editor.document);
          const blocks = withMentions(parsed, pageId);
          if (!blocks.length) return;
          // "Al principio/final de la página": before the first block or after the last one.
          const doc = editor.document;
          if (position === "start") editor.insertBlocks(blocks, doc[0].id, "before");
          else if (position === "end") editor.insertBlocks(blocks, doc[doc.length - 1].id, "after");
          else editor.insertBlocks(blocks, block.id, position === "above" ? "before" : "after");
        }}
      />
    ),
  },
);

/** Callout: an icon beside the text, in a tinted box that also holds its children. */
const CalloutBlock = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      icon: { default: "💡" },
      backgroundColor: { default: "default" },
      textColor: { default: "default" },
    },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => (
      <div className="callout">
        <CalloutIcon
          icon={block.props.icon}
          editable={editor.isEditable}
          onChange={(icon) => editor.updateBlock(block, { props: { icon } })}
        />
        <div className="callout__body" ref={contentRef} />
      </div>
    ),
  },
);

/** The callout's icon opens the icon picker. */
function CalloutIcon({ icon, editable, onChange }: { icon: string; editable: boolean; onChange: (icon: string) => void }) {
  const pop = usePopover();
  if (!icon && !editable) return null;
  const url = icon ? iconUrl(icon) : null;
  return (
    <>
      <button
        type="button"
        className="callout__icon"
        contentEditable={false}
        disabled={!editable}
        aria-label="Cambiar icono"
        onClick={(e) => pop.toggle(e.currentTarget)}
      >
        {url ? <img src={url} alt="" /> : icon || "💡"}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={408}>
          <EmojiPicker
            onPick={(emoji) => {
              onChange(emoji);
              pop.close();
            }}
            onRemove={() => {
              onChange("");
              pop.close();
            }}
          />
        </Popover>
      )}
    </>
  );
}

/**
 * Inline mentions: a page (icon + underlined title, opens it) or a
 * date ("@10 de junio de 2026"). `title` is shown when the page isn't in Xot.
 */
const Mention = createReactInlineContentSpec(
  {
    type: "mention",
    // reminder: "Recordar" (lib/reminders.ts schedules it); remind: how long before ("" at the time).
    propSchema: {
      pageId: { default: "" },
      date: { default: "" },
      title: { default: "" },
      reminder: { default: false },
      remind: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <MentionView
        {...inlineContent.props}
        editable={editor.isEditable}
        onDate={(date) => updateInlineContent({ type: "mention", props: { ...inlineContent.props, date } })}
        onReminder={(code) =>
          updateInlineContent({ type: "mention", props: { ...inlineContent.props, reminder: !!code, remind: code === "0" ? "" : code } })
        }
        onRemove={(el) => removeInlineNode(editor as unknown as XotEditor, el, "mention")}
      />
    ),
  },
);

/** Link mention (a pasted URL > "Mención"): a globe and the site's name, underlined; opens the link. */
/** A custom emoji in the text (Configuración > Emoji); its picture travels with it, so it stays if the emoji is deleted. */
const CustomEmojiSpec = createReactInlineContentSpec(
  { type: "customEmoji", propSchema: { name: { default: "" }, src: { default: "" } }, content: "none" },
  {
    render: ({ inlineContent }) => (
      <img
        className="xot-custom-emoji"
        src={inlineContent.props.src}
        alt={`:${inlineContent.props.name}:`}
        title={`:${inlineContent.props.name}:`}
        draggable={false}
      />
    ),
  },
);

const LinkMention = createReactInlineContentSpec(
  { type: "linkMention", propSchema: { url: { default: "" } }, content: "none" },
  {
    render: ({ inlineContent }) => (
      <span
        className="mention mention--page mention--link"
        title={inlineContent.props.url}
        onClick={() => window.open(inlineContent.props.url, "_blank", "noopener")}
      >
        <Globe size={15} className="mention__globe" />
        <span className="mention__title">{hostOf(inlineContent.props.url)}</span>
      </span>
    ),
    toExternalHTML: ({ inlineContent }) => <a href={inlineContent.props.url}>{hostOf(inlineContent.props.url)}</a>,
  },
);

/** Deletes the inline node (a mention) whose view holds `el`. */
function removeInlineNode(editor: XotEditor, el: HTMLElement, type: string) {
  const view = editor.prosemirrorView;
  let pos: number;
  try {
    pos = view.posAtDOM(el, 0);
  } catch {
    return;
  }
  const at = [pos, pos - 1].find((p) => p >= 0 && view.state.doc.nodeAt(p)?.type.name === type);
  if (at !== undefined) view.dispatch(view.state.tr.delete(at, at + 1));
}

const longDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" });
const timeOfDay = new Intl.DateTimeFormat("es", { hour: "numeric", minute: "2-digit" });
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayOffset = (days: number) => isoDay(new Date(Date.now() + days * 86400000));

/** "2026-06-10" or "2026-06-10T09:30": Hoy / Mañana / Ayer, or the long date. */
function mentionDate(value: string) {
  // A template's "@Hoy"/"@Ahora": the day a page is made from it (lib/templates.ts).
  if (isDynamicDate(value)) return dynamicLabel(value);
  const [day, time] = value.split("T");
  const d = new Date(`${day}T${time ?? "00:00"}`);
  if (Number.isNaN(d.getTime())) return value;
  const relative = { [dayOffset(0)]: "Hoy", [dayOffset(1)]: "Mañana", [dayOffset(-1)]: "Ayer" }[day];
  const label = relative ?? longDate.format(d);
  return time ? `${label} ${timeOfDay.format(d)}` : label;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const WEEKDAY_NAMES = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

/**
 * What "@…" reads as a date: "15/10/2026", "2026-10-15", "15 de octubre",
 * hoy / mañana / ayer, "viernes", "próximo viernes", "en 3 días", each with an optional
 * time: "a las 3", "10:00", "10am", "15:30h". Returns "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm", null when it isn't one.
 */
function parseMentionDate(query: string): string | null {
  let q = fold(query).trim().replace(/\s+/g, " ");
  if (!q) return null;
  let time = "";
  // "a las 3", "10:00", "10am", "15:30h": a bare number ("16 de octubre 2026", "15") isn't a time.
  const at = /(?:^| )(a las |a la )?(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.? ?m\.?|p\.? ?m\.?|h)?$/.exec(q);
  if (at && (at[1] || at[3] || at[4])) {
    let h = +at[2];
    const m = +(at[3] ?? 0);
    const half = at[4]?.replace(/[. ]/g, "");
    if (half === "pm" && h < 12) h += 12;
    else if (half === "am" && h === 12) h = 0;
    // "a las 3" is in the afternoon; "3:00" is a clock time as written.
    else if (!half && at[1] && h >= 1 && h <= 7) h += 12;
    if (h > 23 || m > 59) return null;
    time = `T${pad2(h)}:${pad2(m)}`;
    q = q.slice(0, at.index).trim();
  }
  const today = new Date();
  const day = (offset: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  const exact = (y: number, mo: number, d: number) => {
    const date = new Date(y, mo, d);
    return date.getMonth() === mo && date.getDate() === d ? date : null;
  };
  let date: Date | null = null;
  let m: RegExpExecArray | null;
  if (!q) date = time ? day(0) : null;
  else if (q === "hoy") date = day(0);
  else if (q === "manana") date = day(1);
  else if (q === "pasado manana") date = day(2);
  else if (q === "ayer") date = day(-1);
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q))) date = exact(+m[1], +m[2] - 1, +m[3]);
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(q)))
    date = exact(m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getFullYear(), +m[2] - 1, +m[1]);
  else if ((m = /^(\d{1,2})(?: de)? ([a-z]{3,})(?:,?(?: de)? (\d{4}))?$/.exec(q))) {
    const month = MONTH_NAMES.findIndex((name) => name.startsWith(m![2].slice(0, 3)));
    if (month >= 0) date = exact(m[3] ? +m[3] : today.getFullYear(), month, +m[1]);
  } else if ((m = /^en (\d{1,3}) (dias?|semanas?|mes(?:es)?)$/.exec(q))) {
    const n = +m[1];
    date = m[2].startsWith("dia") ? day(n) : m[2].startsWith("semana") ? day(7 * n) : new Date(today.getFullYear(), today.getMonth() + n, today.getDate());
  } else if ((m = /^(?:(el )?(proximo|este) )?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)$/.exec(q))) {
    const diff = (WEEKDAY_NAMES.indexOf(m[3]) - today.getDay() + 7) % 7;
    date = day(diff || 7);
  }
  return date ? `${isoDay(date)}${time}` : null;
}

/** Where a page lives (its parent page or database), shown under same-named pages in the menus. */
async function pagePlace(page: Block): Promise<string> {
  if (page.parent_table === "block") {
    const parent = await db.blocks.get(page.parent_id);
    return parent && !isWorkspaceRoot(parent.id) ? pageTitle(parent) : "";
  }
  if (page.parent_table === "collection") {
    const collection = await db.collections.get(page.parent_id);
    const database = collection && (await db.blocks.get(collection.parent_id));
    return database ? pageTitle(database) : "";
  }
  return "";
}

/**
 * The current workspace's pages whose title has `q`, most recently visited first
 * (then most recently edited), each with a title the menu can key by.
 */
async function pageItems(q: string, onPick: (page: Block) => void, group: string): Promise<DefaultReactSuggestionItem[]> {
  const [blocks, collections] = await Promise.all([db.blocks.toArray(), db.collections.toArray()]);
  const ws = resolveWorkspace(blocks);
  const rootOf = rootFinder(blocks, collections);
  const recent = new Map(readRecents().map((id, i) => [id, i]));
  const rank = (b: Block) => recent.get(b.id) ?? Infinity;
  const found = blocks
    .filter(
      (b) =>
        b.alive &&
        !b.is_template &&
        !isWorkspaceRoot(b.id) &&
        fold(pageTitle(b)).includes(q) &&
        inWorkspace(rootOf(b), ws),
    )
    .sort((a, b) => rank(a) - rank(b) || b.last_edited_time - a.last_edited_time)
    .slice(0, 8);
  // BlockNote keys the rows by title: same-named pages get an invisible suffix (each shows its place).
  const seen = new Map<string, number>();
  return Promise.all(
    found.map(async (p) => {
      const title = pageTitle(p);
      const n = seen.get(title) ?? 0;
      seen.set(title, n + 1);
      const place = await pagePlace(p);
      return {
        title: title + "\u200b".repeat(n),
        // The gray path at the right of the row.
        badge: place ? (place.length > 18 ? `${place.slice(0, 17)}…` : place) : undefined,
        group,
        icon: <PageIcon block={p} size={18} />,
        onItemClick: () => onPick(p),
      };
    }),
  );
}

function MentionView({
  pageId,
  date,
  title,
  reminder,
  remind = "",
  editable = false,
  onDate,
  onReminder,
  onRemove,
}: {
  pageId: string;
  date: string;
  title: string;
  reminder?: boolean;
  remind?: string;
  editable?: boolean;
  onDate?: (date: string) => void;
  onReminder?: (code: string) => void;
  onRemove?: (el: HTMLElement) => void;
}) {
  const page = useBlock(pageId || null);
  const pop = usePopover();
  const overdue = useOverdue(date, reminder ? remind || "0" : "");
  // "Recordar": App.tsx keeps every reminder scheduled (lib/reminders.ts), whatever page is open.
  if (date) {
    const [start, end] = date.split("/");
    return (
      <>
        <span
          className={`mention mention--date${reminder ? " mention--reminder" : ""}${overdue ? " mention--overdue" : ""}`}
          onClick={(e) => editable && pop.toggle(e.currentTarget)}
        >
          {reminder && <AlarmClock size={14} />}@{mentionDate(start)}
          {end ? ` → ${mentionDate(end)}` : ""}
        </span>
        {pop.anchor && (
          <Popover anchor={pop.anchor} onClose={pop.close} width={280}>
            <DatePicker
              value={isDynamicDate(date) ? null : date}
              reminder={reminder ? remind || "0" : ""}
              onReminder={onReminder}
              onChange={(next) => (next ? onDate?.(next) : onRemove?.(pop.anchor!))}
              onClear={() => {
                const el = pop.anchor!;
                pop.close();
                onRemove?.(el);
              }}
            />
          </Popover>
        )}
      </>
    );
  }
  if (!page || !page.alive)
    return (
      <span className="mention mention--missing">
        <FileText size={15} />
        <span className="mention__title">{page === undefined ? title : title || "Página sin acceso"}</span>
      </span>
    );
  return (
    <span className="mention mention--page" onClick={() => navigate(page.id)}>
      <PageIcon block={page} size={16} />
      <span className="mention__title">{pageTitle(page)}</span>
    </span>
  );
}

/** "Ecuación del bloque": TeX rendered with KaTeX, edited in a popover. */
const EquationBlock = createReactBlockSpec(
  { type: "equation", propSchema: { latex: { default: "" } }, content: "none" },
  {
    render: ({ block, editor }) => (
      <BlockEquation
        latex={block.props.latex}
        editable={editor.isEditable}
        onChange={(latex) => editor.updateBlock(block, { props: { latex } })}
      />
    ),
  },
);

/** Inline equation ($$…$$ or ⌘⇧E). */
const InlineEquationSpec = createReactInlineContentSpec(
  { type: "inlineEquation", propSchema: { latex: { default: "" } }, content: "none" },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <InlineEquation
        latex={inlineContent.props.latex}
        editable={editor.isEditable}
        onChange={(latex) => updateInlineContent({ type: "inlineEquation", props: { latex } })}
      />
    ),
  },
);

/** "Bloque sincronizado": its content lives apart (the synced table) and every copy edits it. */
const SyncedBlock = createReactBlockSpec(
  { type: "synced", propSchema: { sourceId: { default: "" } }, content: "none" },
  {
    // Events inside belong to the nested editor, not to the page's.
    meta: { selectable: false },
    render: ({ block, editor }) => (
      <SyncedSection
        sourceId={block.props.sourceId}
        editable={editor.isEditable}
        onCopy={() => copySyncedBlock(editor as unknown as XotEditor, block.id)}
        onUnsync={(content) => editor.replaceBlocks([block.id], stripIds(normalizeContent(content as StoredBlock[])) as never)}
      />
    ),
  },
);

/**
 * "Pestañas": a row of tabs over the blocks of the one chosen. Each tab is a child `tab` block
 * (its title in a prop) holding that tab's blocks; only the chosen tab's show (a rule in a <style>).
 */
const TabsBlock = createReactBlockSpec(
  { type: "tabs", propSchema: { active: { default: "" } }, content: "none" },
  {
    meta: { selectable: false },
    render: ({ block, editor }) => <TabStrip id={block.id} editor={editor as unknown as XotEditor} />,
  },
);

/** One tab: nothing of its own shows, only its blocks (or, empty, a line to start writing in). */
const TabBlock = createReactBlockSpec(
  { type: "tab", propSchema: { title: { default: "" } }, content: "none" },
  {
    meta: { selectable: false },
    render: ({ block, editor }) => <TabPanelStart id={block.id} editor={editor as unknown as XotEditor} />,
  },
);

/** A new "Pestañas" block: two tabs, each with an empty line. */
const newTabs = () => ({
  type: "tabs",
  children: [1, 2].map((n) => ({ type: "tab", props: { title: `Pestaña ${n}` }, children: [{ type: "paragraph" }] })),
});

/**
 * Puts the caret in a block once the press that led here is over: BlockNote blurs the editor
 * 10ms after a press in a block that isn't selectable (the tabs).
 */
function editAt(editor: XotEditor, id: string | undefined) {
  if (!id) return;
  window.setTimeout(() => {
    if (!editor.getBlock(id)) return;
    editor.setTextCursorPosition(id, "start");
    editor.focus();
  }, 30);
}
let lastTabClick = { id: "", at: 0 };

function useLiveBlock(editor: XotEditor, id: string) {
  const [, tick] = useState(0);
  useEditorChange(() => tick((n) => n + 1), editor as never);
  return editor.getBlock(id) as AnyBlock | undefined;
}

/**
 * The tab chosen in each "Pestañas" block. Choosing one is view state: not an edit (no
 * undo step, allowed on locked pages); the stored `active` prop is only the one it starts on.
 */
const CHOSEN_TABS_KEY = "xot:chosen-tabs";
let chosenTabs: Record<string, string> | null = null;
function chosenTab(tabsId: string): string | undefined {
  if (!chosenTabs) {
    try {
      chosenTabs = JSON.parse(localStorage.getItem(CHOSEN_TABS_KEY) ?? "{}") as Record<string, string>;
    } catch {
      chosenTabs = {};
    }
  }
  return chosenTabs[tabsId];
}
function chooseTab(tabsId: string, tabId: string) {
  chosenTab(tabsId);
  chosenTabs![tabsId] = tabId;
  try {
    localStorage.setItem(CHOSEN_TABS_KEY, JSON.stringify(chosenTabs));
  } catch {
    // Kept for this session only.
  }
}
/** The id of the tab showing, of the tab ids `ids` of a "Pestañas" block. */
const shownTab = (tabsId: string, stored: string, ids: string[]) =>
  [chosenTab(tabsId), stored].find((t) => t && ids.includes(t)) ?? ids[0] ?? "";
const shownTabBlock = (tabs: AnyBlock) => {
  const list = tabs.children.filter((c) => c.type === "tab");
  const id = shownTab(tabs.id, (tabs.props as { active: string }).active, list.map((t) => t.id));
  return list.find((t) => t.id === id);
};

const hasText = (b: AnyBlock) => Array.isArray(b.content);
const LIST_TYPES = new Set(["bulletListItem", "numberedListItem", "checkListItem"]);
const foldable = (b: AnyBlock) => b.type === "toggleListItem" || (b.type === "heading" && !!(b.props as { isToggleable?: boolean }).isToggleable);

/** The first (or last) block with text a caret can go to in `b`; in a "Pestañas", in the tab showing. */
function textEdge(b: AnyBlock, last: boolean): AnyBlock | undefined {
  if (b.type === "tabs") {
    const tab = shownTabBlock(b);
    return tab && textEdge(tab, last);
  }
  if (hasText(b) && (!last || foldable(b) || !b.children.length)) return b;
  for (const c of last ? [...b.children].reverse() : b.children) {
    const hit = textEdge(c, last);
    if (hit) return hit;
  }
  return hasText(b) ? b : undefined;
}

/** The "Pestañas" a block ends with (itself, or its last child's, and so on), if any. */
function tailTabs(b: AnyBlock | undefined): AnyBlock | undefined {
  for (let x = b; x; x = x.children[x.children.length - 1]) if (x.type === "tabs") return x;
  return undefined;
}

function caretTo(editor: XotEditor, target: AnyBlock | undefined, end: boolean) {
  if (!target) return;
  if (hasText(target)) editor.setTextCursorPosition(target.id, end ? "end" : "start");
  else selectBlock(editor, target.id);
}

/**
 * Keys at the edges of a "Pestañas" block, ahead of BlockNote's: they never merge text across a tab's
 * edge nor lift a line out of its tab (where it would show under every tab), and the arrows go into the
 * tab showing, never a hidden one. True when the key was handled.
 */
function tabsKey(editor: XotEditor, e: KeyboardEvent): boolean {
  const cur = editor.getTextCursorPosition().block as AnyBlock;
  const parentOf = (b: AnyBlock) => editor.getParentBlock(b.id) as AnyBlock | undefined;
  const topOfTab = (b: AnyBlock) => parentOf(b)?.type === "tab";
  // Shift+Tab on a tab's own line would put it between the tabs.
  if (e.key === "Tab") return e.shiftKey && ((editor.getSelection()?.blocks ?? [cur]) as AnyBlock[]).some(topOfTab);
  if (e.shiftKey) return false;
  const sel = editor.prosemirrorState.selection;
  if (!sel.empty || !hasText(cur)) return false;
  const parent = parentOf(cur);
  const offset = sel.$from.parentOffset;
  const atEnd = offset === sel.$from.parent.content.size;
  const view = editor.prosemirrorView;
  // The block after `cur` on screen (when it has no children), and whether getting there leaves a tab.
  const below = () => {
    let b: AnyBlock | undefined = cur;
    let leaves = false;
    while (b) {
      const next = editor.getNextBlock(b.id) as AnyBlock | undefined;
      if (next) return { next, leaves };
      const p = parentOf(b);
      if (p?.type === "tab") {
        leaves = true;
        b = parentOf(p);
      } else b = p;
    }
    return { next: undefined, leaves };
  };
  const editable = editor.isEditable;
  if (e.key === "Backspace" && editable && offset === 0) {
    const prev = editor.getPrevBlock(cur.id) as AnyBlock | undefined;
    // At the start of a tab: nothing to merge with (a heading or a list item turns into text).
    if (!prev && parent?.type === "tab") {
      if (cur.type !== "paragraph") editor.updateBlock(cur.id, { type: "paragraph" } as never);
      return true;
    }
    // Right after the tabs: they're selected (a second Backspace removes them).
    const tabs = tailTabs(prev);
    if (tabs) {
      selectBlock(editor, tabs.id);
      return true;
    }
    return false;
  }
  if (e.key === "Delete" && editable && atEnd && !cur.children.length) {
    const { next, leaves } = below();
    return leaves || next?.type === "tabs";
  }
  if (e.key === "Enter" && editable && parent?.type === "tab" && !(cur.content as unknown[]).length && cur.type !== "codeBlock") {
    // An empty line stays in its tab: a list item becomes text, any other line gets one more after it.
    if (!LIST_TYPES.has(cur.type) && cur.type !== "toggleListItem") {
      const [line] = editor.insertBlocks([{ type: "paragraph" }] as never, cur.id, "after");
      editor.setTextCursorPosition(line.id, "start");
    } else editor.updateBlock(cur.id, { type: "paragraph" } as never);
    return true;
  }
  const down = (e.key === "ArrowDown" && !!view?.endOfTextblock("down")) || (e.key === "ArrowRight" && atEnd);
  if (down && !cur.children.length) {
    const { next, leaves } = below();
    if (next?.type === "tabs" || (leaves && next)) {
      caretTo(editor, hasText(next) ? next : (textEdge(next, false) ?? next), false);
      return true;
    }
    return leaves;
  }
  const up = (e.key === "ArrowUp" && !!view?.endOfTextblock("up")) || (e.key === "ArrowLeft" && offset === 0);
  if (up) {
    const prev = editor.getPrevBlock(cur.id) as AnyBlock | undefined;
    if (prev) {
      const tabs = tailTabs(prev);
      if (!tabs) return false;
      caretTo(editor, textEdge(tabs, true), true);
      return true;
    }
    if (parent?.type !== "tab") return false;
    // Out of the tab, to the line above the tabs.
    const tabs = parentOf(parent);
    const before = tabs && (editor.getPrevBlock(tabs.id) as AnyBlock | undefined);
    const outer = tabs && parentOf(tabs);
    caretTo(editor, before ? (textEdge(tailTabs(before) ?? before, true) ?? before) : outer && hasText(outer) ? outer : undefined, true);
    return true;
  }
  return false;
}

function TabStrip({ id, editor }: { id: string; editor: XotEditor }) {
  const block = useLiveBlock(editor, id);
  const [renaming, setRenaming] = useState("");
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [title, setTitle] = useState("");
  const [dragged, setDragged] = useState("");
  const [, redraw] = useState(0);
  if (!block) return null;
  const tabs = block.children.filter((c) => c.type === "tab");
  const active = shownTab(id, (block.props as { active: string }).active, tabs.map((t) => t.id));
  const editable = editor.isEditable;
  const label = (t: AnyBlock, i: number) => (t.props as { title: string }).title || `Pestaña ${i + 1}`;
  // Not an edit: it isn't undone with ⌘Z and works on locked pages.
  const choose = (tab: string) => {
    if (tab === active) return;
    chooseTab(id, tab);
    redraw((n) => n + 1);
  };
  const add = () => {
    const last = tabs[tabs.length - 1];
    const fresh = { type: "tab", props: { title: `Pestaña ${tabs.length + 1}` }, children: [{ type: "paragraph" }] };
    const [tab] = last ? editor.insertBlocks([fresh] as never, last.id, "after") : (editor.updateBlock(id, { children: [fresh] } as never), (editor.getBlock(id) as AnyBlock).children);
    chooseTab(id, tab.id);
    editor.updateBlock(id, { props: { active: tab.id } } as never);
    editAt(editor, (editor.getBlock(tab.id) as AnyBlock | undefined)?.children[0]?.id);
  };
  const remove = (tab: string) => {
    setMenu(null);
    if (tabs.length <= 1) return editor.removeBlocks([id]);
    const i = tabs.findIndex((t) => t.id === tab);
    editor.transact(() => {
      if (tab === active) {
        chooseTab(id, (tabs[i + 1] ?? tabs[i - 1]).id);
        editor.updateBlock(id, { props: { active: (tabs[i + 1] ?? tabs[i - 1]).id } } as never);
      }
      editor.removeBlocks([tab]);
    });
  };
  // Drag a tab onto another to put it there (before or after it, by which half it's dropped on).
  const drop = (target: string, after: boolean) => {
    const from = tabs.find((t) => t.id === dragged);
    setDragged("");
    if (!from || from.id === target) return;
    const rest = block.children.filter((c) => c.id !== from.id);
    const at = rest.findIndex((c) => c.id === target) + (after ? 1 : 0);
    rest.splice(at, 0, from);
    editor.updateBlock(id, { children: rest } as never);
  };
  // Only the chosen tab's blocks show; the tab blocks sit flush, without the nesting indent.
  const scope = `.bn-block[data-id="${CSS.escape(id)}"] > .bn-block-group > .bn-block-outer`;
  // Renaming happens in the tab itself: Enter or a click away saves, Esc leaves it as it was.
  const rename = (save: boolean) => {
    const i = tabs.findIndex((t) => t.id === renaming);
    if (save && i >= 0 && title.trim() !== label(tabs[i], i)) editor.updateBlock(renaming, { props: { title: title.trim() } } as never);
    setRenaming("");
  };
  const css = `${scope}:has(> .bn-block > * > .bn-block-content[data-content-type="tab"]):not([data-id="${CSS.escape(active)}"]) { display: none; }`;
  return (
    <div className="tabs-strip" contentEditable={false} role="tablist">
      <style>{css}</style>
      {tabs.map((t, i) =>
        t.id === renaming ? (
          <span key={t.id} className={`tabs-strip__tab is-renaming${t.id === active ? " is-active" : ""}`}>
            <input
              className="tabs-strip__input"
              autoFocus
              aria-label="Nombre de la pestaña"
              placeholder={`Pestaña ${i + 1}`}
              value={title}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={(e) => rename(!e.currentTarget.dataset.cancel)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== "Escape") return;
                e.preventDefault();
                if (e.key === "Escape") e.currentTarget.dataset.cancel = "1";
                e.currentTarget.blur();
              }}
            />
          </span>
        ) : (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          className={`tabs-strip__tab${t.id === active ? " is-active" : ""}${t.id === dragged ? " is-dragged" : ""}`}
          draggable={editable}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData("application/x-xot-tab", t.id);
            e.dataTransfer.effectAllowed = "move";
            setDragged(t.id);
          }}
          onDragEnd={() => setDragged("")}
          onDragOver={(e) => {
            if (!dragged) return;
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={(e) => {
            if (!dragged) return;
            e.preventDefault();
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            drop(t.id, e.clientX > r.left + r.width / 2);
          }}
          onClick={(e) => {
            // Choosing the tab redraws it, so the browser sends no dblclick: two clicks are timed here.
            // (The view may be drawn anew in between: the last click is kept outside it.)
            // A press of Space or Enter on the focused tab (detail 0) chooses it, never renames it.
            const double = e.detail > 0 && lastTabClick.id === t.id && e.timeStamp - lastTabClick.at < 450;
            lastTabClick = { id: double ? "" : t.id, at: e.timeStamp };
            if (double && editable) {
              setTitle(label(t, i));
              setRenaming(t.id);
            } else choose(t.id);
          }}
          onContextMenu={(e) => {
            if (!editable) return;
            e.preventDefault();
            setMenu({ id: t.id, anchor: e.currentTarget });
          }}
        >
          {label(t, i)}
        </button>
        ),
      )}
      {editable && (
        <button type="button" className="tabs-strip__add" aria-label="Agregar pestaña" data-tooltip="Agregar pestaña" onClick={add}>
          <Plus size={16} />
        </button>
      )}
      {menu && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} width={200}>
          <MenuItem
            icon={<Type size={16} />}
            onClick={() => {
              const i = tabs.findIndex((t) => t.id === menu.id);
              if (i >= 0) setTitle(label(tabs[i], i));
              setRenaming(menu.id);
              setMenu(null);
            }}
          >
            Cambiar nombre
          </MenuItem>
          <MenuItem icon={<Trash2 size={16} />} danger onClick={() => remove(menu.id)}>
            Eliminar pestaña
          </MenuItem>
        </Popover>
      )}
    </div>
  );
}

function TabPanelStart({ id, editor }: { id: string; editor: XotEditor }) {
  const block = useLiveBlock(editor, id);
  if (!block || block.children.length) return <div className="tab-panel" contentEditable={false} />;
  return (
    <div
      className="tab-panel tab-panel--empty"
      contentEditable={false}
      onClick={() => {
        if (!editor.isEditable) return;
        editor.updateBlock(id, { children: [{ type: "paragraph" }] } as never);
        editAt(editor, (editor.getBlock(id) as AnyBlock | undefined)?.children[0]?.id);
      }}
    >
      Pestaña vacía. Haz clic para escribir en ella.
    </div>
  );
}

/** Synced blocks being shown, outermost first: one can't show itself inside itself. */
const SyncedTrail = createContext<string[]>([]);

/** "Copiar y sincronizar": the block goes to the clipboard; pasting it on any page makes a synced copy. */
function copySyncedBlock(editor: XotEditor, blockId: string) {
  selectBlock(editor, blockId);
  editor.focus();
  const ok = document.execCommand("copy");
  toast(ok ? "Bloque sincronizado copiado. Pégalo en otra página para sincronizarlo." : "No se pudo copiar el bloque");
}

function SyncedSection({
  sourceId,
  editable,
  onCopy,
  onUnsync,
}: {
  sourceId: string;
  editable: boolean;
  onCopy: () => void;
  onUnsync: (content: unknown[]) => void;
}) {
  const trail = useContext(SyncedTrail);
  const record = useLiveQuery(async () => (await db.synced.get(sourceId)) ?? null, [sourceId]);
  const [hover, setHover] = useState(false);
  // Pages showing this block ("Editando en N páginas"), counted while the bar shows.
  const pages = useLiveQuery(
    async () =>
      hover
        ? db.blocks.filter((b) => b.alive && Array.isArray(b.content) && JSON.stringify(b.content).includes(sourceId)).count()
        : null,
    [hover, sourceId],
  );
  if (trail.includes(sourceId)) return null;
  return (
    <div
      className="synced-block"
      contentEditable={false}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {editable && record && (
        <div className="synced-block__bar">
          <span className="synced-block__label">
            <RefreshCw size={14} />
            {pages ? `Editando en ${pages} ${pages === 1 ? "página" : "páginas"}` : "Bloque sincronizado"}
          </span>
          <button type="button" className="synced-block__btn" onClick={onCopy}>
            <Copy size={14} /> Copiar y sincronizar
          </button>
          <button type="button" className="synced-block__btn" onClick={() => onUnsync(record.content)}>
            <Link2Off size={14} /> Dejar de sincronizar
          </button>
        </div>
      )}
      {record === null ? (
        <div className="synced-block__missing">El bloque sincronizado original ya no existe.</div>
      ) : record ? (
        <SyncedTrail.Provider value={[...trail, sourceId]}>
          <SyncedEditor id={record.id} content={record.content} editable={editable} />
        </SyncedTrail.Provider>
      ) : null}
    </div>
  );
}

/** The shared content, editable in place; edits made in other copies arrive while this one isn't focused. */
function SyncedEditor({ id, content, editable }: { id: string; content: unknown[]; editable: boolean }) {
  const theme = useColorScheme();
  const editor = useCreateBlockNote(
    {
      schema,
      dictionary,
      links: { onClick: openLink, isValidLink },
      uploadFile: storeFile,
      resolveFileUrl,
      // Simple table: header row / column, cell colors, merge and split.
      tables: { splitCells: true, cellBackgroundColor: true, cellTextColor: true, headers: true },
      initialContent: content.length ? (normalizeContent(content as StoredBlock[]) as never) : undefined,
    },
    [id],
  );
  const saved = useRef(JSON.stringify(content));
  const remote = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const save = useMemo(
    () => () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      const next = editor.document as unknown[];
      saved.current = JSON.stringify(next);
      void db.synced.put({ id, content: next, updated_time: Date.now() });
    },
    [editor, id],
  );
  useEffect(() => {
    const json = JSON.stringify(content);
    if (json === saved.current || editor.isFocused()) return;
    saved.current = json;
    remote.current = true;
    try {
      editor.replaceBlocks(editor.document, normalizeContent(content as StoredBlock[]) as never);
    } finally {
      remote.current = false;
    }
  }, [content, editor]);
  useEffect(
    () => () => {
      if (timer.current !== undefined) save();
    },
    [save],
  );
  return (
    <BlockNoteView
      className="synced-block__editor"
      editor={editor}
      theme={theme}
      editable={editable}
      slashMenu={false}
      formattingToolbar={false}
      onChange={() => {
        if (remote.current) return;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(save, 400);
      }}
    >
      <FormattingToolbarController formattingToolbar={TextToolbar} />
      <LinkSearch />
      <SuggestionMenuController
        triggerCharacter="/"
        getItems={async (query) => filterSuggestionItems(getDefaultReactSlashMenuItems(editor), query)}
      />
    </BlockNoteView>
  );
}

/** Blocks without their ids, to insert them as new blocks. */
function stripIds(list: StoredBlock[]): StoredBlock[] {
  return list.map((b) => {
    const copy: StoredBlock & { id?: string } = { ...b, children: b.children && stripIds(b.children) };
    delete copy.id;
    return copy;
  });
}

/**
 * Languages offered by the code block's picker (its list and labels, top-left on hover). The keys
 * are Shiki's ids: those the bundled highlighter knows get colors, the rest show as plain text.
 */
const CODE_LANGUAGES = {
  abap: { name: "ABAP" },
  agda: { name: "Agda" },
  arduino: { name: "Arduino" },
  asm: { name: "Assembly", aliases: ["assembly", "nasm"] },
  bash: { name: "Bash", aliases: ["sh", "zsh"] },
  basic: { name: "BASIC" },
  bnf: { name: "BNF" },
  c: { name: "C" },
  csharp: { name: "C#", aliases: ["c#", "cs"] },
  cpp: { name: "C++", aliases: ["c++"] },
  clojure: { name: "Clojure", aliases: ["clj"] },
  coffeescript: { name: "CoffeeScript", aliases: ["coffee"] },
  coq: { name: "Coq" },
  css: { name: "CSS" },
  dart: { name: "Dart" },
  dhall: { name: "Dhall" },
  diff: { name: "Diff", aliases: ["patch"] },
  docker: { name: "Docker", aliases: ["dockerfile"] },
  ebnf: { name: "EBNF" },
  elixir: { name: "Elixir", aliases: ["ex", "exs"] },
  elm: { name: "Elm" },
  erlang: { name: "Erlang", aliases: ["erl"] },
  fsharp: { name: "F#", aliases: ["f#", "fs"] },
  flow: { name: "Flow" },
  fortran: { name: "Fortran" },
  formula: { name: "Fórmula" },
  gherkin: { name: "Gherkin", aliases: ["cucumber"] },
  glsl: { name: "GLSL" },
  go: { name: "Go", aliases: ["golang"] },
  graphql: { name: "GraphQL", aliases: ["gql"] },
  groovy: { name: "Groovy" },
  haskell: { name: "Haskell", aliases: ["hs"] },
  hcl: { name: "HCL", aliases: ["terraform", "tf"] },
  html: { name: "HTML", aliases: ["htm"] },
  idris: { name: "Idris" },
  java: { name: "Java" },
  javascript: { name: "JavaScript", aliases: ["js", "jsx", "mjs", "cjs"] },
  json: { name: "JSON", aliases: ["jsonc"] },
  julia: { name: "Julia", aliases: ["jl"] },
  kotlin: { name: "Kotlin", aliases: ["kt", "kts"] },
  latex: { name: "LaTeX", aliases: ["tex"] },
  less: { name: "Less" },
  lisp: { name: "Lisp", aliases: ["common-lisp"] },
  livescript: { name: "LiveScript" },
  llvm: { name: "LLVM IR" },
  lua: { name: "Lua" },
  makefile: { name: "Makefile", aliases: ["make"] },
  markdown: { name: "Markdown", aliases: ["md", "mdx"] },
  markup: { name: "Markup" },
  matlab: { name: "MATLAB" },
  mathematica: { name: "Mathematica", aliases: ["wolfram"] },
  mermaid: { name: "Mermaid", aliases: ["mmd"] },
  nix: { name: "Nix" },
  objc: { name: "Objective-C", aliases: ["objective-c"] },
  ocaml: { name: "OCaml", aliases: ["ml"] },
  pascal: { name: "Pascal" },
  perl: { name: "Perl", aliases: ["pl"] },
  php: { name: "PHP" },
  text: { name: "Texto sin formato", aliases: ["plain text", "plaintext", "txt", "plain"] },
  powershell: { name: "PowerShell", aliases: ["ps1", "pwsh"] },
  prolog: { name: "Prolog" },
  protobuf: { name: "Protobuf", aliases: ["proto"] },
  purescript: { name: "PureScript", aliases: ["purs"] },
  python: { name: "Python", aliases: ["py"] },
  r: { name: "R" },
  racket: { name: "Racket" },
  reason: { name: "Reason" },
  ruby: { name: "Ruby", aliases: ["rb"] },
  rust: { name: "Rust", aliases: ["rs"] },
  sass: { name: "Sass" },
  scala: { name: "Scala" },
  scheme: { name: "Scheme" },
  scss: { name: "SCSS" },
  shellscript: { name: "Shell", aliases: ["shell"] },
  smalltalk: { name: "Smalltalk" },
  solidity: { name: "Solidity", aliases: ["sol"] },
  sql: { name: "SQL" },
  swift: { name: "Swift" },
  toml: { name: "TOML" },
  typescript: { name: "TypeScript", aliases: ["ts", "tsx"] },
  vb: { name: "VB.Net", aliases: ["vb.net", "vbnet"] },
  verilog: { name: "Verilog" },
  vhdl: { name: "VHDL" },
  "visual-basic": { name: "Visual Basic", aliases: ["visual basic", "vba"] },
  wasm: { name: "WebAssembly", aliases: ["webassembly"] },
  xml: { name: "XML", aliases: ["svg"] },
  yaml: { name: "YAML", aliases: ["yml"] },
};

/** A language name or alias ("js", "Python", "yml") → its picker key; anything unknown is plain text. */
function codeLanguage(name: unknown): keyof typeof CODE_LANGUAGES {
  const key = String(name ?? "").trim().toLowerCase();
  if (key in CODE_LANGUAGES) return key as keyof typeof CODE_LANGUAGES;
  const hit = Object.entries(CODE_LANGUAGES).find(
    ([, l]) => l.name.toLowerCase() === key || (l as { aliases?: string[] }).aliases?.includes(key),
  );
  return (hit?.[0] as keyof typeof CODE_LANGUAGES | undefined) ?? "text";
}

/** Code block: the language picker plus a "Copiar" button (top-right on hover); colors come from `syntaxHighlighter`. */
const codeBlockBase = createCodeBlockSpec({ defaultLanguage: "text", supportedLanguages: CODE_LANGUAGES });
// "Ajustar código" (wrap) and "Leyenda" (a caption under the block).
const codeBlock = {
  ...codeBlockBase,
  config: {
    ...codeBlockBase.config,
    propSchema: {
      ...codeBlockBase.config.propSchema,
      wrap: { default: false as boolean },
      caption: { default: "" as const },
      // Mermaid blocks: "Código", "Vista previa" or "Dividir" (code with the diagram under it).
      mermaidView: { default: "split" as const, values: ["code", "preview", "split"] as const },
    },
  },
};
/** The code block "```" just made: a language typed first in it ("js", then Space or Enter) becomes its language. */
let freshFence = "";

/** Opens the caption prompt of a code block (CodeCaptionPrompt). */
const CODE_CAPTION_EVENT = "xot:code-caption";
/** Opens the language picker of a code block (CodeLanguagePicker). */
const CODE_LANGUAGE_EVENT = "xot:code-language";
// Pasted code (```js fences, <code class="language-ts">) keeps a language the picker knows.
const parseCode = codeBlock.implementation.parse!;
codeBlock.implementation.parse = (el) => {
  const props = parseCode(el);
  return props && { ...props, language: codeLanguage(props.language) };
};
const renderCode = codeBlock.implementation.render!;
codeBlock.implementation.render = function (block, editor) {
  // BlockNote's picker throws on a language it doesn't list: show it as plain text, and store that.
  const language = codeLanguage(block.props.language);
  if (language !== block.props.language) {
    queueMicrotask(() => editor.getBlock(block.id) && editor.updateBlock(block.id, { props: { language } } as never));
    block = { ...block, props: { ...block.props, language } };
  }
  const view = renderCode.call(this, block, editor);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-copy";
  copy.contentEditable = "false";
  copy.textContent = "Copiar";
  copy.addEventListener("mousedown", (e) => e.preventDefault());
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(view.contentDOM?.textContent ?? "").then(
      () => toast("Código copiado al portapapeles"),
      () => toast("No se pudo copiar el código"),
    );
  });
  view.dom.appendChild(copy);
  // "JavaScript ⌄": a menu with a search, in place of BlockNote's native <select>.
  if ((this as { renderType?: string }).renderType === "nodeView") {
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "code-language";
    pick.contentEditable = "false";
    const name = document.createElement("span");
    name.textContent = CODE_LANGUAGES[language].name;
    pick.append(name);
    pick.insertAdjacentHTML(
      "beforeend",
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    );
    pick.addEventListener("mousedown", (e) => e.preventDefault());
    pick.addEventListener("click", () => window.dispatchEvent(new CustomEvent(CODE_LANGUAGE_EVENT, { detail: { id: block.id, anchor: pick } })));
    view.dom.appendChild(pick);
  }
  const props = block.props as { wrap?: boolean; caption?: string };
  const dom = view.dom as HTMLElement;
  dom.classList.toggle("code--wrap", !!props.wrap);
  if (props.caption) {
    const caption = document.createElement("div");
    caption.className = "code-caption";
    caption.contentEditable = "false";
    caption.textContent = props.caption;
    caption.addEventListener("mousedown", (e) => e.preventDefault());
    caption.addEventListener("click", () => window.dispatchEvent(new CustomEvent(CODE_CAPTION_EVENT, { detail: block.id })));
    dom.appendChild(caption);
    dom.dataset.caption = "";
  }
  // The live diagram is for the editor only (not a copy rendered for the clipboard or an export).
  if (language !== "mermaid" || !view.contentDOM || (this as { renderType?: string }).renderType !== "nodeView") return view;
  const mermaid = mountMermaid(block.id, (props as { mermaidView?: MermaidView }).mermaidView ?? "split", editor as never, dom, view.contentDOM);
  const { destroy, ignoreMutation } = view;
  return {
    ...view,
    // Drawing the diagram (or switching the view) must not make ProseMirror re-read and redraw the block.
    ignoreMutation: (m) => mermaid.owns(m) || (ignoreMutation?.(m) ?? false),
    destroy: () => {
      destroy?.();
      mermaid.stop();
    },
  };
};

type MermaidView = "code" | "preview" | "split";
const MERMAID_VIEWS: [MermaidView, string][] = [
  ["code", "Código"],
  ["preview", "Vista previa"],
  ["split", "Dividir"],
];

/**
 * Mermaid code block: the "Código / Vista previa / Dividir" switch (top-right on hover) and the
 * diagram drawn from the code, redrawn as it's typed. Returns the node view's mutation filter and cleanup.
 */
function mountMermaid(id: string, view: MermaidView, editor: XotEditor, dom: HTMLElement, code: HTMLElement) {
  dom.dataset.mermaid = view;
  const tabs = document.createElement("div");
  tabs.className = "code-mermaid-views";
  tabs.contentEditable = "false";
  const show = (v: MermaidView) => {
    dom.dataset.mermaid = v;
    for (const b of tabs.children) b.classList.toggle("is-active", (b as HTMLElement).dataset.view === v);
  };
  for (const [v, label] of MERMAID_VIEWS) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.view = v;
    b.textContent = label;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    // Saved with the block when it can be edited; a read-only page only switches what it shows.
    b.addEventListener("click", () =>
      editor.isEditable && editor.getBlock(id) ? editor.updateBlock(id, { props: { mermaidView: v } } as never) : show(v),
    );
    tabs.appendChild(b);
  }
  dom.appendChild(tabs);
  show(view);

  const preview = document.createElement("div");
  preview.className = "code-mermaid";
  preview.contentEditable = "false";
  const pre = dom.querySelector(":scope > pre");
  dom.insertBefore(preview, pre?.nextSibling ?? null);

  let drawn = "";
  let timer = 0;
  const draw = () => {
    const source = code.textContent ?? "";
    const dark = !!dom.closest('.bn-root[data-color-scheme="dark"]');
    const key = `${dark}\n${source}`;
    if (key === drawn) return;
    drawn = key;
    if (!source.trim()) {
      preview.replaceChildren();
      return;
    }
    void renderMermaid(source, dark).then((r) => {
      if (drawn !== key) return;
      if ("svg" in r) {
        preview.innerHTML = r.svg;
        delete preview.dataset.error;
      } else {
        const error = document.createElement("div");
        error.className = "code-mermaid__error";
        error.textContent = r.error;
        preview.replaceChildren(error);
        preview.dataset.error = "";
      }
    });
  };
  const redraw = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(draw, 300);
  };
  const onCode = new MutationObserver(redraw);
  onCode.observe(code, { characterData: true, childList: true, subtree: true });
  // Light / dark: the diagram takes the page's scheme.
  const onTheme = new MutationObserver(redraw);
  const frame = requestAnimationFrame(() => {
    const root = dom.closest(".bn-root");
    if (root) onTheme.observe(root, { attributes: true, attributeFilter: ["data-color-scheme"] });
    draw();
  });
  return {
    owns: (m: { target: Node; type: string; attributeName?: string | null }) =>
      tabs.contains(m.target) ||
      preview.contains(m.target) ||
      (m.target === dom && m.type === "attributes" && m.attributeName === "data-mermaid"),
    stop: () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      onCode.disconnect();
      onTheme.disconnect();
    },
  };
}

/** The caption of a code block, edited in a small box under it ("Leyenda"). */
function CodeCaptionPrompt() {
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const [open, setOpen] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const el = document.querySelector<HTMLElement>(`.bn-block[data-id="${CSS.escape(id)}"] .bn-block-content`);
      const block = editor.getBlock(id) as { props: { caption?: string } } | undefined;
      if (!el || !block || !editor.isEditable || el.closest(".bn-editor") !== editor.domElement) return;
      setText(block.props.caption ?? "");
      setOpen({ id, anchor: el });
    };
    window.addEventListener(CODE_CAPTION_EVENT, onOpen);
    return () => window.removeEventListener(CODE_CAPTION_EVENT, onOpen);
  }, [editor]);
  if (!open) return null;
  return (
    <Popover anchor={open.anchor} onClose={() => setOpen(null)} width={320}>
      <form
        className="xot-image-caption"
        onSubmit={(e) => {
          e.preventDefault();
          if (editor.getBlock(open.id)) editor.updateBlock(open.id, { props: { caption: text.trim() } } as never);
          setOpen(null);
        }}
      >
        <input className="field" autoFocus aria-label="Leyenda" placeholder="Escribe una leyenda…" value={text} onChange={(e) => setText(e.target.value)} />
      </form>
    </Popover>
  );
}

/** Code language menu: "Buscar un lenguaje…" over every language, the current one checked. */
function CodeLanguagePicker() {
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const [open, setOpen] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const onOpen = (e: Event) => {
      const { id, anchor } = (e as CustomEvent<{ id: string; anchor: HTMLElement }>).detail;
      if (!editor.getBlock(id) || !editor.isEditable || anchor.closest(".bn-editor") !== editor.domElement) return;
      setQuery("");
      setOpen({ id, anchor });
    };
    window.addEventListener(CODE_LANGUAGE_EVENT, onOpen);
    return () => window.removeEventListener(CODE_LANGUAGE_EVENT, onOpen);
  }, [editor]);
  // Opens on the current language.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector(".is-active");
    if (!list || !item) return;
    // Only the list scrolls (not the page under the menu).
    list.scrollTop += item.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 2;
  }, [open]);
  if (!open) return null;
  const current = (editor.getBlock(open.id)?.props as { language?: string } | undefined)?.language;
  const q = fold(query.trim());
  const list = (Object.entries(CODE_LANGUAGES) as [string, { name: string; aliases?: string[] }][]).filter(
    ([key, l]) => !q || fold(l.name).includes(q) || key.includes(q) || l.aliases?.some((a) => a.includes(q)),
  );
  const choose = (language: string) => {
    setOpen(null);
    if (editor.getBlock(open.id)) editor.updateBlock(open.id, { props: { language } } as never);
    editor.focus();
  };
  return (
    <Popover anchor={open.anchor} onClose={() => setOpen(null)} width={240}>
      <div className="menu code-language-menu">
        <input
          className="menu-search"
          autoFocus
          placeholder="Buscar un lenguaje…"
          aria-label="Buscar un lenguaje"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && list[0]) {
              e.preventDefault();
              choose(list[0][0]);
            }
          }}
        />
        <div className="code-language-menu__list" ref={listRef}>
          {list.map(([key, l]) => (
            <MenuItem key={key} active={key === current} right={key === current ? <Check size={16} /> : undefined} onClick={() => choose(key)}>
              {l.name}
            </MenuItem>
          ))}
          {!list.length && <div className="menu-empty">Sin resultados</div>}
        </div>
      </div>
    </Popover>
  );
}

// Columns come from BlockNote's multi-column package (GPL-3.0 or commercial license).
/** BlockNote's image plus "Agregar enlace" (`href`): a click on the picture opens it. */
const imageBlock = {
  ...defaultBlockSpecs.image,
  config: { ...defaultBlockSpecs.image.config, propSchema: { ...defaultBlockSpecs.image.config.propSchema, href: { default: "" as const } } },
};

/**
 * A numbered list keeps one format, its first item's: a line added with Enter (or pasted, or moved in)
 * takes it.
 */
function syncListFormats(editor: XotEditor) {
  if (!editor.isEditable) return;
  const fixes: [string, string][] = [];
  const walk = (list: AnyBlock[]) => {
    let format: string | null = null;
    for (const b of list) {
      if (b.type !== "numberedListItem") format = null;
      else {
        const own = (b.props as { listFormat?: string }).listFormat ?? "";
        if (format === null) format = own;
        else if (own !== format) fixes.push([b.id, format]);
      }
      walk(b.children);
    }
  };
  walk(editor.document as AnyBlock[]);
  if (fixes.length)
    queueMicrotask(() =>
      editor.transact(() => {
        for (const [id, listFormat] of fixes) if (editor.getBlock(id)) editor.updateBlock(id, { props: { listFormat } } as never);
      }),
    );
}

/** BlockNote's video, but a YouTube, Vimeo or Loom link (not a file) plays in that site's own player. */
const videoBlock = { ...defaultBlockSpecs.video, implementation: { ...defaultBlockSpecs.video.implementation } };
const renderVideo = videoBlock.implementation.render!;
videoBlock.implementation.render = function (block, editor) {
  const url = String((block.props as { url?: string }).url ?? "");
  if (!url || !isVideoLink(url)) return renderVideo.call(this, block, editor);
  const view = renderVideo.call(this, { ...block, props: { ...block.props, url: "" } } as typeof block, editor);
  const dom = view.dom as HTMLElement;
  const frame = document.createElement("div");
  frame.className = "embed-block embed-block--video";
  frame.contentEditable = "false";
  const iframe = document.createElement("iframe");
  iframe.src = embedSrc(url).src;
  iframe.title = hostOf(url);
  iframe.loading = "lazy";
  iframe.setAttribute("allow", "fullscreen; encrypted-media; picture-in-picture; clipboard-write");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-presentation allow-forms");
  frame.append(iframe);
  dom.replaceChildren(frame);
  return view;
};

/** BlockNote's numbered list plus a list format: "letters" ("a. ") or "roman" ("i. "); "" counts in numbers. */
const numberedListBlock = {
  ...defaultBlockSpecs.numberedListItem,
  config: {
    ...defaultBlockSpecs.numberedListItem.config,
    propSchema: { ...defaultBlockSpecs.numberedListItem.config.propSchema, listFormat: { default: "" as const } },
  },
};

export const schema = withMultiColumn(
  BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      image: imageBlock,
      numberedListItem: numberedListBlock,
      video: videoBlock,
      codeBlock,
      pageLink: PageLinkBlock(),
      database: DatabaseBlock(),
      button: ButtonBlock(),
      callout: CalloutBlock(),
      tableOfContents: TableOfContentsBlock(),
      breadcrumb: BreadcrumbBlock(),
      bookmark: BookmarkBlock(),
      embed: EmbedBlock(),
      pdf: PdfBlock(),
      equation: EquationBlock(),
      synced: SyncedBlock(),
      tabs: TabsBlock(),
      tab: TabBlock(),
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      mention: Mention,
      linkMention: LinkMention,
      inlineEquation: InlineEquationSpec,
      customEmoji: CustomEmojiSpec,
    },
  }),
);

/**
 * Typing shortcuts BlockNote lacks: -> ← => become arrows, "--" an em
 * dash and ~text~ strikethrough. "--" at the start of a line stays, so "---"
 * still makes a divider (see the keydown handler).
 */
const typography = createExtension({
  key: "xotTypography",
  tiptapExtensions: [
    Extension.create({
      name: "xotTypography",
      addInputRules() {
        return [
          textInputRule({ find: /->$/, replace: "→" }),
          textInputRule({ find: /<-$/, replace: "←" }),
          textInputRule({ find: /=>$/, replace: "⇒" }),
          textInputRule({ find: /[^-](--)$/, replace: "—" }),
          markInputRule({ find: /(?:^|\s)(~(?!~)([^~]+)~)$/, type: this.editor.schema.marks.strike }),
          // $$E=mc^2$$ becomes an inline equation.
          new InputRule({
            find: /\$\$([^$]+)\$\$$/,
            handler: ({ state, range, match }) => {
              const type = state.schema.nodes.inlineEquation;
              if (type) state.tr.replaceWith(range.from, range.to, type.create({ latex: match[1].trim() }));
            },
          }),
        ];
      },
    }),
  ],
});

/**
 * Multi-block selection (Shift+↑/↓ after Esc, or a drag from the page margin): the
 * sibling blocks from an anchor to a head, painted in the Esc selection's blue. The head also
 * holds a node selection, so the keys stay with the editor; any other edit or selection drops it.
 */
type BlockRange = { anchor: string; head: string; ids: string[] };
const blockRangeKey = new PluginKey<BlockRange | null>("xotBlockRange");
const blockRange = createExtension({
  key: "xotBlockRange",
  prosemirrorPlugins: [
    new Plugin<BlockRange | null>({
      key: blockRangeKey,
      state: {
        init: () => null,
        apply: (tr, range) => {
          const next = tr.getMeta(blockRangeKey) as BlockRange | null | undefined;
          if (next !== undefined) return next;
          return range && (tr.docChanged || tr.selectionSet) ? null : range;
        },
      },
      props: {
        decorations: (state) => {
          const range = blockRangeKey.getState(state);
          if (!range || range.ids.length < 2) return null;
          const ids = new Set(range.ids);
          const decorations: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (!node.type.isInGroup("bnBlock") || !ids.has(String(node.attrs.id))) return true;
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "xot-block-selected" }));
            return false;
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    }),
  ],
});

/**
 * Keeps each "Pestañas" whole, whatever an edit did (a drop, a paste, a key BlockNote handles): tabs
 * found outside one are wrapped in a new one, and a block that ends up between the tabs (it would show
 * under every tab) goes into the tab showing.
 */
function fixTabs(tr: Transaction): boolean {
  const { schema } = tr.doc.type;
  const isTab = (n: ProseNode) => n.type.name === "blockContainer" && n.firstChild?.type.name === "tab";
  const fixes: (() => void)[] = [];
  tr.doc.descendants((node, pos, parent, index) => {
    if (fixes.length) return false;
    if (node.type.name !== "blockContainer") return true;
    const $pos = tr.doc.resolve(pos);
    const holder = $pos.depth > 0 ? $pos.node($pos.depth - 1) : null;
    if (isTab(node) && parent && holder?.firstChild?.type.name !== "tabs") {
      // The run of tabs from here goes into a new "Pestañas".
      const run: ProseNode[] = [];
      for (let k = index; k < parent.childCount && isTab(parent.child(k)); k++) run.push(parent.child(k));
      const size = run.reduce((n, c) => n + c.nodeSize, 0);
      const tabs = schema.nodes.blockContainer.create({ id: crypto.randomUUID() }, [
        schema.nodes.tabs.create(),
        schema.nodes.blockGroup.create(null, run),
      ]);
      fixes.push(() => tr.replaceWith(pos, pos + size, tabs));
      return false;
    }
    if (node.firstChild?.type.name !== "tabs" || node.childCount < 2) return true;
    const group = node.child(1);
    const start = pos + 1 + node.firstChild.nodeSize + 1;
    const tabs: { node: ProseNode; pos: number }[] = [];
    const loose: { node: ProseNode; pos: number }[] = [];
    group.forEach((c, offset) => (isTab(c) ? tabs : loose).push({ node: c, pos: start + offset }));
    if (!loose.length) return true;
    if (!tabs.length) {
      // No tab left at all: the blocks make one.
      const tab = schema.nodes.blockContainer.create({ id: crypto.randomUUID() }, [
        schema.nodes.tab.create(),
        schema.nodes.blockGroup.create(null, group.content),
      ]);
      fixes.push(() => tr.replaceWith(start, start + group.content.size, tab));
      return false;
    }
    const shown = shownTab(String(node.attrs.id), String(node.firstChild.attrs.active ?? ""), tabs.map((t) => String(t.node.attrs.id)));
    const target = tabs.find((t) => t.node.attrs.id === shown) ?? tabs[0];
    const [stray] = loose;
    fixes.push(() => {
      tr.delete(stray.pos, stray.pos + stray.node.nodeSize);
      const at = tr.mapping.map(target.pos);
      const tab = tr.doc.nodeAt(at);
      if (!tab) return;
      const head = at + 1 + tab.firstChild!.nodeSize;
      // Above the tab's blocks when it was above the tab, else below them.
      if (tab.childCount > 1) tr.insert(stray.pos < target.pos ? head + 1 : at + tab.nodeSize - 2, stray.node);
      else tr.insert(head, schema.nodes.blockGroup.create(null, stray.node));
    });
    return false;
  });
  fixes.forEach((f) => f());
  return fixes.length > 0;
}

const tabsGuard = createExtension({
  key: "xotTabsGuard",
  prosemirrorPlugins: [
    new Plugin({
      appendTransaction: (trs, _old, state) => {
        if (!trs.some((t) => t.docChanged)) return null;
        const tr = state.tr;
        for (let i = 0; i < 50 && fixTabs(tr); i++);
        return tr.docChanged ? tr : null;
      },
    }),
  ],
});

/**
 * Centers the block handles (30px tall) on the block's first line of text.
 * BlockNote pins them to the block's top edge, which the 8px block
 * padding pushes above the text.
 */
const alignSideMenu = {
  name: "alignToFirstLine",
  fn: ({ x, y, rects, elements }: { x: number; y: number; rects: { floating: { height: number } }; elements: { reference: unknown } }) => {
    // The reference is the block element, or a virtual element wrapping it.
    const reference = elements.reference as { contextElement?: unknown } | null;
    const ref = reference instanceof HTMLElement ? reference : reference?.contextElement;
    if (!(ref instanceof HTMLElement)) return { x, y };
    const content = ref.querySelector<HTMLElement>(".bn-block-content") ?? ref;
    const line = content.querySelector<HTMLElement>(".bn-inline-content");
    let center: number;
    if (line) {
      const r = line.getBoundingClientRect();
      center = r.top + Math.min(parseFloat(getComputedStyle(line).lineHeight) || 24, r.height) / 2;
    } else {
      const r = (content.firstElementChild ?? content).getBoundingClientRect();
      center = r.top + Math.min(r.height, 30) / 2;
    }
    return { x, y: y + center - ref.getBoundingClientRect().top - rects.floating.height / 2 };
  },
};

/** The names for the blocks (slash menu, "Convertir en" and the toolbar's block type). */
const slash = es.slash_menu;
const retitle = <K extends keyof typeof slash>(key: K, title: string, ...aliases: string[]) => ({
  ...slash[key],
  title,
  aliases: [...slash[key].aliases, ...aliases],
});
const mcSlash = multiColumnLocales.es.slash_menu;

export const dictionary = {
  ...es,
  slash_menu: {
    ...slash,
    paragraph: retitle("paragraph", "Texto", "text", "parrafo"),
    check_list: retitle("check_list", "Lista de tareas", "todo", "to-do", "tareas"),
    bullet_list: retitle("bullet_list", "Lista con viñetas", "bullet", "vinetas"),
    numbered_list: retitle("numbered_list", "Lista numerada", "numbered"),
    toggle_list: retitle("toggle_list", "Lista desplegable", "toggle", "desplegable"),
    toggle_heading: retitle("toggle_heading", "Encabezado desplegable 1", "toggle"),
    toggle_heading_2: retitle("toggle_heading_2", "Encabezado desplegable 2", "toggle"),
    toggle_heading_3: retitle("toggle_heading_3", "Encabezado desplegable 3", "toggle"),
    code_block: retitle("code_block", "Código", "code", "codigo"),
    divider: retitle("divider", "Divisor", "divider", "separador"),
    video: retitle("video", "Video"),
  },
  color_picker: {
    ...es.color_picker,
    text_title: "Color del texto",
    background_title: "Color de fondo",
    colors: { ...es.color_picker.colors, default: "Predeterminado" },
  },
  multi_column: {
    ...multiColumnLocales.es,
    slash_menu: {
      two_columns: { ...mcSlash.two_columns, title: "2 columnas" },
      three_columns: { ...mcSlash.three_columns, title: "3 columnas" },
    },
  },
  // The es-LA ghost texts (headings 2-4 get theirs in styles.css: BlockNote has one per block type).
  placeholders: {
    ...es.placeholders,
    default: "Escribe “/” para ver los comandos...",
    emptyDocument: "Escribe “/” para ver los comandos...",
    heading: "Encabezado 1",
    checkListItem: "Tarea",
    toggleListItem: "Desplegable",
    quote: "Cita vacía",
    callout: "Escribe algo…",
  },
  toggle_blocks: { ...es.toggle_blocks, add_block_button: "Bloque desplegable vacío. Haz clic o agrega bloques dentro." },
  file_blocks: {
    ...es.file_blocks,
    add_button_text: { ...es.file_blocks.add_button_text, image: "Agregar una imagen", video: "Insertar o subir un video" },
  },
  // Media panel: "Subir" | "Insertar enlace".
  file_panel: {
    upload: {
      ...es.file_panel.upload,
      file_placeholder: { image: "Subir archivo", video: "Subir archivo", audio: "Subir archivo", file: "Subir archivo" },
      upload_error: "No se pudo subir el archivo",
    },
    embed: {
      title: "Insertar enlace",
      embed_button: { image: "Insertar imagen", video: "Insertar video", audio: "Insertar audio", file: "Insertar archivo" },
      url_placeholder: "Pega el enlace…",
    },
  },
  drag_handle: { ...es.drag_handle, colors_menuitem: "Color" },
  table_handle: {
    ...es.table_handle,
    add_left_menuitem: "Insertar a la izquierda",
    add_right_menuitem: "Insertar a la derecha",
    add_above_menuitem: "Insertar arriba",
    add_below_menuitem: "Insertar abajo",
    background_color_menuitem: "Color",
  },
  formatting_toolbar: {
    ...es.formatting_toolbar,
    file_caption: { ...es.formatting_toolbar.file_caption, input_placeholder: "Escribe una leyenda…" },
  },
};

export type XotEditor = typeof schema.BlockNoteEditor;

/** Puts the caret at the start of the body, adding a paragraph when it doesn't start with text (Enter in the title). */
export function focusBodyStart(editor: XotEditor) {
  const first = editor.document[0];
  if (!first || !Array.isArray(first.content)) editor.insertBlocks([{ type: "paragraph" }], first ?? editor.document[0], "before");
  editor.setTextCursorPosition(editor.document[0], "start");
  editor.focus();
}

const isEmptyParagraph = (b: AnyBlock | undefined) =>
  !!b && b.type === "paragraph" && Array.isArray(b.content) && !b.content.length && !b.children.length;

/**
 * Enter in the title: a new text block at the top of the body with the
 * caret in it, holding `text` (what followed the caret in the title). An empty first
 * line is reused instead of adding another.
 */
export function insertBodyStart(editor: XotEditor, text = "") {
  if (!editor.isEditable) return;
  const first = editor.document[0] as AnyBlock | undefined;
  if (isEmptyParagraph(first)) {
    if (text) editor.updateBlock(first!.id, { content: text } as never);
    editor.setTextCursorPosition(first!.id, "start");
  } else {
    const [line] = editor.insertBlocks([{ type: "paragraph", content: text }] as never, editor.document[0], "before");
    editor.setTextCursorPosition(line.id, "start");
  }
  editor.focus();
}

/** Multi-line text pasted in the title: the lines after the first become paragraphs at the top of the body. */
export function insertBodyLines(editor: XotEditor, lines: string[]) {
  if (!editor.isEditable || !lines.length) return;
  const first = editor.document[0] as AnyBlock | undefined;
  const blocks = lines.map((line) => ({ type: "paragraph", content: line }));
  if (first && isEmptyParagraph(first) && editor.document.length === 1) editor.replaceBlocks([first.id], blocks as never);
  else editor.insertBlocks(blocks as never, editor.document[0], "before");
}

type StoredBlock = { type?: string; props?: Record<string, unknown>; children?: StoredBlock[] };

/**
 * Fixes content saved by older versions: column widths that don't add up to 1
 * (flex-grow below 1 leaves the row short; a row is always filled), lone
 * columns (BlockNote pads them with an empty second one) and code languages
 * the picker doesn't offer (it can't render those).
 */
function normalizeContent(blocks: StoredBlock[]): StoredBlock[] {
  return blocks.flatMap((b) => {
    let children = b.children && normalizeContent(b.children);
    let props = b.props;
    if (b.type === "columnList" && (children?.length ?? 0) <= 1) return children?.[0]?.children ?? [];
    if (b.type === "columnList" && children) {
      const width = (c: StoredBlock) => Number(c.props?.width) || 1;
      const sum = children.reduce((s, c) => s + width(c), 0);
      if (Math.abs(sum - 1) > 0.001) children = children.map((c) => ({ ...c, props: { ...c.props, width: width(c) / sum } }));
    }
    if (b.type === "codeBlock" && !(String(props?.language) in CODE_LANGUAGES)) props = { ...props, language: codeLanguage(props?.language) };
    // Page-wide images imported with an unused block_width (2px) as their width.
    if (b.type === "image" && Number(props?.previewWidth) < 40) {
      props = { ...props };
      delete props.previewWidth;
    }
    return { ...b, props, children };
  });
}

type AnyBlock = { id: string; type: string; props: object; content?: unknown; children: AnyBlock[] };

/** A copy of the blocks (and their children) without ids, ready to insert again. */
const cloneBlocks = (blocks: AnyBlock[]): PartialBlock[] =>
  blocks.map((b) => ({ type: b.type, props: b.props, content: b.content, children: cloneBlocks(b.children) }) as PartialBlock);

/** ⌘D: the block (or the selected blocks) again, right after. */
function duplicateBlocks(editor: XotEditor, blocks: AnyBlock[], pageId: string) {
  if (!blocks.length) return;
  // An inline database is copied too (schema, views and rows), and a subpage block copies its page: not shown twice.
  if (linkIdsIn(blocks).size) {
    void withPageCopies(cloneBlocks(blocks) as ClonedBlock[], pageId).then((copies) =>
      editor.insertBlocks(copies as never, blocks[blocks.length - 1].id, "after"),
    );
    return;
  }
  const inserted = editor.insertBlocks(cloneBlocks(blocks) as never, blocks[blocks.length - 1].id, "after");
  const last = inserted[inserted.length - 1];
  if (last && Array.isArray(last.content)) editor.setTextCursorPosition(last, "end");
}

/** The pages and databases the blocks show (subpage blocks and database blocks), nested ones too. */
function linkIdsIn(blocks: { type?: string; props?: object; children?: unknown[] }[], into = new Set<string>()) {
  for (const b of blocks) {
    const props = (b.props ?? {}) as { pageId?: string; blockId?: string };
    if (b.type === "pageLink" && props.pageId) into.add(props.pageId);
    else if (b.type === "database" && props.blockId) into.add(props.blockId);
    if (b.children?.length) linkIdsIn(b.children as AnyBlock[], into);
  }
  return into;
}

/**
 * Cloned blocks whose inline databases point at fresh copies of them, and whose
 * subpage blocks point at copies of those subpages (links to pages elsewhere stay links).
 */
type ClonedBlock = { type?: string; props?: Record<string, unknown>; children?: ClonedBlock[] };
async function withPageCopies(blocks: ClonedBlock[], pageId: string): Promise<ClonedBlock[]> {
  const out: ClonedBlock[] = [];
  for (const b of blocks) {
    const children = b.children?.length ? await withPageCopies(b.children, pageId) : b.children;
    const key = b.type === "database" ? "blockId" : b.type === "pageLink" ? "pageId" : null;
    const target = key ? (b.props?.[key] as string | undefined) : undefined;
    let copy: string | null = null;
    if (target && key === "blockId") copy = await duplicateDatabase(target, { link: false });
    else if (target) {
      const page = await db.blocks.get(target);
      if (page?.alive && page.parent_table === "block" && page.parent_id === pageId) copy = await duplicatePage(target, { link: false });
    }
    out.push({ ...b, props: copy && key ? { ...b.props, [key]: copy } : b.props, children });
  }
  return out;
}

/** Where each type sits in "Convertir en" (Página, 5, is the block menu's own item). */
function turnIntoRank(item: { type: string; props?: Record<string, unknown> }) {
  const level = Number(item.props?.level) || 1;
  if (item.type === "heading") return item.props?.isToggleable ? 12 + level : level;
  return { paragraph: 0, bulletListItem: 6, numberedListItem: 7, checkListItem: 8, toggleListItem: 9, codeBlock: 10, quote: 11, callout: 12 }[item.type] ?? 20;
}

/** The block types offered by "Convertir en" and the toolbar, in the menu's order (headings 1-4 only). */
function textBlockTypes(editor: XotEditor) {
  const extra: BlockTypeSelectItem[] = [
    { name: "Código", type: "codeBlock", props: { language: "text" }, icon: Code },
    { name: "Destacado", type: "callout", props: { icon: "💡", backgroundColor: "gray" }, icon: Lightbulb },
    // BlockNote offers toggle headings 1-3; the slash menu also has the 4th.
    { name: "Encabezado desplegable 4", type: "heading", props: { level: 4, isToggleable: true }, icon: Heading4 },
  ];
  return [
    ...blockTypeSelectItems(editor).filter((item) => !(item.type === "heading" && Number(item.props?.level) > 4)),
    ...extra,
  ].sort((a, b) => turnIntoRank(a) - turnIntoRank(b));
}

/** Names of the blocks "Convertir en" doesn't offer, for the block menu's header. */
const BLOCK_NAMES: Record<string, string> = {
  image: "Imagen",
  video: "Video",
  audio: "Audio",
  file: "Archivo",
  pdf: "PDF",
  table: "Tabla",
  divider: "Divisor",
  pageLink: "Página",
  database: "Base de datos",
  button: "Botón",
  tableOfContents: "Tabla de contenidos",
  breadcrumb: "Ruta de navegación",
  bookmark: "Marcador web",
  embed: "Insertar",
  equation: "Ecuación",
  synced: "Bloque sincronizado",
  columnList: "Columnas",
  column: "Columna",
  tabs: "Pestañas",
  tab: "Pestaña",
};

/** The block's type as named at the top of its ⋮⋮ menu ("Texto", "Encabezado 2"…). */
function blockTypeName(block: AnyBlock, types: BlockTypeSelectItem[]) {
  const props = block.props as Record<string, unknown>;
  const match = types.find(
    (t) =>
      t.type === block.type &&
      (t.type === "callout" || Object.entries(t.props ?? {}).every(([k, v]) => props[k] === v)),
  );
  if (match) return match.name;
  if (block.type === "heading") return `Encabezado ${Number(props.level) || 1}`;
  return BLOCK_NAMES[block.type] ?? "Bloque";
}

const menuDate = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });

/** "Convertir en > Página" (⌘⌥9): the block's text becomes a subpage's title, its children the subpage. */
type TableCellData = { type: "tableCell"; props: Record<string, unknown>; content: InlineNode[] } | InlineNode[];
type TableData = {
  type: "tableContent";
  columnWidths: unknown[];
  headerRows?: number;
  headerCols?: number;
  rows: { cells: TableCellData[] }[];
};
const cellContent = (c: TableCellData | undefined) => (!c ? [] : Array.isArray(c) ? c : c.content);
const withCellContent = (c: TableCellData, content: InlineNode[]): TableCellData =>
  Array.isArray(c) ? structuredClone(content) : { ...c, content: structuredClone(content) };

/**
 * ⌘D / ⌘R in a simple table: the selected cells take the content of the top
 * (or leftmost) one; with only the caret in a cell, it takes the one above (or on the left).
 */
function fillTableCells(editor: XotEditor, dir: "down" | "right"): boolean {
  const view = editor.prosemirrorView;
  const at = view.domAtPos(view.state.selection.from).node;
  const cell = (at instanceof Element ? at : at.parentElement)?.closest("td, th");
  const blockEl = cell?.closest<HTMLElement>(".bn-block[data-id]");
  const block = blockEl ? (editor.getBlock(blockEl.dataset.id!) as AnyBlock | undefined) : undefined;
  if (!cell || !block || block.type !== "table") return false;
  const table = cell.closest("table")!;
  const rows = [...table.querySelectorAll("tr")];
  const coords = (el: Element): [number, number] => [rows.indexOf(el.parentElement as HTMLTableRowElement), [...el.parentElement!.children].indexOf(el)];
  const picked = [...table.querySelectorAll(".selectedCell")].map(coords);
  const data = structuredClone(block.content) as TableData;
  const get = (r: number, c: number) => data.rows[r]?.cells[c];
  const copy = (from: [number, number], to: [number, number]) => {
    const source = get(...from);
    const target = get(...to);
    if (source && target) data.rows[to[0]].cells[to[1]] = withCellContent(target, cellContent(source));
  };
  if (picked.length < 2) {
    const [r, c] = coords(cell);
    const from: [number, number] = dir === "down" ? [r - 1, c] : [r, c - 1];
    if (!get(...from)) return true;
    copy(from, [r, c]);
  } else {
    // Each column (row) of the selection is filled from its first cell.
    const lines = new Map<number, [number, number][]>();
    for (const rc of picked) {
      const key = dir === "down" ? rc[1] : rc[0];
      lines.set(key, [...(lines.get(key) ?? []), rc]);
    }
    for (const line of lines.values()) {
      line.sort((a, b) => (dir === "down" ? a[0] - b[0] : a[1] - b[1]));
      for (const to of line.slice(1)) copy(line[0], to);
    }
  }
  editor.updateBlock(block.id, { content: data } as never);
  return true;
}

/** "Convertir en base de datos" for a simple table: the first column is the title, the others text. */
async function tableToDatabase(editor: XotEditor, block: AnyBlock, pageId: string) {
  const data = block.content as TableData;
  const rows = data.rows.map((r) => r.cells.map((c) => textOf(cellContent(c)).trim()));
  const header = data.headerRows ? rows[0] : [];
  const body = data.headerRows ? rows.slice(1) : rows;
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const id = uuid();
  const { collectionId } = await createDatabaseView(pageId, "table", id);
  const ids = Array.from({ length: cols - 1 }, () => shortId());
  const schema: Record<string, { name: string; type: "title" | "text" }> = { title: { name: header[0] || "Nombre", type: "title" } };
  ids.forEach((pid, i) => (schema[pid] = { name: header[i + 1] || `Columna ${i + 2}`, type: "text" }));
  await db.collections.update(collectionId, { schema: schema as never });
  const viewId = (await db.blocks.get(id))?.view_ids?.[0];
  const view = viewId ? await db.views.get(viewId) : undefined;
  if (view)
    await db.views.update(view.id, { format: { ...view.format, properties: ["title", ...ids].map((property) => ({ property, visible: true })) } });
  const start = Date.now();
  for (const [i, r] of body.entries())
    await addRow(collectionId, { title: r[0] ?? "", ...Object.fromEntries(ids.map((pid, j) => [pid, r[j + 1] ?? ""])) }, start + i);
  editor.replaceBlocks([block.id], [{ type: "database", props: { blockId: id } }] as never);
}

function turnIntoPage(editor: XotEditor, block: AnyBlock, parentId: string) {
  const id = uuid();
  const title = textOf(block.content);
  const content = cloneBlocks(block.children);
  // Subpages among its children go with them into the new page.
  void handOff(block.children, parentId, id);
  editor.transact(() => {
    editor.insertBlocks([{ type: "pageLink", props: { pageId: id } }], block.id, "before");
    editor.removeBlocks([block.id]);
  });
  void createPage("block", parentId, { id, properties: { title }, content: content.length ? (content as unknown[]) : null });
}

/** "Convertir en > Bloque sincronizado": the block (with its children) becomes a synced block's content. */
async function turnIntoSynced(editor: XotEditor, block: AnyBlock) {
  const sourceId = uuid();
  await db.synced.put({ id: sourceId, content: cloneBlocks([block]) as unknown[], updated_time: Date.now() });
  if (!editor.getBlock(block.id)) return;
  editor.replaceBlocks([block.id], [{ type: "synced", props: { sourceId } }] as never);
}

/** "Convertir en > N columnas": the block moves into the first of N columns. */
function turnIntoColumns(editor: XotEditor, block: AnyBlock, n: number) {
  const empty = () => ({ type: "column", children: [{ type: "paragraph" }] });
  editor.replaceBlocks([block.id], [
    { type: "columnList", children: [{ type: "column", children: [block] }, ...Array.from({ length: n - 1 }, empty)] },
  ] as never);
}

/** Subpages trashed by deleting their block here: pasting the block (cut) elsewhere moves the page there. */
const editorTrashed = new Set<string>();

/** Subpages whose blocks leave the page for another one (Mover a, Convertir en página): moved, not trashed. */
const handedOff = new Set<string>();
async function handOff(blocks: AnyBlock[], fromId: string, toId: string) {
  for (const id of linkIdsIn(blocks)) {
    handedOff.add(id);
    const page = await db.blocks.get(id);
    if (page?.parent_table === "block" && page.parent_id === fromId) await updateBlock(id, { parent_id: toId });
  }
}

/** The block being edited, once the slash menu has taken out its "/query". */
const cursorBlock = (editor: XotEditor) => editor.getTextCursorPosition().block as AnyBlock;

/** "/rojo", "/fondo": text and background colors, for the block being edited. */
function colorSlashItems(editor: XotEditor): DefaultReactSuggestionItem[] {
  const english: Record<string, string> = { default: "default", gray: "gray", brown: "brown", orange: "orange", yellow: "yellow", green: "green", blue: "blue", purple: "purple", pink: "pink", red: "red" };
  return OPTION_COLORS.flatMap((c) => {
    const name = OPTION_COLOR_LABELS[c];
    const lower = name.toLowerCase();
    const set = (props: Record<string, string>) => () => {
      const cur = cursorBlock(editor);
      for (const [kind, value] of Object.entries(props)) rememberColor(kind as LastColor["kind"], value);
      if (cur) editor.updateBlock(cur.id, { props } as never);
    };
    return [
      {
        title: name,
        aliases: [english[c], "color", "colour", "texto"],
        group: "Color",
        icon: <span className="xot-slash-color" data-color={c}>A</span>,
        onItemClick: set({ textColor: c }),
      },
      {
        title: c === "default" ? "Fondo predeterminado" : `Fondo ${lower}`,
        aliases: [`${english[c]} background`, "background", "highlight", "fondo", "resaltado"],
        group: "Color",
        icon: <span className="xot-slash-color xot-slash-color--bg" data-color={c}>A</span>,
        onItemClick: set({ backgroundColor: c === "default" ? "default" : c }),
      },
    ];
  });
}

/** The last color picked in any color menu: ⌘⇧H applies it, and the menus offer it first ("Usados recientemente"). */
type LastColor = { kind: "textColor" | "backgroundColor"; value: string };
const LAST_COLOR_KEY = "xotion:last-color";
const PICKER_COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;

function lastColor(): LastColor | null {
  try {
    const c = JSON.parse(localStorage.getItem(LAST_COLOR_KEY) ?? "null") as LastColor | null;
    return c && (c.kind === "textColor" || c.kind === "backgroundColor") && PICKER_COLORS.includes(c.value as never) ? c : null;
  } catch {
    return null;
  }
}

function rememberColor(kind: LastColor["kind"], value: string) {
  if (value === "default" || !PICKER_COLORS.includes(value as never)) return;
  try {
    localStorage.setItem(LAST_COLOR_KEY, JSON.stringify({ kind, value }));
  } catch {
    /* storage unavailable */
  }
}

/** BlockNote's "A" swatch (its ColorIcon isn't exported); styles.css sizes it. */
const colorIcon = (kind: LastColor["kind"], color: string, size = 22) => (
  <div
    className="bn-color-icon"
    data-text-color={kind === "textColor" ? color : "default"}
    data-background-color={kind === "backgroundColor" ? color : "default"}
    style={{ width: size, height: size, lineHeight: `${size}px`, fontSize: size * 0.75, textAlign: "center", pointerEvents: "none" }}
  >
    A
  </div>
);

type ColorTarget = { color: string; set: (color: string) => void };

/** The color menu's sections: "Usados recientemente" (once a color was used), text, background. */
function ColorSections({ text, background }: { text?: ColorTarget; background?: ColorTarget }) {
  const Components = useComponentsContext()!;
  const names = dictionary.color_picker.colors as Record<string, string>;
  const recent = lastColor();
  const recentTarget = recent && (recent.kind === "textColor" ? text : background);
  const section = (kind: LastColor["kind"], title: string, target?: ColorTarget) =>
    target && (
      <>
        <Components.Generic.Menu.Label>{title}</Components.Generic.Menu.Label>
        {PICKER_COLORS.map((c) => (
          <Components.Generic.Menu.Item
            key={kind + c}
            icon={colorIcon(kind, c)}
            checked={target.color === c}
            onClick={() => {
              rememberColor(kind, c);
              target.set(c);
            }}
          >
            {names[c]}
          </Components.Generic.Menu.Item>
        ))}
      </>
    );
  return (
    <>
      {recent && recentTarget && (
        <>
          <Components.Generic.Menu.Label>Usados recientemente</Components.Generic.Menu.Label>
          <Components.Generic.Menu.Item icon={colorIcon(recent.kind, recent.value)} onClick={() => recentTarget.set(recent.value)}>
            {recent.kind === "textColor" ? names[recent.value] : `Fondo ${names[recent.value].toLowerCase()}`}
          </Components.Generic.Menu.Item>
        </>
      )}
      {section("textColor", dictionary.color_picker.text_title, text)}
      {section("backgroundColor", dictionary.color_picker.background_title, background)}
    </>
  );
}

/** The selection toolbar's "Colores" (BlockNote's ColorStyleButton, with the recent color first). */
function ColorButton() {
  const Components = useComponentsContext()!;
  const portalElement = usePortalElement();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editor = useBlockNoteEditor<any, any, any>();
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor.isEditable || !(editor.getSelection()?.blocks || [editor.getTextCursorPosition().block]).find((b) => b.content !== undefined))
        return undefined;
      const styles = editor.getActiveStyles() as { textColor?: string; backgroundColor?: string };
      return { textColor: styles.textColor || "default", backgroundColor: styles.backgroundColor || "default" };
    },
  });
  if (!state) return null;
  const setter = (kind: LastColor["kind"]) => (color: string) => {
    if (color === "default") editor.removeStyles({ [kind]: color });
    else editor.addStyles({ [kind]: color });
    editor.focus();
  };
  return (
    <Components.Generic.Menu.Root portalElement={portalElement}>
      <Components.Generic.Menu.Trigger>
        <Components.FormattingToolbar.Button
          className="bn-button"
          data-test="colors"
          label={dictionary.formatting_toolbar.colors.tooltip}
          mainTooltip={dictionary.formatting_toolbar.colors.tooltip}
          icon={
            <div
              className="bn-color-icon"
              data-text-color={state.textColor}
              data-background-color={state.backgroundColor}
              style={{ width: 20, height: 20, lineHeight: "20px", fontSize: 15, textAlign: "center", pointerEvents: "none" }}
            >
              A
            </div>
          }
        />
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown className="bn-menu-dropdown bn-color-picker-dropdown">
        <ColorSections
          text={{ color: state.textColor, set: setter("textColor") }}
          background={{ color: state.backgroundColor, set: setter("backgroundColor") }}
        />
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

/** The ⋮⋮ menu's "Color" submenu (BlockNote's BlockColorsItem, with the recent color first). */
function BlockColorItem({ children }: { children: ReactNode }) {
  const Components = useComponentsContext()!;
  const portalElement = usePortalElement();
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block }) as
    | AnyBlock
    | undefined;
  const props = block?.props as Record<string, unknown> | undefined;
  if (!block || !props || (!("textColor" in props) && !("backgroundColor" in props))) return null;
  const target = (kind: LastColor["kind"]): ColorTarget | undefined =>
    kind in props
      ? { color: String(props[kind] ?? "default"), set: (c) => editor.updateBlock(block.id, { props: { [kind]: c } } as never) }
      : undefined;
  return (
    <Components.Generic.Menu.Root position="right" sub={true} portalElement={portalElement}>
      <Components.Generic.Menu.Trigger sub={true}>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger={true}>
          {children}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub={true} className="bn-menu-dropdown bn-color-picker-dropdown">
        <ColorSections text={target("textColor")} background={target("backgroundColor")} />
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

/** "/eliminar", "/duplicar", "/mover", "/comentario", "/convertir": the block menu's actions, from the slash menu. */
function actionSlashItems(
  editor: XotEditor,
  pageId: string,
  actions: { move: (blocks: AnyBlock[]) => void; comment: (block: AnyBlock) => void },
  turnInto: boolean,
): DefaultReactSuggestionItem[] {
  const group = "Acciones";
  const items: DefaultReactSuggestionItem[] = [
    {
      title: "Eliminar",
      aliases: ["delete", "borrar", "remove", "suprimir"],
      group,
      icon: <Trash2 size={20} />,
      badge: "Supr",
      onItemClick: () => removeSelectedBlocks(editor, [cursorBlock(editor)]),
    },
    {
      title: "Duplicar",
      aliases: ["duplicate", "copiar", "copy"],
      group,
      icon: <Copy size={20} />,
      badge: "⌘D",
      onItemClick: () => duplicateBlocks(editor, [cursorBlock(editor)], pageId),
    },
    {
      title: "Mover a",
      aliases: ["move", "mover"],
      group,
      icon: <CornerUpRight size={20} />,
      badge: "⌘⇧P",
      onItemClick: () => actions.move([cursorBlock(editor)]),
    },
    {
      title: "Comentario",
      aliases: ["comment", "comentar"],
      group,
      icon: <MessageSquareText size={20} />,
      badge: "⌘⇧M",
      onItemClick: () => actions.comment(cursorBlock(editor)),
    },
  ];
  // "/convertir": Convertir en… with each type, as the block menu offers them.
  if (turnInto)
    for (const t of textBlockTypes(editor)) {
      const Icon = t.icon;
      items.push({
        title: `Convertir en ${t.name.toLowerCase()}`,
        aliases: ["convertir en", "turn into", "convert"],
        group,
        icon: <Icon size={20} />,
        onItemClick: () => {
          const cur = cursorBlock(editor);
          if (cur && Array.isArray(cur.content) && !(cur.type === "callout" && t.type === "callout"))
            editor.updateBlock(cur.id, {
              type: t.type,
              props: t.props ?? {},
              ...(t.type === "codeBlock" ? { content: textOf(cur.content) } : {}),
            } as never);
        },
      });
    }
  return items;
}

/** Editor actions the block menu needs but can't hold itself (it closes on click). */
const EditorActions = createContext<{
  move: (blocks: AnyBlock[]) => void;
  comment: (block: AnyBlock) => void;
} | null>(null);

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** ⋮⋮ menu: search, turn into, color, copy link, duplicate, move, delete, comment. */
function BlockMenu() {
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block }) as
    | AnyBlock
    | undefined;
  // The items mount with the open menu, so the search starts empty each time.
  return <DragHandleMenu>{block ? <BlockMenuItems block={block} /> : []}</DragHandleMenu>;
}

/**
 * BlockNote's ⋮⋮ handle, but its menu hangs from the handle ("left-start"), with the
 * search box level with the block, instead of being centered on it. Near the bottom it flips/shifts up.
 */
/** The blocks being dragged by their ⋮⋮ handle (a drop on a sidebar page moves them there). */
let draggedBlocks: AnyBlock[] = [];
/** Sent by the sidebar when blocks are dropped on one of its pages (detail: the page's id). */
const BLOCKS_TO_PAGE_EVENT = "xot:blocks-to-page";

function BlockHandle() {
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const Components = useComponentsContext()!;
  const portalElement = usePortalElement();
  const dict = useDictionary();
  const sideMenu = useExtension(SideMenuExtension);
  const block = useExtensionState(SideMenuExtension, { selector: (state) => state?.block });
  if (block === undefined) return null;
  return (
    <Components.Generic.Menu.Root
      onOpenChange={(open: boolean) => (open ? sideMenu.freezeMenu() : sideMenu.unfreezeMenu())}
      position="left-start"
      portalElement={portalElement}
    >
      <Components.Generic.Menu.Trigger>
        <Components.SideMenu.Button
          label={dict.side_menu.drag_handle_label}
          draggable={true}
          onDragStart={(e) => {
            sideMenu.blockDragStart(e, block);
            draggedBlocks = (rangeBlocks(editor) ?? (editor.getSelection()?.blocks as AnyBlock[] | undefined) ?? [block]) as AnyBlock[];
            if (!draggedBlocks.some((b) => b.id === block.id)) draggedBlocks = [block as AnyBlock];
            // ⌥ while dragging leaves a copy where the blocks are dropped (ProseMirror copies on ⌥);
            // with only "move" allowed, the browser would refuse that drop.
            e.dataTransfer.effectAllowed = "copyMove";
          }}
          onDragEnd={() => {
            sideMenu.blockDragEnd();
            // After the drop (a sidebar page reads them on its drop).
            window.setTimeout(() => (draggedBlocks = []), 0);
          }}
          className="bn-button"
          icon={
            <svg stroke="currentColor" fill="currentColor" strokeWidth="0" viewBox="0 0 24 24" width={24} height={24} data-test="dragHandle">
              <path fill="none" d="M0 0h24v24H0V0z" />
              <path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
            </svg>
          }
        />
      </Components.Generic.Menu.Trigger>
      <BlockMenu />
    </Components.Generic.Menu.Root>
  );
}

function BlockMenuItems({ block }: { block: AnyBlock }) {
  const Components = useComponentsContext()!;
  const portalElement = usePortalElement();
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const pageId = useContext(PageContext);
  const actions = useContext(EditorActions);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const types = useMemo(() => textBlockTypes(editor), [editor]);
  // Blocks keep no edit times of their own: the footer shows the page's, as the closest local value.
  const page = useBlock(pageId);
  // The menu focuses its first item when it opens; the search box takes over.
  useEffect(() => {
    const t = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);
  // The block turns blue while its menu is open (and stays selected after), unless it's part of a
  // multi-block selection, which the menu then acts on.
  useEffect(() => {
    if (!rangeBlocks(editor)?.some((b) => b.id === block.id)) selectBlock(editor, block.id);
  }, [block.id]);
  // Acts on the selection when the block is part of it.
  const targets = () => {
    const selected = (rangeBlocks(editor) ?? editor.getSelection()?.blocks) as AnyBlock[] | undefined;
    return selected?.some((b) => b.id === block.id) ? selected : [block];
  };
  const hint = (text: string) => <span className="xot-menu-hint">{text}</span>;
  const q = fold(query.trim());
  const shows = (label: string) => !q || fold(label).includes(q);
  const item = (label: string, icon: ReactNode, onClick: () => void, shortcut?: string) =>
    shows(label) && (
      <Components.Generic.Menu.Item key={label} className="bn-menu-item" onClick={onClick}>
        {icon}
        {label}
        {shortcut && hint(shortcut)}
      </Components.Generic.Menu.Item>
    );
  const turnInto = Array.isArray(block.content) && (shows("Convertir en") || types.some((t) => shows(t.name)));
  return (
    <>
      <div className="xot-menu-search" onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}>
        <Search size={16} />
        <input
          ref={searchRef}
          placeholder="Buscar acciones…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar acciones"
        />
      </div>
      {!q && <Components.Generic.Menu.Label className="xot-block-menu-type">{blockTypeName(block, types)}</Components.Generic.Menu.Label>}
      {turnInto && (
        <Components.Generic.Menu.Root position="right" sub={true} portalElement={portalElement}>
          <Components.Generic.Menu.Trigger sub={true}>
            <Components.Generic.Menu.Item className="bn-menu-item" subTrigger={true}>
              <Repeat size={20} />
              Convertir en
            </Components.Generic.Menu.Item>
          </Components.Generic.Menu.Trigger>
          <Components.Generic.Menu.Dropdown sub={true} className="bn-menu-dropdown xot-turn-into">
            {types.flatMap((item) => {
              const Icon = item.icon;
              const props = (item.props ?? {}) as Record<string, unknown>;
              // Only the type's own props count: a callout with another icon is still a callout.
              const current =
                item.type === block.type &&
                (item.type === "callout" ||
                  Object.entries(props).every(([k, v]) => (block.props as Record<string, unknown>)[k] === v));
              const entry = (
                <Components.Generic.Menu.Item
                  key={item.name}
                  className="bn-menu-item"
                  checked={current || undefined}
                  onClick={() => {
                    const blocks = targets();
                    editor.transact(() => {
                      for (const b of blocks)
                        if (!(b.type === "callout" && item.type === "callout"))
                          editor.updateBlock(b.id, {
                            type: item.type,
                            props,
                            // Code holds plain text: the marks and mentions go.
                            ...(item.type === "codeBlock" && Array.isArray(b.content) ? { content: textOf(b.content) } : {}),
                          } as never);
                    });
                  }}
                >
                  <Icon size={20} />
                  {item.name}
                </Components.Generic.Menu.Item>
              );
              // Ecuación del bloque and Bloque sincronizado follow Destacado.
              if (turnIntoRank(item) === 12)
                return [
                  entry,
                  <Components.Generic.Menu.Item
                    key="Ecuación del bloque"
                    className="bn-menu-item"
                    onClick={() => {
                      const blocks = targets().filter((b) => Array.isArray(b.content));
                      editor.transact(() => {
                        for (const b of blocks)
                          editor.updateBlock(b.id, { type: "equation", props: { latex: textOf(b.content).trim() } } as never);
                      });
                    }}
                  >
                    <Radical size={20} />
                    Ecuación del bloque
                  </Components.Generic.Menu.Item>,
                  // Its subpages would leave the page with it: not offered then.
                  !linkIdsIn([block]).size && (
                    <Components.Generic.Menu.Item key="Bloque sincronizado" className="bn-menu-item" onClick={() => void turnIntoSynced(editor, block)}>
                      <RefreshCw size={20} />
                      Bloque sincronizado
                    </Components.Generic.Menu.Item>
                  ),
                ];
              // Página comes right after the headings.
              return turnIntoRank(item) === 4
                ? [
                    entry,
                    <Components.Generic.Menu.Item
                      key="Página"
                      className="bn-menu-item"
                      onClick={() => turnIntoPage(editor, block, pageId)}
                    >
                      <FileText size={20} />
                      Página
                    </Components.Generic.Menu.Item>,
                  ]
                : [entry];
            })}
            {[2, 3, 4, 5].map((n) => (
              <Components.Generic.Menu.Item key={`${n} columnas`} className="bn-menu-item" onClick={() => turnIntoColumns(editor, block, n)}>
                {n === 2 ? <Columns2 size={20} /> : n === 3 ? <Columns3 size={20} /> : <Columns4 size={20} />}
                {n} columnas
              </Components.Generic.Menu.Item>
            ))}
          </Components.Generic.Menu.Dropdown>
        </Components.Generic.Menu.Root>
      )}
      {shows("Color") && (
        <BlockColorItem>
          <Paintbrush size={20} />
          Color
        </BlockColorItem>
      )}
      {block.type === "numberedListItem" &&
        (
          [
            ["", "Números"],
            ["letters", "Letras"],
            ["roman", "Números romanos"],
          ] as const
        ).map(
          ([format, label]) =>
            shows(label) && (
              <Components.Generic.Menu.Item
                key={label}
                className="bn-menu-item"
                checked={((block.props as { listFormat?: string }).listFormat ?? "") === format || undefined}
                onClick={() => {
                  // The whole list (the block and its neighbors at the same level) takes the format.
                  const parent = editor.getParentBlock(block.id) as AnyBlock | undefined;
                  const list = (parent ? parent.children : editor.document) as AnyBlock[];
                  let i = list.findIndex((b) => b.id === block.id);
                  let j = i;
                  while (i > 0 && list[i - 1].type === "numberedListItem") i--;
                  while (j < list.length - 1 && list[j + 1].type === "numberedListItem") j++;
                  editor.transact(() => {
                    for (const b of list.slice(i, j + 1)) editor.updateBlock(b.id, { props: { listFormat: format } } as never);
                  });
                }}
              >
                <ListOrdered size={20} />
                {label}
              </Components.Generic.Menu.Item>
            ),
        )}
      {block.type === "codeBlock" && (
        <>
          {shows("Ajustar código") && (
            <Components.Generic.Menu.Item
              key="Ajustar código"
              className="bn-menu-item"
              checked={!!(block.props as { wrap?: boolean }).wrap || undefined}
              onClick={() => editor.updateBlock(block.id, { props: { wrap: !(block.props as { wrap?: boolean }).wrap } } as never)}
            >
              <WrapText size={20} />
              Ajustar código
            </Components.Generic.Menu.Item>
          )}
          {item("Leyenda", <Captions size={20} />, () =>
            window.setTimeout(() => window.dispatchEvent(new CustomEvent(CODE_CAPTION_EVENT, { detail: block.id })), 50),
          )}
        </>
      )}
      {block.type === "table" && (
        <>
          {[
            ["Fila de encabezado", "headerRows", <PanelTop size={20} key="i" />],
            ["Columna de encabezado", "headerCols", <PanelLeft size={20} key="i" />],
          ].map(
            ([label, key, icon]) =>
              shows(label as string) && (
                <Components.Generic.Menu.Item
                  key={label as string}
                  className="bn-menu-item"
                  checked={!!(block.content as TableData)[key as "headerRows"] || undefined}
                  onClick={() => {
                    const data = block.content as TableData;
                    editor.updateBlock(block.id, { content: { ...data, [key as string]: data[key as "headerRows"] ? 0 : 1 } } as never);
                  }}
                >
                  {icon}
                  {label}
                </Components.Generic.Menu.Item>
              ),
          )}
          {item("Convertir en base de datos", <Table2 size={20} />, () => void tableToDatabase(editor, block, pageId))}
        </>
      )}
      {block.type === "database" &&
        !!(block.props as { blockId?: string }).blockId &&
        item("Convertir en página", <FileText size={20} />, () => {
          // The inline database becomes a full-page one, and a link to it takes its place.
          const id = (block.props as { blockId: string }).blockId;
          editor.replaceBlocks([block.id], [{ type: "pageLink", props: { pageId: id } }] as never);
          void setDatabaseInline(id, false);
        })}
      {(!q || shows("Convertir en") || shows("Color")) && <Components.Generic.Menu.Divider />}
      {item("Copiar enlace al bloque", <Link size={20} />, () => void copyLink(`${pageId}?b=${block.id}`), "⌥⌘L")}
      {item("Duplicar", <Copy size={20} />, () => duplicateBlocks(editor, targets(), pageId), "⌘D")}
      {actions && item("Mover a", <CornerUpRight size={20} />, () => actions.move(targets()), "⌘⇧P")}
      {shows("Eliminar") && (
        <RemoveBlockItem>
          <Trash2 size={20} />
          Eliminar
          {hint("Supr")}
        </RemoveBlockItem>
      )}
      {actions && Array.isArray(block.content) && shows("Comentar") && (
        <>
          <Components.Generic.Menu.Divider />
          {item("Comentar", <MessageSquareText size={20} />, () => actions.comment(block), "⌘⇧M")}
        </>
      )}
      {!q && page && page.last_edited_time > 0 && (
        <>
          <Components.Generic.Menu.Divider />
          <div className="xot-block-menu-meta">
            {/* The local user ("Tú") is the only editor. */}
            <div>Última edición por ti</div>
            <div>{menuDate.format(page.last_edited_time)}</div>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Selection toolbar: block type | link | B I U S code | color (no alignment or indent).
 * An image's own toolbar shows on hover (ImageToolbar).
 */
function TextToolbar() {
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const types = useMemo(() => textBlockTypes(editor), [editor]);
  const selected = useSelectedBlocks(editor);
  // A whole block selected (Esc, or a click on an image) shows only its blue highlight.
  if ("node" in editor.prosemirrorState.selection || (selected.length === 1 && selected[0].type === "image")) return null;
  return (
    <FormattingToolbar>
      <BlockTypeSelect key="type" items={types} />
      <TableCellMergeButton key="merge" />
      <FileCaptionButton key="caption" />
      <FileReplaceButton key="replace" />
      <FileDeleteButton key="delete" />
      <FileDownloadButton key="download" />
      <LinkButton key="link" />
      <AddCommentButton key="comment" />
      <BasicTextStyleButton basicTextStyle="bold" key="bold" />
      <BasicTextStyleButton basicTextStyle="italic" key="italic" />
      <BasicTextStyleButton basicTextStyle="underline" key="underline" />
      <BasicTextStyleButton basicTextStyle="strike" key="strike" />
      <BasicTextStyleButton basicTextStyle="code" key="code" />
      <EquationButton key="equation" />
      <ColorButton key="color" />
    </FormattingToolbar>
  );
}

/** "+" handle: a click adds a block below, ⌥-click one above (with "/" open on it). */
function AddBlockSlot() {
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block }) as
    | AnyBlock
    | undefined;
  const ref = useRef<HTMLSpanElement>(null);
  // BlockNote hides the handles on any key; holding ⌥ over them must keep them for the ⌥-click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Alt" && ref.current?.closest(".bn-side-menu")?.matches(":hover")) e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <span
      ref={ref}
      className="xot-side-btn"
      data-tooltip={"**Haz clic** para agregar un bloque debajo\n**Opción+clic** para agregar un bloque arriba"}
      onMouseDownCapture={(e) => {
        if (!e.altKey || !block) return;
        e.preventDefault();
        e.stopPropagation();
        const [added] = editor.insertBlocks([{ type: "paragraph" }], block.id, "before");
        if (!added) return;
        editor.setTextCursorPosition(added.id, "start");
        editor.focus();
        editor.getExtension(SuggestionMenu)?.openSuggestionMenu("/");
      }}
      onClickCapture={(e) => {
        if (!e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <AddBlockButton />
    </span>
  );
}

/** Spanish names for the common emoji, so ":sonri" or ":corazon" find them in the Spanish UI. */
const EMOJI_ES: Record<string, string[]> = {
  grinning: ["sonrisa", "cara sonriente"],
  smiley: ["sonrisa con ojos grandes", "feliz"],
  smile: ["sonrisa con ojos sonrientes"],
  grin: ["sonrisa radiante"],
  slightly_smiling_face: ["sonrisa leve"],
  blush: ["sonrojado", "sonrisa tímida"],
  sweat_smile: ["sonrisa nerviosa"],
  laughing: ["risa"],
  joy: ["risa con lágrimas", "llorar de risa", "jaja"],
  rolling_on_the_floor_laughing: ["carcajada", "revolcarse de risa"],
  wink: ["guiño"],
  heart_eyes: ["enamorado", "ojos de corazón"],
  kissing_heart: ["beso"],
  sunglasses: ["gafas de sol", "lentes"],
  thinking_face: ["pensar", "pensativo"],
  cry: ["llorar", "triste"],
  sob: ["llorar a mares", "llanto"],
  angry: ["enojado", "enfadado"],
  rage: ["furioso"],
  scream: ["grito", "miedo"],
  partying_face: ["cara de fiesta"],
  heart: ["corazón", "amor"],
  broken_heart: ["corazón roto"],
  fire: ["fuego"],
  "+1": ["pulgar arriba", "me gusta", "bien"],
  "-1": ["pulgar abajo", "no me gusta"],
  ok_hand: ["ok", "perfecto"],
  clap: ["aplausos"],
  pray: ["rezar", "gracias", "por favor"],
  muscle: ["músculo", "fuerza"],
  wave: ["hola", "saludo"],
  eyes: ["ojos", "mirar"],
  star: ["estrella"],
  star2: ["estrella brillante"],
  sparkles: ["destellos", "brillos"],
  white_check_mark: ["check", "hecho", "listo"],
  heavy_check_mark: ["marca de verificación", "visto"],
  x: ["cruz", "error"],
  warning: ["advertencia", "aviso"],
  question: ["pregunta"],
  exclamation: ["exclamación"],
  100: ["cien"],
  rocket: ["cohete"],
  tada: ["fiesta", "celebración"],
  gift: ["regalo"],
  trophy: ["trofeo"],
  checkered_flag: ["meta", "bandera a cuadros"],
  bulb: ["idea", "bombilla"],
  memo: ["nota", "apuntes"],
  pencil2: ["lápiz"],
  books: ["libros"],
  calendar: ["calendario"],
  pushpin: ["chincheta", "fijar"],
  moneybag: ["dinero", "bolsa de dinero"],
  coffee: ["café"],
  sunny: ["sol"],
  house: ["casa"],
  dog: ["perro"],
  cat: ["gato"],
};

/** Opens the link popup (LinkSearch) for an editor's selection; `detail` is the editor. */
const LINK_SEARCH_EVENT = "xot:link-search";

/** "Enlace" button: the same popup as ⌘K, under the selection. */
function LinkButton() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const selected = useSelectedBlocks(editor);
  const sel = editor.prosemirrorState.selection;
  if (!editor.isEditable || sel.empty || isTableCellSelection(sel) || !selected.some((b) => Array.isArray(b.content)))
    return null;
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="Enlace"
      mainTooltip="Enlace"
      secondaryTooltip="⌘K"
      icon={<Link size={16} />}
      onClick={() => document.dispatchEvent(new CustomEvent(LINK_SEARCH_EVENT, { detail: editor }))}
    />
  );
}

/** What was typed, as a web address when it looks like one ("xot.app", "https://…", "mailto:…"). */
function typedUrl(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^(https?|ftp|mailto|tel|xot):/i.test(t)) return t;
  if (/^www\./i.test(t) || /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(t)) return `https://${t}`;
  return null;
}

/**
 * ⌘K popup: "Pega un enlace o busca una página…" under the selection,
 * with the workspace's matching pages (a link to one opens it in Xot) and, when
 * what's typed is an address, "Enlace a una página web" first.
 */
function LinkSearch() {
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<DefaultReactSuggestionItem[]>([]);

  useEffect(() => {
    const open = () => {
      const view = editor.prosemirrorView;
      const sel = view?.state.selection;
      if (!view || !editor.isEditable || !sel || sel.empty || "node" in sel || isTableCellSelection(sel)) return false;
      const host = view.dom.parentElement;
      if (!host) return false;
      // Anchored to the selection itself (not the toolbar), inside the editor so it scrolls with the text.
      const start = view.coordsAtPos(sel.from);
      const end = view.coordsAtPos(sel.to, -1);
      const el = document.createElement("div");
      el.className = "xot-link-anchor";
      el.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none";
      host.append(el);
      const origin = el.getBoundingClientRect();
      const left = end.top > start.top + 4 ? Math.min(start.left, end.left) : start.left;
      el.style.left = `${left - origin.left}px`;
      el.style.top = `${start.top - origin.top}px`;
      el.style.width = `${Math.max(1, (end.top > start.top + 4 ? start.left : end.left) - left)}px`;
      el.style.height = `${end.bottom - start.top}px`;
      editor.getExtension(ShowSelectionExtension)?.showSelection(true, "xotLinkSearch");
      setQuery(editor.getSelectedLinkUrl() ?? "");
      setAnchor(el);
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "k") return;
      if (!editor.isFocused() || !open()) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onOpen = (e: Event) => {
      if ((e as CustomEvent).detail === editor) open();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener(LINK_SEARCH_EVENT, onOpen);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener(LINK_SEARCH_EVENT, onOpen);
    };
  }, [editor]);

  useEffect(() => () => anchor?.remove(), [anchor]);

  const close = (link?: string) => {
    editor.getExtension(ShowSelectionExtension)?.showSelection(false, "xotLinkSearch");
    setAnchor(null);
    editor.focus();
    if (link) editor.createLink(link);
  };

  useEffect(() => {
    if (!anchor) return;
    let live = true;
    void pageItems(fold(query.trim()), (p) => close(`#/${p.id}`), "").then((items) => live && setPages(items.slice(0, 6)));
    return () => {
      live = false;
    };
  }, [anchor, query]);

  if (!anchor) return null;
  const url = typedUrl(query);
  return (
    <Popover anchor={anchor} onClose={() => close()} width={320}>
      <div className="menu move-picker xot-link-search">
        <input
          className="menu-search"
          autoFocus
          placeholder="Pega un enlace o busca una página…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.defaultPrevented && url) {
              e.preventDefault();
              close(url);
            }
          }}
        />
        {url && (
          <>
            <div className="menu-label">Enlace a una página web</div>
            <MenuItem icon={<Globe size={18} />} onClick={() => close(url)}>
              {query.trim()}
            </MenuItem>
          </>
        )}
        {pages.length > 0 && <div className="menu-label">{query.trim() ? "Páginas" : "Recientes"}</div>}
        {pages.map((item) => (
          <MenuItem key={item.title} icon={item.icon} right={item.badge} onClick={item.onItemClick}>
            {item.title}
          </MenuItem>
        ))}
        {!url && !pages.length && <div className="menu-empty">Sin resultados</div>}
      </div>
    </Popover>
  );
}

/** The selected text becomes an inline equation (an empty one opens its editor). */
function selectionToEquation(editor: XotEditor) {
  const sel = editor.prosemirrorState.selection;
  const tex = sel.empty ? "" : editor.prosemirrorState.doc.textBetween(sel.from, sel.to, " ");
  editor.insertInlineContent([{ type: "inlineEquation", props: { latex: tex.trim() } }]);
}

/** "Crear ecuación" (√x), between code and color: what ⌘⇧E does. */
function EquationButton() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const selected = useSelectedBlocks(editor);
  if (!editor.isEditable || selected.some((b) => !Array.isArray(b.content) || b.type === "codeBlock")) return null;
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="Crear ecuación"
      mainTooltip="Crear ecuación"
      secondaryTooltip="⌘⇧E"
      icon={<Radical size={16} />}
      onClick={() => selectionToEquation(editor)}
    />
  );
}

type ImageProps = { url: string; caption: string; textAlignment: string; name: string; href: string };

/** Full-screen image view: the picture over a dark backdrop; a click, Esc or Space closes it. */
async function openImageViewer(url: string, alt = "") {
  if (!url || document.querySelector(".xot-lightbox")) return;
  const overlay = document.createElement("div");
  overlay.className = "xot-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", alt || "Imagen");
  const img = document.createElement("img");
  img.src = await resolveFileUrl(url);
  img.alt = alt;
  const shut = document.createElement("button");
  shut.type = "button";
  shut.className = "xot-lightbox__close";
  shut.setAttribute("aria-label", "Cerrar");
  shut.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  overlay.append(img, shut);
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  overlay.addEventListener("click", (e) => e.target !== img && close());
  window.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
}

/** "Recortar": a box over the picture, its corners dragged; the cropped copy is stored on this device. */
function ImageCrop({ url, onDone, onClose }: { url: string; onDone: (url: string) => void; onClose: () => void }) {
  const [src, setSrc] = useState("");
  const [box, setBox] = useState({ x: 0, y: 0, w: 1, h: 1 });
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => void resolveFileUrl(url).then(setSrc), [url]);
  const drag = (mode: "move" | "nw" | "ne" | "sw" | "se") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = frame.current!.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, box };
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / r.width;
      const dy = (ev.clientY - start.y) / r.height;
      const b = { ...start.box };
      if (mode === "move") {
        b.x = clamp(b.x + dx, 0, 1 - b.w);
        b.y = clamp(b.y + dy, 0, 1 - b.h);
      } else {
        if (mode.includes("w")) {
          const x = clamp(b.x + dx, 0, b.x + b.w - 0.05);
          b.w += b.x - x;
          b.x = x;
        }
        if (mode.includes("e")) b.w = clamp(b.w + dx, 0.05, 1 - b.x);
        if (mode.includes("n")) {
          const y = clamp(b.y + dy, 0, b.y + b.h - 0.05);
          b.h += b.y - y;
          b.y = y;
        }
        if (mode.includes("s")) b.h = clamp(b.h + dy, 0.05, 1 - b.y);
      }
      setBox(b);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const apply = async () => {
    setBusy(true);
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = src;
      await img.decode();
      const [w, h] = [img.naturalWidth, img.naturalHeight];
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(box.w * w));
      canvas.height = Math.max(1, Math.round(box.h * h));
      canvas.getContext("2d")!.drawImage(img, box.x * w, box.y * h, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
      if (!blob) throw new Error("crop");
      onDone(await storeFile(new File([blob], "imagen.png", { type: "image/png" })));
    } catch {
      // A picture from another site without CORS can't be read back from the canvas.
      toast("No se pudo recortar esta imagen");
      onClose();
    }
  };
  const pct = (v: number) => `${v * 100}%`;
  return (
    <Modal label="Recortar imagen" className="xot-crop" onClose={onClose}>
      <div className="xot-crop__frame" ref={frame}>
        {src && <img src={src} alt="" draggable={false} />}
        <div
          className="xot-crop__box"
          style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
          onPointerDown={drag("move")}
        >
          {(["nw", "ne", "sw", "se"] as const).map((corner) => (
            <span key={corner} className={`xot-crop__handle xot-crop__handle--${corner}`} onPointerDown={drag(corner)} />
          ))}
        </div>
      </div>
      <div className="xot-modal__actions">
        <button type="button" className="xot-btn" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="xot-btn xot-btn--primary" disabled={busy || !src} onClick={() => void apply()}>
          Recortar
        </button>
      </div>
    </Modal>
  );
}

/**
 * Image toolbar: on hover, inside the image's top-right corner.
 * Alignment, caption, download, original and "…" (replace, delete).
 */
function ImageToolbar() {
  const editor = useBlockNoteEditor() as unknown as XotEditor;
  const [target, setTarget] = useState<{ id: string; img: HTMLElement } | null>(null);
  const [menu, setMenu] = useState<{ kind: "align" | "caption" | "more" | "alt" | "link"; anchor: HTMLElement } | null>(null);
  const [caption, setCaption] = useState("");
  const [cropping, setCropping] = useState<{ id: string; url: string } | null>(null);
  const [, reposition] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const menuOpen = useRef(false);
  menuOpen.current = !!menu;

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (menuOpen.current || !(e.target instanceof Element) || barRef.current?.contains(e.target)) return;
      const content = e.target.closest<HTMLElement>('.bn-block-content[data-content-type="image"]');
      const img = content?.querySelector<HTMLElement>(".bn-visual-media");
      const id = content?.closest<HTMLElement>(".bn-block[data-id]")?.dataset.id;
      // Over the picture (or its resize handles), not its caption.
      const over = !!img?.parentElement?.contains(e.target) && !!editor.domElement?.contains(img);
      setTarget((t) => (over && id && img ? (t?.id === id ? t : { id, img }) : null));
    };
    const onScroll = () => reposition((n) => n + 1);
    // A double click shows the picture full screen; a click on a linked one opens its link.
    const imageAt = (e: MouseEvent) => {
      const content = e.target instanceof Element ? e.target.closest<HTMLElement>('.bn-block-content[data-content-type="image"]') : null;
      const img = content?.querySelector<HTMLElement>(".bn-visual-media");
      const id = content?.closest<HTMLElement>(".bn-block[data-id]")?.dataset.id;
      // On the picture (or its resize handles), not its caption.
      if (!img || !id || !img.parentElement?.contains(e.target as Node) || img.closest(".bn-editor") !== editor.domElement) return null;
      return editor.getBlock(id) as { props: ImageProps } | undefined;
    };
    // Selecting the image on the first click redraws it, so the browser sends no dblclick: two clicks are timed here.
    let last = { url: "", at: 0 };
    const onClick = (e: MouseEvent) => {
      const b = imageAt(e);
      if (b && b.props.url === last.url && e.timeStamp - last.at < 450) {
        last = { url: "", at: 0 };
        void openImageViewer(b.props.url, b.props.name);
        return;
      }
      last = { url: b?.props.url ?? "", at: e.timeStamp };
      const href = b?.props.href;
      if (!href) return;
      e.preventDefault();
      const route = linkedPage(href);
      if (route) window.location.hash = `/${route}`;
      else window.open(/^[a-z][\w+.-]*:/i.test(href) ? href : `https://${href}`, "_blank", "noopener");
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("click", onClick);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("click", onClick);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [editor]);

  const crop =
    cropping &&
    createPortal(
      <ImageCrop
        url={cropping.url}
        onClose={() => setCropping(null)}
        onDone={(url) => {
          if (editor.getBlock(cropping.id)) editor.updateBlock(cropping.id, { props: { url } } as never);
          setCropping(null);
        }}
      />,
      document.body,
    );
  const block = target && (editor.getBlock(target.id) as { props: ImageProps } | undefined);
  if (!target || !block || !target.img.isConnected || !editor.isEditable) return crop || null;
  const props = block.props;
  const r = target.img.getBoundingClientRect();
  const update = (p: Partial<ImageProps>) => editor.updateBlock(target.id, { props: p } as never);
  const close = () => setMenu(null);
  const open = (kind: "align" | "caption" | "more" | "alt" | "link") => (e: React.MouseEvent<HTMLButtonElement>) => {
    if (kind === "caption") setCaption(props.caption);
    if (kind === "alt") setCaption(props.name);
    if (kind === "link") setCaption(props.href);
    setMenu({ kind, anchor: e.currentTarget });
  };
  const download = async () => {
    const a = document.createElement("a");
    a.href = await resolveFileUrl(props.url);
    a.download = "";
    a.click();
  };
  const AlignIcon = { center: TextAlignCenter, right: TextAlignEnd }[props.textAlignment] ?? TextAlignStart;
  const alignments = [
    ["left", "Izquierda", TextAlignStart],
    ["center", "Centro", TextAlignCenter],
    ["right", "Derecha", TextAlignEnd],
  ] as const;
  return createPortal(
    <div
      ref={barRef}
      className="xot-image-toolbar"
      style={{ top: r.top + 6, left: r.right - 6 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" data-tooltip="Alineación" aria-label="Alineación" onClick={open("align")}>
        <AlignIcon size={16} />
      </button>
      <button type="button" data-tooltip="Leyenda" aria-label="Leyenda" onClick={open("caption")}>
        <Captions size={16} />
      </button>
      <button type="button" data-tooltip="Descargar" aria-label="Descargar" onClick={download}>
        <Download size={16} />
      </button>
      <button type="button" data-tooltip="Pantalla completa" aria-label="Pantalla completa" onClick={() => void openImageViewer(props.url, props.name)}>
        <Maximize2 size={16} />
      </button>
      <button type="button" data-tooltip="Más acciones" aria-label="Más acciones" onClick={open("more")}>
        <Ellipsis size={16} />
      </button>
      {menu?.kind === "align" && (
        <Popover anchor={menu.anchor} onClose={close} width={180}>
          {alignments.map(([value, label, Icon]) => (
            <MenuItem
              key={value}
              icon={<Icon size={16} />}
              active={(props.textAlignment || "left") === value}
              onClick={() => {
                update({ textAlignment: value });
                close();
              }}
            >
              {label}
            </MenuItem>
          ))}
        </Popover>
      )}
      {menu?.kind === "caption" && (
        <Popover anchor={menu.anchor} onClose={close} width={280}>
          <form
            className="xot-image-caption"
            onSubmit={(e) => {
              e.preventDefault();
              update({ caption: caption.trim() });
              close();
            }}
          >
            <input
              className="field"
              autoFocus
              placeholder="Escribe una leyenda…"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </form>
        </Popover>
      )}
      {(menu?.kind === "alt" || menu?.kind === "link") && (
        <Popover anchor={menu.anchor} onClose={close} width={300} align="end">
          <form
            className="xot-image-caption"
            onSubmit={(e) => {
              e.preventDefault();
              update(menu.kind === "alt" ? { name: caption.trim() } : { href: caption.trim() });
              close();
            }}
          >
            <input
              className="field"
              autoFocus
              aria-label={menu.kind === "alt" ? "Texto alternativo" : "Enlace"}
              placeholder={menu.kind === "alt" ? "Describe la imagen…" : "Pega un enlace…"}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </form>
        </Popover>
      )}
      {menu?.kind === "more" && (
        <Popover anchor={menu.anchor} onClose={close} width={220} align="end">
          <MenuItem
            icon={<Crop size={16} />}
            onClick={() => {
              close();
              setCropping({ id: target.id, url: props.url });
            }}
          >
            Recortar
          </MenuItem>
          <MenuItem icon={<Type size={16} />} onClick={() => {
              setCaption(props.name);
              setMenu({ kind: "alt", anchor: menu.anchor });
            }}>
            Texto alternativo
          </MenuItem>
          <MenuItem icon={<Link size={16} />} onClick={() => {
              setCaption(props.href);
              setMenu({ kind: "link", anchor: menu.anchor });
            }}>
            {props.href ? "Editar enlace" : "Agregar enlace"}
          </MenuItem>
          {props.href && (
            <MenuItem icon={<Link2Off size={16} />} onClick={() => (update({ href: "" }), close())}>
              Quitar enlace
            </MenuItem>
          )}
          <MenuItem icon={<ExternalLink size={16} />} onClick={async () => (close(), window.open(await resolveFileUrl(props.url), "_blank", "noopener"))}>
            Ver original
          </MenuItem>
          <MenuItem
            icon={<Repeat size={16} />}
            onClick={() => {
              close();
              editor.getExtension(FilePanelExtension)?.showMenu(target.id);
            }}
          >
            Reemplazar
          </MenuItem>
          <MenuItem
            icon={<Trash2 size={16} />}
            danger
            onClick={() => {
              close();
              setTarget(null);
              editor.removeBlocks([target.id]);
            }}
          >
            Eliminar
          </MenuItem>
        </Popover>
      )}
      {crop}
    </div>,
    document.body,
  );
}

const RECENT_SLASH_KEY = "xotion:recent-slash";

/** The slash menu's items used last, most recent first (this device only). */
function recentSlashItems(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_SLASH_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((id) => typeof id === "string").slice(0, 4) : [];
  } catch {
    return [];
  }
}

function rememberSlashItem(id: string) {
  try {
    localStorage.setItem(RECENT_SLASH_KEY, JSON.stringify([id, ...recentSlashItems().filter((x) => x !== id)].slice(0, 4)));
  } catch {
    // Private mode: nothing is remembered.
  }
}

/** While "/" waits for a query, the line reads "Escribe para filtrar…" (styles.css). */
function SlashFilterHint() {
  const editor = useBlockNoteEditor();
  const waiting = useExtensionState(SuggestionMenu, {
    editor,
    selector: (s) => !!s?.show && (s as { triggerCharacter?: string }).triggerCharacter === "/" && !s.query,
  });
  useEffect(() => {
    const root = editor.domElement?.closest(".bn-container");
    root?.toggleAttribute("data-slash-waiting", waiting);
    return () => root?.removeAttribute("data-slash-waiting");
  }, [editor, waiting]);
  return null;
}

/** Slash menu layout: groups and order, with each block's Markdown shortcut on the right. */
const SLASH_LAYOUT: [group: string, items: [id: string, hint?: string][]][] = [
  [
    "Bloques básicos",
    [
      ["paragraph"],
      ["heading", "#"],
      ["heading_2", "##"],
      ["heading_3", "###"],
      ["heading_4", "####"],
      ["bullet_list", "-"],
      ["numbered_list", "1."],
      ["check_list", "[]"],
      ["toggle_list", ">"],
      ["page"],
      ["callout"],
      ["quote", '"'],
      ["table"],
      ["divider", "---"],
      ["link_to_page"],
    ],
  ],
  ["Contenido multimedia", [["image"], ["video"], ["audio"], ["code_block", "```"], ["file"], ["bookmark"], ["embed"], ["pdf"]]],
  [
    "Base de datos",
    [
      ["database_inline"],
      ["database_page"],
      ["view_table"],
      ["view_board"],
      ["view_gallery"],
      ["view_list"],
      ["view_calendar"],
      ["view_timeline"],
      ["view_chart"],
      ["view_form"],
      ["view_map"],
      ["linked_view"],
    ],
  ],
  [
    "Bloques avanzados",
    [
      ["table_of_contents"],
      ["equation"],
      ["button"],
      ["breadcrumb"],
      ["synced"],
      ["tabs"],
      ["toggle_heading"],
      ["toggle_heading_2"],
      ["toggle_heading_3"],
      ["toggle_heading_4"],
      ["columns_2"],
      ["columns_3"],
      ["columns_4"],
      ["columns_5"],
    ],
  ],
  ["En línea", [["mention_page", "@"], ["date_mention"], ["emoji", ":"], ["inline_equation"]]],
];

type PMNode = {
  type: { name: string };
  attrs: Record<string, unknown>;
  firstChild: PMNode | null;
  isTextblock: boolean;
  nodeSize: number;
  marks: { type: { name: string }; attrs: Record<string, unknown> }[];
  content: { size: number };
  forEach: (fn: (child: PMNode, offset: number) => void) => void;
};

/** Where each inline comment's mark is: block id and offsets in its text. */
function commentAnchors(editor: XotEditor): Map<string, CommentAnchor> {
  const out = new Map<string, CommentAnchor>();
  (editor.prosemirrorState.doc as unknown as { descendants: (fn: (n: PMNode) => boolean) => void }).descendants((node) => {
    if (node.type.name !== "blockContainer") return true;
    const content = node.firstChild;
    if (!content?.isTextblock) return true;
    const block = String(node.attrs.id);
    content.forEach((child, offset) => {
      const mark = child.marks.find((m) => m.type.name === "comment" && !m.attrs.orphan);
      if (!mark) return;
      const id = String(mark.attrs.threadId);
      const a = out.get(id);
      if (!a) out.set(id, { block, from: offset, to: offset + child.nodeSize });
      else if (a.block === block) {
        a.from = Math.min(a.from, offset);
        a.to = Math.max(a.to, offset + child.nodeSize);
      }
    });
    return true;
  });
  return out;
}

/** Puts the saved comment marks back on their text (BlockNote's saved blocks don't keep them). */
function restoreCommentMarks(editor: XotEditor, threads: StoredThread[]) {
  const view = editor.prosemirrorView;
  const markType = view?.state.schema.marks.comment;
  if (!view || !markType) return;
  const byBlock = new Map<string, StoredThread[]>();
  for (const t of threads) if (t.anchor && !t.resolved) byBlock.set(t.anchor.block, [...(byBlock.get(t.anchor.block) ?? []), t]);
  let tr = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "blockContainer") return true;
    const list = byBlock.get(String(node.attrs.id));
    const content = node.firstChild;
    if (!list || !content?.isTextblock) return true;
    // pos is before the block container; +2 is the start of its text.
    for (const t of list) {
      const to = Math.min(t.anchor!.to, content.content.size);
      if (t.anchor!.from < to) tr = tr.addMark(pos + 2 + t.anchor!.from, pos + 2 + to, markType.create({ threadId: t.id, orphan: false }));
    }
    return true;
  });
  if (tr.docChanged) view.dispatch(tr.setMeta("addToHistory", false));
}

/** Selects a whole block (the blue block selection): a node selection on its container. */
function selectBlock(editor: XotEditor, id: string) {
  let pos = -1;
  editor.prosemirrorState.doc.descendants((node, p) => {
    if (pos >= 0) return false;
    if (node.type.name !== "blockContainer" || node.attrs.id !== id) return true;
    pos = p;
    return false;
  });
  if (pos >= 0) editor._tiptapEditor.commands.setNodeSelection(pos);
}

/** The blocks of a multi-block selection (two or more), in order; null without one. */
function rangeBlocks(editor: XotEditor): AnyBlock[] | null {
  const range = blockRangeKey.getState(editor.prosemirrorState);
  if (!range || range.ids.length < 2) return null;
  const blocks = range.ids.map((id) => editor.getBlock(id)).filter(Boolean) as AnyBlock[];
  return blocks.length ? blocks : null;
}

/**
 * Selects the sibling blocks from `anchor` to `head`; a single block is the Esc selection.
 * `only` (⌘⇧+click) picks those siblings alone, not everything between.
 */
function selectBlockRange(editor: XotEditor, anchor: string, head: string, only?: string[]) {
  if (anchor === head && (!only || only.length < 2)) return selectBlock(editor, head);
  const parent = editor.getParentBlock(anchor);
  const list = (parent ? parent.children : editor.document) as AnyBlock[];
  const a = list.findIndex((b) => b.id === anchor);
  const h = list.findIndex((b) => b.id === head);
  if (a < 0 || h < 0) return;
  const ids = only
    ? list.filter((b) => only.includes(b.id)).map((b) => b.id)
    : list.slice(Math.min(a, h), Math.max(a, h) + 1).map((b) => b.id);
  const view = editor.prosemirrorView;
  let pos = -1;
  view.state.doc.descendants((node, p) => {
    if (pos >= 0) return false;
    if (!node.type.isInGroup("bnBlock") || node.attrs.id !== head) return true;
    pos = p;
    return false;
  });
  if (pos < 0) return;
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)).setMeta(blockRangeKey, { anchor, head, ids }));
}

const clearBlockRange = (editor: XotEditor) => {
  if (blockRangeKey.getState(editor.prosemirrorState)) editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.setMeta(blockRangeKey, null));
};

/**
 * A copy left by ⌥+drag keeps its blocks' ids (BlockNote only renews ids repeated inside the dropped
 * range): the blocks in `copied` (the drop's range) get new ones, so the originals keep theirs.
 */
function renewCopiedIds(editor: XotEditor, copied: { from: number; to: number }) {
  const view = editor.prosemirrorView;
  const seen = new Map<string, number[]>();
  view.state.doc.descendants((node, pos) => {
    const id = node.type.isInGroup("bnBlock") ? String(node.attrs.id ?? "") : "";
    if (id) seen.set(id, [...(seen.get(id) ?? []), pos]);
    return true;
  });
  const tr = view.state.tr;
  for (const list of seen.values()) {
    if (list.length < 2) continue;
    const inCopy = (p: number) => p >= copied.from && p < copied.to;
    const keep = list.find((p) => !inCopy(p)) ?? list[0];
    for (const p of list) {
      const node = tr.doc.nodeAt(p);
      if (p !== keep && node) tr.setNodeMarkup(p, undefined, { ...node.attrs, id: uuid() });
    }
  }
  if (tr.steps.length) view.dispatch(tr);
}

/** Removes blocks, then edits the one above (or below) them. */
function removeSelectedBlocks(editor: XotEditor, blocks: AnyBlock[]) {
  const prev = editor.getPrevBlock(blocks[0].id);
  const next = editor.getNextBlock(blocks[blocks.length - 1].id);
  editor.removeBlocks(blocks.map((b) => b.id));
  const target = (prev ?? next) as AnyBlock | undefined;
  if (target && Array.isArray(target.content)) editor.setTextCursorPosition(target.id, prev ? "end" : "start");
  else if (target) selectBlock(editor, target.id);
}

/** ⌘↵: checks a to-do, or opens / closes a toggle (list or heading). True when it did. */
function toggleBlock(editor: XotEditor, block: AnyBlock) {
  const props = block.props as { checked?: boolean; isToggleable?: boolean };
  if (block.type === "checkListItem") {
    editor.updateBlock(block.id, { props: { checked: !props.checked } } as never);
    return true;
  }
  if (block.type === "toggleListItem" || (block.type === "heading" && props.isToggleable)) {
    document.querySelector<HTMLElement>(`.bn-block[data-id="${CSS.escape(block.id)}"] .bn-toggle-button`)?.click();
    return true;
  }
  return false;
}

/** ⌘/: the block's ⋮⋮ menu, as if its handle were clicked (BlockNote opens it only from the handle). */
function openBlockMenu(blockId: string) {
  const el = document.querySelector<HTMLElement>(`.bn-block[data-id="${CSS.escape(blockId)}"] > .bn-block-content`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + 8, clientY: r.top + Math.min(r.height, 30) / 2 }));
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".bn-side-menu [draggable='true']")?.click()),
  );
}

/** Starts an inline comment on the selection (or on the whole block when nothing is selected). */
function startComment(editor: XotEditor, target?: AnyBlock) {
  const comments = editor.getExtension(CommentsExtension);
  if (!comments) return;
  const block = target ?? (editor.getTextCursorPosition().block as AnyBlock);
  const sel = editor.prosemirrorState.selection;
  if (target || sel.empty) {
    if (!Array.isArray(block.content) || !textOf(block.content)) return;
    // The block's whole text (setSelection only spans two or more blocks).
    let range: { from: number; to: number } | null = null;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (range) return false;
      if (node.type.name !== "blockContainer" || node.attrs.id !== block.id) return true;
      const content = node.firstChild;
      if (content?.isTextblock) range = { from: pos + 2, to: pos + 2 + content.content.size };
      return false;
    });
    if (!range) return;
    editor._tiptapEditor.commands.setTextSelection(range);
  }
  editor.focus();
  comments.startPendingComment();
}

/**
 * The page a link points to, when it's one of the workspace's: Xot's own links
 * (Copiar enlace: xot://<id>, or this origin's #/<id>).
 */
function linkedPage(href: string): string | null {
  const xot = /^xot:\/*([\w-]+(?:\?[\w=&-]*)?)/i.exec(href)?.[1];
  if (xot) return xot;
  if (href.startsWith(location.origin) && href.includes("#/")) return href.split("#/")[1] || null;
  return null;
}

/** "+" opens the link menu only at the start of a word ("1+1" stays text). */
const atWordStart = (tr: Transaction) => {
  const $from = tr.selection.$from;
  return $from.parentOffset === 0 || /\s/.test($from.parent.textBetween($from.parentOffset - 1, $from.parentOffset));
};

/** The macOS app (Electron) has tabs. */
const DESKTOP = navigator.userAgent.includes("Electron");

/**
 * A link to a page of the workspace opens inside the app (⌘-click: in a
 * new tab of the macOS app, ⌘⇧-click: in a new window); only real web links go to the browser.
 */
function openLink(event: MouseEvent) {
  const href = (event.target as Element).closest("a")?.href ?? "";
  if (!href) return false;
  const route = linkedPage(href);
  const id = route?.split("?")[0];
  const external = () => void window.open(href, "_blank", "noopener");
  if (!route || !id) return external();
  void db.blocks.get(id).then((b) => {
    if (!b) external();
    else if ((event.metaKey || event.ctrlKey) && DESKTOP && !event.shiftKey) openInNewTab(route);
    else if (event.metaKey || event.ctrlKey) window.open(`${location.origin}${location.pathname}#/${route}`, "_blank");
    else window.location.hash = `/${route}`;
  });
}

/** BlockNote's default link schemes, plus xot:// (Copiar enlace in the macOS app). */
const isValidLink = (href: string) =>
  /^xot:/i.test(href) ||
  /^(?:(?:https?|ftps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z0-9+.-]+(?:[^a-z+.\-:]|$))/i.test(href.replace(/\s/g, ""));

/** An imported page's Markdown as blocks, with Xot's markers turned back into page links, inline databases and callouts. */
export function importedMarkdownBlocks(editor: XotEditor, markdown: string) {
  // "%%xotion:<id>%%" lines mark linked pages, "%%xotion-db:<id>%%" databases shown inline,
  // and "%%xotion-callout:<icon>:<color>%%" … "%%xotion-callout-end%%" a callout's body.
  type Parsed = ReturnType<typeof editor.tryParseMarkdownToBlocks>[number];
  const blocks: Parsed[] = [];
  let callout: Parsed | null = null;
  for (const b of editor.tryParseMarkdownToBlocks(markdown)) {
    const text = Array.isArray(b.content) && b.content.length === 1 && b.content[0].type === "text" ? b.content[0].text : "";
    const marker = b.type === "paragraph" ? text.trim() : "";
    const m = marker.match(/^%%xotion(-db)?:([0-9a-f-]{36})%%$/);
    const c = marker.match(/^%%xotion-callout:([^:]*):(?:(bg|fg)-([a-z]+))?%%$/);
    if (c) {
      let icon = "";
      try {
        icon = decodeURIComponent(c[1]);
      } catch {
        /* keep no icon */
      }
      const color = c[3] ? { [c[2] === "bg" ? "backgroundColor" : "textColor"]: c[3] } : {};
      callout = { type: "callout", props: { icon, ...color }, content: [], children: [] } as unknown as Parsed;
      blocks.push(callout);
      continue;
    }
    if (marker === "%%xotion-callout-end%%") {
      callout = null;
      continue;
    }
    const converted = (
      !m ? b : m[1] ? { type: "database", props: { blockId: m[2] } } : { type: "pageLink", props: { pageId: m[2] } }
    ) as Parsed;
    if (!callout) blocks.push(converted);
    // The first line of text sits beside the icon; the rest is nested inside the box.
    else if (!callout.children.length && !(callout.content as unknown[]).length && Array.isArray(b.content) && !m)
      callout.content = b.content as never;
    else callout.children.push(converted);
  }
  return blocks;
}

/** A page body shown read-only (a version in "Historial de versiones"). */
export function DocPreview({ pageId, content, markdown }: { pageId: string; content: unknown[]; markdown?: string }) {
  const theme = useColorScheme();
  const editor = useCreateBlockNote(
    {
      schema,
      dictionary,
      resolveFileUrl,
      initialContent: content.length ? (normalizeContent(content as StoredBlock[]) as never) : undefined,
    },
    [content],
  );
  // A version saved before the page was first opened holds its imported Markdown.
  useEffect(() => {
    if (content.length || !markdown) return;
    const blocks = importedMarkdownBlocks(editor, markdown);
    if (blocks.length) queueMicrotask(() => editor.replaceBlocks(editor.document, blocks));
  }, [editor, content, markdown]);
  return (
    <PageContext.Provider value={pageId}>
      <BlockNoteView editor={editor} theme={theme} editable={false} slashMenu={false} sideMenu={false} formattingToolbar={false} />
    </PageContext.Provider>
  );
}

/** Blocks without their ids, to put a saved version back into an open editor. */
export function restoreContent(editor: XotEditor, content: unknown[]) {
  editor.replaceBlocks(editor.document, stripIds(normalizeContent(content as StoredBlock[])) as never);
}

/**
 * "Restaurar bloque": one block of a saved version (with what's inside it) back into the open
 * editor: in place of the block it was, else next to the version's neighbours that are still
 * there, else inside its parent, else at the end. Resolves with the restored block's id.
 */
export function restoreVersionBlock(
  editor: XotEditor,
  stored: unknown & { id?: string },
  place: { before: string[]; after: string[]; parent?: string },
): string | null {
  const [block] = stripIds(normalizeContent([stored as StoredBlock]));
  if (!block) return null;
  const existing = stored.id ? editor.getBlock(stored.id) : undefined;
  let done: { id: string }[] | undefined;
  if (existing) done = editor.replaceBlocks([existing], [block as never]).insertedBlocks;
  else {
    const prev = [...place.before].reverse().find((id) => editor.getBlock(id));
    const next = place.after.find((id) => editor.getBlock(id));
    const parent = place.parent ? editor.getBlock(place.parent) : undefined;
    if (prev) done = editor.insertBlocks([block as never], prev, "after");
    else if (next) done = editor.insertBlocks([block as never], next, "before");
    else if (parent) {
      editor.updateBlock(parent, { children: [...parent.children, block] } as never);
      done = editor.getBlock(parent.id)?.children.slice(-1);
    } else {
      const last = editor.document[editor.document.length - 1];
      done = editor.insertBlocks([block as never], last, "after");
    }
  }
  return done?.[0]?.id ?? null;
}

type PastedLink = { url: string; at: number; blockId: string; alone: boolean; pageId?: string; anchor: HTMLElement };

/**
 * After pasting a link: keep it, or turn it into a page mention, a bookmark or an
 * embed (on an empty line). Typing on dismisses it.
 */
function PasteMenu({ editor, link, onClose }: { editor: XotEditor; link: PastedLink; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key !== "Escape" && onClose();
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const view = editor.prosemirrorView;
  // The pasted link: the text just before where the caret was left.
  const linkRange = () => {
    const from = link.at - link.url.length;
    return from >= 0 && view.state.doc.textBetween(from, link.at) === link.url ? { from, to: link.at } : null;
  };
  const toBlock = (type: "bookmark" | "embed") => {
    onClose();
    const target = editor.getBlock(link.blockId) ?? editor.getTextCursorPosition().block;
    editor.updateBlock(target, {
      type,
      props: type === "bookmark" ? { url: link.url, title: hostOf(link.url) } : { url: link.url },
      content: undefined,
    } as never);
    const next = editor.getNextBlock(target.id);
    const line = next && Array.isArray(next.content) ? next : editor.insertBlocks([{ type: "paragraph" } as never], target.id, "after")[0];
    editor.setTextCursorPosition(line.id, "start");
  };
  return (
    <Popover anchor={link.anchor} onClose={onClose} width={220}>
      <div className="menu paste-menu">
        <MenuItem onClick={onClose}>Descartar</MenuItem>
        <div className="menu-separator" />
        <MenuItem
          icon={<AtSign size={16} />}
          onClick={() => {
            onClose();
            const range = linkRange();
            const { mention, linkMention } = view.state.schema.nodes;
            const node = link.pageId
              ? mention?.create({ pageId: link.pageId, date: "", title: "", reminder: false, remind: "" })
              : linkMention?.create({ url: link.url });
            if (range && node) view.dispatch(view.state.tr.replaceWith(range.from, range.to, node));
          }}
        >
          {link.pageId ? "Mencionar página" : "Mención"}
        </MenuItem>
        <MenuItem icon={<Link size={16} />} onClick={onClose}>
          URL
        </MenuItem>
        {link.alone && (
          <>
            <MenuItem icon={<Bookmark size={16} />} onClick={() => toBlock("bookmark")}>
              Marcador web
            </MenuItem>
            <MenuItem icon={<AppWindow size={16} />} onClick={() => toBlock("embed")}>
              {isVideoLink(link.url) ? "Insertar vídeo" : "Insertar"}
            </MenuItem>
          </>
        )}
      </div>
    </Popover>
  );
}

export function Editor({
  block,
  onReady,
  onExitTop,
  onMergeTop,
}: {
  block: Block;
  onReady?: (editor: XotEditor | null) => void;
  /** ↑ / ← from the start of the first block (or Backspace in an empty one) goes back to the title. */
  onExitTop?: () => void;
  /** Backspace at the start of a first paragraph with text: that text joins the end of the title. */
  onMergeTop?: (text: string) => void;
}) {
  const exitTop = useRef(onExitTop);
  exitTop.current = onExitTop;
  const mergeTop = useRef(onMergeTop);
  mergeTop.current = onMergeTop;
  const theme = useColorScheme();
  // Inline comments: one thread store per page, over the threads table.
  const threadStore = useMemo(() => new LocalThreadStore(block.id), [block.id]);
  useEffect(() => {
    threadStore.connect();
    return () => threadStore.dispose();
  }, [threadStore]);
  // Paste menu, under the caret after a link is pasted.
  const [pasted, setPasted] = useState<PastedLink | null>(null);
  // Meanwhile only that menu shows: BlockNote's link toolbar (over the new link) waits for a hover.
  useEffect(() => {
    if (!pasted) return;
    document.body.setAttribute("data-paste-menu", "");
    return () => document.body.removeAttribute("data-paste-menu");
  }, [pasted]);
  const editor = useCreateBlockNote(
    {
      schema,
      dictionary,
      pasteHandler: ({ event, editor: ed, defaultPasteHandler }) => {
        const text = event.clipboardData?.getData("text/plain").trim() ?? "";
        const cur = ed.getTextCursorPosition().block as AnyBlock;
        if (
          cur.type === "codeBlock" ||
          event.clipboardData?.types.includes("blocknote/html") ||
          !/^(?:https?:\/\/|xot:)\S+$/i.test(text)
        )
          return defaultPasteHandler();
        const route = linkedPage(text);
        // A link copied from Xot ("Copiar enlace") is a page of this workspace: it becomes its mention.
        if (route && (/^xot:/i.test(text) || text.startsWith(location.origin))) {
          ed.insertInlineContent([{ type: "mention", props: { pageId: route.split("?")[0], date: "", title: "", reminder: false, remind: "" } }, " "] as never);
          return true;
        }
        const alone = cur.type === "paragraph" && Array.isArray(cur.content) && !cur.content.length;
        const handled = defaultPasteHandler();
        requestAnimationFrame(async () => {
          const view = ed.prosemirrorView;
          if (!view) return;
          const at = view.state.selection.from;
          const c = view.coordsAtPos(at);
          const page = route ? await db.blocks.get(route.split("?")[0]) : undefined;
          setPasted({
            url: text,
            at,
            blockId: cur.id,
            alone,
            pageId: page?.alive ? page.id : undefined,
            anchor: pointerAnchor({ clientX: c.left, clientY: c.bottom + 4 }),
          });
        });
        return handled;
      },
      // Drop line: 4px, in translucent blue.
      dropCursor: { ...multiColumnDropCursor, color: "rgba(35, 131, 226, 0.43)", width: 4 },
      links: { onClick: openLink, isValidLink },
      // Uploads (the file panel's "Subir", pasted and dropped files) stay on this device.
      uploadFile: storeFile,
      resolveFileUrl,
      // Simple table: header row / column, cell colors, merge and split.
      tables: { splitCells: true, cellBackgroundColor: true, cellTextColor: true, headers: true },
      initialContent: block.content?.length ? (normalizeContent(block.content as StoredBlock[]) as never) : undefined,
      extensions: [
        syntaxHighlighter,
        typography,
        blockRange,
        tabsGuard,
        CommentsExtension({ threadStore, resolveUsers: async (ids) => ids.map((id) => ({ ...LOCAL_USER, id })) }),
      ],
    },
    [block.id],
  );
  // Putting the comment marks back isn't an edit.
  const restoring = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void threadStore.ready.then((threads) => {
      if (!threads.some((t) => t.anchor && !t.resolved)) return;
      // After the view has mounted its content.
      window.setTimeout(() => {
        if (cancelled) return;
        restoring.current = true;
        try {
          restoreCommentMarks(editor, threads);
        } finally {
          restoring.current = false;
        }
      }, 50);
    });
    return () => {
      cancelled = true;
    };
  }, [editor, threadStore]);

  // Debounced save, flushed when leaving the page so a fresh subpage link
  // isn't lost when the slash menu navigates away.
  const timer = useRef<number | undefined>(undefined);
  const save = useMemo(
    () => () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      void updateBlock(block.id, { content: editor.document as unknown[] });
      threadStore.syncAnchors(commentAnchors(editor));
    },
    [editor, block.id, threadStore],
  );
  useEffect(
    () => () => {
      if (timer.current !== undefined) save();
    },
    [save],
  );
  useEffect(() => {
    onReady?.(editor);
    return () => onReady?.(null);
  }, [editor, onReady]);

  // "Mover a" (block menu or ⌘⇧P): a page picker under the block; the blocks go to the end of that page.
  const [moving, setMoving] = useState<{ blocks: AnyBlock[]; anchor: HTMLElement } | null>(null);
  const actions = useMemo(
    () => ({
      move: (blocks: AnyBlock[]) => {
        const el = blocks[0] && document.querySelector<HTMLElement>(`.bn-block[data-id="${CSS.escape(blocks[0].id)}"]`);
        if (el) setMoving({ blocks, anchor: el });
      },
      comment: (b: AnyBlock) => startComment(editor, b),
    }),
    [editor],
  );
  const moveTo = async (blocks: AnyBlock[], target: Block) => {
    setMoving(null);
    const copies = cloneBlocks(blocks);
    const fresh = await db.blocks.get(target.id);
    if (!fresh) return;
    // Pages not opened yet still hold Markdown; the blocks join it as Markdown.
    if (fresh.content?.length) await updateBlock(target.id, { content: [...fresh.content, ...(copies as unknown[])] });
    else if (fresh.content_markdown)
      await updateBlock(target.id, { content_markdown: `${fresh.content_markdown}\n\n${editor.blocksToMarkdownLossy(copies as never)}` });
    else await updateBlock(target.id, { content: copies as unknown[] });
    await handOff(blocks, block.id, target.id);
    editor.removeBlocks(blocks.map((b) => b.id));
    toast(`Movido a ${pageTitle(fresh)}`, { label: "Abrir", run: () => navigate(fresh.id) });
  };
  const moveToRef = useRef(moveTo);
  moveToRef.current = moveTo;

  // Block shortcuts, ahead of BlockNote's own (its ⌘⌥4-6 are headings 4-6; here they're lists).
  useEffect(() => {
    const TURN_INTO: Record<string, { type: string }> = {
      Digit4: { type: "checkListItem" },
      Digit5: { type: "bulletListItem" },
      Digit6: { type: "numberedListItem" },
      Digit7: { type: "toggleListItem" },
      Digit8: { type: "codeBlock" },
    };
    const onKey = (e: KeyboardEvent) => {
      const root = editor.domElement;
      if (!root || !(e.target instanceof Node) || !root.contains(e.target)) return;
      // Keys typed in a synced block's own editor are that editor's.
      if (e.target instanceof Element && e.target.closest(".bn-editor") !== root) return;
      // So are the ones typed in a database's own fields (a form's questions, a view's search…).
      if (e.target instanceof Element && e.target.closest(".db-embed, .tabs-strip__input")) return;
      const mod = e.metaKey || e.ctrlKey;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      // A multi-block selection (Shift+↑/↓, or a drag from the margin) is what the keys act on.
      const range = rangeBlocks(editor);
      const current = () => (range ?? editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block]) as AnyBlock[];
      // Esc selects the block being edited, in blue (menus close on Esc first);
      // the arrows then move that selection from block to block.
      const sel = editor.prosemirrorState.selection;
      const selected = "node" in sel && (sel.node as PMNode).type.name === "blockContainer" ? (sel.node as PMNode) : null;
      if (range && e.key === "Escape" && !mod && !e.altKey && !e.shiftKey) {
        stop();
        clearBlockRange(editor);
        return;
      }
      // Shift+↑/↓ grows (or shrinks) the selection by the block above or below.
      if ((selected || range) && e.shiftKey && !mod && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        stop();
        const r = range && blockRangeKey.getState(editor.prosemirrorState);
        const anchor = r ? r.anchor : String(selected!.attrs.id);
        const head = r ? r.head : anchor;
        const next = e.key === "ArrowUp" ? editor.getPrevBlock(head) : editor.getNextBlock(head);
        if (next) selectBlockRange(editor, anchor, next.id);
        return;
      }
      if (range && !mod && !e.altKey && !e.shiftKey && (e.key === "Backspace" || e.key === "Delete")) {
        stop();
        removeSelectedBlocks(editor, range);
        return;
      }
      // Tab / Shift+Tab nest or unnest the selected blocks, which stay selected.
      if ((selected || range) && e.key === "Tab" && !mod && !e.altKey) {
        stop();
        const blocks = range ?? [editor.getBlock(String(selected!.attrs.id)) as AnyBlock];
        const r = blockRangeKey.getState(editor.prosemirrorState);
        try {
          if (blocks.length > 1) editor.setSelection(blocks[0].id, blocks[blocks.length - 1].id);
          else editor.setTextCursorPosition(blocks[0].id, "start");
          // (A tab's own lines stay in it: out of it they'd sit between the tabs.)
          const inTab = blocks.some((b) => editor.getParentBlock(b.id)?.type === "tab");
          if (e.shiftKey ? editor.canUnnestBlock() && !inTab : editor.canNestBlock()) {
            if (e.shiftKey) editor.unnestBlock();
            else editor.nestBlock();
          }
        } catch {
          // A block without text at either end can't hold the text selection nesting needs.
        }
        if (range && r) selectBlockRange(editor, r.anchor, r.head);
        else selectBlock(editor, blocks[0].id);
        return;
      }
      // Shift+Tab in a code block takes one indent (2 spaces or a tab) off each selected line.
      if (
        !range &&
        !selected &&
        e.key === "Tab" &&
        e.shiftKey &&
        !mod &&
        !e.altKey &&
        editor.isEditable &&
        sel.$from.parent.type.name === "codeBlock" &&
        sel.$from.parent === sel.$to.parent
      ) {
        stop();
        const view = editor.prosemirrorView;
        if (!view) return;
        const text = sel.$from.parent.textContent;
        const base = sel.$from.start();
        const cuts: [number, number][] = [];
        for (let at = text.lastIndexOf("\n", sel.$from.parentOffset - 1) + 1; at <= sel.$to.parentOffset; ) {
          const n = text.startsWith("\t", at) ? 1 : text.startsWith("  ", at) ? 2 : text.startsWith(" ", at) ? 1 : 0;
          if (n) cuts.push([base + at, base + at + n]);
          const next = text.indexOf("\n", at);
          if (next < 0) break;
          at = next + 1;
        }
        if (!cuts.length) return;
        const tr = view.state.tr;
        for (const [from, to] of cuts.reverse()) tr.delete(from, to);
        view.dispatch(tr);
        return;
      }
      // The way back up: ↑ on the first line of the first block, ← at its start, or Backspace
      // in it when it's an empty line (which goes too, unless it's the only one) put the caret in the title.
      if (
        exitTop.current &&
        !range &&
        !selected &&
        !mod &&
        !e.altKey &&
        !e.shiftKey &&
        !e.isComposing &&
        (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "Backspace") &&
        sel.empty &&
        !editor.getExtension(SuggestionMenu)?.shown() &&
        !hasOpenPopover()
      ) {
        const first = editor.document[0] as AnyBlock | undefined;
        const cur = editor.getTextCursorPosition().block as AnyBlock;
        if (first && cur.id === first.id && Array.isArray(cur.content)) {
          const view = editor.prosemirrorView;
          const exit =
            e.key === "ArrowUp"
              ? !!view && view.endOfTextblock("up")
              : e.key === "ArrowLeft"
                ? sel.$from.parentOffset === 0
                : editor.isEditable && sel.$from.parentOffset === 0 && isEmptyParagraph(cur);
          if (exit) {
            stop();
            if (e.key === "Backspace" && editor.document.length > 1) editor.removeBlocks([cur.id]);
            exitTop.current();
            return;
          }
          // A plain first paragraph with text: Backspace at its start moves the text up into the title.
          if (
            e.key === "Backspace" &&
            mergeTop.current &&
            editor.isEditable &&
            sel.$from.parentOffset === 0 &&
            cur.type === "paragraph" &&
            !cur.children.length
          ) {
            stop();
            const text = sel.$from.parent.textContent;
            if (editor.document.length > 1) editor.removeBlocks([cur.id]);
            else editor.updateBlock(cur.id, { content: [] } as never);
            mergeTop.current(text);
            return;
          }
        }
      }
      // ⌘↵ checks the to-do or opens / closes the toggle being edited (or selected).
      if (mod && e.key === "Enter" && !e.shiftKey && !e.altKey) {
        const blocks = range ?? (selected ? [editor.getBlock(String(selected.attrs.id)) as AnyBlock] : [editor.getTextCursorPosition().block as AnyBlock]);
        let handled = false;
        for (const b of blocks) if (b && toggleBlock(editor, b)) handled = true;
        if (handled) stop();
        return;
      }
      if (e.key === "Escape" && !mod && !e.altKey && !e.shiftKey) {
        // A second Esc clears the selection (and lets a peek close on the next one).
        if (selected || hasOpenPopover() || document.querySelector(".bn-suggestion-menu, .bn-menu-dropdown, .bn-link-toolbar"))
          return;
        stop();
        selectBlock(editor, editor.getTextCursorPosition().block.id);
        return;
      }
      // Space on a selected image shows it full screen.
      if ("node" in sel && e.key === " " && !mod && !e.altKey && !e.shiftKey) {
        const b = (selected ? editor.getBlock(String(selected.attrs.id)) : editor.getTextCursorPosition().block) as
          | { type: string; props: ImageProps }
          | undefined;
        if (b?.type === "image" && b.props.url) {
          stop();
          void openImageViewer(b.props.url, b.props.name);
          return;
        }
      }
      // With a block selected: Enter edits it, Backspace/Delete removes it.
      if (selected && !mod && !e.altKey && !e.shiftKey && (e.key === "Enter" || e.key === "Backspace" || e.key === "Delete")) {
        const id = String(selected.attrs.id);
        const block = editor.getBlock(id) as AnyBlock | undefined;
        if (!block) return;
        stop();
        if (e.key === "Enter") {
          if (Array.isArray(block.content)) editor.setTextCursorPosition(id, "end");
          return;
        }
        removeSelectedBlocks(editor, [block]);
        return;
      }
      if (selected && (e.key === "ArrowUp" || e.key === "ArrowDown") && !mod && !e.altKey && !e.shiftKey) {
        stop();
        const id = String(selected.attrs.id);
        const next = e.key === "ArrowUp" ? editor.getPrevBlock(id) : editor.getNextBlock(id);
        if (next) selectBlock(editor, next.id);
        return;
      }
      // The keys at a "Pestañas" block's edges (see tabsKey).
      if (
        !mod &&
        !e.altKey &&
        !e.isComposing &&
        ["Backspace", "Delete", "Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) &&
        !editor.getExtension(SuggestionMenu)?.shown() &&
        !hasOpenPopover() &&
        tabsKey(editor, e)
      ) {
        stop();
        return;
      }
      // Enter on an empty list item nested in another list item un-indents it, keeping its kind.
      if (e.key === "Enter" && !mod && !e.altKey && !e.shiftKey && !e.isComposing && editor.isEditable) {
        const cur = editor.getTextCursorPosition().block as AnyBlock;
        const parent = editor.getParentBlock(cur.id) as AnyBlock | undefined;
        if (
          LIST_TYPES.has(cur.type) &&
          parent &&
          (LIST_TYPES.has(parent.type) || parent.type === "toggleListItem") &&
          editor.prosemirrorState.selection.empty &&
          !(cur.content as unknown[]).length &&
          !editor.getExtension(SuggestionMenu)?.shown() &&
          !hasOpenPopover() &&
          editor.canUnnestBlock()
        ) {
          stop();
          editor.unnestBlock();
          return;
        }
      }
      // Enter in a callout's text starts a line inside it (its first child), as in a container;
      // Enter on an empty line inside still unnests it out of the callout (BlockNote's default).
      if (e.key === "Enter" && !mod && !e.altKey && !e.shiftKey && !e.isComposing) {
        const cur = editor.getTextCursorPosition().block as AnyBlock;
        const sel = editor.prosemirrorState.selection;
        if (
          cur.type === "callout" &&
          sel.empty &&
          textOf(cur.content) !== "" &&
          !editor.getExtension(SuggestionMenu)?.shown() &&
          !hasOpenPopover()
        ) {
          stop();
          const [before, after] = splitInline(cur.content as InlineNode[], sel.$from.parentOffset);
          editor.updateBlock(cur.id, {
            content: before,
            children: [{ type: "paragraph", content: after }, ...cur.children],
          } as never);
          const line = (editor.getBlock(cur.id) as AnyBlock | undefined)?.children[0];
          if (line) editor.setTextCursorPosition(line.id, "start");
          return;
        }
      }
      // "---" becomes a divider on the third "-", with the caret on a new line below.
      if (e.key === "-" && !mod && !e.altKey) {
        const cur = editor.getTextCursorPosition().block as AnyBlock;
        const sel = editor.prosemirrorState.selection;
        if (cur.type === "paragraph" && sel.empty && sel.$from.parentOffset === 2 && textOf(cur.content) === "--") {
          stop();
          editor.transact(() => {
            editor.updateBlock(cur.id, { type: "divider", props: {} } as never);
            const [line] = editor.insertBlocks([{ type: "paragraph" }] as never, cur.id, "after");
            editor.setTextCursorPosition(line.id, "start");
          });
        }
        return;
      }
      // "```" becomes a code block on the third backtick.
      if (e.key === "`" && !mod && !e.altKey) {
        const cur = editor.getTextCursorPosition().block as AnyBlock;
        const sel = editor.prosemirrorState.selection;
        if (cur.type === "paragraph" && sel.empty && sel.$from.parentOffset === 2 && textOf(cur.content) === "``") {
          stop();
          editor.updateBlock(cur.id, { type: "codeBlock", props: { language: "text" }, content: [] } as never);
          editor.setTextCursorPosition(cur.id, "start");
          freshFence = cur.id;
        }
        return;
      }
      // "```" then "js" and Space (or Enter): that language, as a Markdown fence would give.
      if ((e.key === " " || e.key === "Enter") && freshFence && !mod && !e.altKey && !e.shiftKey && !e.isComposing) {
        const cur = editor.getTextCursorPosition().block as AnyBlock;
        const typed = cur.type === "codeBlock" && cur.id === freshFence ? textOf(cur.content).trim() : "";
        freshFence = "";
        const language = codeLanguage(typed);
        if (/^\S+$/.test(typed) && (language !== "text" || /^(text|txt|plain)$/i.test(typed))) {
          stop();
          editor.updateBlock(cur.id, { props: { language }, content: [] } as never);
          editor.setTextCursorPosition(cur.id, "start");
          return;
        }
      }
      // "> " starts a toggle list and '" ' a quote (BlockNote makes "> " a quote); "```js " a code block in that language.
      if (e.key === " " && !mod && !e.altKey) {
        const cur = editor.getTextCursorPosition().block as AnyBlock;
        const sel = editor.prosemirrorState.selection;
        const text = textOf(cur.content);
        const fence = /^```(\S*)$/.exec(text);
        // "a. " and "i. " start a numbered list too, as "1. " does (the lettered and roman markers).
        if (cur.type === "paragraph" && sel.empty && /^[aAiI]\.$/.test(text) && sel.$from.parentOffset === 2) {
          stop();
          const listFormat = /^[aA]/.test(text) ? "letters" : "roman";
          editor.updateBlock(cur.id, { type: "numberedListItem", props: { listFormat }, content: [] } as never);
          editor.setTextCursorPosition(cur.id, "start");
        } else if (cur.type === "paragraph" && sel.empty && fence && sel.$from.parentOffset === text.length) {
          stop();
          editor.updateBlock(cur.id, { type: "codeBlock", props: { language: codeLanguage(fence[1]) }, content: [] } as never);
          editor.setTextCursorPosition(cur.id, "start");
        } else if (
          TEXT_SHORTCUT_TYPES.has(cur.type) &&
          sel.empty &&
          sel.$from.parentOffset === 1 &&
          (text[0] === ">" || text[0] === '"') &&
          (cur.content as InlineNode[])[0]?.type === "text"
        ) {
          // In any text block, keeping the rest of the line; a heading becomes a toggle heading.
          stop();
          const [first, ...others] = cur.content as InlineNode[];
          const rest = first.text!.length > 1 ? [{ ...first, text: first.text!.slice(1) }, ...others] : others;
          const update =
            text[0] === '"'
              ? { type: "quote", props: {} }
              : cur.type === "heading"
                ? { type: "heading", props: { isToggleable: true } }
                : { type: "toggleListItem", props: {} };
          editor.updateBlock(cur.id, { ...update, content: rest } as never);
          editor.setTextCursorPosition(cur.id, "start");
        }
        return;
      }
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (e.altKey && !e.shiftKey) {
        if (TURN_INTO[e.code]) {
          stop();
          editor.transact(() => {
            for (const b of current()) if (Array.isArray(b.content)) editor.updateBlock(b.id, TURN_INTO[e.code] as never);
          });
        } else if (e.code === "Digit9") {
          stop();
          turnIntoPage(editor, current()[0], block.id);
        } else if (e.code === "KeyL") {
          stop();
          void copyLink(`${block.id}?b=${current()[0].id}`);
        } else if (e.code === "KeyT") {
          // ⌘⌥T: opens every toggle on the page, or closes them all when they're all open.
          stop();
          const toggles = [...root.querySelectorAll<HTMLElement>(".bn-toggle-button")].filter((el) => el.closest(".bn-editor") === root);
          const isOpen = (el: HTMLElement) => el.getAttribute("aria-expanded") === "true";
          const allOpen = toggles.every(isOpen);
          for (const el of toggles) if (isOpen(el) === allOpen) el.click();
        }
        return;
      }
      if (e.shiftKey) {
        if (key === "p") {
          stop();
          actions.move(current());
        } else if (key === "m") {
          stop();
          startComment(editor);
        } else if (key === "e") {
          // ⌘⇧E: the selected text becomes an inline equation (an empty one opens its editor).
          stop();
          selectionToEquation(editor);
        } else if (key === "h") {
          // ⌘⇧H: the last text or background color used, on the selected text (or the blocks).
          stop();
          const c = lastColor();
          if (!c || !editor.isEditable) return;
          const sel = editor.prosemirrorState.selection;
          if (!sel.empty && !("node" in sel)) editor.addStyles({ [c.kind]: c.value } as never);
          else
            editor.transact(() => {
              for (const b of current()) if (c.kind in b.props) editor.updateBlock(b.id, { props: { [c.kind]: c.value } } as never);
            });
        }
        return;
      }
      // ⌘D / ⌘R in a simple table fill down / right, not duplicate or reload.
      if ((key === "d" || key === "r") && !range && editor.isEditable && fillTableCells(editor, key === "d" ? "down" : "right")) {
        stop();
        return;
      }
      if (key === "d") {
        // ⌘D in the text duplicates the block (outside it, PageView duplicates the page).
        stop();
        duplicateBlocks(editor, current(), block.id);
      } else if (key === "e") {
        stop();
        editor.toggleStyles({ code: true } as never);
      } else if (e.code === "Slash") {
        stop();
        openBlockMenu(current()[0].id);
      }
    };
    // ⌘C / ⌘X on a multi-block selection copy all of its blocks (the node selection holds only one).
    const onCopy = (e: ClipboardEvent) => {
      const root = editor.domElement;
      const blocks = rangeBlocks(editor);
      if (!root || !blocks || !e.clipboardData || !(document.activeElement && root.contains(document.activeElement))) return;
      const ids = new Set(blocks.map((b) => b.id));
      const nodes: ProseNode[] = [];
      editor.prosemirrorState.doc.descendants((node) => {
        if (!node.type.isInGroup("bnBlock") || !ids.has(String(node.attrs.id))) return true;
        nodes.push(node);
        return false;
      });
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData.clearData();
      // As BlockNote's own copy: its HTML (pasted back as the same blocks), plus HTML and Markdown for other apps.
      e.clipboardData.setData("blocknote/html", editor.prosemirrorView.serializeForClipboard(new Slice(Fragment.from(nodes), 0, 0)).dom.innerHTML);
      e.clipboardData.setData("text/html", editor.blocksToHTMLLossy(blocks as never));
      e.clipboardData.setData("text/plain", editor.blocksToMarkdownLossy(blocks as never));
      if (e.type === "cut" && editor.isEditable) removeSelectedBlocks(editor, blocks);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("copy", onCopy, true);
    window.addEventListener("cut", onCopy, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("copy", onCopy, true);
      window.removeEventListener("cut", onCopy, true);
    };
  }, [editor, block.id, actions]);

  // A drag from the page margin: a blue box, and every top-level block it touches is selected.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const root = editor.domElement;
      const target = e.target as Element;
      if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || !root || !editor.isEditable) return;
      const scroller = root.closest<HTMLElement>(".scroller");
      if (!scroller || !(target instanceof Element) || !scroller.contains(target)) return;
      // From the page's margins, the space under the text, or the editor's gutters; never from a block's content.
      const inEditor = root.contains(target);
      if (
        inEditor
          ? !!target.closest(".bn-block-content, .bn-trailing-block, .bn-block-column-list")
          : !(target === scroller || target.matches(".page, .page__editor"))
      )
        return;
      // Outside the editor the press would start a text selection over the page's chrome.
      if (!inEditor) e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, scroll: scroller?.scrollTop ?? 0 };
      let box: HTMLDivElement | null = null;
      let last = "";
      const onMove = (ev: MouseEvent) => {
        if (!box) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
          box = document.createElement("div");
          box.className = "xot-select-box";
          document.body.append(box);
          document.body.classList.add("xot-selecting");
          window.getSelection()?.removeAllRanges();
        }
        ev.preventDefault();
        // Near the window's top or bottom edge the page scrolls, and the box grows with it.
        if (scroller) {
          const r = scroller.getBoundingClientRect();
          if (ev.clientY > r.bottom - 32) scroller.scrollTop += 16;
          else if (ev.clientY < r.top + 32) scroller.scrollTop -= 16;
        }
        const y0 = start.y - ((scroller?.scrollTop ?? 0) - start.scroll);
        const top = Math.min(y0, ev.clientY);
        const bottom = Math.max(y0, ev.clientY);
        const left = Math.min(start.x, ev.clientX);
        Object.assign(box.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${Math.max(start.x, ev.clientX) - left}px`,
          height: `${bottom - top}px`,
        });
        const hits = [...root.querySelectorAll<HTMLElement>(":scope > .bn-block-group > [data-id]")].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && r.bottom > top && r.top < bottom;
        });
        const ids = hits.map((el) => el.dataset.id!);
        const key = ids.join();
        if (key === last) return;
        last = key;
        if (!ids.length) return clearBlockRange(editor);
        // The anchor is the block nearest where the drag started.
        const up = ev.clientY < y0;
        selectBlockRange(editor, up ? ids[ids.length - 1] : ids[0], up ? ids[0] : ids[ids.length - 1]);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        document.body.classList.remove("xot-selecting");
        if (box) {
          box.remove();
          if (last) editor.prosemirrorView.focus();
        } else if (!inEditor) {
          clearBlockRange(editor);
          // A click in the blank space under the text puts the caret on an empty last line
          // (made when the page doesn't end in one). The press held still, so the page didn't scroll.
          const group = root.querySelector(":scope > .bn-block-group");
          const lastBlock = editor.document.at(-1);
          if (!group || !lastBlock || group.getBoundingClientRect().bottom > start.y) return;
          const emptyLine =
            lastBlock.type === "paragraph" && Array.isArray(lastBlock.content) && !lastBlock.content.length && !lastBlock.children.length;
          if (emptyLine) editor.setTextCursorPosition(lastBlock, "end");
          else {
            const [line] = editor.insertBlocks([{ type: "paragraph" }], lastBlock, "after");
            editor.setTextCursorPosition(line, "end");
          }
          editor.focus();
        }
      };
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editor]);

  // Shift+click takes the block selection to the clicked block; ⌘⇧+click adds or takes out one block.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const root = editor.domElement;
      if (e.button !== 0 || !e.shiftKey || e.altKey || !root || !(e.target instanceof Element)) return;
      const el = e.target.closest<HTMLElement>(".bn-block[data-id]");
      if (!el || el.closest(".bn-editor") !== root) return;
      const toggle = e.metaKey || e.ctrlKey;
      const state = editor.prosemirrorState;
      const sel = state.selection;
      const node = "node" in sel && (sel.node as PMNode).type.name === "blockContainer" ? (sel.node as PMNode) : null;
      const range = blockRangeKey.getState(state);
      const ids = range && range.ids.length > 1 ? range.ids : node ? [String(node.attrs.id)] : [];
      // While editing text, Shift+click selects text (the browser's); ⌘⇧+click starts a block selection.
      if (!ids.length && !toggle) return;
      // The clicked block at the selection's level (a block nested deeper counts as its ancestor there).
      const parentOf = (id: string) => editor.getParentBlock(id)?.id ?? null;
      const level = ids.length ? parentOf(ids[0]) : null;
      let target: string | null = el.dataset.id!;
      if (ids.length) while (target && parentOf(target) !== level) target = parentOf(target);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      editor.prosemirrorView.focus();
      if (!toggle) return selectBlockRange(editor, range && range.ids.length > 1 ? range.anchor : ids[0], target);
      const next = ids.includes(target) ? ids.filter((id) => id !== target) : [...ids, target];
      if (!next.length) return clearBlockRange(editor);
      const head = next.includes(target) ? target : next[next.length - 1];
      selectBlockRange(editor, next[0], head, next);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [editor]);

  // Blocks dragged onto a page in the sidebar move to the end of that page.
  useEffect(() => {
    const onDropOnPage = (e: Event) => {
      const target = (e as CustomEvent<string>).detail;
      const blocks = draggedBlocks.filter((b) => editor.getBlock(b.id));
      if (!blocks.length || target === block.id || !editor.isEditable) return;
      draggedBlocks = [];
      void db.blocks.get(target).then((page) => {
        if (page?.alive && page.type === "page") void moveToRef.current(blocks, page);
      });
    };
    window.addEventListener(BLOCKS_TO_PAGE_EVENT, onDropOnPage);
    return () => window.removeEventListener(BLOCKS_TO_PAGE_EVENT, onDropOnPage);
  }, [editor, block.id]);

  // ⌥+drag (duplicate by dragging): ProseMirror leaves a copy; its blocks get ids of their own.
  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      const root = editor.domElement;
      if (!e.altKey || !root || !(e.target instanceof Node) || !root.contains(e.target)) return;
      window.setTimeout(() => {
        const { from, to } = editor.prosemirrorState.selection;
        renewCopiedIds(editor, { from, to });
      }, 0);
    };
    document.addEventListener("drop", onDrop);
    return () => document.removeEventListener("drop", onDrop);
  }, [editor]);

  // "Copiar vínculo al bloque" links to "#/<page>?b=<block>": scroll to that block.
  useEffect(() => {
    const target = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("b");
    if (!target) return;
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`.bn-block[data-id="${CSS.escape(target)}"]`);
      el?.scrollIntoView({ block: "center" });
    }, 300);
    return () => window.clearTimeout(t);
  }, [editor]);

  // Imported pages arrive as Markdown; convert once and keep the blocks.
  useEffect(() => {
    if (block.content?.length || !block.content_markdown) return;
    const markdown = block.content_markdown;
    let cancelled = false;
    void (async () => {
      const blocks = importedMarkdownBlocks(editor, markdown);
      // Subpages added before the page was first opened (sidebar "+", Importar, Mover a) get their
      // block at the end, as every subpage has one.
      const shown = linkIdsIn(blocks as AnyBlock[]);
      const children = await db.blocks.where("[parent_table+parent_id]").equals(["block", block.id]).toArray();
      for (const child of children.sort((a, b) => a.order - b.order))
        if (child.alive && (child.type === "page" || child.type === "collection_view_page") && !shown.has(child.id))
          blocks.push(linkBlockFor(child) as never);
      if (cancelled || !blocks.length) return;
      applyImported(blocks);
    })();
    return () => {
      cancelled = true;
    };
  }, [editor]);
  const applyImported = (blocks: ReturnType<typeof importedMarkdownBlocks>) => {
    // Outside React's render pass: replacing blocks renders page-link views synchronously.
    queueMicrotask(() => {
      quiet.current = true;
      try {
        editor.replaceBlocks(editor.document, blocks);
      } finally {
        quiet.current = false;
        links.current = linkIdsIn(editor.document as AnyBlock[]);
      }
      window.clearTimeout(timer.current);
      timer.current = undefined;
      // Not an edit: keep the last-edited time.
      void db.blocks.update(block.id, { content: editor.document as unknown[] });
    });
  };
  // A subpage and its block are one thing: deleting the block moves the page to the
  // trash (with "Deshacer"), and the block coming back (⌘Z, paste) brings the page back. Trashing or
  // restoring the page elsewhere (sidebar, menus) takes its block out or puts it back here.
  const links = useRef<Set<string> | null>(null);
  const quiet = useRef(false);
  const syncLinks = () => {
    const current = linkIdsIn(editor.document as AnyBlock[]);
    const before = links.current;
    links.current = current;
    if (!before || quiet.current || !editor.isEditable) return;
    const removed = [...before].filter((id) => !current.has(id));
    const added = [...current].filter((id) => !before.has(id));
    if (removed.length || added.length) void applyLinkChanges(removed, added);
  };
  const applyLinkChanges = async (removed: string[], added: string[]) => {
    const trashed: string[] = [];
    for (const id of removed) {
      if (handedOff.delete(id)) continue;
      const page = await db.blocks.get(id);
      if (!page?.alive || page.parent_table !== "block" || page.parent_id !== block.id) continue;
      await trashBlock(id);
      editorTrashed.add(id);
      trashed.push(id);
    }
    if (trashed.length)
      toast(trashed.length === 1 ? "Página movida a la papelera" : `${trashed.length} páginas movidas a la papelera`, {
        label: "Deshacer",
        run: () => void (trashed.length === 1 ? undoLast() : Promise.all(trashed.map(restoreBlock))),
      });
    for (const id of added) {
      const page = await db.blocks.get(id);
      if (!page || page.alive || page.parent_table !== "block") continue;
      // A block cut from another page brings its page along.
      if (page.parent_id !== block.id) {
        if (!editorTrashed.has(id)) continue;
        await updateBlock(id, { parent_id: block.id });
      }
      editorTrashed.delete(id);
      await restoreBlock(id);
    }
  };
  useEffect(() => {
    links.current = linkIdsIn(editor.document as AnyBlock[]);
    let disposed = false;
    const onAlive = async (e: Event) => {
      const { id, parentId, alive, at } = (e as CustomEvent<PageAliveDetail>).detail;
      if (parentId !== block.id) return;
      const page = alive && !linkIdsIn(editor.document as AnyBlock[]).has(id) ? await db.blocks.get(id) : undefined;
      const present = linkIdsIn(editor.document as AnyBlock[]).has(id);
      if (disposed || (alive && (present || !page))) return;
      quiet.current = true;
      try {
        if (!alive && present) {
          const ids: string[] = [];
          editor.forEachBlock((b) => {
            if (linkIdsIn([b as AnyBlock]).has(id) && !linkIdsIn((b as AnyBlock).children).has(id)) ids.push(b.id);
            return true;
          });
          editor.removeBlocks(ids);
        } else if (page && !present) {
          const link = [linkBlockFor(page)] as never;
          const doc = editor.document;
          const parent = at?.parent ? (editor.getBlock(at.parent) as AnyBlock | undefined) : undefined;
          if (at?.prev && editor.getBlock(at.prev)) editor.insertBlocks(link, at.prev, "after");
          else if (parent?.children.length) editor.insertBlocks(link, parent.children[0].id, "before");
          else if (parent) editor.updateBlock(parent.id, { children: link });
          else if (at && !at.prev && doc.length) editor.insertBlocks(link, doc[0].id, "before");
          else if (doc.length) editor.insertBlocks(link, doc[doc.length - 1].id, "after");
        }
      } catch {
        // The editor went away meanwhile.
      } finally {
        quiet.current = false;
        links.current = linkIdsIn(editor.document as AnyBlock[]);
      }
    };
    window.addEventListener(PAGE_ALIVE_EVENT, onAlive);
    return () => {
      disposed = true;
      window.removeEventListener(PAGE_ALIVE_EVENT, onAlive);
    };
  }, [editor, block.id]);

  const onChange = () => {
    if (restoring.current) return;
    syncLinks();
    syncListFormats(editor);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, 400);
  };

  const getItems = async (query: string) => {
    const insertChild = (kind: "page" | "database") => {
      const id = uuid();
      insertOrUpdateBlockForSlashMenu(editor, { type: "pageLink", props: { pageId: id } });
      save();
      const created =
        kind === "page" ? createPage("block", block.id, { id }) : createDatabase("block", block.id, { id });
      void created.then(() => navigate(id));
    };
    const custom: Record<string, DefaultReactSuggestionItem> = {
      page: {
        title: "Página",
        subtext: "Inserta una subpágina dentro de esta",
        aliases: ["page", "pagina", "subpagina"],
        icon: <FileText size={20} />,
        onItemClick: () => insertChild("page"),
      },
      database_inline: {
        title: "Base de datos: integrada",
        subtext: "Una base de datos nueva dentro de esta página",
        aliases: ["database", "inline", "db", "tabla", "tablero", "kanban", "en linea"],
        icon: <Table2 size={20} />,
        onItemClick: () => {
          const id = uuid();
          insertOrUpdateBlockForSlashMenu(editor, { type: "database", props: { blockId: id } });
          void createDatabase("block", block.id, { id, inline: true }).then(save);
        },
      },
      database_page: {
        title: "Base de datos: página completa",
        subtext: "Una subpágina con tabla, tablero, gráficos y más",
        aliases: ["database", "db", "pagina", "full"],
        icon: <Sheet size={20} />,
        onItemClick: () => insertChild("database"),
      },
      button: {
        title: "Botón",
        subtext: "Un clic añade una página a una base de datos",
        aliases: ["button", "boton", "accion"],
        icon: <MousePointerClick size={20} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "button", props: { label: "Nuevo" } });
          save();
        },
      },
      linked_view: {
        title: "Vista vinculada de la fuente de datos",
        subtext: "Muestra aquí una base de datos que ya existe",
        aliases: ["linked", "vinculada", "vista", "conectar"],
        icon: <Link2 size={20} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "database", props: { blockId: "" } });
          save();
        },
      },
      callout: {
        title: "Destacado",
        subtext: "Haz que el texto destaque",
        aliases: ["callout", "destacado", "nota", "aviso"],
        icon: <Lightbulb size={20} />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "callout", props: { icon: "💡", backgroundColor: "gray" } });
        },
      },
    };
    // "Vista de tabla", "Vista de tablero"…: an inline database showing that view.
    const databaseView = (type: ViewType, title: string, ...aliases: string[]): DefaultReactSuggestionItem => {
      const Icon = VIEW_ICONS[type];
      return {
        title,
        subtext: "Una base de datos nueva dentro de esta página",
        aliases: ["vista", "view", "base de datos", "database", ...aliases],
        icon: <Icon size={20} />,
        onItemClick: () => {
          const id = uuid();
          insertOrUpdateBlockForSlashMenu(editor, { type: "database", props: { blockId: id } });
          void createDatabaseView(block.id, type, id).then(save);
        },
      };
    };
    Object.assign(custom, {
      view_table: databaseView("table", "Vista de tabla", "tabla", "table"),
      view_board: databaseView("board", "Vista de tablero", "tablero", "board", "kanban"),
      view_gallery: databaseView("gallery", "Vista de galería", "galeria", "gallery"),
      view_list: databaseView("list", "Vista de lista", "lista", "list"),
      view_calendar: databaseView("calendar", "Vista de calendario", "calendario", "calendar"),
      view_timeline: databaseView("timeline", "Vista de cronología", "cronologia", "timeline", "gantt"),
      view_chart: databaseView("chart", "Vista de gráfico", "grafico", "chart", "grafica"),
      view_form: databaseView("form", "Formulario", "formulario", "form", "encuesta"),
      view_map: databaseView("map", "Vista de mapa", "mapa", "map", "lugar"),
    });
    const columns = (n: number): DefaultReactSuggestionItem => ({
      title: `${n} columnas`,
      subtext: `${n} columnas lado a lado`,
      aliases: ["columns", "columnas", "row", "fila"],
      icon: <Columns4 size={20} />,
      onItemClick: () => insertColumnList(editor, n),
    });
    Object.assign(custom, {
      link_to_page: {
        title: "Enlace a una página",
        subtext: "Enlaza una página que ya existe",
        aliases: ["link", "enlace", "vincular", "pagina"],
        icon: <CornerUpRight size={20} />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "pageLink", props: { pageId: "" } }),
      },
      bookmark: {
        title: "Marcador web",
        subtext: "Una tarjeta con un enlace web",
        aliases: ["bookmark", "marcador", "enlace", "url", "web"],
        icon: <Bookmark size={20} />,
        onItemClick: () => {
          newBookmark.pending = true;
          insertOrUpdateBlockForSlashMenu(editor, { type: "bookmark" });
        },
      },
      table_of_contents: {
        title: "Índice",
        subtext: "Los encabezados de esta página",
        aliases: ["toc", "table of contents", "indice", "contenido"],
        icon: <ListTree size={20} />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "tableOfContents" }),
      },
      breadcrumb: {
        title: "Ruta de navegación",
        subtext: "La ruta de esta página",
        aliases: ["breadcrumb", "ruta", "navegacion", "migas"],
        icon: <ChevronsRight size={20} />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "breadcrumb" }),
      },
      toggle_heading_4: {
        title: "Encabezado desplegable 4",
        subtext: "Encabezado menor que se puede plegar",
        aliases: ["toggle", "h4", "desplegable"],
        icon: <Heading4 size={20} />,
        onItemClick: () =>
          insertOrUpdateBlockForSlashMenu(editor, { type: "heading", props: { level: 4, isToggleable: true } } as never),
      },
      tabs: {
        title: "Pestañas",
        subtext: "Organiza el contenido en pestañas",
        aliases: ["tabs", "pestanas", "pestana", "tab"],
        icon: <PanelsTopLeft size={20} />,
        onItemClick: () => {
          const cur = editor.getTextCursorPosition().block as AnyBlock;
          const [tabs] = isEmptyParagraph(cur)
            ? editor.replaceBlocks([cur.id], [newTabs()] as never).insertedBlocks
            : editor.insertBlocks([newTabs()] as never, cur.id, "after");
          const line = (tabs as AnyBlock).children[0]?.children[0];
          if (line) editor.setTextCursorPosition(line.id, "start");
        },
      },
      synced: {
        title: "Bloque sincronizado",
        subtext: "El mismo contenido en varias páginas",
        aliases: ["synced", "sincronizado", "sync", "sincronizar"],
        icon: <RefreshCw size={20} />,
        onItemClick: async () => {
          const sourceId = uuid();
          await db.synced.put({ id: sourceId, content: [], updated_time: Date.now() });
          insertOrUpdateBlockForSlashMenu(editor, { type: "synced", props: { sourceId } });
        },
      },
      equation: {
        title: "Ecuación del bloque",
        subtext: "Muestra una fórmula matemática",
        aliases: ["equation", "ecuacion", "math", "latex", "tex", "formula"],
        icon: <Radical size={20} />,
        onItemClick: () => {
          newEquation.pending = true;
          insertOrUpdateBlockForSlashMenu(editor, { type: "equation", props: { latex: "" } });
        },
      },
      inline_equation: {
        title: "Ecuación en línea",
        subtext: "Una fórmula dentro del texto",
        aliases: ["inline equation", "ecuacion", "math", "latex", "tex", "en linea"],
        icon: <Sigma size={20} />,
        onItemClick: () => editor.insertInlineContent([{ type: "inlineEquation", props: { latex: "" } }, " "]),
      },
      columns_4: columns(4),
      columns_5: columns(5),
      mention_page: {
        title: "Mencionar una página",
        subtext: "Enlaza una página dentro del texto",
        aliases: ["mention", "mencionar", "pagina", "page", "@"],
        icon: <AtSign size={20} />,
        onItemClick: () =>
          editor.getExtension(SuggestionMenu)?.openSuggestionMenu("@", { deleteTriggerCharacter: true, ignoreQueryLength: true }),
      },
      date_mention: {
        title: "Fecha o recordatorio",
        subtext: "Una fecha dentro del texto",
        aliases: ["fecha", "date", "hoy", "today", "recordatorio", "reminder", "dia"],
        icon: <CalendarDays size={20} />,
        onItemClick: () => {
          editor.insertInlineContent([{ type: "mention", props: { pageId: "", date: dayOffset(0), title: "", reminder: false, remind: "" } }, " "]);
          // Its date picker opens right away.
          const view = editor.prosemirrorView;
          const pos = view.state.selection.from - 2;
          requestAnimationFrame(() => {
            const dom = view.nodeDOM(pos);
            const el = dom instanceof HTMLElement ? (dom.matches(".mention--date") ? dom : dom.querySelector(".mention--date")) : null;
            (el as HTMLElement | null)?.click();
          });
        },
      },
      embed: {
        title: "Insertar",
        subtext: "Una página web, un vídeo o un diseño en un marco",
        aliases: ["embed", "insertar", "incrustar", "iframe", "youtube", "figma", "video"],
        icon: <AppWindow size={20} />,
        onItemClick: () => {
          newEmbed.pending = true;
          insertOrUpdateBlockForSlashMenu(editor, { type: "embed" });
        },
      },
      pdf: {
        title: "PDF",
        subtext: "Un PDF de este dispositivo, para leerlo aquí",
        aliases: ["pdf", "documento"],
        icon: <FileType size={20} />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "pdf" }),
      },
    } satisfies Record<string, DefaultReactSuggestionItem>);
    const byId = new Map(Object.entries(custom));
    for (const item of getDefaultReactSlashMenuItems(editor)) byId.set((item as { key?: string }).key ?? item.title, item);
    getMultiColumnSlashMenuItems(editor).forEach((item, i) =>
      byId.set(`columns_${i + 2}`, { ...item, icon: i ? <Columns3 size={20} /> : <Columns2 size={20} /> }),
    );
    // Regrouped and reordered; BlockNote's own shortcut badges give way to the Markdown hints.
    // Each one used is remembered, for "Usados recientemente".
    const listed = new Map<string, DefaultReactSuggestionItem>();
    const items: DefaultReactSuggestionItem[] = SLASH_LAYOUT.flatMap(([group, entries]) =>
      entries.flatMap(([id, hint]) => {
        const item = byId.get(id);
        if (!item) return [];
        const entry = {
          ...item,
          group,
          badge: hint,
          onItemClick: () => {
            rememberSlashItem(id);
            item.onItemClick();
          },
        };
        listed.set(id, entry);
        return [entry];
      }),
    );
    // Typed only (not in the full list): the colors and the block actions, on the block being edited.
    const q = fold(query.trim());
    // The first group with nothing typed: the blocks last added from this menu (an invisible
    // suffix keeps their rows apart from the same items further down, BlockNote keys rows by title).
    if (!q)
      items.unshift(
        ...recentSlashItems().flatMap((id) => {
          const item = listed.get(id);
          return item ? [{ ...item, title: `${item.title}\u200b`, group: "Usados recientemente" } as DefaultReactSuggestionItem] : [];
        }),
      );
    const extra = q ? [...colorSlashItems(editor), ...actionSlashItems(editor, block.id, actions, /^(conv|turn)/.test(q))] : [];
    // Names that start with what's typed come first ("vid" → Video before Divisor); the sort is stable.
    const rank = (item: DefaultReactSuggestionItem) => {
      const title = fold(item.title);
      if (title.startsWith(q)) return 0;
      if (title.split(/[\s/-]+/).some((w) => w.startsWith(q))) return 1;
      if (item.aliases?.some((a) => fold(a).split(/[\s/-]+/).some((w) => w.startsWith(q)))) return 2;
      return 3;
    };
    const filtered = filterSuggestionItems([...items, ...extra], query);
    const ranked = q ? filtered.map((item, i) => ({ item, i, r: rank(item) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.item) : filtered;
    // Reordered across groups, the results are one flat list (a group's label would repeat).
    const found = ranked.some((item, i) => item !== filtered[i]) ? ranked.map((item) => ({ ...item, group: undefined })) : ranked;
    // The last row, under a separator (the empty group label): "Cerrar menú  esc", never filtered out.
    const close: DefaultReactSuggestionItem = { title: "Cerrar menú", badge: "esc", group: "", onItemClick: () => {} };
    return found.length ? [...found, close] : found;
  };

  // A trigger typed inside another menu's query ("@15/10/2026") is part of that query.
  const triggers = useMemo(() => {
    const free = () => !editor.getExtension(SuggestionMenu)?.shown();
    return { free, wordStart: (tr: Transaction) => free() && atWordStart(tr) };
  }, [editor]);

  // ":" and two letters: the matching emoji with their names, in the same list as the slash menu.
  const getEmojiItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const q = fold(query.trim());
    if (/\s/.test(query)) return [];
    const [data, custom] = await Promise.all([loadEmojis(), listCustomEmojis()]);
    // The workspace's own emoji first, by name (custom emoji).
    const own: DefaultReactSuggestionItem[] = custom
      .filter((c) => !q || c.name.split(/[-_]/).some((w) => w.startsWith(q)) || c.name.startsWith(q))
      .map((c) => ({
        title: c.name,
        icon: <img className="xot-emoji-item xot-emoji-item--custom" src={c.src} alt="" />,
        onItemClick: () => editor.insertInlineContent([{ type: "customEmoji", props: { name: c.name, src: c.src } }] as never),
      }));
    const words = (e: (typeof data.emojis)[string]) => [
      e.id,
      ...e.name.toLowerCase().split(/[\s_-]+/),
      ...e.keywords,
      ...(EMOJI_ES[e.id] ?? []).flatMap((w) => [fold(w), ...fold(w).split(" ")]),
    ];
    // The Spanish name that matched, shown as the row's title (Spanish picker).
    const spanish = (e: (typeof data.emojis)[string]) => (q ? EMOJI_ES[e.id]?.find((w) => fold(w).split(" ").some((p) => p.startsWith(q))) : undefined);
    // Opened from the slash menu ("Emoji") nothing is typed yet: the smileys, in order.
    const all = q ? Object.values(data.emojis) : data.categories[0].emojis.map((id) => data.emojis[id]);
    // The emoji named by what's typed first, then those whose name starts with it, then keywords.
    const rank = (e: (typeof data.emojis)[string]) => {
      const es = spanish(e);
      if (e.id === q || (es && fold(es) === q)) return 0;
      if (e.id.startsWith(q) || (es && fold(es).startsWith(q))) return 1;
      return es || e.name.toLowerCase().startsWith(q) ? 2 : 3;
    };
    // Ties: the shorter Spanish name first ("corazón" before "corazón roto").
    const length = (e: (typeof data.emojis)[string]) => spanish(e)?.length ?? 0;
    return [
      ...own,
      ...all
      .filter((e) => !q || words(e).some((w) => w.startsWith(q)))
      .sort((a, b) => rank(a) - rank(b) || length(a) - length(b))
      .slice(0, 50 - own.length)
      .map((e) => ({
        title: spanish(e) ?? e.name,
        icon: <span className="xot-emoji-item">{e.skins[0].native}</span>,
        onItemClick: () => editor.insertInlineContent(e.skins[0].native),
      })),
    ];
  };

  // "@": mention a date or a page.
  const getMentionItems = async (query: string) => {
    const insert = (props: { pageId?: string; date?: string; title?: string; reminder?: boolean }) => () =>
      editor.insertInlineContent([{ type: "mention", props: { pageId: "", date: "", title: "", reminder: false, remind: "", ...props } }, " "]);
    const q = fold(query.trim());
    const dateItem = (title: string, date: string, reminder = false): DefaultReactSuggestionItem => ({
      title,
      // Relative names ("Mañana") show the date they stand for.
      subtext: isDynamicDate(date)
        ? "Al usar la plantilla"
        : reminder || /^\d/.test(title)
          ? undefined
          : longDate.format(new Date(`${date.split("T")[0]}T00:00`)),
      group: "Fecha",
      icon: reminder ? <AlarmClock size={18} /> : <CalendarDays size={18} />,
      onItemClick: () => {
        // The browser asks for notifications when the first reminder is set.
        if (reminder) askNotificationPermission();
        insert({ date, reminder })();
      },
    });
    // "@recordar mañana 9am" ("@remind"): the date after the keyword, as a reminder first.
    const remind = /^(?:recordar|recuerdame|recordatorio|remind(?: me)?)(?: (.+))?$/.exec(q);
    const parsed = remind ? (remind[1] ? parseMentionDate(remind[1]) : null) : parseMentionDate(query);
    const dates: DefaultReactSuggestionItem[] = [];
    if (parsed && !remind && !["hoy", "manana", "ayer"].includes(q)) dates.push(dateItem(mentionDate(parsed), parsed));
    for (const d of [
      { title: "Hoy", days: 0 },
      { title: "Mañana", days: 1 },
      { title: "Ayer", days: -1 },
    ])
      if (!remind && (!q || fold(d.title).startsWith(q)))
        // In a database template they stay dynamic: the day each page is made from it.
        dates.push(dateItem(d.title, block.is_template ? `@today${d.days ? (d.days > 0 ? "+" : "") + d.days : ""}` : dayOffset(d.days)));
    if (block.is_template && !remind && (!q || "ahora".startsWith(q))) dates.push(dateItem("Ahora", "@now"));
    // "Recordar…": the date with a reminder (9:00 when no time was given).
    const remindAt = parsed
      ? parsed.includes("T") || !remind
        ? parsed
        : `${parsed}T09:00`
      : remind && remind[1]
        ? null
        : q && !"recordar".startsWith(q) && !remind
          ? null
          : `${dayOffset(0)}T09:00`;
    if (remindAt && (parsed || q)) {
      const item = dateItem(`Recordar ${mentionDate(remindAt).replace(/^(Hoy|Mañana|Ayer)/, (w) => w.toLowerCase())}`, remindAt, true);
      if (remind) dates.unshift(item);
      else dates.push(item);
    }
    if (remind && parsed) dates.push(dateItem(mentionDate(parsed), parsed));
    const pages = await pageItems(q, (p) => insert({ pageId: p.id })(), "Vincular a una página");
    // "Nueva página": a subpage of this one, mentioned here.
    if (query.trim())
      pages.push({
        title: `Nueva página «${query.trim()}»`,
        group: "Nueva página",
        icon: <FilePlus size={18} />,
        onItemClick: () => {
          const id = uuid();
          void createPage("block", block.id, { id, properties: { title: query.trim() } });
          insert({ pageId: id })();
        },
      });
    return parsed || (q && dates.length) ? [...dates, ...pages] : [...pages, ...dates];
  };

  // "+" and "[[": "Enlace a una página" (a link block on an empty line, a mention within text).
  const getLinkItems = async (query: string) => {
    const linkTo = (pageId: string) => {
      const cur = editor.getTextCursorPosition().block as AnyBlock;
      if (Array.isArray(cur.content) && cur.content.length)
        editor.insertInlineContent([{ type: "mention", props: { pageId, date: "", title: "", reminder: false, remind: "" } }, " "]);
      else insertOrUpdateBlockForSlashMenu(editor, { type: "pageLink", props: { pageId } });
      save();
    };
    const items = await pageItems(fold(query.trim()), (p) => linkTo(p.id), "Enlace a una página");
    const title = query.trim();
    items.push({
      title: title ? `Nueva subpágina «${title}»` : "Nueva subpágina",
      group: "Nueva página",
      icon: <FilePlus size={18} />,
      onItemClick: () => {
        const id = uuid();
        void createPage("block", block.id, { id, properties: { title } }).then(() => linkTo(id));
      },
    });
    return items;
  };

  return (
    <PageContext.Provider value={block.id}>
      <EditorActions.Provider value={actions}>
      <BlockNoteView
        editor={editor}
        theme={theme}
        editable={!block.format.locked && block.alive}
        slashMenu={false}
        sideMenu={false}
        formattingToolbar={false}
        emojiPicker={false}
        onChange={onChange}
      >
        <SideMenuController
          sideMenu={(props) => (
            // Tooltips on the block handles.
            <SideMenu {...props}>
              <AddBlockSlot />
              <span className="xot-side-btn" data-tooltip={"**Arrastra** para mover\n**Haz clic** o pulsa ⌘/ para abrir el menú"}>
                <BlockHandle />
              </span>
            </SideMenu>
          )}
          floatingUIOptions={{ useFloatingOptions: { middleware: [alignSideMenu] } }}
        />
        <FormattingToolbarController formattingToolbar={TextToolbar} />
        <LinkSearch />
        <SuggestionMenuController triggerCharacter="/" getItems={getItems} shouldOpen={triggers.free} />
        <SuggestionMenuController triggerCharacter="@" getItems={getMentionItems} shouldOpen={triggers.free} />
        <SuggestionMenuController triggerCharacter="+" getItems={getLinkItems} shouldOpen={triggers.wordStart} />
        <SuggestionMenuController triggerCharacter="[[" getItems={getLinkItems} shouldOpen={triggers.free} />
        <SuggestionMenuController triggerCharacter=":" getItems={getEmojiItems} shouldOpen={triggers.wordStart} minQueryLength={2} />
        <SlashFilterHint />
        <ImageToolbar />
        <CodeCaptionPrompt />
        <CodeLanguagePicker />
      </BlockNoteView>
      </EditorActions.Provider>
      {pasted && <PasteMenu editor={editor} link={pasted} onClose={() => setPasted(null)} />}
      {moving && (
        <Popover anchor={moving.anchor} onClose={() => setMoving(null)} width={320}>
          <PagePicker
            placeholder="Mover bloque a…"
            exclude={[block.id]}
            pagesOnly
            onPick={(page) => void moveTo(moving.blocks, page)}
          />
        </Popover>
      )}
    </PageContext.Provider>
  );
}
