import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerUpRight,
  GripVertical,
  Link,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  Trash,
  SquareArrowOutUpRight,
} from "lucide-react";
import {
  COMPUTED_TYPES,
  type Block,
  type Collection,
  type CollectionView,
  type FileRef,
  type PageRef,
  type PropertyValue,
} from "../../lib/model";
import {
  addRow,
  duplicatePage,
  placeInViewOrder,
  purgeBlock,
  setRelation,
  setRowValue,
  setTitle,
  updateBlock,
  updateView,
} from "../../lib/ops";
import { db } from "../../lib/db";
import { cellValue, isEmptyValue, subitemConfig } from "../../lib/query";
import { buildTree, useSubitemToggles } from "../../lib/subitems";
import { tintClass, useRowColors } from "./ConditionalColor";
import { HAS_TABS, navigate, openInNewTab, pageTitle, useStoredState } from "../../lib/hooks";
import { groupRows, NO_GROUP, splitHidden, useGroupValues, viewGrouping, type RowGroup } from "../../lib/group";
import { useSettings } from "../../lib/settings";
import { copyLink, MenuItem, MenuSeparator, PageIcon, pointerAnchor, Popover, trashWithUndo, usePopover } from "../ui";
import { iconUrl } from "../ui";
import { coverSrc } from "../PageCover";
import { ComputedValue, PropertyDisplay, TypeIcon } from "./properties";
import { defaultsFromQuery, viewProperties } from "./DatabaseView";
import { GroupHeader, HiddenGroupsToggle } from "./GroupHeader";
import { LoadMore, useLoadLimit } from "./loadLimit";
import { useMoveMenu } from "../MovePicker";

/** The visible, non-empty properties of a row, as read-only chips. */
export function RowSummary({
  row,
  collection,
  view,
  exclude = [],
  inline = false,
}: {
  row: Block;
  collection: Collection;
  view: CollectionView;
  exclude?: string[];
  inline?: boolean;
}) {
  const props = viewProperties(view, collection).filter(
    (p) => p.visible && p.property !== "title" && !exclude.includes(p.property),
  );
  return (
    <>
      {props.map((p) => {
        const schema = collection.schema[p.property];
        if (COMPUTED_TYPES.includes(schema.type))
          return (
            <span className={inline ? "row-chip" : "card__prop"} key={p.property}>
              <ComputedValue row={row} propertyId={p.property} schema={schema} collectionId={collection.id} />
            </span>
          );
        const value = cellValue(row, p.property, schema);
        if (isEmptyValue(value) || value === false) return null;
        return (
          <span className={inline ? "row-chip" : "card__prop"} key={p.property}>
            <PropertyDisplay value={value} schema={schema} />
          </span>
        );
      })}
    </>
  );
}

/** Comments on each row, from its open threads ("💬 N" on cards). */
export function useCommentCounts(rows: Block[]) {
  const key = rows.map((r) => r.id).join();
  return (
    useLiveQuery(async () => {
      const counts = new Map<string, number>();
      if (!key) return counts;
      await db.threads
        .where("page_id")
        .anyOf(key.split(","))
        .each((t) => {
          if (t.resolved || t.deletedAt) return;
          const n = t.comments.filter((c) => !c.deletedAt).length;
          if (n) counts.set(t.page_id, (counts.get(t.page_id) ?? 0) + n);
        });
      return counts;
    }, [key]) ?? new Map<string, number>()
  );
}

/** The comment count line under a card's properties. */
export function CommentCount({ n }: { n?: number }) {
  if (!n) return null;
  return (
    <span className="card__prop card__comments">
      <MessageSquare size={14} />
      {n}
    </span>
  );
}

function Title({ row, iconSize = 16 }: { row: Block; iconSize?: number }) {
  return (
    <span className="row-title">
      {row.format.icon && <PageIcon block={row} size={iconSize} />}
      <span className={isEmptyValue(row.properties.title) ? "muted" : ""}>{pageTitle(row)}</span>
    </span>
  );
}

// ---------------------------------------------------------------- list

/**
 * Right-click on a list row or gallery card: the row actions, at the pointer
 * (the same as a table row's ⋮⋮ menu). `openAt` anchors it to a card's "⋯" button.
 */
