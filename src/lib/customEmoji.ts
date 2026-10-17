import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";

// Custom emoji (Configuración > Emoji): small pictures with a name, used as page icons and
// in the text (":nombre"). They live in the files table (kept by backups) under ids "custom-emoji:<name>".

export type CustomEmoji = { name: string; src: string };

const PREFIX = "custom-emoji:";

/** A valid name: lowercase letters, digits, "-" and "_". */
export const emojiName = (raw: string) =>
  raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const cache = new Map<string, { blob: Blob; src: string }>();

/** Every custom emoji, by name, each with a data URL (it travels with a page or an icon). */
export async function listCustomEmojis(): Promise<CustomEmoji[]> {
  const files = await db.files.where("id").startsWith(PREFIX).toArray();
  return Promise.all(
    files
      .sort((a, b) => a.created_time - b.created_time)
      .map(async (f) => {
        const hit = cache.get(f.id);
        const src = hit && hit.blob === f.blob ? hit.src : await toDataUrl(f.blob);
        cache.set(f.id, { blob: f.blob, src });
        return { name: f.name, src };
      }),
  );
}

export function useCustomEmojis(): CustomEmoji[] {
  const files = useLiveQuery(() => db.files.where("id").startsWith(PREFIX).toArray(), []);
  const [list, setList] = useState<CustomEmoji[]>([]);
  useEffect(() => {
    let live = true;
    void listCustomEmojis().then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [files]);
  return list;
}

/** Saves a picture as a custom emoji (scaled down to 128px), replacing one with that name. */
export async function addCustomEmoji(file: Blob, rawName: string): Promise<string> {
  const name = emojiName(rawName) || "emoji";
  const src = await toDataUrl(file);
  const img = new Image();
  img.src = src;
  await img.decode();
  let blob: Blob = file;
  if (file.type !== "image/gif") {
    const scale = Math.min(1, 128 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    blob = (await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"))) ?? file;
  }
  await db.files.put({ id: PREFIX + name, name, type: blob.type || "image/png", blob, created_time: Date.now() });
  return name;
}

export async function removeCustomEmoji(name: string) {
  await db.files.delete(PREFIX + name);
}
