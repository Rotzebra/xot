import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Block } from "../lib/model";
import { exportPage, exportWorkspace, type ExportFormat, type ExportOptions, type PageFormat } from "../lib/pageExport";
import { MenuItem, Modal, Popover, Switch, toast, usePopover } from "./ui";

const FORMATS: [ExportFormat, string][] = [
  ["pdf", "PDF"],
  ["html", "HTML"],
  ["markdown", "Markdown y CSV"],
];

/** The "Formato de página" options for PDF. */
const PAGE_FORMATS: [PageFormat, string][] = [
  ["A4", "A4"],
  ["Letter", "Carta"],
  ["Legal", "Legal"],
  ["A3", "A3"],
  ["Tabloid", "Tabloide"],
];

/** "Porcentaje de escala": a number field (10-200), applied when it loses focus or on Enter. */
function ScaleField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Math.round(Number(text.replace(",", ".")));
    const next = Number.isFinite(n) && n > 0 ? Math.min(200, Math.max(10, n)) : value;
    setText(String(next));
    onChange(next);
  };
  return (
    <span className="export-scale">
      <input
        className="export-scale__input"
        inputMode="numeric"
        aria-label="Porcentaje de escala"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span>%</span>
    </span>
  );
}

/** A row's value as a button that opens its options, like the dialog selects. */
function Select<T extends string | boolean>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  const pop = usePopover();
  return (
    <>
      <button type="button" className="xot-select" onClick={(e) => pop.toggle(e.currentTarget)}>
        <span>{options.find(([v]) => v === value)?.[1]}</span>
        <ChevronDown size={14} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={220} align="end">
          <div className="menu">
            {options.map(([v, label]) => (
              <MenuItem
                key={String(v)}
                right={v === value ? <Check size={16} /> : undefined}
                onClick={() => {
                  onChange(v);
                  pop.close();
                }}
              >
                {label}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** The "Exportar" dialog: format, content, subpages and folders. */
export function ExportDialog({ block, onClose }: { block: Block; onClose: () => void }) {
  const isDatabase = block.type === "collection_view_page";
  const [options, setOptions] = useState<ExportOptions>({
    format: isDatabase ? "markdown" : "pdf",
    files: true,
    subpages: false,
    folders: true,
    pageFormat: "A4",
    scale: 100,
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ExportOptions>) => setOptions((o) => ({ ...o, ...patch }));

  const run = async () => {
    setBusy(true);
    try {
      await exportPage(block, options);
      onClose();
    } catch {
      toast("No se pudo exportar la página");
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} className="export-dialog" label="Exportar">
      <div className="export-dialog__rows">
        <div className="dialog-row">
          <span>Formato de exportación</span>
          <Select value={options.format} options={FORMATS} onChange={(format) => set({ format })} />
        </div>
        <div className="dialog-row">
          <span>Incluir contenido</span>
          <Select
            value={options.files}
            options={[
              [true, "Todo"],
              [false, "Sin archivos ni imágenes"],
            ]}
            onChange={(files) => set({ files })}
          />
        </div>
        <button type="button" className="dialog-row" onClick={() => set({ subpages: !options.subpages })}>
          <span>{isDatabase ? "Incluir páginas de la base de datos" : "Incluir subpáginas"}</span>
          <Switch on={options.subpages} />
        </button>
        {options.format !== "markdown" && (
          <button type="button" className="dialog-row" onClick={() => set({ comments: !options.comments })}>
            <span>Incluir comentarios</span>
            <Switch on={!!options.comments} />
          </button>
        )}
        {options.format === "pdf" && (
          <>
            <div className="dialog-row">
              <span>Formato de página</span>
              <Select value={options.pageFormat ?? "A4"} options={PAGE_FORMATS} onChange={(pageFormat) => set({ pageFormat })} />
            </div>
            <div className="dialog-row">
              <span>Porcentaje de escala</span>
              <ScaleField value={options.scale ?? 100} onChange={(scale) => set({ scale })} />
            </div>
          </>
        )}
        {options.format !== "pdf" && (
          <button
            type="button"
            className="dialog-row"
            disabled={!options.subpages}
            onClick={() => set({ folders: !options.folders })}
          >
            <span>Crear carpetas para subpáginas</span>
            <Switch on={options.subpages && options.folders} />
          </button>
        )}
      </div>
      <div className="xot-modal__actions">
        <button type="button" className="xot-btn" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="xot-btn xot-btn--primary" disabled={busy} onClick={() => void run()}>
          {busy ? "Exportando…" : "Exportar"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Configuración > "Exportar todo el contenido del espacio de trabajo": every page and database
 * in one .zip, as HTML or Markdown and CSV.
 */
export function WorkspaceExportDialog({ onClose }: { onClose: () => void }) {
  const [options, setOptions] = useState<Pick<ExportOptions, "format" | "files" | "folders" | "comments">>({
    format: "html",
    files: true,
    folders: true,
    comments: false,
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof options>) => setOptions((o) => ({ ...o, ...patch }));
  const run = async () => {
    setBusy(true);
    try {
      await exportWorkspace(options);
      toast("Se exportó el espacio de trabajo");
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "No se pudo exportar el espacio de trabajo");
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} className="export-dialog" label="Exportar todo el contenido del espacio de trabajo">
      <div className="export-dialog__head">Exportar todo el contenido del espacio de trabajo</div>
      <div className="export-dialog__rows">
        <div className="dialog-row">
          <span>Formato de exportación</span>
          <Select
            value={options.format}
            options={FORMATS.filter(([f]) => f !== "pdf")}
            onChange={(format) => set({ format })}
          />
        </div>
        <div className="dialog-row">
          <span>Incluir contenido</span>
          <Select
            value={options.files}
            options={[
              [true, "Todo"],
              [false, "Sin archivos ni imágenes"],
            ]}
            onChange={(files) => set({ files })}
          />
        </div>
        <button type="button" className="dialog-row" onClick={() => set({ folders: !options.folders })}>
          <span>Crear carpetas para subpáginas</span>
          <Switch on={options.folders} />
        </button>
        {options.format === "html" && (
          <button type="button" className="dialog-row" onClick={() => set({ comments: !options.comments })}>
            <span>Incluir comentarios</span>
            <Switch on={!!options.comments} />
          </button>
        )}
      </div>
      <p className="export-dialog__note">Todas las páginas y bases de datos, con sus subpáginas, en un archivo .zip.</p>
      <div className="xot-modal__actions">
        <button type="button" className="xot-btn" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="xot-btn xot-btn--primary" disabled={busy} onClick={() => void run()}>
          {busy ? "Exportando…" : "Exportar"}
        </button>
      </div>
    </Modal>
  );
}
