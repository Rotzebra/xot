import { useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  CornerUpRight,
  Eye,
  EyeOff,
  Link,
  Maximize2,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  SquareArrowOutUpRight,
  Trash,
} from "lucide-react";
import type {
  Block,
  BoardColumn,
  Collection,
  CollectionView,
  OptionColor,
  PageRef,
  PropertySchema,
  PropertyValue,
  SelectOption,
} from "../../lib/model";
import {
  addOption,
  deleteOption,
  duplicatePage,
  placeInViewOrder,
  purgeBlock,
  setRelation,
  setRowValue,
  setTitle,
  updateBlock,
  updateOption,
  updateView,
} from "../../lib/ops";
import { cellValue, isEmptyValue } from "../../lib/query";
import {
  boardGroupBy,
  GROUPABLE_TYPES,
  groupRows as bucketRows,
  isComputedGroup,
  NO_GROUP,
  useComputed,
  useGroupValues,
  type RowGroup,
} from "../../lib/group";
import { HAS_TABS, navigate, openInNewTab, pageTitle, useStoredState } from "../../lib/hooks";
import { copyLink, MenuItem, MenuLabel, MenuSeparator, PageIcon, pointerAnchor, Popover, trashWithUndo, usePopover } from "../ui";
import { ComputedValue, formatDate, OptionEditor, PropertyDisplay, Tag, TypeIcon } from "./properties";
import { calcLabel, computeCalc } from "../../lib/calc";
import { CalcMenu } from "./CalcMenu";
import { tintClass, useRowColors } from "./ConditionalColor";
import { COMPUTED_TYPES } from "../../lib/model";
import { viewProperties } from "./DatabaseView";
import { CommentCount, coverFit, coverOf, PagePreview, useCommentCounts } from "./views";
import { LoadMore, useLoadLimit } from "./loadLimit";
import { GroupHeader, GroupValue } from "./GroupHeader";
import { useMoveMenu } from "../MovePicker";

const NONE = NO_GROUP;
/** Properties whose groups are its options (and status groups): columns can be renamed, recoloured, added. */
const OPTION_TYPES = ["select", "status", "multi_select"];
/** Column widths for the card sizes (cards are 16px narrower). Large is not measured. */
const COLUMN_WIDTH = { small: 196, medium: 276, large: 336 };

export interface Column {
  key: string;
  label: string;
  color: OptionColor | null;
  /** Option shown in the header (option mode), absent for status groups and "no value". */
  option?: SelectOption;
  /** Options a card gets when created in or dropped on this column. */
  optionIds: string[];
  /** Any other property: the group, which draws the header and holds the value a card gets here. */
  group?: RowGroup;
}

/** `lane`: the sub-group (swimlane) the card is in, on sub-grouped boards. */
type Drag = { rowId: string; from: string; lane?: string };
type Drop = { column: string; index: number; lane?: string };

function optionColumns(group: PropertySchema, byGroup: boolean): Column[] {
  const options = group.options ?? [];
  const base: Column[] = [{ key: NONE, label: `Sin ${group.name}`, color: null, optionIds: [] }];
  if (byGroup)
    for (const g of group.groups ?? [])
      base.push({ key: g.id, label: g.name, color: g.color, optionIds: g.option_ids });
  else
    for (const o of options) base.push({ key: o.id, label: o.value, color: o.color, option: o, optionIds: [o.id] });
  return base;
}

/** Columns in the view's order: saved order first (manual), then anything new (e.g. options added later). */
function orderColumns(view: CollectionView, base: Column[]): Column[] {
  const sort = view.format.board_group?.sort ?? "manual";
  if (sort !== "manual") {
    // Sorted groups: by name for options (other properties come sorted), "no value" last.
    if (!base.some((c) => c.option || c.color)) return base;
    const named = base.filter((c) => c.key !== NONE);
    named.sort((a, b) => a.label.localeCompare(b.label, "es", { numeric: true }) * (sort === "descending" ? -1 : 1));
    const none = base.find((c) => c.key === NONE);
    return none ? [...named, none] : named;
  }
  const saved = view.format.board_columns ?? [];
  const rank = (c: Column) => {
    const i = saved.findIndex((s) => (s.value ?? NONE) === c.key);
    if (i !== -1) return i;
    return c.key === NONE ? -1 : saved.length + base.indexOf(c);
  };
  return [...base].sort((a, b) => rank(a) - rank(b));
}

/**
 * Cards by column, in board order; null when the view has nothing to group by.
 * `values` are a computed property's results (formula, rollup), by row id.
 */
