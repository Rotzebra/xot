import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { CommentData } from "@blocknote/core/comments";
import { ArrowUp, Check, Ellipsis, FaceSlightlySmilingPlus, Link, MessageSquareText, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { db } from "../lib/db";
import {
  addPageComment,
  addPropertyComment,
  commentText,
  deletePageComment,
  LOCAL_USER,
  setThreadResolved,
  toggleReaction,
  updatePageComment,
  type StoredThread,
} from "../lib/comments";
import { copyLink, EmojiPicker, MenuItem, Popover, usePopover } from "./ui";

const relative = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const fullDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });

/** "Justo ahora", "hace 5 minutos", "ayer"…, then the date (the comment times). */
function when(date: Date) {
  const s = (Date.now() - date.getTime()) / 1000;
  if (s < 60) return "Justo ahora";
  if (s < 3600) return relative.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return relative.format(-Math.floor(s / 3600), "hour");
  if (s < 7 * 86400) return relative.format(-Math.floor(s / 86400), "day");
  return fullDate.format(date);
}

const Avatar = () => <span className="comment__avatar">{LOCAL_USER.username.slice(0, 1)}</span>;

/** A one-line box that grows; Enter sends, Shift+Enter breaks the line, Escape gives up. */
function Composer({
  placeholder,
  autoFocus,
  focus,
  initial = "",
  onSend,
  onCancel,
}: {
  placeholder: string;
  autoFocus?: boolean;
  /** "Editar comentario": the comment's text, with the caret at its end. */
  initial?: string;
  /** Takes the caret whenever this turns true (the always-shown composer of a row). */
  focus?: boolean;
  onSend: (text: string) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  useEffect(() => {
    const el = ref.current;
    if (initial && el && autoFocus) el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <div className="comment-composer">
      <Avatar />
      <textarea
        ref={ref}
        rows={1}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => !text.trim() && onCancel?.()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            setText("");
            onCancel?.();
          }
        }}
      />
      <button
        type="button"
        className="comment-composer__send"
        aria-label="Enviar"
        disabled={!text.trim()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={send}
      >
        <ArrowUp size={16} />
      </button>
    </div>
  );
}

/**
 * One comment: on hover "Agregar reacción", Resolver (first comment)
 * and a "⋯" menu (Editar / Eliminar / Copiar enlace); its reactions show as pills under it.
 */
