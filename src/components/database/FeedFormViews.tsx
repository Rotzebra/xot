import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlignLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  Image as ImageIcon,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Smile,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  COMPUTED_TYPES,
  LOCAL_PERSON,
  PROPERTY_TYPE_LABELS,
  READ_ONLY_TYPES,
  type Block,
  type Collection,
  type CollectionView,
  type FileRef,
  type FormQuestion,
  type PageRef,
  type PropertySchema,
  type PropertyType,
  type PropertyValue,
} from "../../lib/model";
import { db } from "../../lib/db";
import { addProperty, addRow, duplicateProperty, setRelation, updateView } from "../../lib/ops";
import { isEmptyValue } from "../../lib/query";
import { pickFiles, storeFile } from "../../lib/files";
import { pageTitle, useBlock } from "../../lib/hooks";
import { EmojiPicker, iconUrl, MenuItem, MenuLabel, MenuSeparator, PageIcon, Popover, Switch, usePopover } from "../ui";
import { coverSrc, gradientOf, randomCover } from "../PageCover";
import { Tag, TypeIcon } from "./properties";
import { defaultsFromQuery, viewProperties } from "./DatabaseView";
import { CommentCount, PagePreview, RowSummary, useCommentCounts, useRowContextMenu } from "./views";
import { LoadMore, useLoadLimit } from "./loadLimit";

// ------------------------------------------------------------------ feed

const feedDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });

/**
 * "Feed": every page as a full-width card, newest layout first:
 * who made it and when, the title, its properties and the start of its content.
 */