export function boardColumns(
  view: CollectionView,
  collection: Collection,
  rows: Block[],
  values?: Map<string, PropertyValue>,
) {
  const groupId = view.format.board_group_by;
  const group = groupId ? collection.schema[groupId] : undefined;
  if (!groupId || !group || !GROUPABLE_TYPES.includes(group.type)) return null;

  if (OPTION_TYPES.includes(group.type)) {
    const multi = group.type === "multi_select";
    const byGroup = group.type === "status" && view.format.board_group_mode === "group";
    const columns = orderColumns(view, optionColumns(group, byGroup));
    const keysOf = (row: Block): string[] => {
      const v = row.properties[groupId];
      if (multi) {
        const ids = (Array.isArray(v) ? (v as string[]) : []).filter((id) => columns.some((c) => c.key === id));
        return ids.length ? ids : [NONE];
      }
      if (typeof v !== "string") return [NONE];
      const column = columns.find((c) => c.optionIds.includes(v));
      return [column?.key ?? NONE];
    };
    const byColumn = new Map(columns.map((c) => [c.key, [] as Block[]]));
    for (const row of rows) for (const key of keysOf(row)) byColumn.get(key)!.push(row);
    return { group, groupId, columns, byColumn };
  }

  // Any other property: the same groups a grouped table shows (people, pages, dates, ranges…).
  const groupBy = { ...boardGroupBy(view)!, hide_empty: false };
  const groups = bucketRows(rows, groupBy, group, values);
  const base: Column[] = groups.map((g) => ({
    key: g.key,
    label: g.key === NONE ? `Sin ${group.name}` : g.label,
    color: g.color ?? null,
    optionIds: [],
    group: g,
  }));
  // "No value" is always a drop target (checkboxes have none: unchecked is their empty value).
  if (group.type !== "checkbox" && !base.some((c) => c.key === NONE)) {
    const none: Column = {
      key: NONE,
      label: `Sin ${group.name}`,
      color: null,
      optionIds: [],
      group: { key: NONE, label: `Sin ${group.name}`, rows: [], value: isComputedGroup(group.type) ? undefined : null, rank: "" },
    };
    if ((groupBy.sort ?? "manual") === "manual") base.unshift(none);
    else base.push(none);
  }
  const columns = orderColumns(view, base);
  const byColumn = new Map(columns.map((c) => [c.key, c.group?.rows ?? []]));
  return { group, groupId, columns, byColumn };
}

/** The saved setting (order, visibility) of a column. */
export const columnSetting = (view: CollectionView, key: string) =>
  view.format.board_columns?.find((s) => (s.value ?? NONE) === key);

/** board_columns for the groups in this order; "no value" only once it has a setting (or is the one changed). */
export function savedColumns(
  view: CollectionView,
  ordered: Column[],
  changed: string,
  hiddenOf: (c: Column) => boolean,
): BoardColumn[] {
  return ordered
    .filter((c) => c.key !== NONE || columnSetting(view, c.key) || c.key === changed)
    .map((c) => ({ value: c.key === NONE ? null : c.key, ...(hiddenOf(c) ? { hidden: true } : {}) }));
}

/** A column's name as its header shows it: the option tag, status group pill, person, page, checkbox or text. */
export function ColumnLabel({ column, schema }: { column: Column; schema: PropertySchema }) {
  if (column.option) return <Tag option={column.option} status={schema.type === "status"} />;
  if (column.color) return <Tag option={{ id: column.key, value: column.label, color: column.color }} status />;
  if (column.group && column.key !== NONE) return <GroupValue group={column.group} schema={schema} />;
  return <span className="board-col__none">{column.label}</span>;
}

/** Row ids as the board shows them (down each visible column, then the next), for the peek's ↑/↓. */
export function boardRowOrder(view: CollectionView, collection: Collection, rows: Block[]): string[] {
  const board = boardColumns(view, collection, rows);
  if (!board) return rows.map((r) => r.id);
  const { columns, byColumn } = board;
  const saved = view.format.board_columns;
  const ids = columns
    .filter((c) => !saved?.find((s) => (s.value ?? NONE) === c.key)?.hidden)
    .flatMap((c) => byColumn.get(c.key)!.map((r) => r.id));
  return [...new Set(ids)];
}

