import { useState, type ReactNode } from "react";
import { BookOpen, FileCode, FileSpreadsheet, FileText, FileType, ListTree, Sheet, X } from "lucide-react";
import { navigate } from "../lib/hooks";
import { isWorkspaceRoot } from "../lib/model";
import { pickFiles } from "../lib/files";
import { IMPORT_ACCEPT, importFiles, mergeCsv, readFileText, ZIP_ACCEPT, type ImportKind, type ImportTarget } from "../lib/importFiles";
import { undoLast } from "../lib/ops";
import { workspaceParent } from "./TitleBar";
import { Modal, toast } from "./ui";

/** The sources Xot imports locally, in order and with their names. */
const SOURCES: { kind: ImportKind; label: string; icon: ReactNode }[] = [
  { kind: "markdown", label: "Texto y Markdown", icon: <FileText size={22} strokeWidth={1.6} /> },
  { kind: "csv", label: "CSV", icon: <Sheet size={22} strokeWidth={1.6} /> },
  { kind: "html", label: "HTML", icon: <FileCode size={22} strokeWidth={1.6} /> },
  { kind: "word", label: "Word", icon: <FileType size={22} strokeWidth={1.6} /> },
  { kind: "pdf", label: "PDF", icon: <FileText size={22} strokeWidth={1.6} /> },
  { kind: "excel", label: "Excel", icon: <FileSpreadsheet size={22} strokeWidth={1.6} /> },
  { kind: "epub", label: "EPUB", icon: <BookOpen size={22} strokeWidth={1.6} /> },
  { kind: "opml", label: "OPML", icon: <ListTree size={22} strokeWidth={1.6} /> },
];

/** The top level of the workspace the sidebar shows (where ⌘N puts pages). */
export async function workspaceTarget(): Promise<ImportTarget> {
  const [table, id] = await workspaceParent();
  return { table, id };
}

/** The import tiles: each opens the file picker for its formats and imports what's chosen. */
export function ImportSources({ target, onDone }: { target?: ImportTarget; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (kind: ImportKind) => {
    const files = await pickFiles(`${IMPORT_ACCEPT[kind]},${ZIP_ACCEPT}`, true);
    if (!files.length) return;
    setBusy(true);
    try {
      const last = await importFiles(files, target ?? (await workspaceTarget()));
      onDone?.();
      if (last) navigate(last);
      toast(files.length === 1 ? `Se importó «${files[0].name}»` : `Se importaron ${files.length} archivos`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "No se pudo importar el archivo");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="import-grid">
      {SOURCES.map((s) => (
        <button key={s.kind} type="button" className="import-tile" disabled={busy} onClick={() => void run(s.kind)}>
          <span className="import-tile__icon">{s.icon}</span>
          <span className="import-tile__label">{s.label}</span>
        </button>
      ))}
    </div>
  );
}

/** "Importar" from a page's "..." menu or the sidebar: the files become pages (or databases) under `target`. */
export function ImportDialog({ target, onClose }: { target?: ImportTarget; onClose: () => void }) {
  return (
    <Modal onClose={onClose} className="import-dialog" label="Importar">
      <div className="import-dialog__head">
        <span className="import-dialog__title">Importar</span>
        <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <ImportSources target={target} onDone={onClose} />
      <p className="import-dialog__hint">
        {target?.table === "block" && !isWorkspaceRoot(target.id)
          ? "Los archivos se agregan como subpáginas de esta página. Cada CSV u hoja de cálculo se convierte en una base de datos."
          : "Los archivos se agregan como páginas privadas. Cada CSV u hoja de cálculo se convierte en una base de datos."}
      </p>
    </Modal>
  );
}

/** "Combinar con CSV": a CSV's rows join the database; columns match its properties by name. */
export async function mergeCsvFile(collectionId: string) {
  const [file] = await pickFiles(IMPORT_ACCEPT.csv);
  if (!file) return;
  try {
    const { rows, added } = await mergeCsv(collectionId, await readFileText(file));
    const props = added.length ? ` y ${added.length} ${added.length === 1 ? "propiedad" : "propiedades"}` : "";
    toast(`Se agregaron ${rows.toLocaleString("es")} ${rows === 1 ? "fila" : "filas"}${props} desde «${file.name}»`, {
      label: "Deshacer",
      run: () => void undoLast(),
    });
  } catch (e) {
    toast(e instanceof Error ? e.message : "No se pudo combinar el archivo CSV");
  }
}
