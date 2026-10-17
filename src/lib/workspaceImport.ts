import { db } from "./db";
import { addFavorites } from "./hooks";
import { repairStatusRollups, type Block, type Collection, type CollectionView } from "./model";

interface WorkspaceImport {
  version: 1;
  import_id: string;
  blocks: Block[];
  collections: Collection[];
  views: CollectionView[];
  /** The source's sidebar favorites. */
  favorites?: string[];
}

const KEY = "xotion:import";
/** Favorites the last import brought, so one removed in Xot isn't added back. */
const FAVORITES_KEY = "xotion:import-favorites";
let running: Promise<void> | null = null;

/**
 * Loads public/import.json, when there is one, into IndexedDB. Records keep
 * their ids, so importing a newer file updates the same pages instead of
 * duplicating them.
 */
export function importWorkspaceIfAvailable() {
  running ??= (async () => {
    let data: WorkspaceImport;
    try {
      const res = await fetch("/import.json", { cache: "no-store" });
      if (!res.ok || !res.headers.get("content-type")?.includes("json")) return;
      data = await res.json();
    } catch {
      return;
    }
    let done: string | null = null;
    try {
      done = localStorage.getItem(KEY);
    } catch {
      /* storage unavailable: import every load */
    }
    if (data.version !== 1 || done === data.import_id) return;

    await db.transaction("rw", db.blocks, db.collections, db.views, async () => {
      await db.collections.bulkPut(data.collections);
      // Status rollups older import files brought in as "count".
      await db.collections.bulkPut(repairStatusRollups(data.collections));
      await db.views.bulkPut(data.views);
      await db.blocks.bulkPut(data.blocks);
    });
    if (data.favorites?.length) {
      let known: string[] = [];
      try {
        known = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(data.favorites));
      } catch {
        /* storage unavailable */
      }
      addFavorites(data.favorites.filter((id) => !known.includes(id)));
    }
    try {
      localStorage.setItem(KEY, data.import_id);
    } catch {
      /* ignore */
    }
  })();
  return running;
}
