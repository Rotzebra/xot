import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ArrowUpRight, FaceSlightlySmiling, Image as ImageIcon, MessageSquareText, PanelsTopLeft } from "lucide-react";
import type { Block } from "../lib/model";
import { setFormat, setIcon, setTitle } from "../lib/ops";
import { navigate, pageTitle, useBacklinks } from "../lib/hooks";
import { EmojiPicker, iconUrl, isGlyphIcon, MenuItem, PageIcon, Popover, randomEmoji, usePopover } from "./ui";
import { randomCover } from "./PageCover";
import { PageDiscussions } from "./Comments";
import { PageLayoutMenu } from "./database/PageLayoutMenu";

/**
 * Icon + hover controls + title. The title is local state so typing never fights the DB round-trip.
 * `compact` is the side peek's header, with a 36px icon. With `onComment` (database
 * pages) the discussions live under the properties, and "Agregar comentario" goes there.
 * The title is always one line: Enter (`onEnter`) moves what follows the
 * caret into a new first block, ↓ goes into the body as it is, and the lines of a
 * multi-line paste after the first go to the top of the body (`onPasteLines`).
 */
export function PageHeader({
  block,
  onEnter,
  onArrowDown,
  onPasteLines,
  compact,
  onComment,
  titleRef,
}: {
  block: Block;
  /** Enter in the title, with the text that was after the caret (now out of the title). */
  onEnter?: (tail: string) => void;
  /** ↓ at the end of the title. */
  onArrowDown?: () => void;
  onPasteLines?: (lines: string[]) => void;
  compact?: boolean;
  onComment?: () => void;
  /** Lets the page put the caret back in the title (↑ from the body). */
  titleRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const pop = usePopover();
  const linksPop = usePopover();
  const layoutPop = usePopover();
  const backlinks = useBacklinks(block);
  // "Personalizar página": backlinks behind a button (default), listed under the title, or hidden;
  // the discussions at the top can be turned off.
  const linksMode = block.format.backlinks ?? "popover";
  const commentsOff = block.format.page_comments === "off";
  const [title, setLocal] = useState(String(block.properties.title ?? ""));
  const [commenting, setCommenting] = useState(false);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = titleRef ?? ownRef;
  const icon = block.format.icon;
  const url = icon ? iconUrl(icon) : null;
  // Uploaded images show at 140px; built-in SVG icons keep the emoji size.
  const isImage = !!url && !isGlyphIcon(icon!);
  const iconSize = compact ? 36 : isImage ? 140 : 78;
  // Image icons are drawn at 89% of their box, centered (124.6px in 140, 32px in the peek's 36).
  const imageSize = isImage ? (compact ? 32 : 124.6) : iconSize;
  // A page in the trash reads like a locked one until it's restored.
  const locked = !!block.format.locked || !block.alive;

  // Follow renames made elsewhere (the sidebar), but never while typing here.
  const stored = String(block.properties.title ?? "");
  const shownId = useRef(block.id);
  useEffect(() => {
    if (shownId.current !== block.id || document.activeElement !== ref.current) setLocal(stored);
    shownId.current = block.id;
  }, [block.id, stored]);

  // A page just created starts with the caret in its title.
  useEffect(() => {
    if (!block.properties.title && !locked && Date.now() - block.created_time < 5000) ref.current?.focus();
  }, [block.id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  return (
    <div className={`page-header${icon ? "" : " page-header--no-icon"}`}>
      {icon && (
        <button
          type="button"
          className={`page-header__icon${isImage ? " page-header__icon--image" : ""}`}
          aria-label="Cambiar ícono de página"
          disabled={locked}
          onClick={(e) => pop.toggle(e.currentTarget)}
        >
          {url ? <img src={url} alt="" width={imageSize} height={imageSize} /> : icon}
        </button>
      )}
      <div className="page-header__controls">
        {!locked && !icon && (
          <button type="button" className="ghost-btn" onClick={() => void setIcon(block.id, randomEmoji())}>
            <FaceSlightlySmiling size={14} /> Agregar un ícono
          </button>
        )}
        {!locked && !block.format.cover && (
          <button type="button" className="ghost-btn" onClick={() => void setFormat(block.id, { cover: randomCover(), cover_position: 0.5 })}>
            <ImageIcon size={14} /> Agregar portada
          </button>
        )}
        {!locked && block.parent_table === "collection" && (
          <button type="button" className="ghost-btn" onClick={(e) => layoutPop.toggle(e.currentTarget)}>
            <PanelsTopLeft size={14} /> Personalizar diseño
          </button>
        )}
        {!locked && !commentsOff && (
          <button type="button" className="ghost-btn" onClick={() => (onComment ? onComment() : setCommenting(true))}>
            <MessageSquareText size={14} /> Agregar comentario
          </button>
        )}
      </div>
      <textarea
        ref={ref}
        rows={1}
        className="page-header__title"
        placeholder="Sin título"
        readOnly={locked}
        value={title}
        onChange={(e) => {
          // Never a line break in a title (a drop or an autocorrect can still bring one).
          const value = e.target.value.replace(/[\r\n]+/g, " ");
          setLocal(value);
          void setTitle(block.id, value);
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text/plain");
          if (!/[\r\n]/.test(text)) return;
          e.preventDefault();
          const [first, ...rest] = text.split(/\r?\n|\r/);
          const el = e.currentTarget;
          el.setRangeText(first, el.selectionStart, el.selectionEnd, "end");
          setLocal(el.value);
          void setTitle(block.id, el.value);
          const lines = rest.filter((line) => line.trim());
          if (lines.length) onPasteLines?.(lines);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          const el = e.currentTarget;
          const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
          if (e.key === "Enter") {
            // Enter cuts the title at the caret; the rest starts a new first block.
            e.preventDefault();
            if (locked) return;
            const head = el.value.slice(0, el.selectionStart);
            const tail = el.value.slice(el.selectionEnd);
            if (head !== el.value) {
              setLocal(head);
              void setTitle(block.id, head);
            }
            onEnter?.(tail);
          } else if (e.key === "ArrowDown" && atEnd && onArrowDown) {
            // ↓ at the end goes into the body as it is.
            e.preventDefault();
            onArrowDown();
          }
        }}
      />
      {/* "Retroenlaces: Mostrar en ventana emergente": a small gray button under the title, always shown. */}
      {linksMode === "popover" && !!backlinks?.length && (
        <div className="page-header__backlinks-row">
          <button
            type="button"
            className="page-header__backlinks"
            onClick={(e) => linksPop.toggle(e.currentTarget)}
          >
            <ArrowUpRight size={16} /> {backlinksLabel(backlinks.length)}
          </button>
        </div>
      )}
      {linksMode === "expanded" && !!backlinks?.length && (
        <div className="page-backlinks">
          <div className="page-backlinks__label">
            <ArrowUpRight size={14} /> {backlinksLabel(backlinks.length)}
          </div>
          {backlinks.map((b) => (
            <button key={b.id} type="button" className="page-backlinks__item" onClick={() => navigate(b.id)}>
              <PageIcon block={b} size={18} />
              <span>{pageTitle(b)}</span>
            </button>
          ))}
        </div>
      )}
      {!onComment && !commentsOff && (
        <PageDiscussions pageId={block.id} composing={commenting} onComposed={() => setCommenting(false)} readOnly={locked} />
      )}
      {linksPop.anchor && backlinks && (
        <Popover anchor={linksPop.anchor} onClose={linksPop.close} width={256}>
          <div className="menu">
            {backlinks.map((b) => (
              <MenuItem
                key={b.id}
                icon={<PageIcon block={b} size={20} />}
                onClick={() => {
                  linksPop.close();
                  navigate(b.id);
                }}
              >
                {pageTitle(b)}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
      {layoutPop.anchor && <PageLayoutMenu collectionId={block.parent_id} onClose={layoutPop.close} />}
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={408}>
          <EmojiPicker
            onPick={(emoji) => {
              void setIcon(block.id, emoji);
              pop.close();
            }}
            onRemove={
              icon
                ? () => {
                    void setIcon(block.id, undefined);
                    pop.close();
                  }
                : undefined
            }
          />
        </Popover>
      )}
    </div>
  );
}

const backlinksLabel = (n: number) => `${n} ${n === 1 ? "retroenlace" : "retroenlaces"}`;

/**
 * Backspace at the start of the first text block: its text joins the end of the title, with
 * the caret where they meet (the way to undo Enter in the title). Typed into the
 * textarea, so the title saves through its own onChange and ⌘Z there takes it back.
 */
export function mergeIntoTitle(el: HTMLTextAreaElement | null, text: string) {
  if (!el || el.readOnly) return;
  const at = el.value.length;
  el.focus();
  el.setSelectionRange(at, at);
  if (text) document.execCommand("insertText", false, text.replace(/[\r\n]+/g, " "));
  el.setSelectionRange(at, at);
}

/** ↑ from the body: the caret goes to the end of the title. */
export function focusTitleEnd(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

/** The full-page database title: a 24px row with the icon inline, no big header. */
export function DatabaseTitle({ block }: { block: Block }) {
  const pop = usePopover();
  const ref = useRef<HTMLSpanElement>(null);
  const locked = !!block.format.locked || !block.alive;

  // Never rewrite the text while it is being typed, so the caret stays put.
  const title = String(block.properties.title ?? "");
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.textContent !== title) el.textContent = title;
  }, [block.id, title]);

  return (
    <div className="db-page-title">
      {block.format.icon && (
        <button
          type="button"
          className="db-page-title__icon"
          aria-label="Cambiar ícono de página"
          disabled={locked}
          onClick={(e) => pop.toggle(e.currentTarget)}
        >
          <PageIcon block={block} size={24} />
        </button>
      )}
      <span
        ref={ref}
        className="db-page-title__text"
        contentEditable={locked ? false : "plaintext-only"}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-label="Título de la base de datos"
        onPaste={(e) => {
          // Plain text on one line: pasted formatting and line breaks never reach the title.
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain").replace(/[\r\n]+/g, " ");
          document.execCommand("insertText", false, text);
        }}
        onInput={(e) => {
          const el = e.currentTarget;
          let text = el.textContent ?? "";
          if (/[\r\n]/.test(text) || el.querySelector("*")) {
            text = text.replace(/[\r\n]+/g, " ");
            el.textContent = text;
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
          void setTitle(block.id, text);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={408}>
          <EmojiPicker
            onPick={(emoji) => {
              void setIcon(block.id, emoji);
              pop.close();
            }}
            onRemove={() => {
              void setIcon(block.id, undefined);
              pop.close();
            }}
          />
        </Popover>
      )}
    </div>
  );
}
