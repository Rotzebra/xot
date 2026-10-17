import { db, type StoredFile } from "./db";
import { downloadBlob } from "./files";

// Configuración > Espacio de trabajo: the whole local database as one JSON file,
// and back. Restoring adds or replaces records; nothing that isn't in the file is deleted.

const FORMAT = "xot-backup";

type StoredFileJson = Omit<StoredFile, "blob"> & { data: string };

interface Backup {
  format: typeof FORMAT;
  version: 1;
  exported_time: number;
  blocks: unknown[];
  collections: unknown[];
  views: unknown[];
  threads: unknown[];
  snapshots: unknown[];
  synced?: unknown[];
  people?: unknown[];
  files: StoredFileJson[];
}

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export async function exportBackup() {
  const [blocks, collections, views, threads, snapshots, synced, files, people] = await Promise.all([
    db.blocks.toArray(),
    db.collections.toArray(),
    db.views.toArray(),
    db.threads.toArray(),
    db.snapshots.toArray(),
    db.synced.toArray(),
    db.files.toArray(),
    db.people.toArray(),
  ]);
  const backup: Backup = {
    format: FORMAT,
    version: 1,
    exported_time: Date.now(),
    blocks,
    collections,
    views,
    threads,
    snapshots,
    synced,
    people,
    files: await Promise.all(
      files.map(async ({ blob, ...file }) => ({ ...file, data: await toDataUrl(blob) })),
    ),
  };
  const day = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([JSON.stringify(backup)], { type: "application/json" }), `Xot copia de seguridad ${day}.json`);
  return blocks.length;
}

/** Comment threads keep Date objects (BlockNote's thread store compares them). */
function reviveThread(thread: Record<string, unknown>) {
  const date = (v: unknown) => (typeof v === "string" || typeof v === "number" ? new Date(v) : v);
  const comments = (thread.comments as Record<string, unknown>[] | undefined) ?? [];
  return {
    ...thread,
    createdAt: date(thread.createdAt),
    updatedAt: date(thread.updatedAt),
    ...(thread.resolvedUpdatedAt ? { resolvedUpdatedAt: date(thread.resolvedUpdatedAt) } : {}),
    ...(thread.deletedAt ? { deletedAt: date(thread.deletedAt) } : {}),
    comments: comments.map((c) => ({
      ...c,
      createdAt: date(c.createdAt),
      updatedAt: date(c.updatedAt),
      ...(c.deletedAt ? { deletedAt: date(c.deletedAt) } : {}),
    })),
  };
}

/** Reads a backup file; throws with a readable message when it isn't one. */
export async function readBackup(file: File): Promise<Backup> {
  let data: Backup;
  try {
    data = JSON.parse(await file.text()) as Backup;
  } catch {
    throw new Error("El archivo no es una copia de seguridad de Xot.");
  }
  if (data?.format !== FORMAT || !Array.isArray(data.blocks)) throw new Error("El archivo no es una copia de seguridad de Xot.");
  return data;
}

export async function restoreBackup(data: Backup) {
  const files: StoredFile[] = await Promise.all(
    (data.files ?? []).map(async ({ data: url, ...file }) => ({ ...file, blob: await (await fetch(url)).blob() })),
  );
  await db.transaction("rw", [db.blocks, db.collections, db.views, db.threads, db.snapshots, db.synced, db.files, db.people], async () => {
    await db.blocks.bulkPut(data.blocks as never[]);
    await db.collections.bulkPut((data.collections ?? []) as never[]);
    await db.views.bulkPut((data.views ?? []) as never[]);
    await db.threads.bulkPut((data.threads ?? []).map((t) => reviveThread(t as Record<string, unknown>)) as never[]);
    await db.snapshots.bulkPut((data.snapshots ?? []) as never[]);
    await db.synced.bulkPut((data.synced ?? []) as never[]);
    await db.files.bulkPut(files);
    await db.people.bulkPut((data.people ?? []) as never[]);
  });
  return data.blocks.length;
}