export function BoardView({
  view,
  collection,
  rows,
  onOpen,
  onNew,
  onCreate,
  locked = false,
}: {
  view: CollectionView;
  collection: Collection;
  rows: Block[];
  onOpen: (id: string) => void;
  onNew: (values?: Record<string, PropertyValue>) => void;
  /** Adds a row without opening it (cards created in a group are edited in place). */
  onCreate?: (values: Record<string, PropertyValue>, order?: number) => Promise<string>;
  /** "Bloquear base de datos": groups can't be added or reordered; cards stay editable. */
  locked?: boolean;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [limit, more] = useLoadLimit(view);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openHidden, setOpenHidden] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ kind: "card" | "column"; id: string } | null>(null);
  const moveMenu = useMoveMenu();
  // Group headers drag to reorder the groups (saved in board_columns).
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [dropGroup, setDropGroup] = useState<{ key: string; after: boolean } | null>(null);
  // "+ Nuevo grupo" (select and multi-select boards): its name input while open.
  const [addingGroup, setAddingGroup] = useState(false);
  // Groups added here stay in sight while empty, even with "Ocultar grupos vacíos".
  const [addedGroups, setAddedGroups] = useState<string[]>([]);
  const comments = useCommentCounts(rows);
  const pop = usePopover();
  const headsRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const values = useGroupValues(rows, view.format.board_group_by, collection);
  // "Color condicional": cards tinted by the view's rules.
  const colors = useRowColors(view, collection, rows);
  const board = boardColumns(view, collection, rows, values);
  // "Subagrupar": a second property splits the board into collapsible swimlanes.
  const subId = view.format.board_sub_group_by;
  const subSchema =
    subId && subId !== view.format.board_group_by && GROUPABLE_TYPES.includes(collection.schema[subId]?.type)
      ? collection.schema[subId]
      : undefined;
  const subValues = useGroupValues(rows, subSchema ? subId : undefined, collection);
  const [closedLanes, setClosedLanes] = useStoredState<string[]>(`xotion:lanes:${view.id}`, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const groupable = Object.entries(collection.schema).filter(([, s]) => GROUPABLE_TYPES.includes(s.type));

  if (!board) {
    return (
      <div className="board-empty">
        <p>Un tablero agrupa las filas por una de sus propiedades.</p>
        {groupable.length ? (
          <select
            className="field"
            defaultValue=""
            onChange={(e) => updateView(view.id, { format: { ...view.format, board_group_by: e.target.value } })}
          >
            <option value="" disabled>
              Agrupar por…
            </option>
            {groupable.map(([id, s]) => (
              <option key={id} value={id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="muted">Añade una propiedad desde Propiedades para agrupar las tarjetas.</p>
        )}
      </div>
    );
  }

  const { group, groupId, byColumn } = board;
  const size = view.format.board_card_size ?? "medium";
  // A formula's results are still being worked out: the board waits for them instead of flashing every card in "no value".
  const pending = isComputedGroup(group.type) && !values;
  const columns = pending ? [] : board.columns;
  const multi = group.type === "multi_select";
  const optionBased = OPTION_TYPES.includes(group.type);

  const settingOf = (c: Column) => columnSetting(view, c.key);
  const shown = columns.filter((c) => {
    const setting = settingOf(c);
    const empty = byColumn.get(c.key)!.length === 0;
    if (empty && view.format.board_hide_empty && !addedGroups.includes(c.key)) return false;
    // Boards made in Xot only show "no value" while it has cards (or during a drag).
    if (c.key === NONE && empty && !setting && !drag) return false;
    return true;
  });
  const visible = shown.filter((c) => !settingOf(c)?.hidden);
  const hidden = shown.filter((c) => settingOf(c)?.hidden);

  /** Saves the groups' order and visibility; "no value" only once it has a setting (or is the one changed). */
  const saveColumns = (
    ordered: Column[],
    changed: string,
    hiddenOf: (c: Column) => boolean,
    patch: Partial<CollectionView["format"]> = {},
  ) => {
    const next = savedColumns(view, ordered, changed, hiddenOf);
    void updateView(view.id, { format: { ...view.format, board_columns: next, ...patch } });
  };
  const setHidden = (key: string, hide: boolean) =>
    saveColumns(columns, key, (c) => (c.key === key ? hide : !!settingOf(c)?.hidden));
  const moveGroup = (key: string, target: string, after: boolean) => {
    const moving = columns.find((c) => c.key === key);
    if (!moving || key === target) return;
    const next = columns.filter((c) => c.key !== key);
    const at = next.findIndex((c) => c.key === target);
    next.splice(at + (after ? 1 : 0), 0, moving);
    // Moving a group by hand turns a sorted group order into a manual one.
    const manual = (view.format.board_group?.sort ?? "manual") === "manual";
    saveColumns(next, key, (c) => !!settingOf(c)?.hidden, manual ? {} : { board_group: { ...view.format.board_group, sort: "manual" } });
  };
  const canAddGroup = !locked && (group.type === "select" || group.type === "multi_select");

  // Swimlanes: the sub-groups that have cards, each showing the same columns.
  const lanes =
    subSchema && subId && !(isComputedGroup(subSchema.type) && !subValues)
      ? bucketRows(rows, { property: subId, sort: "manual", hide_empty: true }, subSchema, subValues)
      : null;
  const laneSets = new Map((lanes ?? []).map((l) => [l.key, new Set(l.rows.map((r) => r.id))]));
  /** A column's cards, in one swimlane when the board is sub-grouped. */
  const listIn = (column: Column, lane?: RowGroup | null) => {
    const list = byColumn.get(column.key)!;
    const ids = lane ? laneSets.get(lane.key) : undefined;
    return ids ? list.filter((r) => ids.has(r.id)) : list;
  };
  /** A card moved to another swimlane takes its value (multi-valued properties swap the lane it left). */
  const moveToLane = async (row: Block, fromKey: string | undefined, to: RowGroup) => {
    if (!subSchema || !subId || fromKey === to.key) return;
    const from = lanes?.find((l) => l.key === fromKey);
    const type = subSchema.type;
    const current = row.properties[subId];
    if (to.key === NONE) {
      if (type === "relation") return setRelation(row.id, subId, []);
      return setRowValue(row.id, subId, type === "checkbox" ? false : type === "multi_select" || type === "person" ? [] : null);
    }
    if (to.value === undefined) return;
    if (type === "relation") {
      const refs = ((current as PageRef[] | null) ?? []).filter((r) => r.id !== from?.ref?.id);
      return setRelation(row.id, subId, to.ref && !refs.some((r) => r.id === to.ref!.id) ? [...refs, to.ref] : refs);
    }
    if (type === "multi_select" || type === "person") {
      const own = type === "person" ? from?.label : from?.key;
      const list = ((current as string[] | null) ?? []).filter((x) => x !== own);
      return setRowValue(row.id, subId, [...new Set([...list, ...((to.value as string[] | null) ?? [])])]);
    }
    return setRowValue(row.id, subId, to.value);
  };
  const addGroup = async (value: string) => {
    setAddingGroup(false);
    if (!value.trim()) return;
    const option = await addOption(collection.id, groupId, value.trim());
    if (option) setAddedGroups((list) => [...list, option.id]);
  };
  const viewOrder = view.format.page_sort;

  const cardProps = viewProperties(view, collection).filter(
    (p) => p.visible && p.property !== "title" && p.property !== groupId,
  );
  const sorted = view.query2.sort.length > 0;
  const tinted = view.format.board_color_columns !== false;
  const withCover = (view.format.board_cover?.type ?? "none") !== "none";

  /** Whether a card can be moved into the column: its group must have a value to give (not a date bucket or a formula). */
  const canReceive = (column: Column) => optionBased || !column.group || column.group.value !== undefined;
  /** People and related pages are lists: a move swaps the group the card left for the one it lands in. */
  const swapped = <T,>(list: T[], keyOf: (x: T) => string, column: Column, add?: T) => {
    if (column.key === NONE) return [];
    const without = drag && drag.from !== NONE ? list.filter((x) => keyOf(x) !== drag.from) : list;
    return !add || without.some((x) => keyOf(x) === keyOf(add)) ? without : [...without, add];
  };
  const relationFor = (column: Column, current?: PropertyValue): PageRef[] =>
    swapped(Array.isArray(current) ? (current as PageRef[]) : [], (r) => `r:${r.id}`, column, column.group?.ref);

  const valueFor = (column: Column, current?: PropertyValue): PropertyValue => {
    const g = column.group;
    if (g) {
      if (group.type === "person")
        return swapped(Array.isArray(current) ? (current as string[]) : [], (n) => `p:${n}`, column, (g.value as string[] | null)?.[0]);
      if (group.type === "relation") return relationFor(column, current);
      // A day group keeps the card's time of day.
      if (group.type === "date" && typeof g.value === "string" && typeof current === "string" && current[10] === "T")
        return g.value + current.slice(10).split("/")[0];
      return g.value ?? null;
    }
    if (multi) {
      const list = Array.isArray(current) ? (current as string[]) : [];
      const without = drag && drag.from !== NONE ? list.filter((id) => id !== drag.from) : list;
      if (column.key === NONE) return without;
      return without.includes(column.key) ? without : [...without, column.key];
    }
    if (column.key === NONE) return null;
    // Dropping on a status group keeps the option if it already belongs there.
    if (typeof current === "string" && column.optionIds.includes(current)) return current;
    return column.optionIds[0] ?? null;
  };

  /** "+ Nueva página": an empty card at the end (or top) of the group with its title being edited. */
  const createIn = async (column: Column, top = false, lane?: RowGroup | null) => {
    // Relations are linked after the page exists, so the related page links back (two-way relations).
    const relation = group.type === "relation" && column.group?.ref;
    const values: Record<string, PropertyValue> = relation ? {} : { [groupId]: valueFor(column) };
    // In a swimlane the card also gets the lane's value.
    const laneRef = lane && subSchema?.type === "relation" ? lane.ref : undefined;
    if (lane && subId && !laneRef && lane.value !== undefined && lane.key !== NONE) values[subId] = lane.value;
    if (!onCreate) return onNew(relation ? { ...values, [groupId]: [relation] } : values);
    const list = listIn(column, lane);
    const order = top && !sorted && list.length && !viewOrder ? list[0].order - 1 : undefined;
    const id = await onCreate(values, order);
    if (relation) await setRelation(id, groupId, [relation], false);
    if (laneRef && subId) await setRelation(id, subId, [laneRef], false);
    // A view with its own order lists the new card above the group's first one.
    if (top && !sorted && list.length && viewOrder)
      await placeInViewOrder(view.id, rows.map((r) => r.id), id, { before: list[0].id });
    setEditingId(id);
  };

  const finishEdit = (id: string, title: string) => {
    setEditingId((current) => (current === id ? null : current));
    void setTitle(id, title.trim());
  };

  const dropIndex = (e: React.DragEvent, list: HTMLElement) => {
    const cards = [...list.querySelectorAll<HTMLElement>("[data-card]")];
    const i = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return i === -1 ? cards.length : i;
  };

  const commitDrop = async (column: Column, index: number, lane?: RowGroup | null) => {
    if (!drag) return;
    const row = rows.find((r) => r.id === drag.rowId);
    if (!row) return;
    if (drag.from !== column.key) {
      if (!canReceive(column)) return;
      const current = row.properties[groupId];
      if (group.type === "relation") await setRelation(row.id, groupId, relationFor(column, current));
      else await setRowValue(row.id, groupId, valueFor(column, current));
    }
    // Into another swimlane: the card takes that lane's value too.
    if (lane && drag.lane !== lane.key) await moveToLane(row, drag.lane, lane);
    if (!sorted) {
      // `index` counts the dragged card when it comes from this column.
      const full = listIn(column, lane);
      const from = full.findIndex((r) => r.id === row.id);
      const at = from !== -1 && from < index ? index - 1 : index;
      const list = full.filter((r) => r.id !== row.id);
      const before = list[at - 1];
      const after = list[at];
      // A view with its own order (page_sort) keeps the move to itself.
      if (viewOrder) {
        if (before || after)
          await placeInViewOrder(view.id, rows.map((r) => r.id), row.id, { before: after?.id, after: before?.id });
        return;
      }
      // Place between neighbours using fractional order.
      const order =
        before && after
          ? (before.order + after.order) / 2
          : before
            ? before.order + 1
            : after
              ? after.order - 1
              : row.order;
      if (order !== row.order) await updateBlock(row.id, { order });
    }
  };

  const openMenu = (e: React.MouseEvent<HTMLElement>, kind: "card" | "column", id: string) => {
    e.stopPropagation();
    setMenu({ kind, id });
    pop.open(e.currentTarget);
  };
  const closeMenu = () => {
    pop.close();
    setMenu(null);
  };

  const card = (row: Block, column: Column, lane?: RowGroup | null) => {
    const editing = editingId === row.id;
    const cover = withCover ? coverOf(row, view.format.board_cover) : null;
    const preview = !cover && view.format.board_cover?.type === "page_content" && !!row.content?.length;
    return (
      <div
        data-card
        className={`card${drag?.rowId === row.id ? " is-dragging" : ""}${tintClass(colors.get(row.id)?.row)}`}
        draggable={!editing}
        onContextMenu={(e) => {
          if (editing) return;
          e.preventDefault();
          e.stopPropagation();
          setMenu({ kind: "card", id: row.id });
          pop.open(pointerAnchor(e));
        }}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", row.id);
          setDrag({ rowId: row.id, from: column.key, lane: lane?.key });
        }}
        onDragEnd={() => {
          setDrag(null);
          setDrop(null);
        }}
        onClick={() => !editing && onOpen(row.id)}
      >
        {cover && (
          <span className="card__cover">
            <img src={cover} alt="" loading="lazy" />
          </span>
        )}
        {preview && (
          <span className="card__cover">
            <PagePreview row={row} />
          </span>
        )}
        <div className="card__title">
          {row.format.icon && (
            <span className="card__icon">
              <PageIcon block={row} size={19} />
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
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.preventDefault();
                  if (!e.currentTarget.value.trim() && isEmptyValue(row.properties.title)) {
                    // A card that was never named goes away.
                    setEditingId(null);
                    void purgeBlock(row.id);
                  } else e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <span className={isEmptyValue(row.properties.title) ? "muted" : ""}>{pageTitle(row)}</span>
          )}
        </div>
        {cardProps.map((p) => {
          const schema = collection.schema[p.property];
          if (COMPUTED_TYPES.includes(schema.type))
            return (
              <div className="card__prop" key={p.property}>
                <ComputedValue row={row} propertyId={p.property} schema={schema} collectionId={collection.id} />
              </div>
            );
          const value = cellValue(row, p.property, schema);
          if (isEmptyValue(value) || value === false) return null;
          return (
            <div className="card__prop" key={p.property}>
              <PropertyDisplay value={value} schema={schema} />
            </div>
          );
        })}
        <CommentCount n={comments.get(row.id)} />
        {!editing && (
          <span className={`card__tools${menu?.kind === "card" && menu.id === row.id ? " is-open" : ""}`}>
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
            <button type="button" aria-label="Más acciones" onClick={(e) => openMenu(e, "card", row.id)}>
              <MoreHorizontal size={16} />
            </button>
          </span>
        )}
      </div>
    );
  };

  const count = (n: number) => (n > 99 ? "99+" : n);
  // The group headers' calculation: the number of cards, or a property's sum, average…
  const boardCalc = view.format.board_calc && collection.schema[view.format.board_calc.property] ? view.format.board_calc : undefined;
  const calcComputed = useComputed(rows, collection, [boardCalc?.property]);
  const calcPop = usePopover();
  const [calcProp, setCalcProp] = useState<string | null>(null);
  const closeCalc = () => {
    calcPop.close();
    setCalcProp(null);
  };
  const setBoardCalc = (calc: CollectionView["format"]["board_calc"]) =>
    void updateView(view.id, { format: { ...view.format, board_calc: calc } });
  const calcOf = (list: Block[]) => {
    if (!boardCalc) return count(list.length);
    const s = collection.schema[boardCalc.property];
    return computeCalc(list, boardCalc.property, s, boardCalc.calc, calcComputed.values, (day) => formatDate(day, s)).value;
  };
  const countButton = (list: Block[]) => (
    <button
      type="button"
      className="board-col__count board-col__count--calc"
      title={
        boardCalc
          ? `${calcLabel(boardCalc.calc, collection.schema[boardCalc.property])} · ${collection.schema[boardCalc.property].name}`
          : "Recuento"
      }
      onClick={(e) => {
        e.stopPropagation();
        if (!locked) calcPop.toggle(e.currentTarget);
      }}
    >
      {calcOf(list)}
    </button>
  );
  const header = (column: Column) => <ColumnLabel column={column} schema={group} />;

  // Group headers sit in their own row so they can stick under the top bar
  // while the cards scroll; both rows scroll sideways together.
  const syncScroll = (from: HTMLDivElement, to: HTMLDivElement | null) => {
    if (to && to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
    // Swimlanes scroll sideways together with the header row.
    if (lanes)
      rootRef.current?.querySelectorAll<HTMLDivElement>(".board__heads, .board__cols").forEach((el) => {
        if (el !== from && el.scrollLeft !== from.scrollLeft) el.scrollLeft = from.scrollLeft;
      });
  };
  const tintOf = (column: Column) => (tinted && column.color ? ` board-col--tinted board-col--${column.color}` : "");

  /** The group bodies: the whole board, or one swimlane of a sub-grouped board. */
  const colsRow = (lane: RowGroup | null, canCreate: boolean) => (
    <div className="board__cols" ref={lane ? undefined : colsRef} onScroll={(e) => syncScroll(e.currentTarget, headsRef.current)}>
        {visible.map((column) => {
          const list = listIn(column, lane);
          const over = drop?.column === column.key && drop.lane === lane?.key;
          return (
            <div
              key={column.key}
              className={`board-col${tintOf(column)}${over ? " is-over" : ""}`}
              style={{ width: COLUMN_WIDTH[size] }}
              onDragOver={(e) => {
                // Date buckets and computed values can't take a card from another group.
                if (!drag || (drag.from !== column.key && !canReceive(column))) return;
                if (lane && drag.lane !== lane.key && !canCreate) return;
                e.preventDefault();
                const index = dropIndex(e, e.currentTarget);
                if (!over || drop.index !== index) setDrop({ column: column.key, index, lane: lane?.key });
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                void commitDrop(column, dropIndex(e, e.currentTarget), lane);
                setDrop(null);
                setDrag(null);
              }}
            >
              <div className="board-col__cards">
                {list.slice(0, limit).map((row, i) => (
                  <div key={row.id}>
                    {over && drop.index === i && <div className="drop-line" />}
                    {card(row, column, lane)}
                  </div>
                ))}
                {over && drop.index === list.length && <div className="drop-line" />}
                <LoadMore hidden={list.length - limit} onMore={more} />
              </div>
              {canReceive(column) && canCreate && (
                <button type="button" className="board-col__new" onClick={() => void createIn(column, false, lane)}>
                  <Plus size={16} /> Nueva página
                </button>
              )}
            </div>
          );
        })}
        {canAddGroup && <div className="board-add-group board-add-group--spacer" aria-hidden />}
        {hidden.length > 0 && !lane && (
          <div className="board-hidden">
            {hidden.map((column) => {
              const list = byColumn.get(column.key)!;
              return (
                <div key={column.key}>
                  <button
                    type="button"
                    className="board-hidden__row"
                    onClick={() => setOpenHidden((k) => (k === column.key ? null : column.key))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenu(e, "column", column.key);
                    }}
                  >
                    {header(column)}
                    <span className="board-col__count">{count(list.length)}</span>
                    <span
                      className="board-hidden__show"
                      role="button"
                      aria-label="Mostrar grupo"
                      onClick={(e) => openMenu(e, "column", column.key)}
                    >
                      <MoreHorizontal size={16} />
                    </span>
                  </button>
                  {openHidden === column.key && (
                    <div className="board-hidden__cards">
                      {list.slice(0, limit).map((row) => (
                        <div key={row.id}>{card(row, column)}</div>
                      ))}
                      <LoadMore hidden={list.length - limit} onMore={more} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
  );

  return (
    <div className={`board board--${size}${lanes ? " board--lanes" : ""}`} style={coverFit(view)} ref={rootRef}>
      {calcPop.anchor && (
        <Popover anchor={calcPop.anchor} onClose={closeCalc} width={240}>
          {calcProp && collection.schema[calcProp] ? (
            <CalcMenu
              schema={collection.schema[calcProp]}
              kind={calcComputed.kinds?.[calcProp]}
              current={boardCalc?.property === calcProp ? boardCalc.calc : undefined}
              noneLabel="Recuento de tarjetas"
              onPick={(calc) => {
                closeCalc();
                setBoardCalc(calc ? { property: calcProp, calc } : undefined);
              }}
            />
          ) : (
            <div className="menu menu-scroll">
              <MenuItem right={!boardCalc ? <Check size={14} /> : null} onClick={() => (closeCalc(), setBoardCalc(undefined))}>
                Recuento de tarjetas
              </MenuItem>
              <MenuSeparator />
              <MenuLabel>Calcular por propiedad</MenuLabel>
              {viewProperties(view, collection).map(({ property }) => {
                const s = collection.schema[property];
                if (!s) return null;
                return (
                  <MenuItem
                    key={property}
                    icon={<TypeIcon type={s.type} size={16} />}
                    right={
                      boardCalc?.property === property ? (
                        <span className="muted">{calcLabel(boardCalc.calc, s)}</span>
                      ) : (
                        <ChevronRight size={14} />
                      )
                    }
                    onClick={() => setCalcProp(property)}
                  >
                    {s.name}
                  </MenuItem>
                );
              })}
            </div>
          )}
        </Popover>
      )}
      <div className="board__heads" ref={headsRef} onScroll={(e) => syncScroll(e.currentTarget, colsRef.current)}>
        {visible.map((column) => (
          <div
            key={column.key}
            className={`board-col__head${tintOf(column)}${dragGroup === column.key ? " is-dragging" : ""}${
              dropGroup?.key === column.key ? (dropGroup.after ? " is-drop-after" : " is-drop-before") : ""
            }`}
            style={{ width: COLUMN_WIDTH[size] }}
            draggable={!locked}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("application/x-xot-group", column.key);
              setDragGroup(column.key);
            }}
            onDragEnd={() => {
              setDragGroup(null);
              setDropGroup(null);
            }}
            onDragOver={(e) => {
              if (!dragGroup || dragGroup === column.key) return setDropGroup(null);
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > r.left + r.width / 2;
              if (dropGroup?.key !== column.key || dropGroup.after !== after) setDropGroup({ key: column.key, after });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragGroup && dropGroup) moveGroup(dragGroup, dropGroup.key, dropGroup.after);
              setDragGroup(null);
              setDropGroup(null);
            }}
          >
            <span className="board-col__pill">{header(column)}</span>
            {countButton(byColumn.get(column.key)!)}
            <span className="board-col__actions">
              <button type="button" aria-label="Opciones del grupo" onClick={(e) => openMenu(e, "column", column.key)}>
                <MoreHorizontal size={16} />
              </button>
              {canReceive(column) && (
                <button type="button" aria-label="Nueva página" onClick={() => void createIn(column, true)}>
                  <Plus size={16} />
                </button>
              )}
            </span>
          </div>
        ))}
        {canAddGroup &&
          (addingGroup ? (
            <div className="board-add-group board-add-group--editing">
              <input
                className="field board-add-group__input"
                autoFocus
                placeholder="Nombre del grupo"
                onBlur={(e) => void addGroup(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setAddingGroup(false);
                }}
              />
            </div>
          ) : (
            <button type="button" className="board-add-group" onClick={() => setAddingGroup(true)}>
              <Plus size={16} /> Nuevo grupo
            </button>
          ))}
        {hidden.length > 0 && (
          <div className="board-hidden board-hidden--head">
            <div className="board-hidden__title">Grupos ocultos</div>
          </div>
        )}
      </div>
      {lanes ? (
        lanes.map((lane) => {
          const open = !closedLanes.includes(lane.key);
          const canCreate = lane.key === NONE || lane.value !== undefined;
          return (
            <div className={`board-lane${open ? " is-open" : ""}`} key={lane.key}>
              <div className="board-lane__head">
                <GroupHeader
                  group={lane}
                  schema={subSchema!}
                  open={open}
                  onToggle={() =>
                    setClosedLanes((list) => (list.includes(lane.key) ? list.filter((k) => k !== lane.key) : [...list, lane.key]))
                  }
                />
              </div>
              {open && colsRow(lane, canCreate)}
            </div>
          );
        })
      ) : (
        colsRow(null, true)
      )}
      {pop.anchor && menu?.kind === "card" && (
        <Popover anchor={pop.anchor} onClose={closeMenu} width={256} align="end">
          <div className="menu">
            <MenuItem
              icon={<PanelRight size={16} />}
              onClick={() => {
                closeMenu();
                onOpen(menu.id);
              }}
            >
              Abrir en vista lateral
            </MenuItem>
            <MenuItem
              icon={<Maximize2 size={16} />}
              onClick={() => {
                closeMenu();
                navigate(menu.id);
              }}
            >
              Abrir en página completa
            </MenuItem>
            {HAS_TABS && (
              <MenuItem
                icon={<SquareArrowOutUpRight size={16} />}
                right="⌘↵"
                onClick={() => {
                  closeMenu();
                  openInNewTab(menu.id);
                }}
              >
                Abrir en una pestaña nueva
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem
              icon={<Pencil size={16} />}
              onClick={() => {
                closeMenu();
                setEditingId(menu.id);
              }}
            >
              Editar título
            </MenuItem>
            <MenuItem
              icon={<Link size={16} />}
              onClick={() => {
                closeMenu();
                void copyLink(menu.id);
              }}
            >
              Copiar enlace
            </MenuItem>
            <MenuItem
              icon={<Copy size={16} />}
              right="⌘D"
              onClick={async () => {
                closeMenu();
                const copy = await duplicatePage(menu.id);
                // The copy goes right below the original.
                if (copy && viewOrder && !sorted)
                  await placeInViewOrder(view.id, rows.map((r) => r.id), copy, { after: menu.id });
              }}
            >
              Duplicar
            </MenuItem>
            <MenuItem
              icon={<CornerUpRight size={16} />}
              right="⌘⇧P"
              onClick={() => {
                const anchor = pop.anchor!;
                closeMenu();
                moveMenu.open(menu.id, anchor);
              }}
            >
              Mover a
            </MenuItem>
            <MenuItem
              danger
              icon={<Trash size={16} />}
              right="Supr"
              onClick={() => {
                closeMenu();
                void trashWithUndo(menu.id);
              }}
            >
              Eliminar
            </MenuItem>
          </div>
        </Popover>
      )}
      {pop.anchor && menu?.kind === "column" && (() => {
        const column = columns.find((c) => c.key === menu.id);
        // A locked database keeps its options: the group can't be renamed, recoloured or deleted.
        const option = locked ? undefined : column?.option;
        const isHidden = hidden.some((c) => c.key === menu.id);
        return (
          <Popover anchor={pop.anchor} onClose={closeMenu} width={256}>
            {/* An option-backed group: rename, delete and colour the option itself. */}
            {option && (
              <OptionEditor
                key={option.id}
                option={option}
                onRename={(value) => updateOption(collection.id, groupId, option.id, { value })}
                onColor={(color) => updateOption(collection.id, groupId, option.id, { color })}
                onDescribe={(description) => updateOption(collection.id, groupId, option.id, { description: description || undefined })}
                onDelete={() => {
                  closeMenu();
                  void deleteOption(collection.id, groupId, option.id);
                }}
              />
            )}
            <div className="menu" style={option ? { paddingTop: 0 } : undefined}>
              {option && <MenuSeparator />}
              <MenuItem
                icon={isHidden ? <Eye size={16} /> : <EyeOff size={16} />}
                onClick={() => {
                  closeMenu();
                  setHidden(menu.id, !isHidden);
                }}
              >
                {isHidden ? "Mostrar grupo" : "Ocultar grupo"}
              </MenuItem>
            </div>
          </Popover>
        );
      })()}
      {moveMenu.element}
    </div>
  );
}
