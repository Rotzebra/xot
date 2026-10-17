import { useEffect, useRef, useState } from "react";
import { FileText, Plus } from "lucide-react";
import type { Block, Collection } from "../../lib/model";
import { addTemplate, applyTemplate } from "../../lib/ops";
import { pageTitle, useTemplates } from "../../lib/hooks";
import { hasOpenPopover, MenuItem, PageIcon } from "../ui";

type StoredBlock = { type?: string; content?: unknown[]; children?: unknown[] };

/** No body yet: nothing stored, or the lone empty paragraph BlockNote starts with. */
export function isEmptyBody(block: Block) {
  if (!block.content?.length) return !block.content_markdown?.trim();
  const blocks = block.content as StoredBlock[];
  return blocks.length === 1 && blocks[0].type === "paragraph" && !blocks[0].content?.length && !blocks[0].children?.length;
}

/**
 * The row editor's key: it changes once a picked template's body has reached
 * the row, so the editor (which reads its content only when mounted) loads it.
 */
export function useBodyKey(row: Block | null | undefined) {
  const [pending, setPending] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const edited = row?.last_edited_time ?? 0;
  useEffect(() => {
    if (pending === null || edited < pending) return;
    setPending(null);
    setVersion((v) => v + 1);
  }, [pending, edited]);
  return { key: `${row?.id}:${version}`, onApplied: setPending };
}

/**
 * The template picker on an empty database page: the "Presiona Intro…" hint,
 * then "Página vacía", the database's templates, and "Nueva plantilla". Without
 * templates only the hint shows, with its "crea una plantilla" link. It goes away
 * once the page has a body.
 */
export function TemplatePicker({
  row,
  collection,
  onApplied,
  onEmpty,
  onOpenTemplate,
}: {
  row: Block;
  collection: Collection;
  /** The row's content was replaced (at or after `since`): the editor has to load it again. */
  onApplied: (since: number) => void;
  /** "Página vacía": start typing in the body. */
  onEmpty: () => void;
  onOpenTemplate: (id: string) => void;
}) {
  const templates = useTemplates(collection.id);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const emptyRef = useRef(onEmpty);
  emptyRef.current = onEmpty;
  const shown = !!templates && !row.is_template && !row.format.locked && dismissed !== row.id && isEmptyBody(row);

  // Enter with nothing focused starts the empty page, and so does
  // reaching the body any other way (the title's Enter, a click): the prompt goes.
  useEffect(() => {
    if (!shown) return;
    const onFocus = (e: FocusEvent) => {
      const host = ref.current?.parentElement;
      const target = e.target as Element | null;
      if (host && target instanceof Element && host.contains(target) && target.closest(".bn-editor")) setDismissed(row.id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      // A peek over this page takes the key for its own row.
      const peek = document.querySelector(".peek");
      if (hasOpenPopover() || (peek && !peek.contains(ref.current))) return;
      e.preventDefault();
      setDismissed(row.id);
      emptyRef.current();
    };
    document.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, [shown, row.id]);
  if (!shown || !templates) return null;

  const create = async () => onOpenTemplate(await addTemplate(collection.id));
  if (!templates.length)
    return (
      <div ref={ref} className="template-picker">
        <div className="template-picker__hint">
          Presiona Intro para continuar con una página vacía o{" "}
          <button type="button" className="link-btn" onClick={() => void create()}>
            crea una plantilla
          </button>
        </div>
      </div>
    );

  return (
    <div ref={ref} className="template-picker">
      <div className="template-picker__hint">Presiona Intro para continuar con una página vacía o elige una plantilla</div>
      <MenuItem
        icon={<FileText size={20} />}
        onClick={() => {
          setDismissed(row.id);
          onEmpty();
        }}
      >
        Página vacía
      </MenuItem>
      {templates.map((t) => (
        <MenuItem
          key={t.id}
          icon={<PageIcon block={t} size={20} />}
          onClick={async () => {
            const since = Date.now();
            await applyTemplate(row.id, t.id);
            // A template without a body still counts as the pick.
            setDismissed(row.id);
            onApplied(since);
          }}
        >
          {pageTitle(t)}
        </MenuItem>
      ))}
      <MenuItem icon={<Plus size={20} />} onClick={() => void create()}>
        Nueva plantilla
      </MenuItem>
    </div>
  );
}
