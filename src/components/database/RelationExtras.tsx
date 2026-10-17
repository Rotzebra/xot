import { useLiveQuery } from "dexie-react-hooks";
import { Eye, ListFilter, Plus } from "lucide-react";
import type { Block, Collection, Filter, PropertySchema } from "../../lib/model";
import { applyQuery, operatorsFor } from "../../lib/query";
import { db } from "../../lib/db";
import { updateSchema } from "../../lib/ops";
import { MenuItem, MenuLabel, Popover, Switch, usePopover } from "../ui";
import { FilterRule, PropertyPicker } from "./DatabaseView";
import { TypeIcon } from "./properties";

// A relation's extras: which of the related pages' properties its cells show,
// and the rules that narrow the pages its menu offers.

/** The pages a relation's menu offers: the related database's pages that meet its filter. */
export function relationCandidates(pages: Block[], target: Collection, schema: PropertySchema): Block[] {
  const rule = schema.relation_filter;
  if (!rule?.filters.length) return pages;
  return applyQuery(pages, target.schema, { filter_operator: rule.operator, filters: rule.filters, sort: [] });
}

/** "Mostrar propiedades" and "Filtrar páginas" in a relation's settings. */
export function RelationViewSettings({
  collectionId,
  propertyId,
  schema,
  nested,
}: {
  collectionId: string;
  propertyId: string;
  schema: PropertySchema;
  nested: boolean;
}) {
  const showPop = usePopover();
  const filterPop = usePopover();
  const target = useLiveQuery(async () => (schema.collection_id ? ((await db.collections.get(schema.collection_id)) ?? null) : null), [schema.collection_id]);
  if (!target) return null;
  const shown = (schema.relation_properties ?? []).filter((id) => target.schema[id]);
  const filters = (schema.relation_filter?.filters ?? []).filter((f) => target.schema[f.property]);
  const operator = schema.relation_filter?.operator ?? "and";
  const ids = Object.keys(target.schema).filter((id) => id !== "title" && target.schema[id].type !== "button");
  const saveFilters = (next: Filter[], op = operator) =>
    void updateSchema(collectionId, propertyId, { relation_filter: next.length ? { operator: op, filters: next } : undefined });
  const cls = nested ? "menu-item--nested" : "";
  return (
    <>
      <MenuItem
        className={cls}
        icon={<Eye size={16} />}
        right={<span className="menu-item__value">{shown.length ? `${shown.length}` : "Solo el título"}</span>}
        onClick={(e) => showPop.toggle(e.currentTarget)}
      >
        Mostrar propiedades
      </MenuItem>
      <MenuItem
        className={cls}
        icon={<ListFilter size={16} />}
        right={<span className="menu-item__value">{filters.length ? `${filters.length} ${filters.length === 1 ? "regla" : "reglas"}` : "Todas las páginas"}</span>}
        onClick={(e) => filterPop.toggle(e.currentTarget)}
      >
        Filtrar páginas
      </MenuItem>
      {showPop.anchor && (
        <Popover anchor={showPop.anchor} onClose={showPop.close} width={260}>
          <div className="menu">
            <MenuLabel>Mostrar en la celda, junto al título</MenuLabel>
            {ids.map((id) => {
              const on = shown.includes(id);
              return (
                <MenuItem
                  key={id}
                  icon={<TypeIcon type={target.schema[id].type} />}
                  right={<Switch on={on} />}
                  onClick={() =>
                    void updateSchema(collectionId, propertyId, {
                      relation_properties: on ? shown.filter((x) => x !== id) : [...shown, id],
                    })
                  }
                >
                  {target.schema[id].name}
                </MenuItem>
              );
            })}
          </div>
        </Popover>
      )}
      {filterPop.anchor && (
        <Popover anchor={filterPop.anchor} onClose={filterPop.close} width={560}>
          <div className="rule-panel relation-filter">
            <MenuLabel>Solo se ofrecen las páginas que cumplen</MenuLabel>
            {filters.map((f, i) => (
              <FilterRule
                key={f.id}
                lead={
                  i === 0 ? (
                    "Donde"
                  ) : i === 1 ? (
                    <select
                      className="field field--sm"
                      value={operator}
                      aria-label="Cómo se combinan las reglas"
                      onChange={(e) => saveFilters(filters, e.target.value as "and" | "or")}
                    >
                      <option value="and">Y</option>
                      <option value="or">O</option>
                    </select>
                  ) : operator === "and" ? (
                    "Y"
                  ) : (
                    "O"
                  )
                }
                filter={f}
                schema={target.schema}
                collectionId={target.id}
                order={ids}
                onChange={(patch) => saveFilters(filters.map((x) => (x.id === f.id ? { ...x, ...patch } : x)))}
                onRemove={() => saveFilters(filters.filter((x) => x.id !== f.id))}
                onDuplicate={() => saveFilters([...filters, { ...f, id: crypto.randomUUID() }])}
              />
            ))}
            <AddRule schema={target.schema} order={ids} onAdd={(f) => saveFilters([...filters, f])} />
          </div>
        </Popover>
      )}
    </>
  );
}

function AddRule({ schema, order, onAdd }: { schema: Record<string, PropertySchema>; order: string[]; onAdd: (f: Filter) => void }) {
  const pop = usePopover();
  return (
    <>
      <div className="rule-panel__foot">
        <MenuItem icon={<Plus size={16} />} onClick={(e) => pop.toggle(e.currentTarget)}>
          Agregar regla de filtros
        </MenuItem>
      </div>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={260}>
          <PropertyPicker
            schema={schema}
            order={["title", ...order]}
            placeholder="Filtrar por…"
            onPick={(id) => {
              pop.close();
              onAdd({ id: crypto.randomUUID(), property: id, operator: operatorsFor(schema[id].type)[0] });
            }}
          />
        </Popover>
      )}
    </>
  );
}
