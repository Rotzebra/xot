import { Check, ChevronRight, Eye, EyeOff, MoreHorizontal, Plus } from "lucide-react";
import type { CollectionView, PropertySchema } from "../../lib/model";
import { NO_GROUP, type RowGroup } from "../../lib/group";
import { updateView } from "../../lib/ops";
import { MenuItem, Popover, usePopover } from "../ui";
import { PropertyDisplay, Tag } from "./properties";

/** A group's value as shown: its tag or status pill, the person or page, a checkbox, or plain text. */
export function GroupValue({ group, schema }: { group: RowGroup; schema: PropertySchema }) {
  if (group.key === NO_GROUP) return <span className="table-group__none">{group.label}</span>;
  if (group.checked !== undefined)
    return (
      <span className="table-group__check">
        <span className={`checkbox checkbox--static${group.checked ? " is-checked" : ""}`} aria-hidden>
          {group.checked ? <Check size={12} strokeWidth={3} /> : null}
        </span>
        <span className="table-group__text">{group.label}</span>
      </span>
    );
  if (group.option) return <Tag option={group.option} status={schema.type === "status"} />;
  if (group.color) return <Tag option={{ id: group.key, value: group.label, color: group.color }} status />;
  if (schema.type === "person" || schema.type === "relation")
    return <PropertyDisplay value={group.value ?? null} schema={schema} />;
  return <span className="table-group__text">{group.label}</span>;
}

/** Table and list group header: chevron, value, count, and "+" (a new page in the group). */
export function GroupHeader({
  group,
  schema,
  open,
  onToggle,
  onAdd,
  view,
}: {
  group: RowGroup;
  schema: PropertySchema;
  open: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  /** A grouped table, list or gallery: its "⋯" menu hides the group (or shows it again). */
  view?: CollectionView;
}) {
  const menu = usePopover();
  const groupBy = view?.format.group_by;
  const hidden = !!groupBy?.hidden?.includes(group.key);
  const setHidden = (hide: boolean) => {
    menu.close();
    if (!view || !groupBy) return;
    const keys = groupBy.hidden ?? [];
    const next = hide ? [...new Set([...keys, group.key])] : keys.filter((k) => k !== group.key);
    void updateView(view.id, { format: { ...view.format, group_by: { ...groupBy, hidden: next.length ? next : undefined } } });
  };
  return (
    <div className={`table-group__head${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="table-group__toggle"
        aria-expanded={open}
        aria-label={open ? "Contraer grupo" : "Expandir grupo"}
        onClick={onToggle}
      >
        <ChevronRight size={16} />
      </button>
      <span className="table-group__value" onClick={onToggle}>
        <GroupValue group={group} schema={schema} />
      </span>
      <span className="table-group__count">{group.rows.length}</span>
      {groupBy && (
        <button
          type="button"
          className={`icon-btn icon-btn--sm table-group__add${menu.anchor ? " is-active" : ""}`}
          aria-label="Opciones de grupo"
          onClick={(e) => menu.toggle(e.currentTarget)}
        >
          <MoreHorizontal size={16} />
        </button>
      )}
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} width={220}>
          <MenuItem icon={hidden ? <Eye size={16} /> : <EyeOff size={16} />} onClick={() => setHidden(!hidden)}>
            {hidden ? "Mostrar grupo" : "Ocultar grupo"}
          </MenuItem>
        </Popover>
      )}
      {onAdd && (
        <button type="button" className="icon-btn icon-btn--sm table-group__add" aria-label="Nueva página en el grupo" onClick={onAdd}>
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}

/** "N grupos ocultos" under a grouped table or list: opens the hidden groups below it. */
export function HiddenGroupsToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`hidden-groups${open ? " is-open" : ""}`} aria-expanded={open} onClick={onToggle}>
      <ChevronRight size={14} className="hidden-groups__chevron" />
      <EyeOff size={14} />
      {count} {count === 1 ? "grupo oculto" : "grupos ocultos"}
    </button>
  );
}
