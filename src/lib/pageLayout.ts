// "Personalizar diseño": while it is open, the layout being edited is a draft that every page of
// the database shows (the preview); "Aplicar a todas las páginas" saves it, closing drops it.
import { useSyncExternalStore } from "react";
import type { Collection } from "./model";

export type LayoutFields = Pick<Collection, "page_properties" | "property_visibility" | "page_layout">;

const drafts = new Map<string, LayoutFields>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const layoutDraft = (collectionId: string) => drafts.get(collectionId);

export function setLayoutDraft(collectionId: string, draft: LayoutFields | null) {
  if (draft) drafts.set(collectionId, draft);
  else drafts.delete(collectionId);
  emit();
}

/** The layout fields a database's pages show: the draft being edited, else the saved ones. */
export function useRowLayout(collection: Collection | undefined | null): LayoutFields {
  const draft = useSyncExternalStore(subscribe, () => (collection ? drafts.get(collection.id) : undefined));
  if (draft) return draft;
  return {
    page_properties: collection?.page_properties,
    property_visibility: collection?.property_visibility,
    page_layout: collection?.page_layout,
  };
}
