import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../lib/db";
import type { PropertySchema } from "../../lib/model";
import { PROPERTY_TYPE_LABELS } from "../../lib/model";
import { updateSchema } from "../../lib/ops";
import { formulaSource, runFormula } from "../../lib/compute";
import { compile, display, FormulaError, typeName, type FValue } from "../../lib/formula";
import { FORMULA_BUILTINS, FORMULA_FUNCTIONS, NO_ARGUMENTS, type FormulaDoc } from "../../lib/formulaDocs";
import { Popover } from "../ui";
import { numberText, TypeIcon } from "./properties";

/** One entry of the editor's list: a property of this database, a built-in or a function. */
type Item = { kind: "property"; id: string; name: string; schema: PropertySchema } | { kind: "builtin" | "function"; doc: FormulaDoc };

const itemKey = (item: Item) => (item.kind === "property" ? `p:${item.id}` : `${item.kind}:${item.doc.name}`);
const itemName = (item: Item) => (item.kind === "property" ? item.name : item.doc.name);

/** The identifier being typed just before the caret ("su" in `prop("A").su|`). */
function wordAt(source: string, caret: number) {
  const before = source.slice(0, caret);
  // Inside a string (prop("Pre|) the word is the property name typed so far.
  const quote = /prop\(\s*["“']([^"”']*)$/.exec(before);
  if (quote) return { word: quote[1], start: caret - quote[0].length, inProp: true };
  const m = /[\p{L}_$][\p{L}\p{N}_$]*$/u.exec(before);
  return { word: m?.[0] ?? "", start: caret - (m?.[0].length ?? 0), inProp: false };
}

/** The function whose parentheses hold the caret, for its help. */
function enclosingFunction(source: string, caret: number): string | null {
  let depth = 0;
  for (let i = caret - 1; i >= 0; i--) {
    const c = source[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) return /[\p{L}_$][\p{L}\p{N}_$]*$/u.exec(source.slice(0, i))?.[0] ?? null;
      depth--;
    }
  }
  return null;
}

type Segment = { text: string; cls?: string };

/** Syntax colors for the source: property tokens, functions, strings, numbers, comments. Never throws. */
function highlight(source: string, error?: { at?: number; end?: number }): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  const push = (text: string, cls?: string) => text && out.push({ text, cls });
  while (i < source.length) {
    const rest = source.slice(i);
    const prop = /^prop\(\s*(["“'])([^"”']*)(["”'])\s*\)/.exec(rest);
    if (prop) {
      const open = prop[0].indexOf(prop[1]) + 1;
      push(prop[0].slice(0, open), "hl-prop hl-prop--edge");
      push(prop[2], "hl-prop hl-prop--name");
      push(prop[0].slice(open + prop[2].length), "hl-prop hl-prop--edge");
      i += prop[0].length;
      continue;
    }
    if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/");
      const len = close < 0 ? rest.length : close + 2;
      push(rest.slice(0, len), "hl-comment");
      i += len;
      continue;
    }
    const quote = /^["“']/.exec(rest);
    if (quote) {
      const close = quote[0] === "“" ? "”" : quote[0];
      let j = 1;
      while (j < rest.length && rest[j] !== close) j += rest[j] === "\\" ? 2 : 1;
      push(rest.slice(0, j + 1), "hl-string");
      i += j + 1;
      continue;
    }
    const num = /^(\d+(\.\d+)?|\.\d+)/.exec(rest);
    if (num) {
      push(num[0], "hl-number");
      i += num[0].length;
      continue;
    }
    const id = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(rest);
    if (id) {
      const word = id[0];
      const cls = /^\s*\(/.test(rest.slice(word.length))
        ? "hl-function"
        : ["true", "false", "and", "or", "not"].includes(word)
          ? "hl-keyword"
          : ["current", "index"].includes(word)
            ? "hl-variable"
            : undefined;
      push(word, cls);
      i += word.length;
      continue;
    }
    push(source[i], /[+\-*/%^=!<>?:]/.test(source[i]) ? "hl-operator" : undefined);
    i++;
  }
  // The error's span gets a red underline (the whole end when it has no span).
  if (!error || error.at === undefined) return out;
  const at = Math.min(error.at, Math.max(0, source.length - 1));
  const end = Math.max(at + 1, error.end ?? source.length);
  const marked: Segment[] = [];
  let pos = 0;
  for (const s of out) {
    const a = pos;
    const b = pos + s.text.length;
    pos = b;
    if (b <= at || a >= end) {
      marked.push(s);
      continue;
    }
    const cut = [Math.max(a, at), Math.min(b, end)];
    if (cut[0] > a) marked.push({ text: s.text.slice(0, cut[0] - a), cls: s.cls });
    marked.push({ text: s.text.slice(cut[0] - a, cut[1] - a), cls: `${s.cls ?? ""} hl-error` });
    if (cut[1] < b) marked.push({ text: s.text.slice(cut[1] - a), cls: s.cls });
  }
  return marked;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The result's type as the editor names it: "Número", "Lista de páginas"… */
function resultType(v: FValue): string {
  if (Array.isArray(v)) {
    // Empty items don't change the list's type.
    const kinds = new Set(v.filter((x) => x !== null).map(typeName));
    if (kinds.size !== 1) return "Lista";
    const [one] = kinds;
    return `Lista de ${{ número: "números", texto: "textos", fecha: "fechas", página: "páginas", booleano: "booleanos", lista: "listas", vacío: "vacíos" }[one] ?? one}`;
  }
  return capital(typeName(v));
}

/** The preview of a result: lists between brackets, numbers as the cell formats them, everything else as text. */
function previewText(v: FValue, schema: PropertySchema): string {
  if (Array.isArray(v)) return `[${v.map((x) => previewText(x, schema)).join(", ")}]`;
  if (typeof v === "number") return numberText(v, schema);
  return display(v);
}

/**
 * The formula editor: the source with syntax colors and property tokens,
 * the result for the first row (with its type) or the error marked in the source,
 * and the list of properties, built-ins and functions that filters as you type
 * (↑/↓ and Tab or Enter insert), with the help of the one highlighted.
 * "Listo" (or Enter) saves; Shift+Enter starts a new line.
 */
export function FormulaEditor({
  anchor,
  placement = "below",
  collectionId,
  propertyId,
  schema,
  onClose,
}: {
  anchor: HTMLElement;
  /** "cover": in place of the property menu it opens from (the anchor). */
  placement?: "below" | "cover";
  collectionId: string;
  propertyId: string;
  schema: PropertySchema;
  onClose: () => void;
}) {
  const collection = useLiveQuery(() => db.collections.get(collectionId), [collectionId]);
  const [source, setSource] = useState<string | null>(null);
  const initial = collection ? formulaSource(schema.formula, collection) : "";
  const draft = source ?? initial;
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const preview = useLiveQuery(async () => {
    const c = await db.collections.get(collectionId);
    if (!c || !draft.trim()) return { empty: true as const };
    const rows = await db.blocks.where("[parent_table+parent_id]").equals(["collection", collectionId]).toArray();
    const first = rows.filter((b) => b.alive && !b.is_template).sort((a, b) => a.order - b.order)[0];
    try {
      if (!first) {
        compile(draft);
        return { empty: true as const };
      }
      return { value: await runFormula(first, draft, c) };
    } catch (e) {
      const err = e instanceof FormulaError ? e : new FormulaError(e instanceof Error ? e.message : String(e));
      return { error: err.message, at: err.at, end: err.end };
    }
  }, [collectionId, draft]);

  const commit = () => {
    if (source === null || source === initial) return;
    void updateSchema(collectionId, propertyId, { formula: { kind: "expression", source } });
  };
  // Closing the editor any other way (Escape, a click outside) saves too, as before.
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => () => latest.current(), []);
  const done = () => {
    commit();
    latest.current = () => {};
    onClose();
  };

  // The caret starts at the end of the formula.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || !collection) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    setCaret(el.value.length);
  }, [!!collection]);

  const properties: Item[] = useMemo(
    () =>
      Object.entries(collection?.schema ?? {})
        .filter(([id]) => id !== propertyId)
        .map(([id, s]) => ({ kind: "property" as const, id, name: s.name, schema: s })),
    [collection, propertyId],
  );
  const builtins: Item[] = FORMULA_BUILTINS.map((doc) => ({ kind: "builtin", doc }));
  const functions: Item[] = FORMULA_FUNCTIONS.map((doc) => ({ kind: "function", doc }));

  const { word, start, inProp } = wordAt(draft, caret);
  const q = word.toLowerCase();
  const matches = (item: Item) => {
    const name = itemName(item).toLowerCase();
    return item.kind === "property" ? name.includes(q) : name.startsWith(q);
  };
  // Typing filters the list; the property list alone inside prop("…"), the functions alone after a ".".
  const filtering = !!q || inProp;
  const method = !inProp && draft.slice(0, start).trimEnd().endsWith(".");
  const sections: [string, Item[]][] = (
    [
      ["Propiedades", method ? [] : properties.filter((p) => !filtering || matches(p))],
      // Only the named built-ins (and, true, current…) match what's typed.
      ["Integradas", inProp || method ? [] : builtins.filter((b) => !filtering || (/^\w/.test(itemName(b)) && matches(b)))],
      ["Funciones", inProp ? [] : functions.filter((f) => !filtering || matches(f))],
    ] as [string, Item[]][]
  ).filter(([, items]) => items.length);
  // Exact names first, then the ones that start with what's typed; the section with the best match leads.
  const rank = (item: Item) => {
    const name = itemName(item).toLowerCase();
    return name === q ? 0 : name.startsWith(q) ? 1 : 2;
  };
  if (filtering) {
    for (const section of sections) section[1].sort((a, b) => rank(a) - rank(b));
    sections.sort((a, b) => rank(a[1][0]) - rank(b[1][0]));
  }
  const flat = sections.flatMap(([, items]) => items);
  const selected = filtering ? flat[Math.min(active, flat.length - 1)] : undefined;
  useEffect(() => setActive(0), [q, inProp]);
  useEffect(() => {
    if (!selected) return;
    listRef.current?.querySelector(`[data-key="${CSS.escape(itemKey(selected))}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected && itemKey(selected)]);

  // Help: the hovered entry, else the highlighted one, else the function around the caret.
  const around = enclosingFunction(draft, caret);
  const helpItem =
    flat.find((i) => itemKey(i) === hover) ??
    selected ??
    functions.find((f) => f.kind === "function" && f.doc.name === around) ??
    undefined;

  const insert = (item: Item) => {
    const el = inputRef.current;
    if (!el) return;
    let text: string;
    let back = 0;
    const from = start;
    if (item.kind === "property") {
      text = `prop("${item.name}")`;
    } else if (item.kind === "function") {
      const fn = item.doc.name;
      text = `${fn}()`;
      back = NO_ARGUMENTS.has(fn) ? 0 : 1;
    } else {
      text = item.doc.insert ?? item.doc.name;
      if (text === "/*  */") back = 3;
    }
    // A property picked inside prop("…") replaces the whole call typed so far.
    if (inProp && item.kind === "property") {
      const tail = /^[^"”']*["”']?\s*\)?/.exec(draft.slice(caret))?.[0] ?? "";
      apply(draft.slice(0, from) + text + draft.slice(caret + tail.length), from + text.length);
      return;
    }
    const next = draft.slice(0, from) + text + draft.slice(caret);
    apply(next, from + text.length - back);
  };
  const apply = (next: string, at: number) => {
    setSource(next);
    setCaret(at);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
    });
  };

  const err = preview && "error" in preview ? preview : null;
  const segments = highlight(draft, err ?? undefined);

  return (
    <Popover anchor={anchor} onClose={onClose} width={720} placement={placement} className="formula-editor-popover">
      <div className="formula-editor" onKeyDown={(e) => e.stopPropagation()}>
        <div className="formula-editor__code">
          <pre ref={highlightRef} className="formula-editor__highlight" aria-hidden>
            {segments.map((s, i) => (
              <span key={i} className={s.cls}>
                {s.text}
              </span>
            ))}
            {"\n"}
          </pre>
          <textarea
            ref={inputRef}
            className="formula-editor__input"
            aria-label="Fórmula"
            placeholder="Escribe una fórmula"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={draft}
            onChange={(e) => {
              setSource(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onScroll={(e) => {
              if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (selected && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActive((a) => (Math.min(a, flat.length - 1) + step + flat.length) % flat.length);
                return;
              }
              if (selected && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey))) {
                e.preventDefault();
                insert(selected);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                done();
              }
            }}
          />
        </div>
        <div className="formula-editor__status">
          {err ? (
            <span className="formula-editor__error" role="alert">
              {err.error}
            </span>
          ) : preview && "value" in preview ? (
            <span className="formula-editor__result">
              <span className="formula-editor__equals">=</span>
              <span className="formula-editor__value">{previewText(preview.value ?? null, schema) || "Vacío"}</span>
              <span className="formula-editor__type">{resultType(preview.value ?? null)}</span>
            </span>
          ) : (
            <span className="formula-editor__hint">Escribe una fórmula para ver su resultado</span>
          )}
          <button type="button" className="formula-editor__done" onClick={done}>
            Listo
          </button>
        </div>
        <div className="formula-editor__body">
          <div ref={listRef} className="formula-editor__list" role="listbox" aria-label="Propiedades y funciones">
            {sections.map(([label, items]) => (
              <div key={label} className="formula-editor__section">
                <div className="formula-editor__label">{label}</div>
                {items.map((item) => {
                  const key = itemKey(item);
                  return (
                    <button
                      type="button"
                      key={key}
                      data-key={key}
                      role="option"
                      aria-selected={selected === item}
                      className={`formula-editor__item${selected === item ? " is-active" : ""}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setHover(key)}
                      onMouseLeave={() => setHover((h) => (h === key ? null : h))}
                      onClick={() => insert(item)}
                    >
                      {item.kind === "property" ? (
                        <>
                          <span className="formula-editor__item-icon">
                            <TypeIcon type={item.schema.type} size={14} />
                          </span>
                          <span className="formula-editor__item-name">{item.name}</span>
                        </>
                      ) : (
                        <span className="formula-editor__item-name formula-editor__item-name--code">{item.doc.name}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {!sections.length && <p className="formula-editor__none">No hay resultados</p>}
          </div>
          <div className="formula-editor__help">{helpItem ? <Help item={helpItem} /> : <Intro />}</div>
        </div>
      </div>
    </Popover>
  );
}

function Intro() {
  return (
    <>
      <h3 className="formula-editor__help-title">Fórmulas</h3>
      <p className="formula-editor__help-text">
        Combina propiedades y funciones para calcular un valor en cada página. Escribe para buscar, usa ↑ y ↓ para
        elegir y Tab para insertar.
      </p>
      <Code>{'if(prop("Hecho"), "✅", "Pendiente")'}</Code>
    </>
  );
}

const Code = ({ children }: { children: ReactNode }) => <pre className="formula-editor__help-code">{children}</pre>;

function Help({ item }: { item: Item }) {
  if (item.kind === "property")
    return (
      <>
        <h3 className="formula-editor__help-title">
          <TypeIcon type={item.schema.type} size={16} />
          {item.name}
        </h3>
        <p className="formula-editor__help-meta">{PROPERTY_TYPE_LABELS[item.schema.type]}</p>
        <p className="formula-editor__help-text">Devuelve el valor de la propiedad «{item.name}» de cada página.</p>
        <Code>{`prop("${item.name}")`}</Code>
      </>
    );
  const { doc } = item;
  return (
    <>
      <h3 className="formula-editor__help-title formula-editor__help-title--code">{doc.name}</h3>
      <p className="formula-editor__help-text">{doc.description}</p>
      <div className="formula-editor__help-label">Sintaxis</div>
      <Code>{doc.syntax}</Code>
      {doc.examples.length > 0 && (
        <>
          <div className="formula-editor__help-label">{doc.examples.length > 1 ? "Ejemplos" : "Ejemplo"}</div>
          <Code>{doc.examples.join("\n")}</Code>
        </>
      )}
    </>
  );
}
