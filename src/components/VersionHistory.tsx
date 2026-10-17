import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { History, MoreHorizontal, Pencil, X } from "lucide-react";
import { db, type DatabaseState, type Snapshot } from "../lib/db";
import { READ_ONLY_TYPES, type Block, type Collection } from "../lib/model";
import { databaseState, listSnapshots, nameVersion, saveVersionNow } from "../lib/history";
import { undoLast, updateBlock } from "../lib/ops";
import { DocPreview, importedMarkdownBlocks, restoreContent, restoreVersionBlock, type XotEditor } from "./Editor";
import { coverSrc, gradientOf } from "./PageCover";
import { PropertyDisplay, TypeIcon } from "./database/properties";
import { viewIcon } from "./database/DatabaseView";
import { iconUrl, isGlyphIcon, MenuItem, Modal, Popover, Switch, toast, usePopover } from "./ui";

/** The id of the "Versión actual" entry shown while no version is saved. */
const CURRENT = -1;

const timeOfDay = new Intl.DateTimeFormat("es", { hour: "numeric", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("es", { day: "numeric", month: "long" });
const dayMonthYear = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" });

/** "Hoy, 10:42", "Ayer, 18:03", "3 de junio, 9:15" (with the year when it isn't this one). */
export function versionLabel(time: number) {
  const d = new Date(time);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  const day =
    days === 0
      ? "Hoy"
      : days === 1
        ? "Ayer"
        : d.getFullYear() === today.getFullYear()
          ? dayMonth.format(d)
          : dayMonthYear.format(d);
  return `${day}, ${timeOfDay.format(d)}`;
}

/** "de hoy, 10:42", "de ayer, 18:03", "del 3 de junio, 9:15": a version's time inside a sentence. */
const versionOf = (time: number) => {
  const label = versionLabel(time);
  return /^(Hoy|Ayer),/.test(label) ? `de ${label[0].toLowerCase()}${label.slice(1)}` : `del ${label}`;
};

/**
 * The page menu's "Deshacer" (⌘Z): the last change in the page's text, else the
 * last page operation (what ⌘Z undoes outside the text).
 */
export async function undoInPage(block: Block, editor: XotEditor | null) {
  if (editor && !block.format.locked && editor.undo()) return;
  const label = await undoLast();
  toast(label ? `Deshecho: ${label}` : "No hay nada que deshacer");
}

/** A stored block, as far as the comparison needs it. */
type DocNode = { id?: string; type?: string; props?: unknown; content?: unknown; children?: DocNode[] };

/** What changed from the version before: blocks added or edited, and blocks removed (shown where they were). */
export interface ContentDiff {
  content: DocNode[];
  added: Set<string>;
  changed: Set<string>;
  removed: Set<string>;
}

const blockKey = (b: DocNode) => JSON.stringify([b.type, b.props ?? null, b.content ?? null]);

function byId(list: DocNode[], map = new Map<string, DocNode>()) {
  for (const b of list) {
    if (b.id) map.set(b.id, b);
    byId(b.children ?? [], map);
  }
  return map;
}

/** Compares a version's body with the one before it, block by block (by id). */
export function diffContent(next: DocNode[], prev: DocNode[]): ContentDiff {
  const now = byId(next);
  const before = byId(prev);
  const diff: ContentDiff = { content: [], added: new Set(), changed: new Set(), removed: new Set() };
  for (const [id, b] of now) {
    const old = before.get(id);
    if (!old) diff.added.add(id);
    else if (blockKey(old) !== blockKey(b)) diff.changed.add(id);
  }
  const markRemoved = (b: DocNode) => {
    if (b.id && !now.has(b.id)) diff.removed.add(b.id);
    (b.children ?? []).forEach(markRemoved);
  };
  // The version's blocks, with the removed ones put back after the neighbour they followed.
  const merge = (list: DocNode[], old: DocNode[]): DocNode[] => {
    const out = list.map((b) => {
      const was = b.id ? before.get(b.id) : undefined;
      return was?.children?.length ? { ...b, children: merge(b.children ?? [], was.children) } : b;
    });
    old.forEach((b, i) => {
      if (!b.id || now.has(b.id)) return;
      markRemoved(b);
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const k = out.findIndex((o) => o.id === old[j].id);
        if (k >= 0) {
          at = k + 1;
          break;
        }
      }
      // Blocks that moved out of a removed one are shown where they are now, not twice.
      const prune = (x: DocNode): DocNode => ({ ...x, children: (x.children ?? []).filter((c) => !c.id || !now.has(c.id)).map(prune) });
      out.splice(at, 0, prune(b));
    });
    return out;
  };
  diff.content = merge(next, prev);
  return diff;
}

/** Where a block sits in a list of blocks: its neighbours and its parent. */
function placeOf(list: DocNode[], id: string, parent?: string): { node: DocNode; before: string[]; after: string[]; parent?: string } | null {
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.id === id)
      return {
        node: b,
        before: list.slice(0, i).flatMap((x) => (x.id ? [x.id] : [])),
        after: list.slice(i + 1).flatMap((x) => (x.id ? [x.id] : [])),
        parent,
      };
    const inner = placeOf(b.children ?? [], id, b.id);
    if (inner) return inner;
  }
  return null;
}