function CommentItem({
  pageId,
  thread,
  comment,
  readOnly,
  resolve,
}: {
  pageId: string;
  thread: StoredThread;
  comment: CommentData;
  readOnly?: boolean;
  /** The Resolver (or Volver a abrir) button, on the thread's first comment. */
  resolve?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const react = usePopover();
  const more = usePopover();
  const text = comment.body ? commentText(comment.body) : "";
  const edited = !!comment.updatedAt && new Date(comment.updatedAt).getTime() > new Date(comment.createdAt).getTime();
  const reactions = (comment.reactions ?? []).filter((r) => r.userIds.length);
  return (
    <div className="comment">
      <Avatar />
      <div className="comment__main">
        <div className="comment__head">
          <span className="comment__author">{LOCAL_USER.username}</span>
          <span className="comment__time">{when(new Date(comment.createdAt))}</span>
          {edited && <span className="comment__time">(editado)</span>}
          {!readOnly && !editing && (
            <span className={`comment__actions${react.anchor || more.anchor ? " is-open" : ""}`}>
              <button
                type="button"
                className="icon-btn"
                aria-label="Agregar reacción"
                data-tooltip="Agregar reacción"
                onClick={(e) => react.toggle(e.currentTarget)}
              >
                <FaceSlightlySmilingPlus size={16} />
              </button>
              {resolve}
              <button
                type="button"
                className="icon-btn"
                aria-label="Más acciones"
                data-tooltip="Más acciones"
                onClick={(e) => more.toggle(e.currentTarget)}
              >
                <Ellipsis size={16} />
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <Composer
            autoFocus
            initial={text}
            placeholder="Editar comentario…"
            onSend={(next) => {
              if (next !== text) void updatePageComment(thread.id, comment.id, next);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="comment__body">{text}</div>
        )}
        {reactions.length > 0 && (
          <div className="comment__reactions">
            {reactions.map((r) => {
              const mine = r.userIds.includes(LOCAL_USER.id);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  className={`comment__reaction${mine ? " is-mine" : ""}`}
                  aria-pressed={mine}
                  disabled={readOnly}
                  onClick={() => void toggleReaction(thread.id, comment.id, r.emoji)}
                >
                  <span className="comment__reaction-emoji">{r.emoji}</span>
                  <span>{r.userIds.length}</span>
                </button>
              );
            })}
            {!readOnly && (
              <button
                type="button"
                className="comment__reaction comment__reaction--add"
                aria-label="Agregar reacción"
                data-tooltip="Agregar reacción"
                onClick={(e) => react.toggle(e.currentTarget)}
              >
                <FaceSlightlySmilingPlus size={14} />
              </button>
            )}
          </div>
        )}
      </div>
      {react.anchor && (
        <Popover anchor={react.anchor} onClose={react.close} width={408}>
          <EmojiPicker
            emojiOnly
            onPick={(emoji) => {
              void toggleReaction(thread.id, comment.id, emoji);
              react.close();
            }}
          />
        </Popover>
      )}
      {more.anchor && (
        <Popover anchor={more.anchor} onClose={more.close} width={240} align="end">
          <div className="menu">
            <MenuItem
              icon={<Pencil size={18} />}
              onClick={() => {
                more.close();
                setEditing(true);
              }}
            >
              Editar comentario
            </MenuItem>
            <MenuItem
              danger
              icon={<Trash2 size={18} />}
              onClick={() => {
                more.close();
                void deletePageComment(thread.id, comment.id);
              }}
            >
              Eliminar comentario
            </MenuItem>
            <MenuItem
              icon={<Link size={18} />}
              onClick={() => {
                more.close();
                void copyLink(`${pageId}?d=${thread.id}`);
              }}
            >
              Copiar enlace al comentario
            </MenuItem>
          </div>
        </Popover>
      )}
    </div>
  );
}

/**
 * The page discussions, under the title: each thread with its comments,
 * a reply box, and resolve / delete on hover. `composing` opens a new thread.
 * `persistent` (database pages, under the properties) keeps the
 * "Agregar un comentario…" box there even with no threads.
 */
export function PageDiscussions({
  pageId,
  composing,
  onComposed,
  readOnly,
  persistent,
}: {
  pageId: string;
  composing: boolean;
  onComposed: () => void;
  readOnly?: boolean;
  persistent?: boolean;
}) {
  const threads = useLiveQuery(
    async () =>
      (await db.threads.where("page_id").equals(pageId).toArray())
        // Comments on a property's value show by that property, not here.
        .filter((t) => t.metadata?.page && !t.metadata?.property && !t.resolved)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    [pageId],
  );
  const always = persistent && !readOnly;
  if (!threads?.length && !composing && !always) return null;
  return (
    <div className={`page-discussions${persistent ? " page-discussions--row" : ""}`}>
      {threads?.map((t) => (
        <div className="discussion" key={t.id}>
          {t.comments.map((c, i) => (
            <CommentItem
              key={c.id}
              pageId={pageId}
              thread={t}
              comment={c}
              readOnly={readOnly}
              resolve={
                i === 0 && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Resolver"
                    data-tooltip="Resolver"
                    onClick={() => void setThreadResolved(t.id, true)}
                  >
                    <Check size={16} />
                  </button>
                )
              }
            />
          ))}
          {!readOnly && <Composer placeholder="Responder…" onSend={(text) => void addPageComment(pageId, text, t.id)} />}
        </div>
      ))}
      {always ? (
        <Composer
          focus={composing}
          placeholder="Agregar un comentario…"
          onSend={(text) => {
            void addPageComment(pageId, text);
            onComposed();
          }}
          onCancel={onComposed}
        />
      ) : composing && !readOnly && (
        <Composer
          autoFocus
          placeholder="Agregar un comentario…"
          onSend={(text) => {
            void addPageComment(pageId, text);
            onComposed();
          }}
          onCancel={onComposed}
        />
      )}
    </div>
  );
}

/** The open comments on one property of a page (property comments), with a box for a new one. */
export function PropertyThreads({ pageId, propertyId, readOnly }: { pageId: string; propertyId: string; readOnly?: boolean }) {
  const threads = useLiveQuery(
    async () =>
      (await db.threads.where("page_id").equals(pageId).toArray())
        .filter((t) => t.metadata?.property === propertyId && !t.resolved)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    [pageId, propertyId],
  );
  return (
    <div className="page-discussions property-threads">
      {threads?.map((t) => (
        <div className="discussion" key={t.id}>
          {t.comments.map((c, i) => (
            <CommentItem
              key={c.id}
              pageId={pageId}
              thread={t}
              comment={c}
              readOnly={readOnly}
              resolve={
                i === 0 && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Resolver"
                    data-tooltip="Resolver"
                    onClick={() => void setThreadResolved(t.id, true)}
                  >
                    <Check size={16} />
                  </button>
                )
              }
            />
          ))}
          {!readOnly && <Composer placeholder="Responder…" onSend={(text) => void addPageComment(pageId, text, t.id)} />}
        </div>
      ))}
      {!readOnly && (
        <Composer
          autoFocus={!threads?.length}
          placeholder="Agregar un comentario…"
          onSend={(text) => void addPropertyComment(pageId, propertyId, text)}
        />
      )}
    </div>
  );
}

