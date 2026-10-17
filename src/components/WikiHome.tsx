import { House } from "lucide-react";
import type { Block } from "../lib/model";
import { useBlock } from "../lib/hooks";
import { Editor } from "./Editor";

/** The icon of a wiki's "Inicio" tab. */
export const WIKI_HOME_ICON = House;

/** A wiki's "Inicio" view: the wiki page's own content, edited in place. */
export function WikiHome({ block }: { block: Block }) {
  const live = useBlock(block.id);
  if (!live) return null;
  const readOnly = !!live.format.locked || !live.alive;
  return (
    <div className={`page__editor wiki-home${readOnly ? " is-readonly" : ""}`}>
      <Editor key={live.id} block={live} />
    </div>
  );
}