export function useRowContextMenu(onOpen: (id: string) => void, onRename?: (id: string) => void) {
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const moveMenu = useMoveMenu();
  const close = () => setMenu(null);
  const act = (fn: (id: string) => unknown) => () => {
    if (!menu) return;
    close();
    void fn(menu.id);
  };
  const onContextMenu = (id: string) => (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ id, anchor: pointerAnchor(e) });
  };
  const openAt = (id: string, anchor: HTMLElement) => setMenu({ id, anchor });
  const element = menu && (
    <Popover anchor={menu.anchor} onClose={close} width={256}>
      <div className="menu">
        <MenuItem icon={<PanelRight size={16} />} onClick={act(onOpen)}>
          Abrir en vista lateral
        </MenuItem>
        <MenuItem icon={<Maximize2 size={16} />} onClick={act(navigate)}>
          Abrir en página completa
        </MenuItem>
        {HAS_TABS && (
          <MenuItem icon={<SquareArrowOutUpRight size={16} />} right="⌘↵" onClick={act(openInNewTab)}>
            Abrir en una pestaña nueva
          </MenuItem>
        )}
        <MenuSeparator />
        {onRename && (
          <MenuItem icon={<Pencil size={16} />} onClick={act(onRename)}>
            Editar título
          </MenuItem>
        )}
        <MenuItem icon={<Link size={16} />} onClick={act(copyLink)}>
          Copiar enlace
        </MenuItem>
        <MenuItem icon={<Copy size={16} />} right="⌘D" onClick={act(duplicatePage)}>
          Duplicar
        </MenuItem>
        <MenuItem
          icon={<CornerUpRight size={16} />}
          right="⌘⇧P"
          onClick={() => {
            if (!menu) return;
            close();
            moveMenu.open(menu.id, menu.anchor);
          }}
        >
          Mover a
        </MenuItem>
        <MenuItem danger icon={<Trash size={16} />} right="Supr" onClick={act(trashWithUndo)}>
          Eliminar
        </MenuItem>
      </div>
    </Popover>
  );
  return {
    onContextMenu,
    openAt,
    openId: menu?.id ?? null,
    element: (
      <>
        {element}
        {moveMenu.element}
      </>
    ),
  };
}

/** A page created in a group gets its value (relations through setRelation, for two-way sync). */
async function addRowInGroup(
  view: CollectionView,
  collection: Collection,
  grouping: NonNullable<ReturnType<typeof viewGrouping>>,
  group: RowGroup,
) {
  const prop = grouping.groupBy.property;
  const relation = grouping.schema.type === "relation";
  const values = { ...defaultsFromQuery(view.query2, collection.schema), ...(relation ? {} : { [prop]: group.value ?? null }) };
  const id = await addRow(collection.id, values);
  if (relation && group.ref) await setRelation(id, prop, [group.ref], false);
  return id;
}

