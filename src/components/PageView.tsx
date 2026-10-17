import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ALargeSmall,
  Archive,
  ArchiveRestore,
  BadgeCheck,
  BookOpen,
  ClipboardCopy,
  Clock,
  CopyPlus,
  CornerUpRight,
  Ellipsis,
  FileDown,
  FileUp,
  History,
  House,
  LayoutTemplate,
  Link,
  Lock,
  MessageSquareText,
  MoveHorizontal,
  PanelsTopLeft,
  SlidersHorizontal,
  Star,
  TableOfContents,
  Trash,
  Undo2,
} from "lucide-react";
import { SidebarOpenIcon } from "./SidebarOpenIcon";
import { convertToWiki, revertWiki } from "../lib/wiki";
import { databaseToInline } from "../lib/databaseConvert";
import { useRowLayout } from "../lib/pageLayout";
import { db } from "../lib/db";
import { isWorkspaceRoot, type Block } from "../lib/model";
import {
  archivePage,
  duplicateDatabase,
  duplicatePage,
  getAncestors,
  isArchived,
  purgeBlock,
  pushUndo,
  restoreBlock,
  setFormat,
  undoLast,
} from "../lib/ops";
import { leavePage, recordDatabase } from "../lib/history";
import { charCount, countChars, countWords, pageMarkdown, wordCount } from "../lib/pageExport";
import { editedLabel } from "../lib/format";
import { PageCover } from "./PageCover";
import { PageOutline } from "./PageOutline";
import { navigate, pageLinkProps, pageTitle, takeTraversal, toggleFavorite, useBlock, useFavorites } from "../lib/hooks";
import {
  confirmDialog,
  confirmPurge,
  copyLink,
  toast,
  MenuItem,
  MenuSeparator,
  PageIcon,
  Popover,
  Switch,
  trashWithUndo,
  usePopover,
} from "./ui";
import { DatabaseTitle, focusTitleEnd, mergeIntoTitle, PageHeader } from "./PageHeader";
import { Editor, focusBodyStart, insertBodyLines, insertBodyStart, type XotEditor } from "./Editor";
import { DatabaseView } from "./database/DatabaseView";
import { RowProperties } from "./database/RowPeek";
import { TemplatePicker, useBodyKey } from "./database/TemplatePicker";
import { CommentsPanel, PageDiscussions } from "./Comments";
import { ExportDialog } from "./ExportDialog";
import { MovePicker } from "./MovePicker";
import { ImportDialog, mergeCsvFile } from "./ImportDialog";
import { undoInPage, VersionHistory } from "./VersionHistory";
import { HOME_ROUTE } from "./HomeView";
import { CustomizePageDialog, PageUpdates, VerifiedBadge, VerifyMenu } from "./PageExtras";

const fullDate = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";

const isTyping = (el: Element | null) =>
  !!el && (el.matches("input, textarea, select, [contenteditable='true']") || !!el.closest(".bn-editor"));

/** Where each page was scrolled, for back / forward (this session only). */
const scrollMemory = new Map<string, number>();

