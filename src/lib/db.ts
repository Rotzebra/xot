import Dexie, { type EntityTable } from "dexie";
import type { Block, Collection, CollectionView, PropertyValue } from "./model";
import type { StoredThread } from "./comments";

/** An uploaded file (editor media, "Archivos y multimedia" cells), referenced as xot-file://<id>. */
export interface StoredFile {
  id: string;
  name: string;
  type: string;
  blob: Blob;
  created_time: number;
}

/** A synced block's shared content: every copy on any page shows and edits it. */
export interface SyncedContent {
  id: string;
  content: unknown[];
  updated_time: number;
}

/** A page as "Historial de versiones" keeps it. */
export interface PageState {
  title: string;
  /**
   * Icon, cover and property values (rows' too) were added in version 5; older
   * versions only have the title and body, so restoring them leaves the rest alone.
   */
  icon?: string;
  cover?: string;
  cover_position?: number;
  properties?: Record<string, PropertyValue>;
  content: unknown[];
  /** A page edited before it was ever opened still holds its imported Markdown. */
  content_markdown?: string;
  /** A full-page database's version: its description, properties and views (rows have their own). */
  database?: DatabaseState;
}

/** What a full-page database's version keeps besides its title, icon and cover. */
export interface DatabaseState {
  description?: string;
  schema: Collection["schema"];
  views: CollectionView[];
}

/** A saved version of a page, for "Historial de versiones". */
export interface Snapshot extends PageState {
  id?: number;
  page_id: string;
  time: number;
  /** "Nombrar versión": a named version is kept when older ones are pruned. */
  name?: string;
}

/** A reminder that fired, in "Bandeja de entrada" (keyed by the reminder's id, so it lands once). */
export interface InboxEntry {
  id: string;
  page_id: string;
  title: string;
  body: string;
  /** When it was due. */
  time: number;
  read: boolean;
  archived?: boolean;
  /** "automation": sent by an automation's or a button's "Enviar notificación" (`source` is its name). */
  kind?: "automation";
  source?: string;
}

/** Someone a "Persona" property can name: values are names, this is their email and photo (their profile). */
export interface Person {
  name: string;
  email?: string;
  /** An image URL or an uploaded file (xot-file://…). */
  avatar?: string;
  created_time: number;
}

// Storage ids keep the original "xotion" name so data saved before the rename to Xot survives.
export const db = new Dexie("xotion") as Dexie & {
  blocks: EntityTable<Block, "id">;
  collections: EntityTable<Collection, "id">;
  views: EntityTable<CollectionView, "id">;
  threads: EntityTable<StoredThread, "id">;
  files: EntityTable<StoredFile, "id">;
  snapshots: EntityTable<Snapshot, "id">;
  synced: EntityTable<SyncedContent, "id">;
  inbox: EntityTable<InboxEntry, "id">;
  people: EntityTable<Person, "name">;
};

db.version(1).stores({
  blocks: "id, [parent_table+parent_id]",
  collections: "id, parent_id",
  views: "id, parent_id",
});

// Comment threads: page discussions and inline comments, by page.
db.version(2).stores({
  threads: "id, page_id",
});

// Uploaded files and page versions.
db.version(3).stores({
  files: "id",
  snapshots: "++id, page_id, time",
});

// Synced blocks' shared content.
db.version(4).stores({
  synced: "id",
});

// Page versions are listed newest first per page: an index on both, so the
// list is read in order instead of sorting every version in memory.
db.version(5).stores({
  snapshots: "++id, page_id, time, [page_id+time]",
});

// "Bandeja de entrada": fired reminders, newest first.
db.version(6).stores({
  inbox: "id, time",
});

// "Persona": the people directory (email and photo by name). The names kept on
// this device before it existed join it.
db.version(7)
  .stores({
    people: "name",
  })
  .upgrade(async (tx) => {
    let names: unknown = [];
    try {
      names = JSON.parse(localStorage.getItem("xotion:people") ?? "[]");
    } catch {
      /* nothing kept */
    }
    if (!Array.isArray(names)) return;
    const t = Date.now();
    const people = names.filter((n): n is string => typeof n === "string" && !!n.trim()).map((name) => ({ name, created_time: t }));
    await tx.table("people").bulkPut(people);
  });

// Workspace roots are "space-…" blocks. Older ones had a word before that
// prefix: they take the plain id, and their pages and the open workspace follow.
db.version(8)
  .stores({})
  .upgrade(async (tx) => {
    const blocks = tx.table("blocks");
    const old = await blocks.filter((b: Block) => b.parent_table === "space" && /^[a-z]+-space-/.test(b.id)).toArray();
    let open = "";
    try {
      open = JSON.parse(localStorage.getItem("xotion:workspace") ?? '""');
    } catch {
      /* nothing kept */
    }
    for (const b of old as Block[]) {
      const id = b.id.replace(/^[a-z]+-/, "");
      await blocks.delete(b.id);
      if (!(await blocks.get(id))) await blocks.put({ ...b, id });
      await blocks.where("[parent_table+parent_id]").equals(["block", b.id]).modify({ parent_id: id });
      if (open === b.id) {
        try {
          localStorage.setItem("xotion:workspace", JSON.stringify(id));
        } catch {
          /* ignore */
        }
      }
    }
  });
