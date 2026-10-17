import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CornerUpRight } from "lucide-react";
import { db } from "../lib/db";
import { WORKSPACE_ID, isWorkspaceRoot, type Block } from "../lib/model";
import { getAncestors, movePage, moveToDatabase } from "../lib/ops";
import { pageTitle, useBlock } from "../lib/hooks";
import { MenuItem, PageIcon, Popover } from "./ui";

/** "Mover a": pick a new parent page or database, or the top level of the workspace. */
export function MovePicker({ block, onDone }: { block: Block; onDone: () => void }) {
  const [query, setQuery] = useState("");
  const data = useLiveQuery(async () => {
    const all = await db.blocks.toArray();
    const byId = new Map(all.map((b) => [b.id, b]));
    // Pages inside the one being moved can't become its parent.
    const insideSelf = (b: Block) => {
      for (let cur: Block | undefined = b, guard = 0; cur && guard < 50; guard++) {
        if (cur.id === block.id) return true;
        cur = cur.parent_table === "block" ? byId.get(cur.parent_id) : undefined;
      }
      return false;
    };
    const root = (await getAncestors(block))[0];
    // Pages can also go into a database (as a row): its own block, not a linked view of it.
    const owners = new Map(
      block.type === "page" ? (await db.collections.toArray()).map((c) => [c.parent_id, c.id] as const) : [],
    );
    const targets = all
      .filter(
        (b) =>
          b.alive &&
          (b.type === "page" || (b.type === "collection_view_page" && owners.get(b.id) === b.collection_id)) &&
          b.parent_table !== "collection" &&
          !isWorkspaceRoot(b.id) &&
          b.id !== block.parent_id &&
          (b.type === "page" || b.collection_id !== block.parent_id) &&
          !insideSelf(b),
      )
      .sort((a, b) => b.last_edited_time - a.last_edited_time);
    return { targets, workspace: root && isWorkspaceRoot(root.id) ? root : null };
  }, [block.id, block.parent_id]);

  const q = query.trim().toLowerCase();
  const list = (data?.targets ?? []).filter((b) => pageTitle(b).toLowerCase().includes(q)).slice(0, 50);
  const atTop = block.parent_table === "space" || isWorkspaceRoot(block.parent_id);

  const moveTo = async (table: Block["parent_table"], parent: string) => {
    onDone();
    await movePage(block.id, table, parent);
  };

  return (
    <div className="menu move-picker">
      <input
        className="menu-search"
        autoFocus
        placeholder="Mover página a…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="menu-label">Sugerencias</div>
      {!atTop && !q && (
        <MenuItem
          icon={<CornerUpRight size={18} />}
          onClick={() =>
            void (data?.workspace ? moveTo("block", data.workspace.id) : moveTo("space", WORKSPACE_ID))
          }
        >
          Privado
        </MenuItem>
      )}
      <div className="move-picker__list">
        {list.map((b) => (
          <MenuItem
            key={b.id}
            icon={<PageIcon block={b} size={18} />}
            onClick={() => {
              if (b.type === "page") return void moveTo("block", b.id);
              onDone();
              void moveToDatabase(block.id, b.collection_id!);
            }}
          >
            {pageTitle(b)}
          </MenuItem>
        ))}
        {data && list.length === 0 && <div className="menu-empty">Sin resultados</div>}
      </div>
    </div>
  );
}

/**
 * "Mover a" for database rows and cards: `open(id, anchor)` shows the picker
 * for that page where its menu was; render `element` once.
 */
export function useMoveMenu() {
  const [target, setTarget] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const block = useBlock(target?.id);
  const close = () => setTarget(null);
  const open = (id: string, anchor: HTMLElement) => setTarget({ id, anchor });
  const element =
    target && block ? (
      <Popover anchor={target.anchor} onClose={close} width={320}>
        <MovePicker block={block} onDone={close} />
      </Popover>
    ) : null;
  return { open, element };
}
