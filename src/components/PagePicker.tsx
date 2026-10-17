import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { isWorkspaceRoot, type Block } from "../lib/model";
import { pageTitle } from "../lib/hooks";
import { MenuItem, PageIcon } from "./ui";

/** Any page or database, newest first (MovePicker's list without the move rules). */
export function PagePicker({
  placeholder,
  exclude,
  pagesOnly,
  onPick,
}: {
  placeholder: string;
  /** Pages that can't be picked (the page itself). */
  exclude?: string[];
  /** Pages only, no databases (where blocks can go). */
  pagesOnly?: boolean;
  onPick: (page: Block) => void;
}) {
  const [query, setQuery] = useState("");
  const pages = useLiveQuery(
    async () =>
      (
        await db.blocks
          .filter(
            (b) =>
              b.alive &&
              !b.is_template &&
              !b.format.inline &&
              b.parent_table !== "collection" &&
              !isWorkspaceRoot(b.id) &&
              (b.type === "page" || (!pagesOnly && b.type === "collection_view_page")),
          )
          .toArray()
      ).sort((a, b) => b.last_edited_time - a.last_edited_time),
    [pagesOnly],
  );
  const q = query.trim().toLowerCase();
  const list = (pages ?? []).filter((b) => !exclude?.includes(b.id) && pageTitle(b).toLowerCase().includes(q)).slice(0, 50);
  return (
    <div className="menu move-picker">
      <input
        className="menu-search"
        autoFocus
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && list[0]) onPick(list[0]);
        }}
      />
      <div className="menu-label">{q ? "Páginas" : "Recientes"}</div>
      <div className="move-picker__list">
        {list.map((b) => (
          <MenuItem key={b.id} icon={<PageIcon block={b} size={18} />} onClick={() => onPick(b)}>
            {pageTitle(b)}
          </MenuItem>
        ))}
        {pages && list.length === 0 && <div className="menu-empty">Sin resultados</div>}
      </div>
    </div>
  );
}
