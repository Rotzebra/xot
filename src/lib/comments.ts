import { DefaultThreadStoreAuth, ThreadStore, type CommentBody, type CommentData, type ThreadData } from "@blocknote/core/comments";
import { liveQuery, type Subscription } from "dexie";
import { db } from "./db";

// Comments live in their own table, by page. Inline threads go through BlockNote's
// comments UI; page discussions (metadata.page) show under the title. BlockNote
// doesn't keep its comment marks in the saved blocks, so each inline thread also
// stores where its mark sits (block id + offsets), and the editor puts it back.

/** Xot is single-user: every comment is yours. */
export const LOCAL_USER = { id: "local", username: "Tú", avatarUrl: "" };

export interface CommentAnchor {
  block: string;
  from: number;
  to: number;
}

export type StoredThread = ThreadData & { page_id: string; anchor?: CommentAnchor };

const newId = () => crypto.randomUUID();

function newComment(body: CommentBody, metadata?: unknown): CommentData {
  const now = new Date();
  return { type: "comment", id: newId(), userId: LOCAL_USER.id, createdAt: now, updatedAt: now, reactions: [], metadata, body };
}

/** A comment body (a BlockNote document) as plain text. */
export function commentText(body: CommentBody): string {
  const text = (content: unknown): string =>
    Array.isArray(content)
      ? content.map((i: { text?: string; content?: unknown }) => i.text ?? text(i.content)).join("")
      : "";
  return Array.isArray(body) ? body.map((b: { content?: unknown }) => text(b.content)).join("\n") : "";
}

export const textBody = (text: string): CommentBody =>
  text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line, styles: {} }] : [] }));

// ------------------------------------------------------------ page discussions

export async function addPageComment(pageId: string, text: string, threadId?: string) {
  const comment = newComment(textBody(text));
  if (threadId) {
    const t = await db.threads.get(threadId);
    if (t) await db.threads.put({ ...t, updatedAt: new Date(), comments: [...t.comments, comment] });
    return;
  }
  const now = new Date();
  await db.threads.put({
    type: "thread",
    id: newId(),
    page_id: pageId,
    createdAt: now,
    updatedAt: now,
    comments: [comment],
    resolved: false,
    metadata: { page: true },
  });
}

/** A comment on a property's value on a page (property comments): a page thread tied to the property. */
export async function addPropertyComment(pageId: string, propertyId: string, text: string) {
  const now = new Date();
  await db.threads.put({
    type: "thread",
    id: newId(),
    page_id: pageId,
    createdAt: now,
    updatedAt: now,
    comments: [newComment(textBody(text))],
    resolved: false,
    metadata: { page: true, property: propertyId },
  });
}

export async function setThreadResolved(threadId: string, resolved: boolean) {
  const t = await db.threads.get(threadId);
  if (t) await db.threads.put({ ...t, resolved, resolvedUpdatedAt: new Date(), resolvedBy: LOCAL_USER.id });
}

export async function deletePageComment(threadId: string, commentId: string) {
  const t = await db.threads.get(threadId);
  if (!t) return;
  const comments = t.comments.filter((c) => c.id !== commentId);
  if (comments.length) await db.threads.put({ ...t, comments });
  else await db.threads.delete(threadId);
}

/** "Editar comentario": new text for a comment of any thread; its time then reads "(editado)". */
export async function updatePageComment(threadId: string, commentId: string, text: string) {
  const t = await db.threads.get(threadId);
  if (!t) return;
  const now = new Date();
  await db.threads.put({
    ...t,
    updatedAt: now,
    comments: t.comments.map((c) => (c.id === commentId ? ({ ...c, body: textBody(text), updatedAt: now } as CommentData) : c)),
  });
}

/** Adds your reaction with this emoji to a comment, or takes it back when it's already there. */
export async function toggleReaction(threadId: string, commentId: string, emoji: string) {
  const t = await db.threads.get(threadId);
  if (!t) return;
  const comments = t.comments.map((c) => {
    if (c.id !== commentId) return c;
    const list = c.reactions ?? [];
    const existing = list.find((r) => r.emoji === emoji);
    const reactions = !existing
      ? [...list, { emoji, createdAt: new Date(), userIds: [LOCAL_USER.id] }]
      : existing.userIds.includes(LOCAL_USER.id)
        ? list
            .map((r) => (r === existing ? { ...r, userIds: r.userIds.filter((u) => u !== LOCAL_USER.id) } : r))
            .filter((r) => r.userIds.length)
        : list.map((r) => (r === existing ? { ...r, userIds: [...r.userIds, LOCAL_USER.id] } : r));
    return { ...c, reactions };
  });
  await db.threads.put({ ...t, comments });
}

// ------------------------------------------------------------- inline threads

/** BlockNote's thread store over the threads table, for one page's inline comments. */
export class LocalThreadStore extends ThreadStore {
  private threads = new Map<string, StoredThread>();
  private snapshot = new Map<string, ThreadData>();
  private subscribers = new Set<(threads: Map<string, ThreadData>) => void>();
  readonly ready: Promise<StoredThread[]>;
  /** Unset: BlockNote marks the commented text itself. */
  addThreadToDocument = undefined;

  /** Follows the table, so replies and resolves from the comments panel show in the editor too. */
  private live: Subscription | null = null;