export function FeedView({
  view,
  collection,
  rows,
  onOpen,
  onNew,
}: {
  view: CollectionView;
  collection: Collection;
  rows: Block[];
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [limit, more] = useLoadLimit(view);
  const rowMenu = useRowContextMenu(onOpen);
  const comments = useCommentCounts(rows);
  return (
    <div className="feed">
      {rows.slice(0, limit).map((row) => (
        <button
          type="button"
          key={row.id}
          className="feed-card"
          onClick={() => onOpen(row.id)}
          onContextMenu={rowMenu.onContextMenu(row.id)}
        >
          <span className="feed-card__meta">
            <span className="person__avatar">{LOCAL_PERSON.charAt(0)}</span>
            <span className="feed-card__author">{LOCAL_PERSON}</span>
            <span>{feedDate.format(row.created_time).replace(".", "")}</span>
          </span>
          <span className="feed-card__title">
            {row.format.icon && <PageIcon block={row} size={22} />}
            <span className={isEmptyValue(row.properties.title) ? "muted" : ""}>{pageTitle(row)}</span>
          </span>
          <span className="feed-card__props">
            <RowSummary row={row} collection={collection} view={view} inline />
            <CommentCount n={comments.get(row.id)} />
          </span>
          <PagePreview row={row} className="page-preview--feed" />
        </button>
      ))}
      <LoadMore hidden={rows.length - limit} onMore={more} />
      <button type="button" className="table-new" onClick={onNew}>
        <Plus size={16} /> Nueva página
      </button>
      {rowMenu.element}
    </div>
  );
}

// ------------------------------------------------------------------ form

/** Types a form can't ask for: values Xot derives. */
const UNASKED: PropertyType[] = [...READ_ONLY_TYPES, ...COMPUTED_TYPES];

/** "+ Agregar pregunta": the kinds of new question, each a new property of that type. */
const NEW_QUESTION_TYPES: PropertyType[] = [
  "text",
  "number",
  "select",
  "multi_select",
  "date",
  "person",
  "file",
  "checkbox",
  "url",
  "email",
  "phone_number",
];

type Answer = string | boolean | string[] | PageRef[] | FileRef[];

const OPTION_TYPES: PropertyType[] = ["select", "status", "multi_select"];

/** An answer as the row stores it. */
function toValue(answer: Answer | undefined, schema: PropertySchema): PropertyValue {
  if (answer === undefined) return null;
  if (schema.type === "number") return answer === "" ? null : Number(answer);
  if (schema.type === "person")
    return String(answer)
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
  if (schema.type === "checkbox") return !!answer;
  if (typeof answer === "string") return answer.trim() ? answer : null;
  if (Array.isArray(answer) && !answer.length) return null;
  return answer as PropertyValue;
}

/** The option ids an answer picked (select, status and multi-select). */
const pickedOf = (answer: Answer | undefined): string[] =>
  Array.isArray(answer) ? (answer as unknown[]).filter((a): a is string => typeof a === "string") : answer ? [String(answer)] : [];

/** A relation question: the related database's pages to tick, up to `max`. */
function RelationField({
  schema,
  picked,
  max,
  onChange,
}: {
  schema: PropertySchema;
  picked: PageRef[];
  max: number;
  onChange: (refs: PageRef[]) => void;
}) {
  const [query, setQuery] = useState("");
  const pages = useLiveQuery(
    async () =>
      schema.collection_id
        ? (await db.blocks.where("[parent_table+parent_id]").equals(["collection", schema.collection_id]).toArray()).filter(
            (b) => b.alive && !b.is_template && !b.trashed_time,
          )
        : [],
    [schema.collection_id],
  );
  const q = query.trim().toLowerCase();
  const ids = new Set(picked.map((r) => r.id));
  const shown = (pages ?? []).filter((p) => ids.has(p.id) || (pageTitle(p) || "Sin título").toLowerCase().includes(q)).slice(0, 8);
  return (
    <div className="form-relation">
      <input className="field form-input" placeholder="Buscar páginas…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="form-relation__list">
        {shown.map((p) => {
          const on = ids.has(p.id);
          return (
            <button
              type="button"
              key={p.id}
              className={`form-relation__item${on ? " is-on" : ""}`}
              aria-pressed={on}
              onClick={() => {
                if (on) return onChange(picked.filter((r) => r.id !== p.id));
                const ref = { id: p.id, name: pageTitle(p) };
                onChange(max === 1 ? [ref] : max && picked.length >= max ? picked : [...picked, ref]);
              }}
            >
              <PageIcon block={p} size={16} />
              <span>{pageTitle(p) || "Sin título"}</span>
              {on && <Check size={14} />}
            </button>
          );
        })}
        {pages && !shown.length && <div className="form-question__empty">Sin páginas</div>}
      </div>
    </div>
  );
}

/** One question's answer field, for the property's type and the question's settings. */
function FormField({
  schema,
  question,
  answer,
  onChange,
}: {
  schema: PropertySchema;
  question: FormQuestion;
  answer: Answer | undefined;
  onChange: (answer: Answer) => void;
}) {
  const dropPop = usePopover();
  if (OPTION_TYPES.includes(schema.type)) {
    const multi = schema.type === "multi_select";
    const picked = pickedOf(answer);
    const max = multi ? (question.max ?? 0) : 1;
    if (!schema.options?.length) return <div className="form-question__empty">Sin opciones</div>;
    const toggle = (id: string) => {
      const on = picked.includes(id);
      if (!multi) return onChange(on ? "" : id);
      if (on) return onChange(picked.filter((x) => x !== id));
      if (max && picked.length >= max) return;
      onChange([...picked, id]);
    };
    const option = (o: NonNullable<PropertySchema["options"]>[number]) => {
      const on = picked.includes(o.id);
      return question.dropdown ? (
        <MenuItem key={o.id} right={on ? <Check size={14} /> : null} onClick={() => (toggle(o.id), !multi && dropPop.close())}>
          <Tag option={o} status={schema.type === "status"} />
        </MenuItem>
      ) : (
        <button
          type="button"
          key={o.id}
          className={`form-option${on ? " is-on" : ""}`}
          aria-pressed={on}
          disabled={!on && multi && !!max && picked.length >= max}
          onClick={() => toggle(o.id)}
        >
          <Tag option={o} status={schema.type === "status"} />
          {on && <Check size={14} />}
        </button>
      );
    };
    const hint = multi && max ? <div className="form-question__hint">Elige hasta {max}</div> : null;
    if (question.dropdown) {
      const chosen = schema.options.filter((o) => picked.includes(o.id));
      return (
        <>
          <button type="button" className="field form-input form-dropdown" onClick={(e) => dropPop.toggle(e.currentTarget)}>
            {chosen.length ? (
              <span className="tags">
                {chosen.map((o) => (
                  <Tag key={o.id} option={o} status={schema.type === "status"} />
                ))}
              </span>
            ) : (
              <span className="muted">Selecciona {multi ? "opciones" : "una opción"}</span>
            )}
            <ChevronDown size={16} />
          </button>
          {dropPop.anchor && (
            <Popover anchor={dropPop.anchor} onClose={dropPop.close} width={Math.max(240, dropPop.anchor.offsetWidth)}>
              <div className="menu menu-scroll">{schema.options.map(option)}</div>
            </Popover>
          )}
          {hint}
        </>
      );
    }
    return (
      <>
        <div className="form-options">{schema.options.map(option)}</div>
        {hint}
      </>
    );
  }
  if (schema.type === "checkbox")
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={!!answer}
        className={`checkbox${answer ? " is-checked" : ""}`}
        onClick={() => onChange(!answer)}
      >
        {answer ? <Check size={12} strokeWidth={3} /> : null}
      </button>
    );
  if (schema.type === "relation") {
    const picked = Array.isArray(answer) ? (answer as PageRef[]).filter((r) => typeof r === "object") : [];
    return <RelationField schema={schema} picked={picked} max={schema.limit === 1 ? 1 : (question.max ?? 0)} onChange={onChange} />;
  }
  if (schema.type === "file") {
    const files = Array.isArray(answer) ? (answer as FileRef[]).filter((f) => typeof f === "object") : [];
    return (
      <div className="form-files">
        {files.map((f, i) => (
          <span key={i} className="form-files__item">
            <Paperclip size={14} /> {f.name}
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Quitar" onClick={() => onChange(files.filter((_, j) => j !== i))}>
              <X size={12} />
            </button>
          </span>
        ))}
        <button
          type="button"
          className="form-files__add"
          onClick={async () => {
            const picked = await pickFiles("*/*", true);
            const added = await Promise.all(picked.map(async (file) => ({ name: file.name, url: await storeFile(file) })));
            onChange([...files, ...added]);
          }}
        >
          <Upload size={14} /> Subir archivos
        </button>
      </div>
    );
  }
  const text = typeof answer === "string" ? answer : "";
  if (question.long ?? schema.type === "text")
    return (
      <textarea
        className="field form-input form-input--long"
        placeholder="Respuesta larga"
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  const input: Partial<Record<PropertyType, [string, string]>> = {
    number: ["number", "Número"],
    date: ["date", ""],
    email: ["email", "nombre@ejemplo.com"],
    url: ["url", "https://"],
    phone_number: ["tel", "Teléfono"],
    person: ["text", "Nombres, separados por comas"],
  };
  const [type, placeholder] = input[schema.type] ?? ["text", "Respuesta corta"];
  return (
    <input className="field form-input" type={type} placeholder={placeholder} value={text} onChange={(e) => onChange(e.target.value)} />
  );
}

/** Form builder edits, saved in order. */
let formEdits: Promise<void> = Promise.resolve();

/** A text edited in place in the form builder, saved when it loses focus. */
function InlineText({
  value,
  placeholder,
  className,
  multiline,
  onSave,
}: {
  value: string;
  placeholder: string;
  className: string;
  multiline?: boolean;
  onSave: (text: string) => void;
}) {
  const props = {
    className,
    placeholder,
    defaultValue: value,
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const text = e.target.value.trim();
      if (text !== value) onSave(text);
    },
    // Capture: inside a page the editor would take Enter first.
    onKeyDownCapture: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !multiline) e.currentTarget.blur();
      if (e.key === "Escape") e.currentTarget.blur();
    },
  };
  return multiline ? <textarea key={value} rows={1} {...props} /> : <input key={value} {...props} />;
}

