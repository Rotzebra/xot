import { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { Radical } from "lucide-react";
import { Popover } from "./ui";

// Equations: TeX rendered with KaTeX, edited in a
// small popover. Block equations are centered on their own line; inline ones
// sit in the text.

function render(latex: string, displayMode: boolean) {
  return katex.renderToString(latex, { displayMode, throwOnError: false, strict: false });
}

/** The TeX parse error, if any (shown under the editor while typing). */
function parseError(latex: string) {
  try {
    katex.renderToString(latex, { throwOnError: true, strict: false });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^KaTeX parse error: /, "") : "Ecuación no válida";
  }
}

/**
 * The equation editor: a monospace box and "Listo"; Enter commits, Shift+Enter breaks the line.
 * `onInput` gets every keystroke, so the equation renders live while it's typed.
 */
function EquationEditor({
  anchor,
  value,
  onInput,
  onDone,
}: {
  anchor: HTMLElement;
  value: string;
  onInput: (latex: string) => void;
  onDone: (latex: string) => void;
}) {
  const [text, setText] = useState(value);
  const error = useMemo(() => (text.trim() ? parseError(text) : null), [text]);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(text.trim());
  };
  return (
    <Popover anchor={anchor} onClose={finish} width={360}>
      <div className="equation-editor">
        <textarea
          className="equation-editor__input"
          autoFocus
          rows={Math.min(8, Math.max(2, text.split("\n").length))}
          spellCheck={false}
          placeholder="E = mc^2"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onInput(e.target.value.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              finish();
            }
          }}
        />
        <div className="equation-editor__foot">
          <span className="equation-editor__error">{error}</span>
          <button type="button" className="xot-btn xot-btn--primary equation-editor__done" onClick={finish}>
            Listo
          </button>
        </div>
      </div>
    </Popover>
  );
}

/** Set by the slash menu: the next block equation to mount is a new one and opens its editor. */
export const newEquation = { pending: false };

/** "Ecuación del bloque". A new, empty one opens its editor right away. */
export function BlockEquation({
  latex,
  editable,
  onChange,
}: {
  latex: string;
  editable: boolean;
  onChange: (latex: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // Only a just-inserted one; an empty equation on a page being opened just shows its placeholder.
    if (!latex && editable && newEquation.pending) {
      newEquation.pending = false;
      setAnchor(ref.current);
    }
  }, []);
  // While the editor is open the block shows what's being typed.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = anchor && draft !== null ? draft : latex;
  const html = useMemo(() => (shown ? render(shown, true) : ""), [shown]);
  return (
    <div
      ref={ref}
      className={`equation-block${shown ? "" : " equation-block--empty"}`}
      contentEditable={false}
      // The editor is portaled, but its clicks still bubble here through React.
      onClick={(e) => editable && ref.current?.contains(e.target as Node) && setAnchor(ref.current)}
    >
      {shown ? (
        <div className="equation-block__tex" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span className="equation-block__placeholder">
          <Radical size={18} /> Añade una ecuación TeX
        </span>
      )}
      {anchor && (
        <EquationEditor
          anchor={anchor}
          value={latex}
          onInput={setDraft}
          onDone={(next) => {
            setAnchor(null);
            setDraft(null);
            if (next !== latex) onChange(next);
          }}
        />
      )}
    </div>
  );
}

/** "Ecuación en línea" ($$…$$ or ⌘⇧E). */
export function InlineEquation({
  latex,
  editable,
  onChange,
}: {
  latex: string;
  editable: boolean;
  onChange: (latex: string) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!latex && editable) setAnchor(ref.current);
  }, []);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = anchor && draft !== null ? draft : latex;
  const html = useMemo(() => (shown ? render(shown, false) : ""), [shown]);
  return (
    <span
      ref={ref}
      className={`equation-inline${shown ? "" : " equation-inline--empty"}`}
      contentEditable={false}
      onClick={(e) => editable && ref.current?.contains(e.target as Node) && setAnchor(ref.current)}
    >
      {shown ? <span dangerouslySetInnerHTML={{ __html: html }} /> : "Nueva ecuación"}
      {anchor && (
        <EquationEditor
          anchor={anchor}
          value={latex}
          onInput={setDraft}
          onDone={(next) => {
            setAnchor(null);
            setDraft(null);
            if (next !== latex) onChange(next);
          }}
        />
      )}
    </span>
  );
}