export function ListView({
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
  const grouping = viewGrouping(view, collection.schema);
  // Formula and rollup results, worked out for grouping by them.
  const groupValues = useGroupValues(rows, grouping?.groupBy.property, collection);
  const split = useMemo(
    () => (grouping ? splitHidden(groupRows(rows, grouping.groupBy, grouping.schema, groupValues), grouping.groupBy) : null),
    [rows, grouping?.groupBy, grouping?.schema, groupValues],
  );
  const groups = split ? [...split.shown, ...split.hidden] : null;
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [collapsed, setCollapsed] = useStoredState<string[]>(`xotion:grp:${view.id}`, []);
  const toggle = (key: string) =>
    setCollapsed((list) => (list.includes(key) ? list.filter((x) => x !== key) : [...list, key]));
  const createIn = async (group: RowGroup) => {
    if (grouping) onOpen(await addRowInGroup(view, collection, grouping, group));
  };

  // Drag and drop, as in a table: ⋮⋮ reorders (unsorted views) and moves a page to another group.
  const sorted = view.query2.sort.length > 0;
  const [drag, setDrag] = useState<{ rowId: string; group: string | null } | null>(null);
  const [drop, setDrop] = useState<{ key: string; side: "before" | "after" } | null>(null);
  const canDrag = !sorted || !!groups;
  /** A page dropped in another group takes that group's value (and leaves the old one). */
  const moveToGroup = async (row: Block, from: RowGroup, to: RowGroup) => {
    if (!grouping || from.key === to.key) return;
    const prop = grouping.groupBy.property;
    const type = grouping.schema.type;
    const current = row.properties[prop];
    if (to.key === NO_GROUP) {
      if (type === "relation") return setRelation(row.id, prop, []);
      return setRowValue(row.id, prop, type === "checkbox" ? false : type === "multi_select" || type === "person" ? [] : null);
    }
    if (to.value === undefined) return;
    if (type === "relation") {
      const refs = ((current as PageRef[] | null) ?? []).filter((r) => r.id !== from.ref?.id);
      return setRelation(row.id, prop, to.ref && !refs.some((r) => r.id === to.ref!.id) ? [...refs, to.ref] : refs);
    }
    if (type === "multi_select" || type === "person") {
      const own = type === "person" ? from.label : from.key;
      const list = ((current as string[] | null) ?? []).filter((x) => x !== own);
      return setRowValue(row.id, prop, [...new Set([...list, ...((to.value as string[] | null) ?? [])])]);
    }
    return setRowValue(row.id, prop, to.value);
  };
  const dropOn = async (target: Block, side: "before" | "after", items: Block[], group: RowGroup | null) => {
    const row = rows.find((r) => r.id === drag?.rowId);
    if (!row || !drag || row.id === target.id) return;
    const from = groups?.find((g) => g.key === drag.group);
    if (group && from && from.key !== group.key) await moveToGroup(row, from, group);
    if (sorted) return;
    const list = items.filter((r) => r.id !== row.id);
    const t = list.indexOf(target);
    const prev = side === "before" ? list[t - 1] : list[t];
    const next = side === "before" ? list[t] : list[t + 1];
    // A view with its own order (page_sort) keeps the move to itself.
    if (view.format.page_sort)
      return placeInViewOrder(view.id, rows.map((r) => r.id), row.id, side === "before" ? { before: target.id } : { after: target.id });
    const order = prev && next ? (prev.order + next.order) / 2 : prev ? prev.order + 1 : next ? next.order - 1 : row.order;
    if (order !== row.order) await updateBlock(row.id, { order });
  };
  const endDrag = () => {
    setDrag(null);
    setDrop(null);
  };

  // Sub-items nest under their parent row behind a toggle, as in a table.
  const sub = (view.format.subitems_display ?? "nested") === "nested" ? subitemConfig(collection) : null;
  const subOpen = useSubitemToggles(view);
  // "Color condicional": rows tinted by the view's rules.
  const colors = useRowColors(view, collection, rows);
  /** The rows a list shows (the first `limit` top-level ones and their open sub-items), and how many top-level rows it has. */
  const entriesOf = (items: Block[]) => {
    if (!sub) return { total: items.length, entries: items.slice(0, limit).map((row) => ({ row, depth: 0, kids: 0 })) };
    const tree = buildTree(items, sub.parent);
    const entries: { row: Block; depth: number; kids: number }[] = [];
    const visit = (row: Block, depth: number) => {
      const kids = tree.children.get(row.id) ?? [];
      entries.push({ row, depth, kids: kids.length });
      if (subOpen.isOpen(row.id)) for (const k of kids) visit(k, depth + 1);
    };
    tree.roots.slice(0, limit).forEach((r) => visit(r, 0));
    return { total: tree.roots.length, entries };
  };
  const list = (items: Block[], group: RowGroup | null = null) => {
    const { total, entries } = entriesOf(items);
    return (
    <>
      {entries.map(({ row, depth, kids }) => {
        const key = `${group?.key ?? ""}:${row.id}`;
        return (
        <button
          type="button"
          key={row.id}
          className={`list-row${drop?.key === key ? ` is-drop-${drop.side}` : ""}${drag?.rowId === row.id ? " is-dragging" : ""}${tintClass(colors.get(row.id)?.row)}`}
          onClick={() => onOpen(row.id)}
          onContextMenu={rowMenu.onContextMenu(row.id)}
          draggable={canDrag}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("application/x-xot-row", row.id);
            setDrag({ rowId: row.id, group: group?.key ?? null });
          }}
          onDragEnd={endDrag}
          onDragOver={(e) => {
            if (!drag || drag.rowId === row.id) return;
            // Unsorted views reorder; sorted ones only take pages from another group.
            if (sorted && drag.group === (group?.key ?? null)) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const side = e.clientY < r.top + r.height / 2 ? "before" : "after";
            if (drop?.key !== key || drop.side !== side) setDrop({ key, side });
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (drop) void dropOn(row, drop.side, items, group);
            endDrag();
          }}
        >
          {canDrag && (
            <span className="list-row__grip" aria-hidden>
              <GripVertical size={16} />
            </span>
          )}
          {sub && (
            <span
              role="button"
              className={`list-row__toggle${kids ? "" : " is-empty"}${subOpen.isOpen(row.id) ? " is-open" : ""}`}
              style={{ marginLeft: depth * 24 }}
              aria-label={subOpen.isOpen(row.id) ? "Ocultar subelementos" : "Mostrar subelementos"}
              aria-expanded={subOpen.isOpen(row.id)}
              onClick={(e) => {
                e.stopPropagation();
                subOpen.toggle(row.id);
              }}
            >
              <ChevronRight size={12} strokeWidth={2.4} />
            </span>
          )}
          <Title row={row} />
          <span className="list-row__props">
            <RowSummary row={row} collection={collection} view={view} inline />
          </span>
        </button>
        );
      })}
      <LoadMore hidden={total - limit} onMore={more} />
    </>
    );
  };
  if (split && grouping) {
    const section = (g: RowGroup) => {
      const open = !collapsed.includes(g.key);
      return (
        <div className="list-group" key={g.key}>
          <GroupHeader
            group={g}
            schema={grouping.schema}
            open={open}
            onToggle={() => toggle(g.key)}
            onAdd={g.value === undefined ? undefined : () => void createIn(g)}
            view={view}
          />
          {open && (
            <>
              {list(g.rows, g)}
              {g.value !== undefined && (
                <button type="button" className="table-new" onClick={() => void createIn(g)}>
                  <Plus size={16} /> Nueva página
                </button>
              )}
            </>
          )}
        </div>
      );
    };
    return (
      <div className="list-view list-view--grouped">
        {split.shown.map(section)}
        {split.hidden.length > 0 && (
          <HiddenGroupsToggle count={split.hidden.length} open={hiddenOpen} onToggle={() => setHiddenOpen((o) => !o)} />
        )}
        {hiddenOpen && split.hidden.map(section)}
        {rowMenu.element}
      </div>
    );
  }
  return (
    <div className="list-view">
      {list(rows)}
      <button type="button" className="table-new" onClick={onNew}>
        <Plus size={16} /> Nueva página
      </button>
      {rowMenu.element}
    </div>
  );
}