  constructor(private readonly pageId: string) {
    super(new DefaultThreadStoreAuth(LOCAL_USER.id, "editor"));
    this.ready = db.threads
      .where("page_id")
      .equals(pageId)
      .toArray()
      .then((rows) => {
        for (const row of rows) if (!row.metadata?.page) this.threads.set(row.id, row);
        this.emit();
        return [...this.threads.values()];
      });
  }

  /** Starts following the table (the editor calls it on mount, `dispose` on unmount). */
  connect() {
    if (this.live) return;
    this.live = liveQuery(() => db.threads.where("page_id").equals(this.pageId).toArray()).subscribe((list) => {
      this.threads = new Map(list.filter((row) => !row.metadata?.page).map((row) => [row.id, row]));
      this.emit();
    });
  }

  dispose() {
    this.live?.unsubscribe();
    this.live = null;
  }

  private emit() {
    this.snapshot = new Map([...this.threads].map(([id, { page_id: _p, anchor: _a, ...t }]) => [id, t as ThreadData]));
    for (const cb of this.subscribers) cb(this.snapshot);
  }

  private async save(thread: StoredThread) {
    this.threads.set(thread.id, thread);
    this.emit();
    await db.threads.put(thread);
  }

  private stored(threadId: string) {
    const t = this.threads.get(threadId);
    if (!t) throw new Error(`Comment thread ${threadId} not found`);
    return t;
  }

  private editComment(threadId: string, commentId: string, change: (c: CommentData) => CommentData) {
    const t = this.stored(threadId);
    return this.save({ ...t, updatedAt: new Date(), comments: t.comments.map((c) => (c.id === commentId ? change(c) : c)) });
  }

  /** Records where each thread's mark is now (called when the page saves). */
  syncAnchors(anchors: Map<string, CommentAnchor>) {
    for (const t of this.threads.values()) {
      const a = anchors.get(t.id);
      if (!a || (t.anchor && t.anchor.block === a.block && t.anchor.from === a.from && t.anchor.to === a.to)) continue;
      t.anchor = a;
      void db.threads.update(t.id, { anchor: a });
    }
  }

  async createThread(options: { initialComment: { body: CommentBody; metadata?: unknown }; metadata?: unknown }) {
    const now = new Date();
    const thread: StoredThread = {
      type: "thread",
      id: newId(),
      page_id: this.pageId,
      createdAt: now,
      updatedAt: now,
      comments: [newComment(options.initialComment.body, options.initialComment.metadata)],
      resolved: false,
      metadata: options.metadata,
    };
    await this.save(thread);
    return this.snapshot.get(thread.id)!;
  }

  async addComment(options: { comment: { body: CommentBody; metadata?: unknown }; threadId: string }) {
    const t = this.stored(options.threadId);
    const comment = newComment(options.comment.body, options.comment.metadata);
    await this.save({ ...t, updatedAt: new Date(), comments: [...t.comments, comment] });
    return comment;
  }

  async updateComment(options: { comment: { body: CommentBody; metadata?: unknown }; threadId: string; commentId: string }) {
    await this.editComment(options.threadId, options.commentId, (c) => ({
      ...c,
      body: options.comment.body,
      metadata: options.comment.metadata ?? c.metadata,
      updatedAt: new Date(),
    }) as CommentData);
  }

  async deleteComment(options: { threadId: string; commentId: string }) {
    const t = this.stored(options.threadId);
    const comments = t.comments.filter((c) => c.id !== options.commentId);
    if (!comments.length) return this.deleteThread({ threadId: t.id });
    await this.save({ ...t, updatedAt: new Date(), comments });
  }

  async deleteThread(options: { threadId: string }) {
    this.threads.delete(options.threadId);
    this.emit();
    await db.threads.delete(options.threadId);
  }

  async resolveThread(options: { threadId: string }) {
    const t = this.stored(options.threadId);
    await this.save({ ...t, resolved: true, resolvedUpdatedAt: new Date(), resolvedBy: LOCAL_USER.id });
  }

  async unresolveThread(options: { threadId: string }) {
    const t = this.stored(options.threadId);
    await this.save({ ...t, resolved: false, resolvedUpdatedAt: new Date() });
  }

  async addReaction(options: { threadId: string; commentId: string; emoji: string }) {
    await this.editComment(options.threadId, options.commentId, (c) => {
      const existing = c.reactions.find((r) => r.emoji === options.emoji);
      const reactions = existing
        ? c.reactions.map((r) => (r === existing ? { ...r, userIds: [...new Set([...r.userIds, LOCAL_USER.id])] } : r))
        : [...c.reactions, { emoji: options.emoji, createdAt: new Date(), userIds: [LOCAL_USER.id] }];
      return { ...c, reactions };
    });
  }

  async deleteReaction(options: { threadId: string; commentId: string; emoji: string }) {
    await this.editComment(options.threadId, options.commentId, (c) => ({
      ...c,
      reactions: c.reactions
        .map((r) => (r.emoji === options.emoji ? { ...r, userIds: r.userIds.filter((u) => u !== LOCAL_USER.id) } : r))
        .filter((r) => r.userIds.length),
    }));
  }

  getThread(threadId: string): ThreadData {
    const t = this.snapshot.get(threadId);
    if (!t) throw new Error(`Comment thread ${threadId} not found`);
    return t;
  }

  getThreads(): Map<string, ThreadData> {
    return this.snapshot;
  }

  subscribe(cb: (threads: Map<string, ThreadData>) => void) {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }
}
