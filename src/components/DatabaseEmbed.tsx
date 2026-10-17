import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link2, Sheet } from "lucide-react";
import { db } from "../lib/db";
import { createLinkedView } from "../lib/ops";
import { pageTitle, useBlock } from "../lib/hooks";
import { PageIcon } from "./ui";
import { DatabaseTitle } from "./PageHeader";
import { DatabaseView } from "./database/DatabaseView";
import { LoadLimitContext } from "./database/loadLimit";

/** The page an editor belongs to, so embedded blocks know where to create things. */
export const PageContext = createContext<string>("");

/**
 * A database shown inside a page: an inline database or a linked view of an
 * existing one. Fully interactive; the
 * editor ignores events inside it because the block has no editable content.
 */
export function DatabaseEmbed({ blockId, onLink }: { blockId: string; onLink: (id: string) => void }) {
  const database = useBlock(blockId || null);
  if (!blockId) return <LinkPicker onLink={onLink} />;
  if (database === undefined) return <div className="db-embed" />;
  if (!database?.alive)
    return (
      <div className="db-embed db-embed--missing" contentEditable={false}>
        <Sheet size={16} /> Base de datos eliminada
      </div>
    );
  return (
    <div className="db-embed" contentEditable={false}>
      {/* The inline title: 24px, edited in place; the icon only when the database has one.
          With a single view the toolbar shares its row. */}
      <LoadLimitContext.Provider value={25}>
        <DatabaseView
          key={database.id}
          block={database}
          embedded
          title={database.format.hide_title ? undefined : <DatabaseTitle block={database} />}
        />
      </LoadLimitContext.Provider>
    </div>
  );
}

/** Choose the database a new linked view shows. */
function LinkPicker({ onLink }: { onLink: (id: string) => void }) {
  const pageId = useContext(PageContext);
  const [query, setQuery] = useState("");
  // Every database's own block (full page or inline), not the linked views of it;
  // inline ones say which page holds them.
  const databases = useLiveQuery(async () => {
    const owners = new Set((await db.collections.toArray()).map((c) => c.parent_id));
    const blocks = await db.blocks.toArray();
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const seen = new Set<string>();
    return blocks
      .filter((b) => b.alive && !b.trashed_time && b.type === "collection_view_page" && b.collection_id && owners.has(b.id))
      .filter((b) => !seen.has(b.collection_id!) && seen.add(b.collection_id!))
      .sort((a, b) => b.last_edited_time - a.last_edited_time)
      .map((b) => ({ block: b, in: b.format.inline ? byId.get(b.parent_id) : undefined }));
  });
  const q = query.trim().toLowerCase();
  // The editor keeps focus after the slash menu inserts the block; the search takes it once mounted.
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="db-embed db-picker" contentEditable={false}>
      <div className="db-picker__head">
        <Link2 size={16} /> Vista vinculada: elige una base de datos
      </div>
      <input
        ref={input}
        className="field"
        placeholder="Buscar base de datos…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="db-picker__list">
        {(databases ?? [])
          .filter(({ block: b }) => (pageTitle(b) || "Sin título").toLowerCase().includes(q))
          .slice(0, 12)
          .map(({ block: b, in: page }) => (
            <button
              type="button"
              key={b.id}
              className="db-picker__item"
              onClick={async () => {
                const id = await createLinkedView(b.collection_id!, pageId);
                if (id) onLink(id);
              }}
            >
              <PageIcon block={b} size={16} />
              <span>{pageTitle(b) || "Sin título"}</span>
              {page && <span className="db-picker__in">en {pageTitle(page) || "Sin título"}</span>}
            </button>
          ))}
      </div>
    </div>
  );
}
