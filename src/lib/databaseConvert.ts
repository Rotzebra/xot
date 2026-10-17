// "Convertir en página" (an inline database becomes a full-page one, linked from where it
// was) and "Convertir en integrada" (a full-page database shows inside its page again).
import { db } from "./db";
import { createPage, updateBlock } from "./ops";
import type { Block } from "./model";

type DocBlock = { id?: string; type?: string; props?: Record<string, unknown>; children?: DocBlock[] };

const uid = () => crypto.randomUUID();

/** The page's blocks with the first block `match` finds replaced by `next`; null when none matched. */
function replaceIn(blocks: DocBlock[], match: (b: DocBlock) => boolean, next: DocBlock): DocBlock[] | null {
  for (let i = 0; i < blocks.length; i++) {
    if (match(blocks[i])) return [...blocks.slice(0, i), next, ...blocks.slice(i + 1)];
    const kids = blocks[i].children;
    if (kids?.length) {
      const inner = replaceIn(kids, match, next);
      if (inner) return [...blocks.slice(0, i), { ...blocks[i], children: inner }, ...blocks.slice(i + 1)];
    }
  }
  return null;
}

/** A database block shown inside a page, for its BlockNote content. */
const databaseBlock = (id: string): DocBlock => ({ id: uid(), type: "database", props: { blockId: id }, children: [] });

/**
 * "Convertir en página" for a page that isn't open: its inline database becomes a full-page one
 * (in the sidebar under the page) and a link to it takes the database's place in the page.
 */
export async function databaseToPage(id: string) {
  const database = await db.blocks.get(id);
  if (!database || database.type !== "collection_view_page") return;
  const page = database.parent_table === "block" ? await db.blocks.get(database.parent_id) : undefined;
  if (page?.content) {
    const next = replaceIn(page.content as DocBlock[], (b) => b.type === "database" && b.props?.blockId === id, {
      id: uid(),
      type: "pageLink",
      props: { pageId: id },
      children: [],
    });
    if (next) await updateBlock(page.id, { content: next });
  } else if (page?.content_markdown?.includes(`%%xotion-db:${id}%%`))
    await updateBlock(page.id, { content_markdown: page.content_markdown.replace(`%%xotion-db:${id}%%`, `%%xotion:${id}%%`) });
  await updateBlock(id, { format: { ...database.format, inline: undefined } });
}

/**
 * "Convertir en integrada": a full-page database shows inside its page, where the link to it was
 * (or at the end). One at the top of the workspace first gets a page of its own.
 * Returns the page that now holds it.
 */
export async function databaseToInline(id: string): Promise<string | undefined> {
  const database = await db.blocks.get(id);
  if (!database || database.type !== "collection_view_page" || database.format.inline) return;
  let page: Block | undefined = database.parent_table === "block" ? await db.blocks.get(database.parent_id) : undefined;
  if (!page) {
    const pageId = await createPage(database.parent_table, database.parent_id, {
      properties: { title: String(database.properties.title ?? "") },
      format: database.format.icon ? { icon: database.format.icon } : {},
      order: database.order,
    });
    await updateBlock(id, { parent_id: pageId, parent_table: "block" });
    page = await db.blocks.get(pageId);
    if (!page) return;
  }
  if (page.content || !page.content_markdown) {
    const blocks = (page.content ?? []) as DocBlock[];
    const next =
      replaceIn(blocks, (b) => b.type === "pageLink" && b.props?.pageId === id, databaseBlock(id)) ?? [...blocks, databaseBlock(id)];
    await updateBlock(page.id, { content: next });
  } else {
    const md = page.content_markdown;
    await updateBlock(page.id, {
      content_markdown: md.includes(`%%xotion:${id}%%`) ? md.replace(`%%xotion:${id}%%`, `%%xotion-db:${id}%%`) : `${md}\n\n%%xotion-db:${id}%%`,
    });
  }
  await updateBlock(id, { format: { ...database.format, inline: true } });
  return page.id;
}

/** Marks a database as shown inside its page or as a full page (the page's content is changed by the caller). */
export async function setDatabaseInline(id: string, inline: boolean) {
  const database = await db.blocks.get(id);
  if (database) await updateBlock(id, { format: { ...database.format, inline: inline || undefined } });
}
