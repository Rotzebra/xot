import { db } from "./db";
import { addToInbox } from "./inbox";
import { emptyQuery, setFormat, shortId, uuid } from "./ops";
import { LOCAL_PERSON, type Collection, type CollectionView } from "./model";
import { pageTitle } from "./hooks";

// Verified pages (wikis): a page can be verified for a while or
// indefinitely; it shows a "Verificada" badge until it expires, and the expiry
// lands in "Bandeja de entrada" so it can be verified again.

const DAY = 86_400_000;

/** "Verificar" choices: days the verification lasts (null: indefinitely). */
export const VERIFY_CHOICES: { label: string; days: number | null }[] = [
  { label: "Durante 1 semana", days: 7 },
  { label: "Durante 30 días", days: 30 },
  { label: "Durante 90 días", days: 90 },
  { label: "Indefinidamente", days: null },
];

export function verifyPage(id: string, until: number | null) {
  return setFormat(id, { verified: { at: Date.now(), until } });
}

export const unverifyPage = (id: string) => setFormat(id, { verified: undefined });

export type VerifyState = "verified" | "expired" | null;

export function verifyState(v: { at: number; until: number | null } | undefined, now = Date.now()): VerifyState {
  if (!v) return null;
  return v.until !== null && v.until <= now ? "expired" : "verified";
}

/** The end of the day `days` from now (verification lasts through that date). */
export const untilIn = (days: number) => new Date(Date.now() + days * DAY).setHours(23, 59, 59, 999);

/** Puts each verification that expired in the inbox (once per expiry). */
export async function checkVerifications() {
  const now = Date.now();
  const expired = await db.blocks
    .filter((b) => b.alive && !!b.format.verified?.until && b.format.verified.until <= now)
    .toArray();
  if (!expired.length) return;
  await addToInbox(
    expired.map((b) => ({
      id: `verify:${b.id}:${b.format.verified!.until}`,
      pageId: b.id,
      title: pageTitle(b),
      body: "Verificación caducada · vuelve a verificar la página",
      at: b.format.verified!.until!,
    })),
  );
}

/** Checks at launch and every hour after. */
export function startVerificationChecks(): () => void {
  void checkVerifications();
  const timer = window.setInterval(() => void checkVerifications(), 3_600_000);
  return () => window.clearInterval(timer);
}

// "Convertir en wiki": the page becomes a database of its subpages, with
// Propietario, Verificación, Etiquetas and Última edición; its own content
// stays as the wiki's "Inicio" view, and "Todas las páginas" lists them.

export async function convertToWiki(id: string): Promise<boolean> {
  const page = await db.blocks.get(id);
  if (!page?.alive || page.type !== "page" || page.parent_table === "collection" || page.is_template) return false;
  const collectionId = uuid();
  const owner = shortId();
  const verification = shortId();
  const tags = shortId();
  const edited = shortId();
  const collection: Collection = {
    id: collectionId,
    parent_id: id,
    schema: {
      title: { name: "Página", type: "title" },
      [owner]: { name: "Propietario", type: "person" },
      [verification]: { name: "Verificación", type: "verification" },
      [tags]: { name: "Etiquetas", type: "multi_select", options: [] },
      [edited]: { name: "Última edición", type: "last_edited_time" },
    },
  };
  const properties = ["title", owner, verification, tags, edited].map((property) => ({ property, visible: true }));
  const home: CollectionView = {
    id: uuid(),
    type: "table",
    name: "Inicio",
    parent_id: id,
    collection_id: collectionId,
    format: { properties: properties.map((p) => ({ ...p })), wiki_home: true },
    query2: emptyQuery(),
  };
  const all: CollectionView = {
    id: uuid(),
    type: "table",
    name: "Todas las páginas",
    parent_id: id,
    collection_id: collectionId,
    format: { properties },
    query2: emptyQuery(),
  };
  await db.transaction("rw", db.blocks, db.collections, db.views, async () => {
    // Subpages become the wiki's pages, owned by the local person; inline databases stay in the content.
    const children = await db.blocks.where("[parent_table+parent_id]").equals(["block", id]).toArray();
    for (const child of children)
      if (child.type === "page")
        await db.blocks.update(child.id, {
          parent_table: "collection",
          parent_id: collectionId,
          properties: { ...child.properties, [owner]: [LOCAL_PERSON] },
        });
    await db.collections.add(collection);
    await db.views.bulkAdd([home, all]);
    await db.blocks.update(id, {
      type: "collection_view_page",
      collection_id: collectionId,
      view_ids: [home.id, all.id],
      format: { ...page.format, wiki: true },
      last_edited_time: Date.now(),
    });
  });
  return true;
}

/** "Revertir a página": the wiki goes back to a page, its pages back to subpages (their wiki values go). */
export async function revertWiki(id: string): Promise<boolean> {
  const wiki = await db.blocks.get(id);
  if (!wiki?.format.wiki || wiki.type !== "collection_view_page" || !wiki.collection_id) return false;
  const collectionId = wiki.collection_id;
  await db.transaction("rw", db.blocks, db.collections, db.views, async () => {
    const rows = await db.blocks.where("[parent_table+parent_id]").equals(["collection", collectionId]).toArray();
    for (const row of rows)
      await db.blocks.update(row.id, {
        parent_table: "block",
        parent_id: id,
        properties: { title: row.properties.title ?? "" },
      });
    await db.views.where("parent_id").equals(id).delete();
    await db.collections.delete(collectionId);
    const format = { ...wiki.format };
    delete format.wiki;
    await db.blocks.update(id, {
      type: "page",
      collection_id: undefined,
      view_ids: undefined,
      format,
      last_edited_time: Date.now(),
    });
  });
  return true;
}
