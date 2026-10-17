import { Check, ChevronRight } from "lucide-react";
import { useState } from "react";
import { CALC_LABELS, calcsFor, isPerGroup, splitCalc, type CalcName } from "../../lib/calc";
import type { CalcType, PropertySchema } from "../../lib/model";
import type { ResultKind } from "../../lib/query";
import { MenuItem, MenuSeparator } from "../ui";

/**
 * One "Calcular" choice: a plain calculation, or "Recuento por grupo" / "Porcentaje por grupo"
 * on status, which opens the property's groups (To-do / In progress / Complete) to pick one.
 */
export function CalcChoice({
  name,
  schema,
  current,
  onPick,
  className,
  nestedClassName = "menu-item--nested",
}: {
  name: CalcName;
  schema: PropertySchema;
  current: CalcType | undefined | null;
  onPick: (calc: CalcType) => void;
  className?: string;
  nestedClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const picked = current ? splitCalc(current) : undefined;
  if (!isPerGroup(name))
    return (
      <MenuItem className={className} right={current === name ? <Check size={14} /> : null} onClick={() => onPick(name)}>
        {CALC_LABELS[name]}
      </MenuItem>
    );
  return (
    <>
      <MenuItem
        className={className}
        right={<ChevronRight size={14} className={open ? "rotate-90" : ""} />}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {CALC_LABELS[name]}
      </MenuItem>
      {open &&
        (schema.groups ?? []).map((g) => (
          <MenuItem
            key={g.id}
            className={nestedClassName}
            right={picked?.name === name && picked.group === g.id ? <Check size={14} /> : null}
            onClick={() => onPick(`${name}:${g.id}`)}
          >
            {g.name}
          </MenuItem>
        ))}
    </>
  );
}

/** The "Calcular" menu for one property: "Ninguno", then the calculations its type offers. */
export function CalcMenu({
  schema,
  kind,
  current,
  onPick,
  noneLabel = "Ninguno",
}: {
  schema: PropertySchema;
  kind?: ResultKind;
  current: CalcType | undefined;
  onPick: (calc: CalcType | null) => void;
  noneLabel?: string;
}) {
  return (
    <div className="menu">
      <MenuItem right={!current ? <Check size={14} /> : null} onClick={() => onPick(null)}>
        {noneLabel}
      </MenuItem>
      {calcsFor(schema, kind).map((group, i) => (
        <div key={i}>
          <MenuSeparator />
          {group.map((c) => (
            <CalcChoice key={c} name={c} schema={schema} current={current} onPick={onPick} />
          ))}
        </div>
      ))}
    </div>
  );
}