// ------------------------------------------------------------- gallery

/** Preview image (gallery or board cards): the page cover, the first image in the body, or an image file property. */
export function coverOf(row: Block, cover: CollectionView["format"]["gallery_cover"]): string | null {
  if (!cover || cover.type === "none") return null;
  if (cover.type === "page_cover")
    return row.format.cover && !row.format.cover.startsWith("gradient:") ? coverSrc(row.format.cover) : null;
  if (cover.type === "property" && cover.property) {
    const files = row.properties[cover.property];
    const img = Array.isArray(files)
      ? (files as FileRef[]).find((f) => /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(f.url ?? ""))
      : undefined;
    return img ? (iconUrl(img.url) ?? img.url) : null;
  }
  const blocks = (row.content ?? []) as { type?: string; props?: { url?: string } }[];
  const image = blocks.find((b) => b.type === "image" && b.props?.url)?.props?.url;
  if (image) return image;
  return row.content_markdown?.match(/!\[[^\]]*\]\(([^)\s]+)\)/)?.[1] ?? null;
}

type PreviewBlock = { type?: string; props?: { level?: number; checked?: boolean; url?: string }; content?: unknown };

/** Plain text of a block's inline content (text runs and links). */
function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string; content?: unknown }) =>
      c.type === "link" ? inlineText(c.content) : (c.text ?? ""),
    )
    .join("");
}

/** "Contenido de la página": a scaled-down copy of the page's first blocks, as card previews. */
export function PagePreview({ row, className = "" }: { row: Block; className?: string }) {
  const blocks = ((row.content ?? []) as PreviewBlock[]).slice(0, 10);
  if (!blocks.length) return null;
  let number = 0;
  return (
    <span className={`page-preview${className ? ` ${className}` : ""}`} aria-hidden>
      {blocks.map((b, i) => {
        number = b.type === "numberedListItem" ? number + 1 : 0;
        const text = inlineText(b.content);
        switch (b.type) {
          case "heading":
            return (
              <span key={i} className={`page-preview__h${Math.min(3, b.props?.level ?? 1)}`}>
                {text}
              </span>
            );
          case "bulletListItem":
            return (
              <span key={i} className="page-preview__li">
                <span className="page-preview__marker">•</span>
                {text}
              </span>
            );
          case "numberedListItem":
            return (
              <span key={i} className="page-preview__li">
                <span className="page-preview__marker">{number}.</span>
                {text}
              </span>
            );
          case "checkListItem":
            return (
              <span key={i} className={`page-preview__li${b.props?.checked ? " is-checked" : ""}`}>
                <span className="page-preview__check" />
                {text}
              </span>
            );
          case "quote":
            return (
              <span key={i} className="page-preview__quote">
                {text}
              </span>
            );
          case "divider":
            return <span key={i} className="page-preview__hr" />;
          case "image":
            return b.props?.url ? <img key={i} className="page-preview__img" src={b.props.url} alt="" loading="lazy" /> : null;
          default:
            return text || b.type === "paragraph" ? (
              <span key={i} className="page-preview__p">
                {text || "\u00a0"}
              </span>
            ) : null;
        }
      })}
    </span>
  );
}

/** A card's preview area: the chosen image, or the page's first blocks for "Contenido de la página". */
export function CardPreview({
  row,
  cover,
  className,
}: {
  row: Block;
  cover: CollectionView["format"]["gallery_cover"];
  className: string;
}) {
  const src = coverOf(row, cover);
  if (src)
    return (
      <span className={className}>
        <img src={src} alt="" loading="lazy" />
      </span>
    );
  return <span className={className}>{cover?.type === "page_content" && <PagePreview row={row} />}</span>;
}

