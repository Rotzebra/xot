import { useState } from "react";
import { Check, ChevronDown, Paintbrush, Plus, Trash } from "lucide-react";
import { OPTION_COLOR_LABELS, OPTION_COLORS, type Block, type Collection, type CollectionView, type ColorRule, type OptionColor } from "../../lib/model";
import { updateView, shortId } from "../../lib/ops";
import { OPERATOR_LABELS, operatorsFor, rowMatches } from "../../lib/query";
import { useComputed } from "../../lib/group";
import { MenuItem, MenuLabel, Popover, usePopover } from "../ui";
import { FilterRule, viewProperties } from "./DatabaseView";

export type RowColors = Map<string, { row?: OptionColor; cells: Record<string, OptionColor> }>;

/**
 * Conditional colors for a view's rows: each page's row (or card) color and its cells'
 * colors, from the first rule each one meets.
 */
export function useRowColors(view: CollectionView, collection: Collection, rows: Block[]): RowColors {
  const rules = (view.format.color_rules ?? []).filter((r) => collection.schema[r.filter.property]);
  const computed = useComputed(rules.length ? rows : undefined, collection, rules.map((r) => r.filter.property));
  const out: RowColors = new Map();
  if (!rules.length) return out;
  for (const row of rows) {
    const entry: { row?: OptionColor; cells: Record<string, OptionColor> } = { cells: {} };
    for (const rule of rules) {
      if (rule.target === "row" ? entry.row : entry.cells[rule.filter.property]) continue;
      if (!rowMatches(row, rule.filter, collection.schema, computed)) continue;
      if (rule.target === "row") entry.row = rule.color;
      else entry.cells[rule.filter.property] = rule.color;
    }
    if (entry.row || Object.keys(entry.cells).length) out.set(row.id, entry);
  }
  return out;
}

/** The class that tints an element in a conditional color. */
export const tintClass = (color: OptionColor | undefined) => (color ? ` cc cc--${color}` : "");

/** "Color condicional" in the view's settings: the rules, each one opening its editor. */
export function ColorRulesMenu({ view, collection }: { view: CollectionView; collection: Collection }) {
  const rules = view.format.color_rules ?? [];
  const pop = usePopover();
  const [current, setCurrent] = useState<string | null>(null);
  const save = (next: ColorRule[]) => void updateView(view.id, { format: { ...view.format, color_rules: next.length ? next : undefined } });
  const order = viewProperties(view, collection).map((p) => p.property);
  const rule = rules.find((r) => r.id === current);
  const setRule = (patch: Partial<ColorRule>) => rule && save(rules.map((r) => (r.id === rule.id ? { ...r, ...patch } : r)));
  const summary = (r: ColorRule) => {
    const s = collection.schema[r.filter.property];
    if (!s) return "Propiedad eliminada";
    const v = r.filter.value;
    const text = Array.isArray(v)
      ? v.map((x) => (typeof x === "string" ? (s.options?.find((o) => o.id === x)?.value ?? x) : "")).join(", ")
      : typeof v === "string"
        ? (s.options?.find((o) => o.id === v)?.value ?? v)
        : v === undefined || v === null
          ? ""
          : typeof v === "boolean"
            ? v
              ? "marcada"
              : "sin marcar"
            : String(v);
    return `${s.name} ${OPERATOR_LABELS[r.filter.operator]}${text ? ` ${text}` : ""}`;
  };
  return (
    <>
      <div className="settings-note">Colorea las filas, tarjetas o celdas de las páginas que cumplan una condición.</div>
      {rules.map((r) => (
        <MenuItem
          key={r.id}
          icon={<span className={`cc-swatch cc--${r.color}`} />}
          right={<span className="muted">{r.target === "row" ? "Fila" : "Celda"}</span>}
          onClick={(e) => {
            setCurrent(r.id);
            pop.open(e.currentTarget);
          }}
        >
          {summary(r)}
        </MenuItem>
      ))}
      <MenuItem
        icon={<Plus size={16} />}
        onClick={(e) => {
          const property = order.find((id) => id !== "title" && collection.schema[id]) ?? "title";
          const created: ColorRule = {
            id: shortId(),
            filter: { id: shortId(), property, operator: operatorsFor(collection.schema[property].type)[0] },
            color: "red",
            target: "row",
          };
          save([...rules, created]);
          setCurrent(created.id);
          pop.open(e.currentTarget);
        }}
      >
        Agregar regla
      </MenuItem>
      {pop.anchor && rule && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={540} align="end">
          <div className="rule-panel cc-editor">
            <FilterRule
              lead="Si"
              filter={rule.filter}
              schema={collection.schema}
              collectionId={collection.id}
              order={order}
              onChange={(patch) => setRule({ filter: { ...rule.filter, ...patch } })}
              onRemove={() => {
                pop.close();
                save(rules.filter((r) => r.id !== rule.id));
              }}
              onDuplicate={() => save([...rules, { ...structuredClone(rule), id: shortId() }])}
            />
            <div className="cc-editor__row">
              <span className="rule__lead">Colorear</span>
              <TargetPicker value={rule.target} onChange={(target) => setRule({ target })} />
            </div>
            <div className="cc-editor__row">
              <span className="rule__lead">Color</span>
              <div className="cc-editor__colors" role="radiogroup" aria-label="Color">
                {OPTION_COLORS.filter((c) => c !== "default").map((c) => (
                  <button
                    type="button"
                    key={c}
                    role="radio"
                    aria-checked={rule.color === c}
                    aria-label={OPTION_COLOR_LABELS[c]}
                    data-tooltip={OPTION_COLOR_LABELS[c]}
                    className={`cc-swatch cc-swatch--pick cc--${c}${rule.color === c ? " is-on" : ""}`}
                    onClick={() => setRule({ color: c })}
                  >
                    {rule.color === c && <Check size={12} />}
                  </button>
                ))}
              </div>
            </div>
            <MenuItem
              danger
              icon={<Trash size={16} />}
              onClick={() => {
                pop.close();
                save(rules.filter((r) => r.id !== rule.id));
              }}
            >
              Eliminar regla
            </MenuItem>
          </div>
        </Popover>
      )}
    </>
  );
}

function TargetPicker({ value, onChange }: { value: ColorRule["target"]; onChange: (v: ColorRule["target"]) => void }) {
  const pop = usePopover();
  const label = value === "row" ? "la fila o tarjeta" : "la celda de la propiedad";
  return (
    <>
      <button type="button" className="rule-btn" onClick={(e) => pop.toggle(e.currentTarget)}>
        <Paintbrush size={14} />
        <span className="rule-btn__label">{label}</span>
        <ChevronDown size={12} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={240}>
          <div className="menu">
            <MenuLabel>Aplicar a</MenuLabel>
            {(
              [
                ["row", "La fila o tarjeta"],
                ["cell", "La celda de la propiedad"],
              ] as const
            ).map(([k, text]) => (
              <MenuItem
                key={k}
                right={value === k ? <Check size={14} /> : null}
                onClick={() => {
                  pop.close();
                  onChange(k);
                }}
              >
                {text}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