/**
 * "Formulario": a question per visible property (title first). The builder edits each
 * question's wording, description, "Obligatoria", answer kind and logic, the form's icon, cover,
 * button and confirmation; "Vista previa" fills it in, and "Enviar" adds the answers as a new page.
 */
export function FormView({
  view,
  collection,
  onOpen,
}: {
  view: CollectionView;
  collection: Collection;
  onOpen: (id: string) => void;
}) {
  const database = useBlock(collection.parent_id);
  const [preview, setPreview] = useState(false);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  const iconPop = usePopover();
  const addPop = usePopover();
  const qPop = usePopover();
  const [menuFor, setMenuFor] = useState<{ id: string; page: "main" | "logic" | "logic_options"; source?: string } | null>(null);
  const required = view.format.form_required ?? ["title"];
  const form = view.format.form ?? {};
  const settings = view.format.form_questions ?? {};
  const questionOf = (id: string): FormQuestion => settings[id] ?? {};
  const all = viewProperties(view, collection).filter(
    (p) => collection.schema[p.property] && !UNASKED.includes(collection.schema[p.property].type),
  );
  const questions = all.filter((p) => p.visible);
  const hidden = all.filter((p) => !p.visible);
  // Each change merges into the view as stored, one after another, so quick edits in a row
  // (a field's blur and the click that caused it) don't undo each other.
  const editFormat = (change: (format: CollectionView["format"]) => Partial<CollectionView["format"]>) => {
    formEdits = formEdits.then(async () => {
      const fresh = await db.views.get(view.id);
      if (fresh) await updateView(view.id, { format: { ...fresh.format, ...change(fresh.format) } });
    });
  };
  const setFormat = (patch: Partial<CollectionView["format"]>) => editFormat(() => patch);
  const setForm = (patch: Partial<typeof form>) => editFormat((f) => ({ form: { ...f.form, ...patch } }));
  const setQuestion = (id: string, patch: Partial<FormQuestion>) =>
    editFormat((f) => ({ form_questions: { ...f.form_questions, [id]: { ...f.form_questions?.[id], ...patch } } }));
  const toggleRequired = (id: string) =>
    editFormat((f) => {
      const list = f.form_required ?? ["title"];
      return { form_required: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
    });
  const setVisible = (id: string, visible: boolean) =>
    setFormat({ properties: viewProperties(view, collection).map((p) => (p.property === id ? { ...p, visible } : p)) });

  /** Conditional logic: a question is asked when its condition's question is asked and answered with one of its options. */
  const asked = (id: string, depth = 0): boolean => {
    const cond = questionOf(id).show_if;
    if (!cond || !collection.schema[cond.property]) return true;
    if (depth > 20 || !questions.some((q) => q.property === cond.property)) return true;
    return asked(cond.property, depth + 1) && pickedOf(answers[cond.property]).some((o) => cond.options.includes(o));
  };
  const shownQuestions = preview ? questions.filter((q) => asked(q.property)) : questions;

  const submit = async () => {
    const values: Record<string, PropertyValue> = {};
    for (const q of shownQuestions) values[q.property] = toValue(answers[q.property], collection.schema[q.property]);
    const empty = shownQuestions
      .filter((q) => required.includes(q.property) && (isEmptyValue(values[q.property]) || values[q.property] === false))
      .map((q) => q.property);
    setMissing(empty);
    if (empty.length) return;
    const relations = Object.entries(values).filter(([id, v]) => collection.schema[id].type === "relation" && v !== null);
    const answered = Object.fromEntries(
      Object.entries(values).filter(([id, v]) => v !== null && collection.schema[id].type !== "relation"),
    );
    const id = await addRow(collection.id, { ...defaultsFromQuery(view.query2, collection.schema), ...answered });
    // Relations are linked once the page exists, so two-way ones link back.
    for (const [prop, refs] of relations) await setRelation(id, prop, refs as PageRef[]);
    setAnswers({});
    setSent(id);
  };

  const closeMenu = () => {
    qPop.close();
    setMenuFor(null);
  };
  /** The "⋯" menu of a question: its answer kind, logic, duplicate and hide. */
  const questionMenu = (id: string) => {
    const schema = collection.schema[id];
    const q = questionOf(id);
    const page = menuFor?.page ?? "main";
    const index = questions.findIndex((p) => p.property === id);
    const sources = questions.slice(0, Math.max(0, index)).filter((p) => OPTION_TYPES.includes(collection.schema[p.property].type));
    if (page === "logic")
      return (
        <div className="menu">
          <MenuLabel>Mostrar esta pregunta solo si…</MenuLabel>
          {sources.map((p) => (
            <MenuItem
              key={p.property}
              icon={<TypeIcon type={collection.schema[p.property].type} size={16} />}
              right={q.show_if?.property === p.property ? <Check size={14} /> : <ChevronRight size={14} />}
              onClick={() => setMenuFor({ id, page: "logic_options", source: p.property })}
            >
              {questionOf(p.property).title || collection.schema[p.property].name}
            </MenuItem>
          ))}
          {!sources.length && <p className="form-menu__empty">Añade antes una pregunta de selección para mostrar esta según su respuesta.</p>}
          {q.show_if && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Trash2 size={16} />} onClick={() => (setQuestion(id, { show_if: undefined }), closeMenu())}>
                Quitar lógica
              </MenuItem>
            </>
          )}
        </div>
      );
    if (page === "logic_options" && menuFor?.source) {
      const source = menuFor.source;
      const opts = collection.schema[source].options ?? [];
      const chosen = q.show_if?.property === source ? q.show_if.options : [];
      return (
        <div className="menu">
          <MenuLabel>Si la respuesta incluye</MenuLabel>
          {opts.map((o) => {
            const on = chosen.includes(o.id);
            return (
              <MenuItem
                key={o.id}
                right={on ? <Check size={14} /> : null}
                onClick={() => {
                  const next = on ? chosen.filter((x) => x !== o.id) : [...chosen, o.id];
                  setQuestion(id, { show_if: next.length ? { property: source, options: next } : undefined });
                }}
              >
                <Tag option={o} status={collection.schema[source].type === "status"} />
              </MenuItem>
            );
          })}
        </div>
      );
    }
    return (
      <div className="menu">
        {(schema.type === "text" || schema.type === "title") && (
          <MenuItem
            icon={<AlignLeft size={16} />}
            right={<Switch on={q.long ?? schema.type === "text"} />}
            onClick={() => setQuestion(id, { long: !(q.long ?? schema.type === "text") })}
          >
            Respuesta larga
          </MenuItem>
        )}
        {OPTION_TYPES.includes(schema.type) && (
          <MenuItem icon={<ChevronDown size={16} />} right={<Switch on={!!q.dropdown} />} onClick={() => setQuestion(id, { dropdown: !q.dropdown || undefined })}>
            Mostrar como desplegable
          </MenuItem>
        )}
        {(schema.type === "multi_select" || (schema.type === "relation" && schema.limit !== 1)) && (
          <div className="form-menu__row">
            <span>Máximo de selecciones</span>
            <input
              className="field form-menu__number"
              type="number"
              min={0}
              placeholder="Sin límite"
              defaultValue={q.max ?? ""}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value));
                setQuestion(id, { max: n > 0 ? n : undefined });
              }}
            />
          </div>
        )}
        {id !== "title" && (
          <MenuItem
            icon={<GitBranch size={16} />}
            right={q.show_if ? <span className="muted">Activa</span> : <ChevronRight size={14} />}
            onClick={() => setMenuFor({ id, page: "logic" })}
          >
            Lógica condicional
          </MenuItem>
        )}
        <MenuSeparator />
        {id !== "title" && (
          <MenuItem
            icon={<Copy size={16} />}
            onClick={async () => {
              closeMenu();
              const copy = await duplicateProperty(collection.id, id);
              if (!copy) return;
              const fresh = await db.views.get(view.id);
              if (fresh)
                await updateView(view.id, {
                  format: {
                    ...fresh.format,
                    form_questions: { ...fresh.format.form_questions, [copy]: { ...q, title: q.title ? `${q.title} (1)` : undefined } },
                    form_required: required.includes(id) ? [...required, copy] : fresh.format.form_required,
                  },
                });
            }}
          >
            Duplicar
          </MenuItem>
        )}
        {id !== "title" && (
          <MenuItem icon={<EyeOff size={16} />} onClick={() => (closeMenu(), setVisible(id, false))}>
            Quitar del formulario
          </MenuItem>
        )}
      </div>
    );
  };

  const title = form.title ?? (database ? pageTitle(database) : "");
  const cover = form.cover;
  return (
    <div className={`form-view${preview ? " is-preview" : ""}`}>
      <div className="form-view__bar">
        {preview ? (
          <button type="button" className="ghost-btn form-view__mode" onClick={() => (setPreview(false), setSent(null), setMissing([]))}>
            <Pencil size={14} /> Editar formulario
          </button>
        ) : (
          <button type="button" className="ghost-btn form-view__mode" onClick={() => (setPreview(true), setAnswers({}))}>
            <Eye size={14} /> Vista previa
          </button>
        )}
      </div>
      <div className="form-view__sheet">
        {cover && (
          <div className="form-view__cover" style={gradientOf(cover) ? { background: gradientOf(cover)! } : undefined}>
            {!gradientOf(cover) && <img src={coverSrc(cover)} alt="" />}
            {!preview && (
              <div className="form-view__cover-actions">
                <button type="button" onClick={() => setForm({ cover: randomCover() })}>
                  Cambiar
                </button>
                <button type="button" onClick={() => setForm({ cover: undefined })}>
                  Quitar
                </button>
              </div>
            )}
          </div>
        )}
        {form.icon && (
          <button
            type="button"
            className="form-view__icon"
            disabled={preview}
            onClick={(e) => iconPop.toggle(e.currentTarget)}
            aria-label="Cambiar icono"
          >
            {iconUrl(form.icon) ? <img src={iconUrl(form.icon)!} alt="" width={56} height={56} /> : form.icon}
          </button>
        )}
        {!preview && (!form.icon || !cover) && (
          <div className="form-view__add">
            {!form.icon && (
              <button type="button" className="ghost-btn" onClick={(e) => iconPop.toggle(e.currentTarget)}>
                <Smile size={14} /> Agregar icono
              </button>
            )}
            {!cover && (
              <button type="button" className="ghost-btn" onClick={() => setForm({ cover: randomCover() })}>
                <ImageIcon size={14} /> Agregar portada
              </button>
            )}
          </div>
        )}
        {iconPop.anchor && (
          <Popover anchor={iconPop.anchor} onClose={iconPop.close} width={408}>
            <EmojiPicker
              onPick={(icon) => (setForm({ icon }), iconPop.close())}
              onRemove={form.icon ? () => (setForm({ icon: undefined }), iconPop.close()) : undefined}
            />
          </Popover>
        )}
        {preview ? (
          <div className="form-view__title">{title || "Formulario sin título"}</div>
        ) : (
          <InlineText
            className="form-view__title form-view__title--edit"
            value={title}
            placeholder="Formulario sin título"
            onSave={(text) => setForm({ title: text || undefined })}
          />
        )}
        {preview ? (
          view.format.form_description && <p className="form-view__description">{view.format.form_description}</p>
        ) : (
          <InlineText
            className="form-view__description"
            multiline
            value={view.format.form_description ?? ""}
            placeholder="Añade una descripción…"
            onSave={(text) => setFormat({ form_description: text || undefined })}
          />
        )}
        {preview && sent ? (
          <div className="form-view__sent">
            <div className="form-view__sent-title">{form.sent_title || "Se ha enviado tu respuesta"}</div>
            {form.sent_message && <div className="form-view__sent-message">{form.sent_message}</div>}
            <div className="form-view__sent-actions">
              <button type="button" className="ghost-btn" onClick={() => onOpen(sent)}>
                Ver respuesta
              </button>
              <button type="button" className="primary-btn" onClick={() => setSent(null)}>
                Enviar otra respuesta
              </button>
            </div>
          </div>
        ) : (
          <>
            {shownQuestions.map((p) => {
              const id = p.property;
              const schema = collection.schema[id];
              const q = questionOf(id);
              const isRequired = required.includes(id);
              const cond = q.show_if && collection.schema[q.show_if.property];
              const field = (
                <FormField
                  schema={schema}
                  question={q}
                  answer={answers[id]}
                  onChange={(answer) => {
                    setAnswers((a) => ({ ...a, [id]: answer }));
                    setMissing((m) => m.filter((x) => x !== id));
                  }}
                />
              );
              return (
                <div
                  className={`form-question${missing.includes(id) ? " is-missing" : ""}${preview ? "" : " form-question--edit"}`}
                  key={id}
                  data-question={id}
                >
                  <div className="form-question__head">
                    {preview ? (
                      <span className="form-question__label">
                        {q.title || schema.name}
                        {isRequired && <span className="form-question__star"> *</span>}
                      </span>
                    ) : (
                      <>
                        <TypeIcon type={schema.type} size={16} />
                        <InlineText
                          className="form-question__label form-question__title"
                          value={q.title ?? ""}
                          placeholder={schema.name}
                          onSave={(text) => setQuestion(id, { title: text && text !== schema.name ? text : undefined })}
                        />
                        {isRequired && <span className="form-question__star">*</span>}
                        <span className="form-question__tools">
                          <button type="button" className="form-question__required" onClick={() => toggleRequired(id)}>
                            Obligatoria
                            <Switch on={isRequired} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn icon-btn--sm"
                            aria-label="Opciones de la pregunta"
                            onClick={(e) => {
                              setMenuFor({ id, page: "main" });
                              qPop.toggle(e.currentTarget);
                            }}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                  {preview ? (
                    q.description && <div className="form-question__desc">{q.description}</div>
                  ) : (
                    <InlineText
                      className="form-question__desc form-question__desc--edit"
                      multiline
                      value={q.description ?? ""}
                      placeholder="Añade una descripción…"
                      onSave={(text) => setQuestion(id, { description: text || undefined })}
                    />
                  )}
                  {!preview && cond && (
                    <div className="form-question__logic">
                      <GitBranch size={12} /> Se muestra si «{questionOf(q.show_if!.property).title || cond.name}» es{" "}
                      {(cond.options ?? [])
                        .filter((o) => q.show_if!.options.includes(o.id))
                        .map((o) => o.value)
                        .join(" o ")}
                    </div>
                  )}
                  {preview ? field : <div className="form-question__field" inert>{field}</div>}
                  {missing.includes(id) && <div className="form-question__error">Esta pregunta es obligatoria</div>}
                </div>
              );
            })}
            {qPop.anchor && menuFor && (
              <Popover anchor={qPop.anchor} onClose={closeMenu} width={260} align="end">
                {questionMenu(menuFor.id)}
              </Popover>
            )}
            {!preview && (
              <button type="button" className="form-view__add-question" onClick={(e) => addPop.toggle(e.currentTarget)}>
                <Plus size={16} /> Agregar pregunta
              </button>
            )}
            {addPop.anchor && (
              <Popover anchor={addPop.anchor} onClose={addPop.close} width={260}>
                <div className="menu menu-scroll">
                  {hidden.length > 0 && <MenuLabel>Propiedades existentes</MenuLabel>}
                  {hidden.map((p) => (
                    <MenuItem
                      key={p.property}
                      icon={<TypeIcon type={collection.schema[p.property].type} size={16} />}
                      onClick={() => (addPop.close(), setVisible(p.property, true))}
                    >
                      {collection.schema[p.property].name}
                    </MenuItem>
                  ))}
                  <MenuLabel>Nueva pregunta</MenuLabel>
                  {NEW_QUESTION_TYPES.map((type) => (
                    <MenuItem
                      key={type}
                      icon={<TypeIcon type={type} size={16} />}
                      onClick={() => {
                        addPop.close();
                        void addProperty(collection.id, type);
                      }}
                    >
                      {PROPERTY_TYPE_LABELS[type]}
                    </MenuItem>
                  ))}
                </div>
              </Popover>
            )}
            {preview ? (
              <button type="button" className="primary-btn form-view__submit" onClick={() => void submit()}>
                {form.submit_label || "Enviar"}
              </button>
            ) : (
              <>
                <InlineText
                  className="primary-btn form-view__submit form-view__submit--edit"
                  value={form.submit_label ?? ""}
                  placeholder="Enviar"
                  onSave={(text) => setForm({ submit_label: text && text !== "Enviar" ? text : undefined })}
                />
                <div className="form-view__confirm">
                  <MenuLabel>Pantalla de confirmación</MenuLabel>
                  <InlineText
                    className="form-view__sent-title form-view__confirm-input"
                    value={form.sent_title ?? ""}
                    placeholder="Se ha enviado tu respuesta"
                    onSave={(text) => setForm({ sent_title: text || undefined })}
                  />
                  <InlineText
                    className="form-view__confirm-input form-view__confirm-message"
                    multiline
                    value={form.sent_message ?? ""}
                    placeholder="Añade un mensaje para quien responda…"
                    onSave={(text) => setForm({ sent_message: text || undefined })}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
