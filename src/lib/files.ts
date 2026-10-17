import { db } from "./db";

// Uploaded files stay on this device. Small ones are inlined as data URLs (they
// travel with the page, like a cover upload); larger ones are kept as Blobs in
// the files table and referenced as xot-file://<id>.

export const FILE_SCHEME = "xot-file://";
const INLINE_LIMIT = 512 * 1024;

const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Stores a file and returns the URL to save in the block or cell. */
export async function storeFile(file: File): Promise<string> {
  if (file.size <= INLINE_LIMIT) return readAsDataUrl(file);
  const id = crypto.randomUUID();
  await db.files.put({ id, name: file.name, type: file.type, blob: file, created_time: Date.now() });
  return `${FILE_SCHEME}${id}`;
}

const objectUrls = new Map<string, string>();

/** The URL to show a stored file with; other URLs are returned as they are. */
export async function resolveFileUrl(url: string): Promise<string> {
  if (!url.startsWith(FILE_SCHEME)) return url;
  const id = url.slice(FILE_SCHEME.length);
  const cached = objectUrls.get(id);
  if (cached) return cached;
  const stored = await db.files.get(id);
  if (!stored) return "";
  const objectUrl = URL.createObjectURL(stored.blob);
  objectUrls.set(id, objectUrl);
  return objectUrl;
}

/** Opens the system file picker; resolves with the chosen files (empty when cancelled). */
export function pickFiles(accept = "*/*", multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/** Saves a Blob as a download. */
export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A file name without the characters file systems reject. */
export const safeFileName = (name: string, fallback = "pagina") => name.replace(/[\\/:*?"<>|]+/g, " ").trim() || fallback;

// ------------------------------------------------------------------ storage

const STORED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A file uploaded moments ago may not be saved in its block yet: it stays at least this long. */
const ORPHAN_GRACE = 24 * 3600 * 1000;

/**
 * Deletes the stored files (uploads kept as xot-file://) that nothing points to any more: no
 * block (trashed pages included, until the trash is emptied), page version, comment, synced
 * block, person, inbox entry or setting. Resolves with how many went and the bytes freed.
 */
export async function sweepOrphanFiles(now = Date.now()): Promise<{ count: number; bytes: number }> {
  const candidates = (await db.files.toArray()).filter((f) => STORED_ID.test(f.id) && now - (f.created_time ?? 0) > ORPHAN_GRACE);
  if (!candidates.length) return { count: 0, bytes: 0 };
  const used = new Set<string>();
  const pattern = /xot-file:\/\/([0-9a-f-]{36})/g;
  const scan = (value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text || !text.includes(FILE_SCHEME)) return;
    for (const m of text.matchAll(pattern)) used.add(m[1]);
  };
  for (const table of [db.blocks, db.collections, db.views, db.threads, db.snapshots, db.synced, db.inbox, db.people] as const)
    await (table as unknown as { each(cb: (row: unknown) => void): Promise<void> }).each(scan);
  try {
    for (let i = 0; i < localStorage.length; i++) scan(localStorage.getItem(localStorage.key(i) ?? ""));
  } catch {
    /* storage unavailable */
  }
  const orphans = candidates.filter((f) => !used.has(f.id));
  if (!orphans.length) return { count: 0, bytes: 0 };
  await db.files.bulkDelete(orphans.map((f) => f.id));
  for (const f of orphans) {
    const url = objectUrls.get(f.id);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(f.id);
  }
  return { count: orphans.length, bytes: orphans.reduce((n, f) => n + (f.blob?.size ?? 0), 0) };
}

/** What Xot keeps on this device: everything (IndexedDB and the rest, when the browser says) and the stored files. */
export async function storageUsage(): Promise<{ total: number | null; quota: number | null; files: number; fileCount: number; persisted: boolean | null }> {
  let files = 0;
  let fileCount = 0;
  await db.files.each((f) => {
    files += f.blob?.size ?? 0;
    fileCount++;
  });
  const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
  const estimate = await storage?.estimate?.().catch(() => null);
  const persisted = (await storage?.persisted?.().catch(() => null)) ?? null;
  return { total: estimate?.usage ?? null, quota: estimate?.quota ?? null, files, fileCount, persisted };
}

/**
 * In a browser, asks it to keep Xot's data when the disk runs low (navigator.storage.persist).
 * The macOS app's storage is already its own.
 */
export async function keepStorage(): Promise<boolean | null> {
  const storage = navigator.storage;
  if (!storage?.persist || navigator.userAgent.includes("Electron")) return null;
  try {
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return null;
  }
}

/** "1,4 MB": a size in bytes, for display. */
export function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toLocaleString("es", { maximumFractionDigits: u && n < 10 ? 1 : 0 })} ${units[u]}`;
}