const FONTS = [
  { id: "default", label: "Predeterminado" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Mono" },
] as const;

export function PageView({
  id,
  sidebarOpen,
  onOpenSidebar,
  onPeekSidebar,
  onUnpeekSidebar,
}: {
  id: string;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  /** Hovering the sidebar button shows the closed sidebar for a moment. */
  onPeekSidebar?: () => void;
  onUnpeekSidebar?: () => void;
}) {
  const block = useBlock(id);
  const ancestors = useLiveQuery(async () => (block ? getAncestors(block) : []), [block?.id, block?.parent_id]);
  const collection = useLiveQuery(
    async () => (block?.parent_table === "collection" ? db.collections.get(block.parent_id) : undefined),
    [block?.parent_table, block?.parent_id],
  );
  const rowLayout = useRowLayout(collection);
  const menu = usePopover();
  const share = usePopover();
  const move = usePopover();
  const hiddenPop = usePopover();
  const [dialog, setDialog] = useState<"export" | "history" | "import" | "customize" | null>(null);
  const updatesPop = usePopover();
  const verifyPop = usePopover();
  const updatesRef = useRef<HTMLButtonElement>(null);
  // The comments panel: the topbar shows its button once the page has comments.
  const [commentsOpen, setCommentsOpen] = useState(false);
  // Database pages keep their discussion under the properties; the header's button opens it there.
  const [commenting, setCommenting] = useState(false);
  const threadCount = useLiveQuery(() => db.threads.where("page_id").equals(id).count(), [id]);
  const moreRef = useRef<HTMLButtonElement>(null);
  const openMove = useRef(move.open);
  openMove.current = move.open;
  const favorites = useFavorites();
  const body = useBodyKey(block);
  const editorRef = useRef<XotEditor | null>(null);
  // Also kept in state: the floating outline follows the editor's headings.
  const [editor, setEditorState] = useState<XotEditor | null>(null);
  const setEditor = useCallback((editor: XotEditor | null) => {
    editorRef.current = editor;
    setEditorState(editor);
  }, []);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const exitTop = useCallback(() => focusTitleEnd(titleRef.current), []);
  const mergeTop = useCallback((text: string) => mergeIntoTitle(titleRef.current, text), []);

  // Back / forward come back to where the page was scrolled; a link opens it at the top.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<number | null>(null);
  const hasBlock = !!block;
  // Right after a navigation the previous page can still be on screen for a render.
  const shown = block?.id === id;
  const isDatabasePage = block?.type === "collection_view_page";
  useLayoutEffect(() => {
    restoreTo.current = takeTraversal() ? (scrollMemory.get(id) ?? null) : null;
    if (restoreTo.current === null && scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [id]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // The scroller can outlive a navigation for a moment: only its own page's scrolls count.
    const onScroll = () => el.dataset.page === id && scrollMemory.set(id, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [id, hasBlock]);
  useEffect(() => {
    const el = scrollerRef.current;
    const target = restoreTo.current;
    if (!el || target === null || !shown || (!isDatabasePage && !editor)) return;
    // Rows and embeds keep loading for a few frames: retry until the page is tall enough.
    let frame = 0;
    let tries = 0;
    const step = () => {
      el.scrollTop = target;
      if (Math.abs(el.scrollTop - target) > 1 && tries++ < 60) frame = requestAnimationFrame(step);
      else restoreTo.current = null;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [id, hasBlock, shown, isDatabasePage, editor]);

  // "Historial de versiones": leaving a page saves a version of it, when it was edited.
  useEffect(() => () => leavePage(id), [id]);
  // A full-page database's version is saved as it's opened too (what it had before this visit).
  useEffect(() => {
    if (isDatabasePage) void recordDatabase(id);
  }, [id, isDatabasePage]);

  // Page shortcuts: ⌘L copies the link, ⌘⇧P moves the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // With a row open in a peek, its shortcuts act on that row (RowPeek handles them).
      if (document.querySelector(".peek")) return;
      const key = e.key.toLowerCase();
      if (key === "l" && !e.shiftKey) {
        e.preventDefault();
        void copyLink(id);
      } else if (key === "d" && !e.shiftKey && !isTyping(document.activeElement)) {
        // ⌘D outside the text duplicates the page.
        e.preventDefault();
        void db.blocks
          .get(id)
          .then((b) => (b?.type === "collection_view_page" ? duplicateDatabase(id) : duplicatePage(id)))
          .then((copy) => copy && navigate(copy));
      } else if (key === "p" && e.shiftKey && moreRef.current) {
        e.preventDefault();
        openMove.current(moreRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id]);

  if (block === undefined) return null;
  // A missing page keeps the top bar (the way back to the sidebar) and offers Inicio.
  if (block === null)
    return (
      <div className="page-shell">
        <header className="topbar">
          {!sidebarOpen && (
            <button
              type="button"
              className="icon-btn topbar__sidebar"
              aria-label="Mostrar barra lateral"
              data-tooltip="Mostrar barra lateral"
              data-shortcut={`${mod}\\`}
              onClick={onOpenSidebar}
              onMouseEnter={onPeekSidebar}
              onMouseLeave={onUnpeekSidebar}
            >
              <SidebarOpenIcon />
            </button>
          )}
        </header>
        <div className="not-found">
          <p>Esta página no existe.</p>
          <button type="button" className="ghost-btn not-found__home" onClick={() => navigate(HOME_ROUTE)}>
            <House size={16} /> Volver a Inicio
          </button>
        </div>
      </div>
    );

  const isDatabase = block.type === "collection_view_page";
  const isFavorite = favorites.includes(block.id);
  const font = block.format.page_font ?? "default";
  // Locked, or in the trash: the page shows but nothing in it can change.
  const readOnly = !!block.format.locked || !block.alive;
  // Archived, itself or through a page above it: a banner offers "Desarchivar".
  const archived = isArchived(block, ancestors ?? []);
  // The workspace itself lives in the sidebar switcher, not in the path.
  const crumbs = [...(ancestors ?? []).filter((a) => a.id !== block.id && !isWorkspaceRoot(a.id)), block];
  // Long paths collapse their middle into "…": first / … / parent / page.
  const hiddenCrumbs = crumbs.length > 4 ? crumbs.slice(1, -2) : [];
  const shownCrumbs: (Block | null)[] = hiddenCrumbs.length ? [crumbs[0], null, ...crumbs.slice(-2)] : crumbs;

  return (
    <div className={`page-shell${commentsOpen ? " has-comments" : ""}`}>
      <header className="topbar">
        {!sidebarOpen && (
          <button
            type="button"
            className="icon-btn topbar__sidebar"
            aria-label="Mostrar barra lateral"
            data-tooltip="Mostrar barra lateral"
            data-shortcut={`${mod}\\`}
            onClick={onOpenSidebar}
            onMouseEnter={onPeekSidebar}
            onMouseLeave={onUnpeekSidebar}
          >
            <SidebarOpenIcon />
          </button>
        )}
        <nav className="crumbs" aria-label="Ruta">
          {/* ancestors can lag one render behind the route; drop stale entries */}
          {shownCrumbs.map((b, i, all) => (
            <span className="crumbs__item" key={b ? b.id : "more"}>
              {b ? (
                <button type="button" className="crumb" {...pageLinkProps(b.id)}>
                  <PageIcon block={b} size={16} />
                  <span>{pageTitle(b)}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="crumb crumb--more"
                  aria-label="Mostrar ruta completa"
                  onClick={(e) => hiddenPop.toggle(e.currentTarget)}
                >
                  …
                </button>
              )}
              {i < all.length - 1 && <span className="crumbs__sep">/</span>}
            </span>
          ))}
          {hiddenPop.anchor && (
            <Popover anchor={hiddenPop.anchor} onClose={hiddenPop.close} width={256}>
              <div className="menu">
                {hiddenCrumbs.map((b) => (
                  <MenuItem
                    key={b.id}
                    icon={<PageIcon block={b} size={20} />}
                    {...pageLinkProps(b.id, () => {
                      hiddenPop.close();
                      navigate(b.id);
                    }, hiddenPop.close)}
                  >
                    {pageTitle(b)}
                  </MenuItem>
                ))}
              </div>
            </Popover>
          )}
          {block.format.locked && (
            <button
              type="button"
              className="topbar__locked"
              data-tooltip="Desbloquear página"
              onClick={() => void setFormat(block.id, { locked: false })}
            >
              <Lock size={14} /> Bloqueada
            </button>
          )}
          <VerifiedBadge block={block} />
        </nav>
        <span className="topbar__edited" data-tooltip={fullDate.format(block.last_edited_time)}>
          {editedLabel(block.last_edited_time)}
        </span>
        <button type="button" className="topbar__share" onClick={(e) => share.toggle(e.currentTarget)}>
          Compartir
        </button>
        {(!!threadCount || commentsOpen) && (
          <button
            type="button"
            className={`icon-btn${commentsOpen ? " is-active" : ""}`}
            aria-label="Ver todos los comentarios"
            data-tooltip="Ver todos los comentarios"
            aria-pressed={commentsOpen}
            onClick={() => setCommentsOpen((o) => !o)}
          >
            <MessageSquareText size={20} />
          </button>
        )}
        {!isDatabase && (
          <button
            ref={updatesRef}
            type="button"
            className={`icon-btn${updatesPop.anchor ? " is-active" : ""}`}
            aria-label="Ver todas las actualizaciones"
            data-tooltip="Ver todas las actualizaciones"
            onClick={(e) => updatesPop.toggle(e.currentTarget)}
          >
            <Clock size={20} />
          </button>
        )}
        <button
          type="button"
          className={`icon-btn${isFavorite ? " is-favorite" : ""}`}
          aria-label={isFavorite ? "Quitar de favoritos" : "Añadir a favoritos"}
          data-tooltip={isFavorite ? "Quitar de favoritos" : "Añadir a favoritos"}
          aria-pressed={isFavorite}
          onClick={() => toggleFavorite(block.id)}
        >
          <Star size={20} fill={isFavorite ? "currentColor" : "none"} />
        </button>
        <button
          ref={moreRef}
          type="button"
          className="icon-btn topbar__more"
          aria-label="Opciones de página"
          data-tooltip="Estilo, exportar y más…"
          onClick={(e) => menu.toggle(e.currentTarget)}
        >
          <Ellipsis size={20} />
        </button>

        {share.anchor && (
          <Popover anchor={share.anchor} onClose={share.close} width={256} align="end">
            <div className="menu">
              <MenuItem
                icon={<Link size={18} />}
                onClick={() => {
                  share.close();
                  void copyLink(block.id);
                }}
              >
                Copiar enlace
              </MenuItem>
              <MenuItem
                icon={<FileDown size={18} />}
                onClick={() => {
                  share.close();
                  setDialog("export");
                }}
              >
                Exportar
              </MenuItem>
            </div>
          </Popover>
        )}

        {menu.anchor && (
          <Popover anchor={menu.anchor} onClose={menu.close} width={256} align="end">
            <PageMenu
              block={block}
              editor={editor}
              font={font}
              onClose={menu.close}
              onDialog={setDialog}
              onPageDialog={(d) => {
                if (d === "customize") setDialog("customize");
                else if (d === "updates") updatesRef.current && updatesPop.open(updatesRef.current);
                else if (moreRef.current) verifyPop.open(moreRef.current);
              }}
              onMove={() => {
                const anchor = menu.anchor;
                menu.close();
                if (anchor) move.open(anchor);
              }}
            />
          </Popover>
        )}
        {updatesPop.anchor && (
          <Popover anchor={updatesPop.anchor} onClose={updatesPop.close} width={380} align="end">
            <PageUpdates block={block} />
          </Popover>
        )}
        {verifyPop.anchor && (
          <Popover anchor={verifyPop.anchor} onClose={verifyPop.close} width={280} align="end">
            <VerifyMenu block={block} onDone={verifyPop.close} />
          </Popover>
        )}
        {dialog === "customize" && <CustomizePageDialog block={block} onClose={() => setDialog(null)} />}

        {dialog === "export" && <ExportDialog block={block} onClose={() => setDialog(null)} />}
        {dialog === "history" && <VersionHistory block={block} editor={editor} onClose={() => setDialog(null)} />}
        {dialog === "import" && (
          <ImportDialog target={{ table: "block", id: block.id }} onClose={() => setDialog(null)} />
        )}

        {move.anchor && (
          <Popover anchor={move.anchor} onClose={move.close} width={320} align="end">
            <MovePicker block={block} onDone={move.close} />
          </Popover>
        )}
      </header>

      {!block.alive && (
        <div className="trash-banner">
          <span>Esta página está en la papelera.</span>
          <button type="button" className="banner-btn" onClick={() => void restoreBlock(block.id)}>
            Restaurar página
          </button>
          <button
            type="button"
            className="banner-btn"
            onClick={async () => {
              if (!(await confirmPurge())) return;
              // A top-level page goes back to Inicio: the workspace root isn't a page.
              const parent = ancestors?.filter((a) => !isWorkspaceRoot(a.id)).pop();
              await purgeBlock(block.id);
              navigate(parent ? parent.id : HOME_ROUTE);
            }}
          >
            Eliminar de la papelera
          </button>
        </div>
      )}

      {block.alive && archived && (
        <div className="trash-banner archive-banner">
          <Archive size={16} />
          <span>
            {block.format.archived ? "Esta página está archivada." : "Esta página está dentro de una página archivada."}
          </span>
          {block.format.archived && (
            <button type="button" className="banner-btn" onClick={() => void archivePage(block.id, false)}>
              Desarchivar
            </button>
          )}
        </div>
      )}

      {block.is_template && block.alive && (
        <div className="template-banner">
          <LayoutTemplate size={16} />
          <span>
            Estás editando una plantilla de <strong>{pageTitle(ancestors?.[ancestors.length - 1])}</strong>
          </span>
        </div>
      )}

      <div className="scroller" ref={scrollerRef} data-page={id}>
        {!isDatabase && editor && block.format.floating_toc !== "off" && <PageOutline key={block.id} editor={editor} />}
        {block.format.cover && <PageCover block={block} />}
        <div
          className={`page${isDatabase ? " page--database" : ""}${block.format.full_width ? " page--full" : ""}${
            block.format.small_text ? " page--small" : ""
          }${font !== "default" ? ` page--${font}` : ""}${block.format.cover ? " has-cover" : ""}${
            block.format.inline_comments === "minimal" ? " page--comments-minimal" : ""
          }`}
        >
          {isDatabase ? (
            <DatabaseTitle block={block} />
          ) : (
            <PageHeader
              block={block}
              titleRef={titleRef}
              onEnter={(tail) => editorRef.current && insertBodyStart(editorRef.current, tail)}
              onArrowDown={() => editorRef.current && focusBodyStart(editorRef.current)}
              onPasteLines={(lines) => editorRef.current && insertBodyLines(editorRef.current, lines)}
              onComment={collection ? () => setCommenting(true) : undefined}
            />
          )}
          {collection && <RowProperties row={block} collection={collection} readOnly={readOnly} />}
          {collection && rowLayout.page_layout?.discussions !== "off" && block.format.page_comments !== "off" && (
            <PageDiscussions
              pageId={block.id}
              persistent
              composing={commenting}
              onComposed={() => setCommenting(false)}
              readOnly={readOnly}
            />
          )}
          {collection && <div className="row-props__divider" />}
          {collection && block.alive && (
            <TemplatePicker
              row={block}
              collection={collection}
              onApplied={body.onApplied}
              onEmpty={() => editorRef.current && focusBodyStart(editorRef.current)}
              onOpenTemplate={navigate}
            />
          )}
          {isDatabase ? (
            <DatabaseView key={block.id} block={block} />
          ) : (
            <div
              className="page__editor"
              // A page dragged from the sidebar drops in as a link to it, where the pointer is.
              onDragOverCapture={(e) => {
                if (readOnly || !e.dataTransfer.types.includes("text/xot-page")) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
              }}
              onDropCapture={(e) => {
                const pageId = e.dataTransfer.getData("text/xot-page");
                if (readOnly || !pageId) return;
                e.preventDefault();
                e.stopPropagation();
                if (editorRef.current && pageId !== block.id) dropPageLink(editorRef.current, pageId, e.clientX, e.clientY);
              }}
            >
              <Editor key={body.key} block={block} onReady={setEditor} onExitTop={exitTop} onMergeTop={mergeTop} />
            </div>
          )}
        </div>
      </div>
      {commentsOpen && (
        <CommentsPanel
          pageId={block.id}
          content={block.content}
          readOnly={readOnly}
          onClose={() => setCommentsOpen(false)}
        />
      )}
    </div>
  );
}

/** Inserts a link to `pageId` before or after the block under the pointer (else at the end). */
function dropPageLink(editor: XotEditor, pageId: string, x: number, y: number) {
  const outer = document.elementFromPoint(x, y)?.closest<HTMLElement>(".bn-block-outer[data-id]");
  const link = [{ type: "pageLink" as const, props: { pageId } }];
  if (outer?.dataset.id) {
    const r = outer.getBoundingClientRect();
    editor.insertBlocks(link, outer.dataset.id, y < r.top + r.height / 2 ? "before" : "after");
  } else {
    const last = editor.document[editor.document.length - 1];
    if (last) editor.insertBlocks(link, last, "after");
  }
}

/**
 * The topbar "..." menu: typeface, page actions and layout toggles.
 * The side peek shows it too, with `extraTop` ("Abrir como página") first and
 * `onTrashed` to close itself.
 */
export function PageMenu({
  block,
  editor,
  font,
  onClose,
  onMove,
  onDialog,
  onPageDialog,
  extraTop,
  onTrashed,
  onDuplicated = navigate,
  inPeek,
}: {
  block: Block;
  editor: XotEditor | null;
  font: string;
  onClose: () => void;
  onMove: () => void;
  onDialog: (dialog: "export" | "history" | "import") => void;
  /** The full page's own panels: Personalizar página, Actualizaciones, Verificar (the peek leaves them out). */
  onPageDialog?: (dialog: "customize" | "updates" | "verify") => void;
  extraTop?: ReactNode;
  onTrashed?: () => void;
  /** Where a copy made by "Duplicar" opens (the peek opens it in place). */
  onDuplicated?: (id: string) => void;
  /** The peek's menu: no "Ancho completo" or "Índice", which only apply to the full page. */
  inPeek?: boolean;
}) {
  const [query, setQuery] = useState("");
  const isDatabase = block.type === "collection_view_page";
  const isRow = block.parent_table === "collection";
  const words = useMemo(() => (isDatabase ? 0 : wordCount(block)), [block, isDatabase]);
  const chars = useMemo(() => (isDatabase ? 0 : charCount(block)), [block, isDatabase]);
  // Text selected on the page when the menu opened (its search box takes the focus right after).
  const [selected] = useState(() => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    return sel && !sel.isCollapsed && el?.closest(".bn-editor") ? sel.toString() : "";
  });

  const run = (action: () => unknown) => () => {
    onClose();
    void action();
  };
  const toggle = (patch: Partial<Block["format"]>) => () => void setFormat(block.id, patch);

  const items: { label: string; node: ReactNode; section: number }[] = [
    {
      section: 0,
      label: "Copiar enlace",
      node: (
        <MenuItem icon={<Link size={18} />} right={`${mod}L`} onClick={run(() => copyLink(block.id))}>
          Copiar enlace
        </MenuItem>
      ),
    },
    {
      section: 0,
      label: "Duplicar",
      node: (
        <MenuItem
          icon={<CopyPlus size={18} />}
          right={`${mod}D`}
          onClick={run(async () => {
            const id = await (isDatabase ? duplicateDatabase(block.id) : duplicatePage(block.id));
            if (id) onDuplicated(id);
          })}
        >
          Duplicar
        </MenuItem>
      ),
    },
    ...(isDatabase
      ? []
      : [
          {
            section: 0,
            label: "Copiar contenido de la página",
            node: (
              <MenuItem
                icon={<ClipboardCopy size={18} />}
                onClick={run(async () => {
                  await navigator.clipboard.writeText(await pageMarkdown(block));
                  toast("Contenido de la página copiado");
                })}
              >
                Copiar contenido de la página
              </MenuItem>
            ),
          },
        ]),
    {
      section: 0,
      label: "Mover a",
      node: (
        <MenuItem icon={<CornerUpRight size={18} />} right={`${mod}⇧P`} onClick={onMove}>
          Mover a
        </MenuItem>
      ),
    },
    ...(isRow
      ? []
      : [
          {
            section: 0,
            label: block.format.archived ? "Desarchivar" : "Archivar",
            node: (
              <MenuItem
                icon={block.format.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}
                onClick={run(() => archivePage(block.id, !block.format.archived))}
              >
                {block.format.archived ? "Desarchivar" : "Archivar"}
              </MenuItem>
            ),
          },
        ]),
    {
      section: 0,
      label: "Mover a la papelera",
      node: (
        <MenuItem
          danger
          icon={<Trash size={18} />}
          onClick={run(() => {
            void trashWithUndo(block.id);
            onTrashed?.();
          })}
        >
          Mover a la papelera
        </MenuItem>
      ),
    },
    ...(onPageDialog && !isDatabase
      ? [
          {
            section: 1,
            label: "Personalizar página",
            node: (
              <MenuItem icon={<SlidersHorizontal size={18} />} onClick={run(() => onPageDialog("customize"))}>
                Personalizar página
              </MenuItem>
            ),
          },
        ]
      : []),
    {
      section: 1,
      label: "Texto pequeño",
      node: (
        <MenuItem
          icon={<ALargeSmall size={18} />}
          right={<Switch on={!!block.format.small_text} />}
          onClick={toggle({ small_text: !block.format.small_text })}
        >
          Texto pequeño
        </MenuItem>
      ),
    },
    ...(inPeek
      ? []
      : [
          {
            section: 1,
            label: "Ancho completo",
            node: (
              <MenuItem
                icon={<MoveHorizontal size={18} />}
                right={<Switch on={!!block.format.full_width} />}
                onClick={toggle({ full_width: !block.format.full_width })}
              >
                Ancho completo
              </MenuItem>
            ),
          },
        ]),
    ...(isDatabase || inPeek
      ? []
      : [
          {
            section: 1,
            label: "Índice",
            node: (
              <MenuItem
                icon={<TableOfContents size={18} />}
                right={<Switch on={block.format.floating_toc !== "off"} />}
                onClick={toggle({ floating_toc: block.format.floating_toc === "off" ? undefined : "off" })}
              >
                Índice
              </MenuItem>
            ),
          },
        ]),
    {
      section: 2,
      label: isDatabase ? "Bloquear base de datos" : "Bloquear página",
      node: (
        <MenuItem
          icon={<Lock size={18} />}
          right={<Switch on={!!block.format.locked} />}
          onClick={toggle({ locked: !block.format.locked })}
        >
          {isDatabase ? "Bloquear base de datos" : "Bloquear página"}
        </MenuItem>
      ),
    },
    ...(!isDatabase && !isRow && !block.is_template
      ? [
          {
            section: 2,
            label: "Convertir en wiki",
            node: (
              <MenuItem
                icon={<BookOpen size={18} />}
                onClick={run(async () => {
                  if (!(await convertToWiki(block.id))) return;
                  // One ⌘Z step (and the toast's "Deshacer") turns it back into a page.
                  pushUndo({
                    label: "Convertir en wiki",
                    undo: async () => void (await revertWiki(block.id)),
                    redo: async () => void (await convertToWiki(block.id)),
                  });
                  toast("La página ahora es un wiki", { label: "Deshacer", run: () => void undoLast() });
                })}
              >
                Convertir en wiki
              </MenuItem>
            ),
          },
        ]
      : []),
    ...(isDatabase && block.format.wiki
      ? [
          {
            section: 2,
            label: "Revertir a página",
            node: (
              <MenuItem
                icon={<BookOpen size={18} />}
                onClick={run(async () => {
                  // Warn first: the wiki's pages lose their wiki properties.
                  const pages = block.collection_id
                    ? await db.blocks.where("[parent_table+parent_id]").equals(["collection", block.collection_id]).count()
                    : 0;
                  if (
                    pages &&
                    !(await confirmDialog({
                      text: `Se quitarán las propiedades del wiki (Propietario, Verificación, Etiquetas) de ${pages} ${
                        pages === 1 ? "página" : "páginas"
                      }.`,
                      confirm: "Revertir a página",
                      danger: true,
                    }))
                  )
                    return;
                  if (await revertWiki(block.id)) toast("El wiki volvió a ser una página");
                })}
              >
                Revertir a página
              </MenuItem>
            ),
          },
        ]
      : []),
    // "Convertir en integrada": the database shows inside its page again.
    ...(isDatabase && !block.format.wiki && !block.format.inline && !isRow
      ? [
          {
            section: 2,
            label: "Convertir en integrada",
            node: (
              <MenuItem
                icon={<PanelsTopLeft size={18} />}
                onClick={run(async () => {
                  const page = await databaseToInline(block.id);
                  if (page) navigate(page);
                })}
              >
                Convertir en integrada
              </MenuItem>
            ),
          },
        ]
      : []),
    ...(onPageDialog && !isDatabase
      ? [
          {
            section: 2,
            label: block.format.verified ? "Verificación" : "Verificar página",
            node: (
              <MenuItem icon={<BadgeCheck size={18} />} onClick={run(() => onPageDialog("verify"))}>
                {block.format.verified ? "Verificación" : "Verificar página"}
              </MenuItem>
            ),
          },
        ]
      : []),
    // "Deshacer ⌘Z" opens the section with the page's history.
    {
      section: 3,
      label: "Deshacer",
      node: (
        <MenuItem icon={<Undo2 size={18} />} right={`${mod}Z`} onClick={run(() => undoInPage(block, editor))}>
          Deshacer
        </MenuItem>
      ),
    },
    ...(isDatabase
      ? block.collection_id
        ? [
            {
              section: 3,
              label: "Historial de versiones",
              node: (
                <MenuItem icon={<History size={18} />} onClick={run(() => onDialog("history"))}>
                  Historial de versiones
                </MenuItem>
              ),
            },
            {
              section: 4,
              label: "Combinar con CSV",
              node: (
                <MenuItem icon={<FileUp size={18} />} onClick={run(() => mergeCsvFile(block.collection_id!))}>
                  Combinar con CSV
                </MenuItem>
              ),
            },
          ]
        : []
      : [
          ...(onPageDialog
            ? [
                {
                  section: 3,
                  label: "Actualizaciones",
                  node: (
                    <MenuItem icon={<Clock size={18} />} onClick={run(() => onPageDialog("updates"))}>
                      Actualizaciones
                    </MenuItem>
                  ),
                },
              ]
            : []),
          {
            section: 3,
            label: "Historial de versiones",
            node: (
              <MenuItem icon={<History size={18} />} onClick={run(() => onDialog("history"))}>
                Historial de versiones
              </MenuItem>
            ),
          },
          {
            section: 4,
            label: "Importar",
            node: (
              <MenuItem icon={<FileUp size={18} />} onClick={run(() => onDialog("import"))}>
                Importar
              </MenuItem>
            ),
          },
        ]),
    {
      section: 4,
      label: "Exportar",
      node: (
        <MenuItem icon={<FileDown size={18} />} onClick={run(() => onDialog("export"))}>
          Exportar
        </MenuItem>
      ),
    },
  ];

  const q = query.trim().toLowerCase();
  // A page in the trash only offers what doesn't change it (restoring is on its banner).
  const TRASHED_ITEMS = ["Copiar enlace", "Copiar contenido de la página", "Historial de versiones", "Exportar"];
  const shown = items
    .filter((i) => block.alive || TRASHED_ITEMS.includes(i.label))
    .filter((i) => i.label.toLowerCase().includes(q));

  return (
    <div className="menu page-menu">
      <input
        className="menu-search"
        autoFocus
        placeholder="Buscar acciones…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!q && !isDatabase && block.alive && (
        <>
          <div className="font-trio">
            {FONTS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`font-trio__item font-trio__item--${f.id}${font === f.id ? " is-active" : ""}`}
                onClick={() => void setFormat(block.id, { page_font: f.id === "default" ? undefined : f.id })}
              >
                <span className="font-trio__sample">Ag</span>
                <span className="font-trio__label">{f.label}</span>
              </button>
            ))}
          </div>
          <MenuSeparator />
        </>
      )}
      {!q && extraTop}
      {shown.map((item, i) => (
        <div key={item.label}>
          {i > 0 && shown[i - 1].section !== item.section && <MenuSeparator />}
          {item.node}
        </div>
      ))}
      {shown.length === 0 && <div className="menu-empty">Sin resultados</div>}
      {!q && (
        <>
          <MenuSeparator />
          <div className="page-menu__meta">
            {!isDatabase && <div>Recuento de palabras: {words.toLocaleString("es")} palabras</div>}
            {!isDatabase && <div>Caracteres: {chars.toLocaleString("es")}</div>}
            {!isDatabase && selected.trim() && (
              <div>
                Selección: {countWords(selected).toLocaleString("es")} {countWords(selected) === 1 ? "palabra" : "palabras"},{" "}
                {countChars(selected).toLocaleString("es")} caracteres
              </div>
            )}
            {block.last_edited_time > 0 && <div>Última edición: {fullDate.format(block.last_edited_time)}</div>}
          </div>
        </>
      )}
    </div>
  );
}