type DocNode = { id?: string; content?: unknown; children?: DocNode[] };

/** The commented text of an inline thread, read from the saved page body. */
function anchorText(content: unknown[] | null | undefined, anchor: StoredThread["anchor"]): string {
  if (!anchor || !content) return "";
  const find = (list: DocNode[]): DocNode | undefined => {
    for (const b of list) {
      if (b.id === anchor.block) return b;
      const inner = find(b.children ?? []);
      if (inner) return inner;
    }
  };
  const block = find(content as DocNode[]);
  const text = (c: unknown): string =>
    Array.isArray(c) ? c.map((i: { text?: string; content?: unknown }) => i.text ?? text(i.content)).join("") : "";
  return text(block?.content).slice(anchor.from, anchor.to);
}

/**
 * The comments panel (the topbar's comment icon): every thread of the page,
 * page discussions and inline comments, open or resolved, with replies.
 */
export function CommentsPanel({
  pageId,
  content,
  readOnly,
  onClose,
}: {
  pageId: string;
  content: unknown[] | null;
  readOnly?: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const threads = useLiveQuery(
    async () =>
      (await db.threads.where("page_id").equals(pageId).toArray()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    [pageId],
  );
  const shown = (threads ?? []).filter((t) => t.resolved === (tab === "resolved"));
  const scrollTo = (blockId: string) =>
    document.querySelector(`.bn-block[data-id="${CSS.escape(blockId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  return (
    <aside className="comments-panel" aria-label="Comentarios">
      <header className="comments-panel__head">
        <span className="comments-panel__title">Comentarios</span>
        <button type="button" className="icon-btn" aria-label="Cerrar" data-tooltip="Cerrar" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="comments-panel__tabs" role="tablist">
        {(
          [
            ["open", "Abiertos"],
            ["resolved", "Resueltos"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`comments-panel__tab${tab === id ? " is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="comments-panel__list">
        {!shown.length && (
          <div className="comments-panel__empty">
            <MessageSquareText size={28} />
            <p>{tab === "open" ? "No hay comentarios abiertos" : "No hay comentarios resueltos"}</p>
          </div>
        )}
        {shown.map((t) => {
          const quote = t.metadata?.page ? "" : anchorText(content, t.anchor);
          return (
            <div className="panel-thread" key={t.id}>
              {quote && (
                <button type="button" className="panel-thread__quote" onClick={() => t.anchor && scrollTo(t.anchor.block)}>
                  {quote}
                </button>
              )}
              {t.comments.map((c, i) => (
                <CommentItem
                  key={c.id}
                  pageId={pageId}
                  thread={t}
                  comment={c}
                  readOnly={readOnly}
                  resolve={
                    i === 0 && (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t.resolved ? "Volver a abrir" : "Resolver"}
                        data-tooltip={t.resolved ? "Volver a abrir" : "Resolver"}
                        onClick={() => void setThreadResolved(t.id, !t.resolved)}
                      >
                        {t.resolved ? <RotateCcw size={16} /> : <Check size={16} />}
                      </button>
                    )
                  }
                />
              ))}
              {!readOnly && !t.resolved && (
                <Composer placeholder="Responder…" onSend={(text) => void addPageComment(pageId, text, t.id)} />
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