/** "Ajustar contenido multimedia": contain fits the whole image in the preview. */
export const coverFit = (view: CollectionView) =>
  ({ "--cover-fit": view.format.gallery_cover_aspect === "contain" ? "contain" : "cover" }) as React.CSSProperties;

export function GalleryView({
  view,
  collection,
  rows,
  onOpen,
  onNew,
  onCreate,
}: {
  view: CollectionView;
  collection: Collection;
  rows: Block[];
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Adds a row without opening it; the new card's title is then edited in place. */
  onCreate?: () => Promise<string>;
}) {
  const size = { small: 180, medium: 260, large: 320 }[view.format.gallery_card_size ?? "medium"];
  const withCover = (view.format.gallery_cover?.type ?? "none") !== "none";
  const [limit, more] = useLoadLimit(view);
  const [editingId, setEditingId] = useState<string | null>(null);
  const rowMenu = useRowContextMenu(onOpen, setEditingId);
  const comments = useCommentCounts(rows);
  const colors = useRowColors(view, collection, rows);
  // "Agrupar": a header and its own card grid per group, as in grouped galleries.
  const grouping = viewGrouping(view, collection.schema);
  const groupValues = useGroupValues(rows, grouping?.groupBy.property, collection);
  const split = useMemo(
    () => (grouping ? splitHidden(groupRows(rows, grouping.groupBy, grouping.schema, groupValues), grouping.groupBy) : null),
    [rows, grouping?.groupBy, grouping?.schema, groupValues],
  );
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [collapsed, setCollapsed] = useStoredState<string[]>(`xotion:grp:${view.id}`, []);
  // Manual order: cards drag to a new place while the view has no sort (a blue bar shows where).
  const sorted = view.query2.sort.length > 0 || !!split;
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ index: number; left: number; top: number; height: number } | null>(null);
  const finishEdit = (id: string, title: string) => {
    setEditingId((current) => (current === id ? null : current));
    void setTitle(id, title.trim());
  };
  const shown = rows.slice(0, limit);
  const dragOver = (e: React.DragEvent<HTMLElement>, i: number) => {
    if (!dragId) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const g = e.currentTarget.parentElement!.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    // Centered in the 16px gap between cards.
    const left = (before ? r.left - 8 : r.right + 8) - g.left - 1.5;
    const index = before ? i : i + 1;
    if (drop?.index !== index || drop.top !== r.top - g.top) setDrop({ index, left, top: r.top - g.top, height: r.height });
  };
  const commitDrop = async () => {
    const row = rows.find((r) => r.id === dragId);
    if (!row || !drop) return;
    const list = shown.filter((r) => r.id !== row.id);
    const at = drop.index - (shown.findIndex((r) => r.id === row.id) < drop.index ? 1 : 0);
    const before = list[at - 1];
    const after = list[at];
    if (view.format.page_sort) {
      await placeInViewOrder(view.id, rows.map((r) => r.id), row.id, { before: after?.id, after: before?.id });
      return;
    }
    const order =
      before && after ? (before.order + after.order) / 2 : before ? before.order + 1 : after ? after.order - 1 : row.order;
    if (order !== row.order) await updateBlock(row.id, { order });
  };
  const card = (row: Block, i: number) => {
    const editing = editingId === row.id;
    return (
      <div
        role="button"
        tabIndex={0}
        key={row.id}
        className={`gallery-card${dragId === row.id ? " is-dragging" : ""}${tintClass(colors.get(row.id)?.row)}`}
        draggable={!editing && !sorted}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", row.id);
          setDragId(row.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setDrop(null);
        }}
        onDragOver={(e) => dragOver(e, i)}
        onClick={() => !editing && onOpen(row.id)}
        onKeyDown={(e) => !editing && e.key === "Enter" && onOpen(row.id)}
        onContextMenu={rowMenu.onContextMenu(row.id)}
      >
        {withCover && <CardPreview row={row} cover={view.format.gallery_cover} className="gallery-card__cover" />}
        <span className="gallery-card__body">
          <span className="row-title gallery-card__title">
            {row.format.icon && (
              <span className="card__icon">
                <PageIcon block={row} size={18} />
              </span>
            )}
            {editing ? (
              <input
                className="card__title-input"
                autoFocus
                defaultValue={typeof row.properties.title === "string" ? row.properties.title : ""}
                placeholder="Escribe un nombre…"
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => finishEdit(row.id, e.currentTarget.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    if (!e.currentTarget.value.trim() && isEmptyValue(row.properties.title)) {
                      setEditingId(null);
                      void purgeBlock(row.id);
                    } else e.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <span className={isEmptyValue(row.properties.title) ? "muted" : ""}>{pageTitle(row)}</span>
            )}
          </span>
          <RowSummary row={row} collection={collection} view={view} />
          <CommentCount n={comments.get(row.id)} />
        </span>
        {!editing && (
          <span className={`card__tools${rowMenu.openId === row.id ? " is-open" : ""}`}>
            <button
              type="button"
              aria-label="Editar título"
              onClick={(e) => {
                e.stopPropagation();
                setEditingId(row.id);
              }}
            >
              <Pencil size={16} />
            </button>
            <button
              type="button"
              aria-label="Más acciones"
              onClick={(e) => {
                e.stopPropagation();
                rowMenu.openAt(row.id, e.currentTarget);
              }}
            >
              <MoreHorizontal size={16} />
            </button>
          </span>
        )}
      </div>
    );
  };
  const columns = `repeat(auto-fill, minmax(${size}px, 1fr))`;
  if (split && grouping) {
    const section = (g: RowGroup) => {
      const open = !collapsed.includes(g.key);
      const create = g.value === undefined ? undefined : () => void addRowInGroup(view, collection, grouping, g).then(onOpen);
      return (
        <div className="gallery-group" key={g.key}>
          <GroupHeader
            group={g}
            schema={grouping.schema}
            open={open}
            onToggle={() => setCollapsed((list) => (list.includes(g.key) ? list.filter((x) => x !== g.key) : [...list, g.key]))}
            onAdd={create}
            view={view}
          />
          {open && (
            <div className="gallery" style={{ gridTemplateColumns: columns }}>
              {g.rows.slice(0, limit).map(card)}
              {g.rows.length > limit && (
                <button type="button" className="gallery-card gallery-card--new" onClick={more}>
                  Cargar más ({g.rows.length - limit})
                </button>
              )}
              {create && (
                <button type="button" className="gallery-card gallery-card--new" onClick={create}>
                  <Plus size={16} /> Nueva página
                </button>
              )}
            </div>
          )}
        </div>
      );
    };
    return (
      <div className="gallery-groups" style={coverFit(view)}>
        {split.shown.map(section)}
        {split.hidden.length > 0 && (
          <HiddenGroupsToggle count={split.hidden.length} open={hiddenOpen} onToggle={() => setHiddenOpen((o) => !o)} />
        )}
        {hiddenOpen && split.hidden.map(section)}
        {rowMenu.element}
      </div>
    );
  }
  return (
    <div
      className="gallery"
      style={{ ...coverFit(view), gridTemplateColumns: columns }}
      onDrop={(e) => {
        if (!dragId) return;
        e.preventDefault();
        void commitDrop();
        setDragId(null);
        setDrop(null);
      }}
      onDragOver={(e) => dragId && drop && e.preventDefault()}
    >
      {shown.map(card)}
      {drop && <div className="gallery__drop" style={{ left: drop.left, top: drop.top, height: drop.height }} />}
      {rows.length > limit && (
        <button type="button" className="gallery-card gallery-card--new" onClick={more}>
          Cargar más ({rows.length - limit})
        </button>
      )}
      <button
        type="button"
        className="gallery-card gallery-card--new"
        onClick={async () => (onCreate ? setEditingId(await onCreate()) : onNew())}
      >
        <Plus size={16} /> Nueva página
      </button>
      {rowMenu.element}
    </div>
  );
}