/** CSS that marks blocks of the preview by id (BlockNote renders each block with its data-id). */
const blockRule = (ids: Iterable<string>, rule: string, inner = "") => {
  const list = [...ids].map((id) => `.history__page .bn-block-outer[data-id="${CSS.escape(id)}"] > .bn-block > .bn-block-content${inner}`);
  return list.length ? `${list.join(",\n")} { ${rule} }\n` : "";
};

/** Row values the restore leaves as they are: the other side of a relation isn't part of this page. */
const keepsCurrent = (collection: Collection | undefined, id: string) => {
  const type = collection?.schema[id]?.type;
  return !!type && (type === "relation" || READ_ONLY_TYPES.includes(type));
};

/**
 * "Historial de versiones": the chosen version on the left (read-only,
 * with its cover, icon, title, properties and body), the saved versions on the
 * right, and "Restaurar versión".
 */
export function VersionHistory({
  block,
  editor,
  onClose,
}: {
  block: Block;
  editor: XotEditor | null;
  onClose: () => void;
}) {
  const saved = useLiveQuery(() => listSnapshots(block.id), [block.id]);
  // The list always has the page as it is now; with nothing saved yet, that's the one shown.
  const versions = useMemo<Snapshot[] | undefined>(() => {
    if (!saved || saved.length) return saved;
    return [
      {
        id: CURRENT,
        page_id: block.id,
        time: block.last_edited_time,
        title: String(block.properties.title ?? ""),
        icon: block.format.icon,
        cover: block.format.cover,
        cover_position: block.format.cover_position,
        properties: block.properties,
        content: (editor ? editor.document : block.content) ?? [],
        content_markdown: editor ? undefined : block.content_markdown,
      },
    ];
  }, [saved, block, editor]);
  const collection = useLiveQuery(
    async () => (block.parent_table === "collection" ? db.collections.get(block.parent_id) : undefined),
    [block.parent_table, block.parent_id],
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  // "Resaltar cambios": what the chosen version changed from the one before it.
  const [showChanges, setShowChanges] = useState(true);
  // A block picked in the preview, for "Restaurar bloque".
  const [picked, setPicked] = useState<string | null>(null);
  const [naming, setNaming] = useState<number | null>(null);
  const isDatabase = block.type === "collection_view_page";
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (versions?.length && !versions.some((v) => v.id === selected)) setSelected(versions[0].id!);
  }, [versions, selected]);
  const current = versions?.find((v) => v.id === selected);
  const previous = current && versions ? versions[versions.indexOf(current) + 1] : undefined;
  const locked = !!block.format.locked;
  useEffect(() => setPicked(null), [selected]);
  const diff = useMemo(
    () =>
      current && previous?.content.length && current.content.length && showChanges && !isDatabase
        ? diffContent(current.content as DocNode[], previous.content as DocNode[])
        : null,
    [current, previous, showChanges, isDatabase],
  );

  // The list takes the keyboard: ↑/↓ pick the previous or next version.
  useEffect(() => listRef.current?.focus(), []);
  const onListKey = (e: KeyboardEvent) => {
    if (!versions?.length || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const i = versions.findIndex((v) => v.id === selected);
    const next = versions[Math.min(versions.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    setSelected(next.id!);
    listRef.current?.querySelector(`[data-version="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const restore = async () => {
    if (!current || current.id === CURRENT || locked || restoring) return;
    setRestoring(true);
    const page = (await db.blocks.get(block.id)) ?? block;
    // What the page has now becomes a version too, so the restore can be undone from here.
    await saveVersionNow(page, editor ? (editor.document as unknown[]) : undefined);
    if (isDatabase) {
      if (current.database) await restoreDatabase(page, current.database);
      await updateBlock(block.id, {
        properties: { ...page.properties, title: current.title },
        format: { ...page.format, icon: current.icon, cover: current.cover, cover_position: current.cover_position },
      });
      toast(`Se restauró la versión ${versionOf(current.time)}`);
      onClose();
      return;
    }
    const patch: Partial<Block> = {};
    if (current.properties) {
      const properties = { ...current.properties };
      for (const id of new Set([...Object.keys(properties), ...Object.keys(page.properties)]))
        if (keepsCurrent(collection, id)) {
          if (id in page.properties) properties[id] = page.properties[id];
          else delete properties[id];
        }
      patch.properties = properties;
      patch.format = { ...page.format, icon: current.icon, cover: current.cover, cover_position: current.cover_position };
    } else {
      // Versions saved before icons and properties were kept: the title and body.
      patch.properties = { ...page.properties, title: current.title };
    }
    if (editor) {
      // Through the open editor, so ⌘Z there takes the restore back as well.
      const body = current.content.length
        ? current.content
        : current.content_markdown
          ? (importedMarkdownBlocks(editor, current.content_markdown) as unknown[])
          : [];
      restoreContent(editor, body);
    } else {
      patch.content = current.content.length ? current.content : null;
      patch.content_markdown = current.content_markdown;
    }
    await updateBlock(block.id, patch);
    toast(`Se restauró la versión ${versionOf(current.time)}`);
    onClose();
  };

  /** "Restaurar bloque": the picked block of this version (or one it removed) back into the page. */
  const restorePicked = () => {
    if (!editor || !picked || !current || locked) return;
    const content = (diff?.content ?? current.content) as DocNode[];
    const place = placeOf(content, picked) ?? (previous ? placeOf(previous.content as DocNode[], picked) : null);
    if (!place) return;
    const id = restoreVersionBlock(editor, place.node, place);
    if (!id) return;
    toast(`Se restauró un bloque de la versión ${versionOf(current.time)}`, { label: "Deshacer", run: () => editor.undo() });
    onClose();
  };

  return (
    <Modal onClose={onClose} className="history" label="Historial de versiones">
      <div className="history__preview">
        {current && isDatabase ? (
          <VersionDatabase key={current.id} block={block} version={current} previous={showChanges ? previous : undefined} />
        ) : current ? (
          <VersionPage
            key={current.id}
            block={block}
            version={current}
            previous={showChanges ? previous : undefined}
            diff={diff}
            collection={collection}
            picked={picked}
            onPick={current.id === CURRENT || locked ? undefined : setPicked}
          />
        ) : versions ? (
          <div className="history__empty">
            <History size={28} strokeWidth={1.6} />
            <p>Aún no hay versiones guardadas de esta página.</p>
            <p className="history__hint">Xot guarda una versión cada 10 minutos mientras editas y al salir de la página.</p>
          </div>
        ) : null}
      </div>
      <aside className="history__side">
        <header className="history__head">
          <span>Historial de versiones</span>
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div
          ref={listRef}
          className="history__list"
          role="listbox"
          aria-label="Versiones"
          tabIndex={0}
          onKeyDown={onListKey}
        >
          {(versions ?? []).map((v) => (
            <div key={v.id} className={`history__row${v.id === selected ? " is-selected" : ""}`}>
              <button
                type="button"
                role="option"
                aria-selected={v.id === selected}
                data-version={v.id}
                tabIndex={-1}
                className={`history__item${v.id === selected ? " is-selected" : ""}`}
                onClick={() => setSelected(v.id!)}
                onDoubleClick={() => v.id !== CURRENT && setNaming(v.id!)}
              >
                {naming === v.id ? (
                  <VersionNameInput
                    value={v.name ?? ""}
                    onDone={(name) => {
                      setNaming(null);
                      if (name !== null) void nameVersion(v.id!, name);
                      listRef.current?.focus();
                    }}
                  />
                ) : v.name ? (
                  <>
                    <span className="history__time history__name">{v.name}</span>
                    <span className="history__current">{versionLabel(v.time)}</span>
                  </>
                ) : (
                  <span className="history__time">{versionLabel(v.time)}</span>
                )}
                {v.id === CURRENT && <span className="history__current">Versión actual</span>}
                <span className="history__by">
                  <span className="history__avatar" aria-hidden>
                    T
                  </span>
                  Tú
                </span>
              </button>
              {v.id !== CURRENT && naming !== v.id && (
                <VersionMenu
                  named={!!v.name}
                  onName={() => setNaming(v.id!)}
                  onClear={() => void nameVersion(v.id!, "")}
                />
              )}
            </div>
          ))}
        </div>
        <footer className="history__foot">
          {!!previous && (
            <button type="button" className="dialog-row history__changes" onClick={() => setShowChanges((v) => !v)}>
              <span>Resaltar cambios</span>
              <Switch on={showChanges} />
            </button>
          )}
          {!isDatabase && current && current.id !== CURRENT && (
            <p className="history__note">
              {picked ? "Bloque seleccionado: restáuralo solo a él en la página." : "Haz clic en un bloque para restaurarlo por separado."}
            </p>
          )}
          {picked && (
            <button
              type="button"
              className="xot-btn history__restore"
              disabled={!editor || locked}
              onClick={restorePicked}
            >
              Restaurar bloque
            </button>
          )}
          {!!versions?.length && (
            <p className="history__note">
              {saved && !saved.length && "Aún no hay versiones guardadas. "}
              {isDatabase
                ? "Se guarda una versión de la base de datos (título, descripción, propiedades y vistas) al abrirla y al salir si cambió. "
                : "Se guarda una versión cada 10 minutos de edición y al salir de la página. "}
              Se conservan las 50 más recientes y las que tienen nombre.
            </p>
          )}
          <button
            type="button"
            className="xot-btn xot-btn--primary history__restore"
            disabled={!current || current.id === CURRENT || locked || restoring}
            title={locked ? "La página está bloqueada" : undefined}
            onClick={() => void restore()}
          >
            Restaurar versión
          </button>
        </footer>
      </aside>
    </Modal>
  );
}

/** A version laid out like the page: cover, icon, title, the row's properties and the body. */
function VersionPage({
  block,
  version,
  previous,
  diff,
  collection,
  picked,
  onPick,
}: {
  block: Block;
  version: Snapshot;
  previous?: Snapshot;
  diff: ContentDiff | null;
  collection?: Collection;
  picked: string | null;
  onPick?: (id: string | null) => void;
}) {
  // Versions from before icons and covers were kept show the page's current ones.
  const full = !!version.properties;
  const icon = full ? version.icon : block.format.icon;
  const cover = full ? version.cover : block.format.cover;
  const position = (full ? version.cover_position : block.format.cover_position) ?? 0.5;
  const url = icon ? iconUrl(icon) : null;
  const isImage = !!url && !isGlyphIcon(icon!);
  const gradient = cover ? gradientOf(cover) : null;

  const order = collection?.page_properties ?? [];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const props =
    collection && version.properties
      ? Object.keys(collection.schema)
          .filter((id) => id !== "title" && !READ_ONLY_TYPES.includes(collection.schema[id].type))
          .filter((id) => collection.property_visibility?.[id] !== "hide")
          .sort((a, b) => rank(a) - rank(b))
      : [];

  return (
    <>
      {cover && (
        <div className="history__cover">
          {gradient ? (
            <div className="history__cover-fill" style={{ background: gradient }} />
          ) : (
            <img src={coverSrc(cover)} alt="" draggable={false} style={{ objectPosition: `center ${(1 - position) * 100}%` }} />
          )}
        </div>
      )}
      <div
        className={`history__page${block.format.full_width ? " history__page--full" : ""}${cover ? " has-cover" : ""}${
          icon ? " has-icon" : ""
        }${block.format.small_text ? " page--small" : ""}${
          block.format.page_font && block.format.page_font !== "default" ? ` page--${block.format.page_font}` : ""
        }`}
      >
        {icon && (
          <div className={`history__icon${isImage ? " history__icon--image" : ""}`}>
            {url ? <img src={url} alt="" /> : icon}
          </div>
        )}
        <h1
          className={`history__title${version.title ? "" : " is-empty"}${
            previous && previous.title !== version.title ? " is-changed" : ""
          }`}
        >
          {version.title || "Sin título"}
        </h1>
        {props.length > 0 && (
          <div className="history__props">
            {props.map((id) => {
              const schema = collection!.schema[id];
              const value = version.properties![id];
              const changed =
                !!previous?.properties && JSON.stringify(previous.properties[id] ?? null) !== JSON.stringify(value ?? null);
              return (
                <div className={`history__prop${changed ? " is-changed" : ""}`} key={id}>
                  <span className="history__prop-name">
                    <TypeIcon type={schema.type} size={16} />
                    <span>{schema.name}</span>
                  </span>
                  <span className="history__prop-value">
                    <PropertyDisplay value={value} schema={schema} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {(diff || picked) && (
          <style>
            {diff
              ? blockRule([...diff.added, ...diff.changed], "background: var(--history-added);") +
                blockRule(diff.removed, "background: var(--history-removed);") +
                blockRule(diff.removed, "text-decoration: line-through; text-decoration-color: var(--history-removed-line);", " .bn-inline-content")
              : ""}
            {picked ? blockRule([picked], "box-shadow: inset 0 0 0 2px var(--accent); border-radius: 4px;") : ""}
          </style>
        )}
        <div
          className={onPick ? "history__body is-pickable" : "history__body"}
          onClickCapture={(e) => {
            if (!onPick) return;
            const el = (e.target as HTMLElement).closest(".bn-block-outer[data-id]");
            const id = el?.getAttribute("data-id") ?? null;
            if ((e.target as HTMLElement).closest(".bn-toggle-button")) return;
            onPick(id === picked ? null : id);
          }}
        >
          <DocPreview
            pageId={block.id}
            content={(diff?.content as unknown[]) ?? version.content}
            markdown={version.content_markdown}
          />
        </div>
      </div>
    </>
  );
}

/** "Nombrar versión": the name field in place of the version's time; Enter saves, Esc cancels. */
function VersionNameInput({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      ref={ref}
      className="history__name-input"
      defaultValue={value}
      placeholder="Nombre de la versión"
      aria-label="Nombre de la versión"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/** A version's "...": name it (or rename it), or take its name off. */
function VersionMenu({ named, onName, onClear }: { named: boolean; onName: () => void; onClear: () => void }) {
  const pop = usePopover();
  return (
    <>
      <button
        type="button"
        className="icon-btn history__more"
        aria-label="Opciones de la versión"
        onClick={(e) => pop.toggle(e.currentTarget)}
      >
        <MoreHorizontal size={16} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={220} align="end">
          <div className="menu">
            <MenuItem
              icon={<Pencil size={16} />}
              onClick={() => {
                pop.close();
                onName();
              }}
            >
              {named ? "Cambiar nombre" : "Nombrar versión"}
            </MenuItem>
            {named && (
              <MenuItem
                icon={<X size={16} />}
                onClick={() => {
                  pop.close();
                  onClear();
                }}
              >
                Quitar nombre
              </MenuItem>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Puts a database version back: its description, properties and views (rows stay as they are). */
async function restoreDatabase(page: Block, state: DatabaseState) {
  const collectionId = page.collection_id;
  if (!collectionId) return;
  await db.transaction("rw", db.collections, db.views, async () => {
    await db.collections.update(collectionId, { schema: state.schema, description: state.description });
    const keep = new Set(state.views.map((v) => v.id));
    const stale = (await db.views.where("parent_id").equals(page.id).primaryKeys()).filter((id) => !keep.has(String(id)));
    await db.views.bulkDelete(stale);
    await db.views.bulkPut(structuredClone(state.views));
  });
  await updateBlock(page.id, { view_ids: state.views.map((v) => v.id) });
}

/** A full-page database's version: title, description, its properties and its views. */
function VersionDatabase({ block, version, previous }: { block: Block; version: Snapshot; previous?: Snapshot }) {
  // The page as it is now, while no version holds the database's properties yet.
  const now = useLiveQuery(() => (version.database ? undefined : databaseState(block)), [version.database, block]);
  const state = version.database ?? now?.database;
  const before = previous?.database;
  const icon = version.icon;
  const url = icon ? iconUrl(icon) : null;
  const props = state ? Object.entries(state.schema) : [];
  const removedProps = before ? Object.entries(before.schema).filter(([id]) => !state?.schema[id]) : [];
  const removedViews = before ? before.views.filter((v) => !state?.views.some((x) => x.id === v.id)) : [];
  const propClass = (id: string) => {
    if (!before) return "";
    const old = before.schema[id];
    if (!old) return " is-changed";
    return JSON.stringify(old) !== JSON.stringify(state?.schema[id]) ? " is-changed" : "";
  };
  const viewClass = (id: string) => {
    if (!before) return "";
    const old = before.views.find((v) => v.id === id);
    if (!old) return " is-changed";
    return JSON.stringify(old) !== JSON.stringify(state?.views.find((v) => v.id === id)) ? " is-changed" : "";
  };
  return (
    <div className={`history__page${icon ? " has-icon" : ""}`}>
      {icon && <div className="history__icon">{url ? <img src={url} alt="" /> : icon}</div>}
      <h1 className={`history__title${previous && previous.title !== version.title ? " is-changed" : ""}`}>
        {version.title || "Sin título"}
      </h1>
      {state?.description && (
        <p className={`history__db-desc${before && before.description !== state.description ? " is-changed" : ""}`}>{state.description}</p>
      )}
      <h2 className="history__db-head">Propiedades</h2>
      <div className="history__db-list">
        {props.map(([id, schema]) => (
          <div key={id} className={`history__db-item${propClass(id)}`}>
            <TypeIcon type={schema.type} size={16} />
            <span>{schema.name}</span>
          </div>
        ))}
        {removedProps.map(([id, schema]) => (
          <div key={id} className="history__db-item is-removed">
            <TypeIcon type={schema.type} size={16} />
            <span>{schema.name}</span>
          </div>
        ))}
      </div>
      <h2 className="history__db-head">Vistas</h2>
      <div className="history__db-list">
        {(state?.views ?? []).map((v) => {
          const Icon = viewIcon(v);
          return (
            <div key={v.id} className={`history__db-item${viewClass(v.id)}`}>
              <Icon size={16} />
              <span>{v.name}</span>
            </div>
          );
        })}
        {removedViews.map((v) => {
          const Icon = viewIcon(v);
          return (
            <div key={v.id} className="history__db-item is-removed">
              <Icon size={16} />
              <span>{v.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