// ------------------------------------------------------------ calendar

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00`);
const addDays = (s: string, n: number) => {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return isoDay(d);
};
const daysBetween = (a: string, b: string) => Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86400000);
const WEEKDAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

/** A date value with its start or end moved to `day` (keeping times); ends before the start swap. */
function stretchDate(value: string, edge: "start" | "end", day: string): string {
  const [start, end = start] = value.split("/");
  let from = edge === "start" ? day + start.slice(10) : start;
  let to = edge === "end" ? day + end.slice(10) : end;
  if (to.slice(0, 10) < from.slice(0, 10)) [from, to] = [to, from];
  return from === to ? from : `${from}/${to}`;
}

/** Moves a date value to a new start day, keeping its time and range length. */
function moveDate(value: string, day: string): string {
  const [start, end] = value.split("/");
  const time = start.slice(10);
  const moved = day + time;
  if (!end) return moved;
  return `${moved}/${addDays(day, daysBetween(start, end))}${end.slice(10)}`;
}

/** An empty calendar or timeline's "Mostrar … por…": a button opening the date properties, in the menu style. */
export function DatePropPicker({
  label,
  schema,
  onPick,
}: {
  label: string;
  schema: Collection["schema"];
  onPick: (id: string) => void;
}) {
  const pop = usePopover();
  const dates = Object.entries(schema).filter(([, s]) => s.type === "date");
  return (
    <>
      <button type="button" className="db-empty-pick" onClick={(e) => pop.toggle(e.currentTarget)}>
        {label}
        <ChevronDown size={14} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={240}>
          <div className="menu">
            {dates.map(([id, s]) => (
              <MenuItem
                key={id}
                icon={<TypeIcon type={s.type} />}
                onClick={() => {
                  pop.close();
                  onPick(id);
                }}
              >
                {s.name}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

export function CalendarView({
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
  onNew: (values?: Record<string, PropertyValue>) => void;
}) {
  const weekly = view.format.calendar_range === "week";
  const colors = useRowColors(view, collection, rows);
  /** "Mostrar fines de semana" off: five columns, Monday to Friday. */
  const cols = view.format.calendar_show_weekends === false ? 5 : 7;
  // Configuración > "Iniciar la semana el lunes" (weeks without weekends always start on Monday).
  const monday = useSettings().weekStartsMonday || cols === 5;
  const weekdays = monday ? WEEKDAYS : [WEEKDAYS[6], ...WEEKDAYS.slice(0, 6)];
  const dayIndex = (d: Date) => (monday ? (d.getDay() + 6) % 7 : d.getDay());
  const startOfWeek = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - dayIndex(d));
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return weekly ? startOfWeek(d) : new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [dragId, setDragId] = useState<string | null>(null);
  /** Dragging an item's left or right edge: its start or end day follows the pointer. */
  const [resize, setResize] = useState<{ id: string; edge: "start" | "end" } | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const dateProps = Object.entries(collection.schema).filter(([, s]) => s.type === "date");
  const by = view.format.calendar_by && collection.schema[view.format.calendar_by] ? view.format.calendar_by : undefined;

  if (!by)
    return (
      <div className="board-empty">
        <p>El calendario coloca cada fila según una propiedad de fecha.</p>
        {dateProps.length ? (
          <DatePropPicker
            label="Mostrar calendario por…"
            schema={collection.schema}
            onPick={(id) => updateView(view.id, { format: { ...view.format, calendar_by: id } })}
          />
        ) : (
          <p className="muted">Añade una propiedad de tipo «Fecha» desde Propiedades.</p>
        )}
      </div>
    );

  const schema = collection.schema[by];
  const first = isoDay(month);
  const offset = dayIndex(month);
  const gridStart = addDays(first, -offset);
  const nextMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const weeks = weekly ? 1 : Math.ceil((offset + daysBetween(first, isoDay(nextMonth))) / 7);
  const today = isoDay(new Date());

  // Each dated row, as a [start, end] day range (single days have start === end).
  const ranges: { row: Block; start: string; end: string }[] = [];
  for (const row of rows) {
    const v = cellValue(row, by, schema);
    if (typeof v !== "string" || !v) continue;
    const [start, end] = v.split("/");
    const span = end ? Math.min(366, Math.max(0, daysBetween(start, end))) : 0;
    ranges.push({ row, start: start.slice(0, 10), end: addDays(start, span) });
  }
  ranges.sort((a, b) => a.start.localeCompare(b.start) || daysBetween(b.start, b.end) - daysBetween(a.start, a.end));

  // An item is the title row plus one 24px row per visible property it shows (as RowSummary does).
  const props = viewProperties(view, collection).filter((p) => p.visible && p.property !== "title");
  const shownProps = (row: Block) =>
    props.filter((p) => {
      const ps = collection.schema[p.property];
      if (COMPUTED_TYPES.includes(ps.type)) return true;
      const value = cellValue(row, p.property, ps);
      return !isEmptyValue(value) && value !== false;
    }).length;
  const itemHeight = (row: Block) => 24 + 24 * shownProps(row) + 4 + 6;

  /** The week's bars: each range clipped to the week, stacked in the first lane that is free. */
  const layoutWeek = (weekStart: string) => {
    const weekEnd = addDays(weekStart, 6);
    const lanes: { until: number; height: number }[] = [];
    const bars = [];
    for (const r of ranges) {
      if (r.end < weekStart || r.start > weekEnd) continue;
      const from = Math.max(0, daysBetween(weekStart, r.start));
      const to = Math.min(cols - 1, daysBetween(weekStart, r.end));
      if (from > to) continue;
      let lane = lanes.findIndex((l) => l.until < from);
      if (lane === -1) lane = lanes.push({ until: -1, height: 0 }) - 1;
      lanes[lane].until = to;
      lanes[lane].height = Math.max(lanes[lane].height, itemHeight(r.row));
      bars.push({ ...r, from, to, lane, contLeft: r.start < weekStart, contRight: r.end > addDays(weekStart, cols - 1) });
    }
    const tops = lanes.reduce<number[]>((acc, _, i) => [...acc, i ? acc[i - 1] + lanes[i - 1].height : 30], []);
    const height = Math.max(weekly ? 372 : 124, (tops.at(-1) ?? 30) + (lanes.at(-1)?.height ?? 0) + 4);
    return { bars: bars.map((b) => ({ ...b, top: tops[b.lane] })), height };
  };

  const label = weekly
    ? `${month.toLocaleDateString("es", { day: "numeric", month: "short" })} – ${parseDay(addDays(first, 6)).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" })}`
    : month.toLocaleDateString("es", { month: "long", year: "numeric" });
  const shift = (n: number) =>
    setMonth(weekly ? parseDay(addDays(first, 7 * n)) : new Date(month.getFullYear(), month.getMonth() + n, 1));
  /** The day under the pointer in a week row. */
  const dayAt = (e: React.DragEvent<HTMLElement>, weekStart: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    return addDays(weekStart, Math.min(cols - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * cols))));
  };

  return (
    <div className="calendar">
      <div className="calendar__nav">
        <span className="calendar__month">{label.charAt(0).toUpperCase() + label.slice(1)}</span>
        <button type="button" className="icon-btn" aria-label="Mes anterior" onClick={() => shift(-1)}>
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          className="text-btn calendar__today"
          onClick={() => setMonth(weekly ? startOfWeek(new Date()) : new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
        >
          Hoy
        </button>
        <button type="button" className="icon-btn" aria-label="Mes siguiente" onClick={() => shift(1)}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="calendar__weekdays">
        {weekdays.slice(0, cols).map((d) => (
          <div key={d} className="calendar__weekday">
            {d}
          </div>
        ))}
      </div>
      <div className={`calendar__grid${weekly ? " calendar__grid--week" : ""}`}>
        {Array.from({ length: weeks }, (_, w) => {
          const weekStart = addDays(gridStart, w * 7);
          const { bars, height } = layoutWeek(weekStart);
          return (
            <div
              key={weekStart}
              className="calendar__week"
              style={{ height }}
              onDragOver={(e) => {
                if (!dragId && !resize) return;
                e.preventDefault();
                const day = dayAt(e, weekStart);
                if (overDay !== day) setOverDay(day);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const day = dayAt(e, weekStart);
                const row = rows.find((r) => r.id === (resize?.id ?? dragId));
                const v = row ? cellValue(row, by, schema) : null;
                if (row && typeof v === "string")
                  void setRowValue(row.id, by, resize ? stretchDate(v, resize.edge, day) : moveDate(v, day));
                setDragId(null);
                setResize(null);
                setOverDay(null);
              }}
            >
              {Array.from({ length: cols }, (_, i) => {
                const day = addDays(weekStart, i);
                const outside = !weekly && day.slice(0, 7) !== first.slice(0, 7);
                const isToday = day === today;
                return (
                  <div
                    key={day}
                    className={`calendar__day${i >= 5 ? " is-weekend" : ""}${outside ? " is-outside" : ""}${overDay === day ? " is-over" : ""}`}
                  >
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm calendar__add"
                      aria-label={`Nueva fila el ${day}`}
                      onClick={() => onNew({ [by]: day })}
                    >
                      <Plus size={14} />
                    </button>
                    <span className={`calendar__num${isToday ? " is-today" : ""}`}>
                      {day.endsWith("-01") && !isToday
                        ? parseDay(day).toLocaleDateString("es", { day: "numeric", month: "short" })
                        : Number(day.slice(8))}
                    </span>
                  </div>
                );
              })}
              {bars.map(({ row, from, to, top, contLeft, contRight }) => (
                <div
                  key={row.id}
                  className={`calendar__slot${contLeft ? " is-cont-left" : ""}${contRight ? " is-cont-right" : ""}`}
                  style={{ left: `calc(100% / ${cols} * ${from})`, width: `calc(100% / ${cols} * ${to - from + 1})`, top }}
                >
                  {/* A div, not a button: relation chips inside are buttons themselves. */}
                  <div
                    role="button"
                    tabIndex={0}
                    className={`calendar__item${tintClass(colors.get(row.id)?.row)}`}
                    draggable={schema.type === "date"}
                    onDragStart={() => setDragId(row.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverDay(null);
                    }}
                    onClick={() => onOpen(row.id)}
                    onKeyDown={(e) => e.key === "Enter" && onOpen(row.id)}
                  >
                    <Title row={row} iconSize={14} />
                    <RowSummary row={row} collection={collection} view={view} />
                  </div>
                  {schema.type === "date" &&
                    (["start", "end"] as const).map(
                      (edge) =>
                        !(edge === "start" ? contLeft : contRight) && (
                          <span
                            key={edge}
                            className={`calendar__handle calendar__handle--${edge}`}
                            draggable
                            onClick={(e) => e.stopPropagation()}
                            onDragStart={(e) => {
                              e.stopPropagation();
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", row.id);
                              setResize({ id: row.id, edge });
                            }}
                            onDragEnd={() => {
                              setResize(null);
                              setOverDay(null);
                            }}
                          />
                        ),
                    )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
