import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  AlarmClock,
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  AtSign,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleChevronDown,
  CircleUserRound,
  Clock,
  CopyPlus,
  Download,
  Ellipsis,
  EyeOff,
  GripVertical,
  Hash,
  IdCard,
  Info,
  Link,
  List,
  ListFilter,
  LoaderCircle,
  MapPin,
  Maximize2,
  Minus,
  MousePointerClick,
  Paperclip,
  PenLine,
  Phone,
  Pin,
  PinOff,
  Plus,
  Search,
  Sigma,
  SlidersHorizontal,
  SquareCheck,
  Star,
  TextAlignStart,
  Trash,
  Type,
  UserRound,
  UserRoundPen,
  WrapText,
  X,
} from "lucide-react";
import {
  COMPUTED_TYPES,
  isWorkspaceRoot,
  OPTION_COLOR_LABELS,
  OPTION_COLORS,
  PROPERTY_TYPE_LABELS,
  READ_ONLY_TYPES,
  statusDefault,
  type Block,
  type CalcType,
  type FileRef,
  type PageRef,
  type NumberDisplay,
  type RollupAggregation,
  type RollupSpec,
  type PropertySchema,
  type PropertyType,
  type PropertyValue,
  type SelectOption,
} from "../../lib/model";
import {
  addOption,
  addProperty,
  addRow,
  addRowFromTemplate,
  addRelationProperty,
  setRelationTwoWay,
  addRollupProperty,
  changePropertyType,
  deleteOption,
  deleteProperty,
  setRelation,
  setReminder,
  setPlace,
  setRichText,
  setRowValue,
  setTimeZone,
  updateOption,
  updateSchema,
} from "../../lib/ops";
import { cellValue, isEmptyValue, relationLimit } from "../../lib/query";
import { isHiddenRef } from "../../lib/group";
import { evaluate, formulaSource, formulaValue, PERCENT_AGGREGATIONS, rollupOriginal, runFormula, type RollupItem } from "../../lib/compute";
import { display, isDate, isPage, isRich, storedDate, type FRich, type FValue } from "../../lib/formula";
import { DECIMAL_CHOICES, formatNumber, NUMBER_FORMATS } from "../../lib/format";
import { DYNAMIC_DATES, dynamicLabel, isDynamicDate } from "../../lib/templates";
import { FormulaEditor } from "./FormulaEditor";
import { askNotificationPermission, reminderChoices, reminderCode, reminderLabel, useOverdue } from "../../lib/reminders";
import { calcLabel, calcsFor } from "../../lib/calc";
import { CalcChoice } from "./CalcMenu";
import { db } from "../../lib/db";
import { navigate, pageTitle } from "../../lib/hooks";
import { FILE_SCHEME, pickFiles, resolveFileUrl, storeFile } from "../../lib/files";
import { ConfirmDialog, MenuItem, MenuLabel, MenuSeparator, PageIcon, Popover, Switch, toast, usePopover } from "../ui";
import { ActionsEditor } from "../ActionsEditor";
import { buttonPropertyActions, runActions, type Action, type ActionType } from "../../lib/actions";
import { VerificationCell, VerificationValue, VERIFICATION_ICON } from "../PageExtras";
import { RichCellEditor, richRunsOf, RichTextValue } from "./RichTextCell";
import { fromZone, localTimeZone, timeZones, toZone, zoneLabel, zoneName } from "../../lib/timezones";
import { PeoplePicker, People } from "./People";
import { relationCandidates, RelationViewSettings } from "./RelationExtras";
import { PlaceEditor, placeCoords, PlaceValue } from "./PlaceCell";

export const TYPE_ICONS: Record<PropertyType, typeof Type> = {
  title: Type,
  text: TextAlignStart,
  number: Hash,
  select: CircleChevronDown,
  multi_select: List,
  status: LoaderCircle,
  date: Calendar,
  person: UserRound,
  file: Paperclip,
  checkbox: SquareCheck,
  url: Link,
  email: AtSign,
  phone_number: Phone,
  place: MapPin,
  created_time: Clock,
  last_edited_time: Clock,
  created_by: CircleUserRound,
  last_edited_by: UserRoundPen,
  button: MousePointerClick,
  auto_increment_id: IdCard,
  relation: ArrowUpRight,
  formula: Sigma,
  rollup: Search,
  verification: VERIFICATION_ICON,
};

/** Types the user can add from the "+" menus. */
export const CREATABLE_TYPES: PropertyType[] = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "person",
  "file",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "button",
  "auto_increment_id",
  "place",
  "relation",
  "formula",
  "rollup",
];

/** "Correo": something@domain.tld. */
export const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
/** "Teléfono": digits with the usual separators (+, spaces, dots, dashes, parentheses), at least 3 digits. */
export const isValidPhone = (v: string) => /^\+?[\d\s().-]+$/.test(v.trim()) && (v.match(/\d/g)?.length ?? 0) >= 3;
/** The link a valid email or phone opens (mailto:/tel:); null when it isn't valid. */
export function contactHref(type: PropertyType, value: string): string | null {
  if (type === "email") return isValidEmail(value) ? `mailto:${value.trim()}` : null;
  if (type === "phone_number") return isValidPhone(value) ? `tel:${value.replace(/[^\d+]/g, "")}` : null;
  return null;
}

/** The tooltip over a property's name: its name and description (none without a description). */
export const propertyTooltip = (schema: PropertySchema) =>
  schema.description?.trim() ? `**${schema.name}**\n${schema.description.trim()}` : undefined;

export function TypeIcon({ type, size = 15 }: { type: PropertyType; size?: number }) {
  const Icon = TYPE_ICONS[type];
  return <Icon size={size} strokeWidth={1.8} />;
}

export function Tag({
  option,
  onRemove,
  status,
}: {
  option: SelectOption;
  onRemove?: () => void;
  /** Status values are pills with a leading dot. */
  status?: boolean;
}) {
  return (
    <span
      className={`tag tag--${option.color}${status ? " tag--status" : ""}`}
      data-tooltip={option.description?.trim() ? `**${option.value}**\n${option.description.trim()}` : undefined}
    >
      {status && <span className="tag__dot" />}
      <span className="tag__text">{option.value}</span>
      {onRemove && (
        <button
          type="button"
          className="tag__remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Quitar ${option.value}`}
        >
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/** The "Formato de fecha" choices; the full date ("5 de agosto de 2024") when absent. */
export const DATE_FORMATS: [string, string][] = [
  ["full", "Fecha completa"],
  ["MM/DD/YYYY", "Mes/Día/Año"],
  ["DD/MM/YYYY", "Día/Mes/Año"],
  ["YYYY/MM/DD", "Año/Mes/Día"],
  ["relative", "Relativa"],
];
export const TIME_FORMATS: [string, string][] = [
  ["h:mm A", "12 horas"],
  ["H:mm", "24 horas"],
];

const shortMonth = new Intl.DateTimeFormat("es", { month: "short" });
const relativeDay = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

function formatPoint(value: string, dateFormat?: string, timeFormat?: string) {
  const [day, time] = value.split("T");
  const d = new Date(`${day}T${time?.slice(0, 5) ?? "00:00"}:00`);
  if (Number.isNaN(d.getTime())) return value;
  const [y, m, dd] = [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")];
  // The default: "28 de sept" this year, "28 de sept de 2025" otherwise.
  const mon = shortMonth.format(d).replace(".", "");
  let date = d.getFullYear() === new Date().getFullYear() ? `${d.getDate()} de ${mon}` : `${d.getDate()} de ${mon} de ${y}`;
  if (dateFormat === "MM/DD/YYYY") date = `${m}/${dd}/${y}`;
  else if (dateFormat === "DD/MM/YYYY") date = `${dd}/${m}/${y}`;
  else if (dateFormat === "YYYY/MM/DD") date = `${y}/${m}/${dd}`;
  else if (dateFormat === "relative") {
    // Within a week: "Hoy", "Mañana", "Hace 3 días"; further away, the full date.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(`${day}T00:00:00`).getTime() - today.getTime()) / 86400000);
    if (Math.abs(days) <= 7) {
      const text = relativeDay.format(days, "day");
      date = text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
  if (!time) return date;
  const hour12 = timeFormat === "h:mm A" ? true : timeFormat === "H:mm" ? false : undefined;
  return `${date} ${d.toLocaleTimeString("es", { hour: "numeric", minute: "2-digit", hour12 })}`;
}

/** "2025-11-14", "2025-11-14T09:00" or a "start/end" range, in the property's date format. */
export function formatDate(value: string, schema?: Pick<PropertySchema, "date_format" | "time_format">) {
  // A template's dynamic date ("Hoy", "Ahora"…), resolved when a page is made from it.
  if (isDynamicDate(value)) return dynamicLabel(value);
  const [start, end] = value.split("/");
  const point = (v: string) => formatPoint(v, schema?.date_format, schema?.time_format);
  return end ? `${point(start)} → ${point(end)}` : point(start);
}

const isImageFile = (f: FileRef) =>
  /^data:image\//.test(f.url) || /\.(png|jpe?g|gif|webp|avif|svg|heic)(\?|#|$)/i.test(f.url) || /\.(png|jpe?g|gif|webp|avif|svg|heic)$/i.test(f.name);

/** The URL to show a file with: uploads kept in Xot resolve to a local object URL. */
function useFileUrl(url: string) {
  const [resolved, setResolved] = useState(url.startsWith(FILE_SCHEME) ? "" : url);
  useEffect(() => {
    let alive = true;
    void resolveFileUrl(url).then((u) => alive && setResolved(u));
    return () => {
      alive = false;
    };
  }, [url]);
  return resolved;
}

/** One file: images as a 24px thumbnail (in cells), others as a chip with the name. */
function FileItem({ file }: { file: FileRef }) {
  const url = useFileUrl(file.url);
  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (url) window.open(url, "_blank", "noopener");
  };
  if (isImageFile(file))
    return (
      <a className="file-thumb" href={url || undefined} title={file.name} onClick={open}>
        {url && <img src={url} alt={file.name} />}
      </a>
    );
  return (
    <a className="file-chip" href={url || undefined} title={file.name} onClick={open}>
      <Paperclip size={12} />
      {file.name}
    </a>
  );
}

function Files({ files }: { files: FileRef[] }) {
  return (
    <span className="files">
      {files.map((f, i) => (
        <FileItem key={`${f.url}-${i}`} file={f} />
      ))}
    </span>
  );
}

/** A date property's value, with an alarm clock when it has a reminder (red once it's past). */
function DateValue({ value, reminder, schema, timeZone }: { value: string; reminder: string; schema: PropertySchema; timeZone?: string }) {
  const overdue = useOverdue(value, reminder);
  // A value with its own zone reads as the time there, with the offset after it.
  const zoned = timeZone && value.includes("T");
  const text = zoned ? formatDate(toZone(value, timeZone), schema) : formatDate(value, schema);
  const zone = zoned ? <span className="date-value__zone">{zoneLabel(timeZone, value)}</span> : null;
  if (!reminder)
    return (
      <span>
        {text}
        {zone}
      </span>
    );
  return (
    <span className={`date-value date-value--reminder${overdue ? " date-value--overdue" : ""}`}>
      {text}
      {zone}
      <AlarmClock size={14} aria-label="Recordatorio" />
    </span>
  );
}

/** Related pages: live title and icon when the page is in Xot, else the imported name. */
function Relations({ refs, schema }: { refs: PageRef[]; schema?: PropertySchema }) {
  const pages = useLiveQuery(() => db.blocks.bulkGet(refs.map((r) => r.id)), [refs.map((r) => r.id).join()]);
  // "Mostrar propiedades": the related pages' chosen values beside their title.
  const shownIds = schema?.relation_properties ?? [];
  const target = useLiveQuery(
    async () => (shownIds.length && schema?.collection_id ? ((await db.collections.get(schema.collection_id)) ?? null) : null),
    [shownIds.join(), schema?.collection_id],
  );
  const extras = (page: Block) =>
    target
      ? shownIds
          .filter((id) => target.schema[id] && !COMPUTED_TYPES.includes(target.schema[id].type) && !isEmptyValue(cellValue(page, id, target.schema[id])))
          .map((id) => (
            <span key={id} className="relation__prop" data-tooltip={target.schema[id].name}>
              <PropertyDisplay value={cellValue(page, id, target.schema[id])} schema={target.schema[id]} />
            </span>
          ))
      : null;
  return (
    <span className="relations">
      {refs.map((ref, i) => {
        const page = pages?.[i];
        // Trashed pages, and missing ones with no name, aren't shown.
        if (pages && isHiddenRef(ref, page)) return null;
        if (!page?.alive)
          return (
            <span key={ref.id} className="relation relation--static">
              {ref.name || "Sin título"}
            </span>
          );
        return (
          <button
            type="button"
            key={ref.id}
            className="relation"
            onClick={(e) => {
              e.stopPropagation();
              navigate(page.id);
            }}
          >
            <PageIcon block={page} size={14} />
            <span>{pageTitle(page)}</span>
            {extras(page)}
          </button>
        );
      })}
    </span>
  );
}

/** The rollup "Calcular" choices, by the kinds of value they read. */
const ROLLUP_LABELS: Record<RollupAggregation, string> = {
  show_original: "Mostrar original",
  show_unique: "Mostrar valores únicos",
  count: "Contar todo",
  count_all: "Contar todo",
  count_values: "Contar valores",
  count_unique: "Contar valores únicos",
  count_empty: "Contar celdas vacías",
  count_not_empty: "Contar celdas no vacías",
  percent_empty: "% de celdas vacías",
  percent_not_empty: "% de celdas no vacías",
  sum: "Suma",
  average: "Promedio",
  median: "Mediana",
  min: "Mínimo",
  max: "Máximo",
  range: "Rango",
  earliest_date: "Fecha más antigua",
  latest_date: "Fecha más reciente",
  date_range: "Intervalo de fechas",
  checked: "Marcado",
  unchecked: "Sin marcar",
  percent_checked: "% de elementos marcados",
  percent_unchecked: "% de elementos sin marcar",
  count_per_group: "Recuento por grupo",
  percent_per_group: "Porcentaje por grupo",
};
const ROLLUP_ANY: RollupAggregation[] = [
  "show_original",
  "show_unique",
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
];
const ROLLUP_NUMBER: RollupAggregation[] = ["sum", "average", "median", "min", "max", "range"];
const ROLLUP_DATE: RollupAggregation[] = ["earliest_date", "latest_date", "date_range"];
const ROLLUP_CHECK: RollupAggregation[] = ["checked", "unchecked", "percent_checked", "percent_unchecked"];
/** Status targets: the related rows in one status group (To-do / In progress / Complete). */
const ROLLUP_STATUS: RollupAggregation[] = ["count_per_group", "percent_per_group"];
/** Results that aren't numbers: the related values themselves, or dates. */
const ROLLUP_TEXT: RollupAggregation[] = ["show_original", "show_unique", "earliest_date", "latest_date", "date_range"];

/** The aggregations that make sense for the target property's type (all of them when it isn't known). */
function rollupChoices(type: PropertyType | undefined): RollupAggregation[] {
  const computed = !type || type === "formula" || type === "rollup";
  return [
    ...ROLLUP_ANY,
    ...(computed || type === "number" || type === "auto_increment_id" ? ROLLUP_NUMBER : []),
    ...(computed || type === "date" || type === "created_time" || type === "last_edited_time" ? ROLLUP_DATE : []),
    ...(computed || type === "checkbox" ? ROLLUP_CHECK : []),
    ...(type === "status" ? ROLLUP_STATUS : []),
  ];
}

function RollupSettings({
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
  const collection = useLiveQuery(() => db.collections.get(collectionId), [collectionId]);
  const rollup = schema.rollup ?? { relation: "", target: "title", aggregation: "count_all" as const };
  const relation = collection?.schema[rollup.relation];
  const target = useLiveQuery(
    async () => (relation?.collection_id ? ((await db.collections.get(relation.collection_id)) ?? null) : null),
    [relation?.collection_id],
  );
  const set = (patch: Partial<RollupSpec>) => void updateSchema(collectionId, propertyId, { rollup: { ...rollup, ...patch } });
  const relations = Object.entries(collection?.schema ?? {}).filter(([, s]) => s.type === "relation");
  const targetSchema = target?.schema[rollup.target];
  const targetType = targetSchema?.type;
  const choices = rollupChoices(targetType);
  const statusGroups = targetSchema?.type === "status" ? (targetSchema.groups ?? []) : [];
  const aggregation = rollup.aggregation === "count" ? "count_all" : rollup.aggregation;
  if (!choices.includes(aggregation)) choices.push(aggregation);
  return (
    <>
      <FormatSetting
        label="Relación"
        choices={[["", "Elige…"], ...relations.map(([id, s]) => [id, s.name] as [string, string])]}
        value={rollup.relation}
        nested={nested}
        onPick={(id) => set({ relation: id, target: "title" })}
      />
      <FormatSetting
        label="Propiedad"
        choices={Object.entries(target?.schema ?? { title: { name: "Título" } as PropertySchema }).map(
          ([id, s]) => [id, s.name] as [string, string],
        )}
        value={rollup.target}
        nested={nested}
        onPick={(id) => set({ target: id })}
      />
      <FormatSetting
        label="Calcular"
        choices={choices.map((id) => [id, ROLLUP_LABELS[id]] as [string, string])}
        value={aggregation}
        nested={nested}
        onPick={(id) => {
          const next = id as RollupAggregation;
          if (!ROLLUP_STATUS.includes(next)) return set({ aggregation: next, group_id: undefined });
          // The last group (Complete) to start with, and a share shows as a bar.
          const group_id = statusGroups.some((g) => g.id === rollup.group_id) ? rollup.group_id : statusGroups.at(-1)?.id;
          void updateSchema(collectionId, propertyId, {
            rollup: { ...rollup, aggregation: next, group_id },
            ...(next === "percent_per_group" && !schema.number_display ? { number_display: { as: "bar" as const } } : {}),
          });
        }}
      />
      {ROLLUP_STATUS.includes(aggregation) && (
        <FormatSetting
          label="Grupo"
          choices={statusGroups.map((g) => [g.id, g.name] as [string, string])}
          value={rollup.group_id ?? ""}
          nested={nested}
          onPick={(id) => set({ group_id: id })}
        />
      )}
      {!ROLLUP_TEXT.includes(aggregation) && (
        <>
          <NumberFormatSettings collectionId={collectionId} propertyId={propertyId} schema={schema} nested={nested} />
          <NumberDisplaySetting collectionId={collectionId} propertyId={propertyId} schema={schema} nested={nested} />
        </>
      )}
    </>
  );
}

const DISPLAY_AS: [NumberDisplay["as"], string][] = [
  ["number", "Número"],
  ["bar", "Barra"],
  ["ring", "Anillo"],
];

/** The display a number or rollup uses; imported "show as bar" rollups read as a bar. */
export function numberDisplayOf(schema: PropertySchema): NumberDisplay | undefined {
  return schema.number_display ?? (schema.rollup?.show_as === "bar" ? { as: "bar" } : undefined);
}

/** "Mostrar como" for numbers and rollups: Número, Barra or Anillo, with its color, "Dividir entre" and "Mostrar número". */
function NumberDisplaySetting({
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
  const display = numberDisplayOf(schema) ?? { as: "number" as const };
  const set = (patch: Partial<NumberDisplay>) => {
    const next = { ...display, ...patch };
    void updateSchema(collectionId, propertyId, {
      number_display: next.as === "number" ? undefined : next,
      // The imported flag gives way to the setting.
      ...(schema.rollup?.show_as ? { rollup: { ...schema.rollup, show_as: undefined } } : {}),
    });
  };
  const percent = isPercentValue(schema);
  return (
    <>
      <FormatSetting
        label="Mostrar como"
        choices={DISPLAY_AS}
        value={display.as}
        nested={nested}
        onPick={(as) => set({ as: as as NumberDisplay["as"] })}
      />
      {display.as !== "number" && (
        <>
          <FormatSetting
            label="Color"
            choices={OPTION_COLORS.map((c) => [c, OPTION_COLOR_LABELS[c]] as [string, string])}
            value={display.color ?? "default"}
            nested={nested}
            onPick={(color) => set({ color: color as NumberDisplay["color"] })}
          />
          {!percent && (
            <label className={`menu-field${nested ? " menu-item--nested" : ""}`}>
              <span>Dividir entre</span>
              <input
                className="field field--sm"
                type="number"
                min={0}
                placeholder="100"
                defaultValue={display.divide_by ?? ""}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  set({ divide_by: e.target.value.trim() && n > 0 ? n : undefined });
                }}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            </label>
          )}
          <MenuItem
            className={nested ? "menu-item--nested" : ""}
            right={<Switch on={display.show_number !== false} />}
            onClick={() => set({ show_number: display.show_number === false })}
          >
            Mostrar número
          </MenuItem>
        </>
      )}
    </>
  );
}

/**
 * "Formato de número" and "Decimales", for numbers, numeric formulas and rollups.
 * Formulas and rollups show separators unless another format is picked.
 */
function NumberFormatSettings({
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
  const fallback = schema.type === "number" ? "number" : "number_with_commas";
  return (
    <>
      <FormatSetting
        label="Formato de número"
        choices={NUMBER_FORMATS}
        value={schema.number_format ?? fallback}
        nested={nested}
        onPick={(number_format) => void updateSchema(collectionId, propertyId, { number_format })}
      />
      <FormatSetting
        label="Decimales"
        choices={DECIMAL_CHOICES}
        value={schema.decimals === undefined ? "default" : String(schema.decimals)}
        nested={nested}
        onPick={(d) => void updateSchema(collectionId, propertyId, { decimals: d === "default" ? undefined : Number(d) })}
      />
    </>
  );
}

/** Values that are a share (0 to 1): percentage rollups and numbers formatted as a percentage. */
function isPercentValue(schema: PropertySchema) {
  if (schema.type === "rollup" && schema.rollup && PERCENT_AGGREGATIONS.includes(schema.rollup.aggregation)) return true;
  return schema.number_format === "percent";
}

/** A number as its property formats it: format and decimals; formulas and rollups with separators by default. */
export function numberText(value: number, schema: PropertySchema) {
  const computed = schema.type === "rollup" || schema.type === "formula";
  // Percentage rollups read "50%" until another format is picked.
  if (schema.type === "rollup" && !schema.number_format && isPercentValue(schema))
    return schema.decimals === undefined ? `${Math.round(value * 100)}%` : formatNumber(value, "percent", false, schema.decimals);
  return formatNumber(value, schema.number_format ?? (computed ? "number_with_commas" : undefined), false, schema.decimals);
}

/** A number (or rollup) as its "Mostrar como" draws it: the number, a bar or a ring. */
export function NumberValue({ value, schema }: { value: number; schema: PropertySchema }) {
  const display = numberDisplayOf(schema);
  const percent = isPercentValue(schema);
  const text = numberText(value, schema);
  if (!display || display.as === "number") return <span>{text}</span>;
  const ratio = Math.max(0, Math.min(1, value / (display.divide_by ?? (percent ? 1 : 100))));
  const color = display.color && display.color !== "default" ? `var(--dot-${display.color})` : undefined;
  const number = display.show_number !== false && <span className="progress__value">{text}</span>;
  if (display.as === "ring") {
    const r = 8;
    const c = 2 * Math.PI * r;
    return (
      <span className="progress progress--ring" aria-label={text}>
        <svg width="20" height="20" viewBox="0 0 20 20" className="progress__ring" aria-hidden>
          <circle cx="10" cy="10" r={r} className="progress__ring-track" />
          {ratio > 0 && (
          <circle
            cx="10"
            cy="10"
            r={r}
            className="progress__ring-fill"
            style={{ strokeDasharray: `${c * ratio} ${c}`, ...(color ? { stroke: color } : {}) }}
          />
          )}
        </svg>
        {number}
      </span>
    );
  }
  return (
    <span className="progress" aria-label={text}>
      <span className="progress__track">
        <span className="progress__fill" style={{ width: `${ratio * 100}%`, ...(color ? { background: color } : {}) }} />
      </span>
      {number}
    </span>
  );
}

/**
 * A formula property's settings: its source, which opens the formula editor
 * (right away for a new, empty formula), and for numeric results the number
 * format, decimals and "Mostrar como".
 */
function FormulaSettings({
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
  const collection = useLiveQuery(() => db.collections.get(collectionId), [collectionId]);
  const source = collection ? formulaSource(schema.formula, collection) : "";
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const fieldRef = useRef<HTMLButtonElement>(null);
  // The editor takes the place of the property menu it opens from: it covers the
  // menu's spot (kept within the window) and the menu stays out of sight until it closes.
  const openEditor = (field: HTMLElement) => setAnchor(field.closest<HTMLElement>(".popover") ?? field);
  const covers = !!anchor?.matches(".popover");
  useEffect(() => {
    if (!anchor || !covers) return;
    anchor.classList.add("is-covered");
    return () => anchor.classList.remove("is-covered");
  }, [anchor, covers]);
  // A formula with no source yet opens the editor, as when the type changes.
  useEffect(() => {
    if (collection && !source.trim() && fieldRef.current) openEditor(fieldRef.current);
  }, [!!collection]);
  // The first row's result tells whether the number settings apply.
  const numeric = useLiveQuery(async () => {
    const c = await db.collections.get(collectionId);
    if (!c || !source.trim()) return false;
    const rows = await db.blocks.where("[parent_table+parent_id]").equals(["collection", collectionId]).toArray();
    const first = rows.filter((b) => b.alive && !b.is_template).sort((a, b) => a.order - b.order)[0];
    if (!first) return false;
    try {
      return typeof (await runFormula(first, source, c)) === "number";
    } catch {
      return false;
    }
  }, [collectionId, source]);
  return (
    <>
      <div className={`formula-settings${nested ? " menu-item--nested" : ""}`}>
        <button
          ref={fieldRef}
          type="button"
          className="formula-settings__field"
          aria-label="Editar fórmula"
          onClick={(e) => openEditor(e.currentTarget)}
        >
          {source.trim() ? <code>{source}</code> : <span className="formula-settings__placeholder">Escribe una fórmula</span>}
        </button>
      </div>
      {numeric && (
        <>
          <NumberFormatSettings collectionId={collectionId} propertyId={propertyId} schema={schema} nested={nested} />
          <NumberDisplaySetting collectionId={collectionId} propertyId={propertyId} schema={schema} nested={nested} />
        </>
      )}
      {anchor && (
        <FormulaEditor
          anchor={anchor}
          placement={covers ? "cover" : "below"}
          collectionId={collectionId}
          propertyId={propertyId}
          schema={schema}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

/**
 * The relation menu: a search ("En" the related database), the linked
 * pages (− unlinks), then the database's other pages (+ links) and
 * "Nueva página" for the search text. ↑/↓ and Enter come from the Popover.
 * With "Limitar: 1 página" picking a page replaces the link and closes.
 */
function RelationPicker({
  row,
  propertyId,
  schema,
  collectionId,
  selected,
  onClose,
}: {
  row: Block;
  propertyId: string;
  schema: PropertySchema;
  collectionId: string;
  selected: PageRef[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const targetId = schema.collection_id;
  // The linked pages wherever they are: trashed ones, and missing ones with no name, are left out.
  const linkedPages = useLiveQuery(() => db.blocks.bulkGet(selected.map((r) => r.id)), [selected.map((r) => r.id).join()]);
  const data = useLiveQuery(async () => {
    if (!targetId) return null;
    const target = await db.collections.get(targetId);
    if (!target) return null;
    const pages = (await db.blocks.where("[parent_table+parent_id]").equals(["collection", targetId]).toArray()).filter(
      (b) => b.alive && !b.is_template,
    );
    const own = await db.collections.get(collectionId);
    return {
      target,
      database: await db.blocks.get(target.parent_id),
      pages,
      offered: relationCandidates(pages, target, schema),
      limit: own ? relationLimit(own, propertyId) : 0,
    };
  }, [targetId, collectionId, propertyId, schema]);
  const [showAll, setShowAll] = useState(false);
  if (data === undefined) return null;
  if (!data) return <p className="rule-panel__empty">Esta relación apunta a una base de datos que no está en Xot.</p>;
  const single = data.limit === 1;
  const q = query.trim();
  const matches = (title: string) => title.toLowerCase().includes(q.toLowerCase());
  const ids = new Set(selected.map((r) => r.id));
  const byId = new Map(data.pages.map((p) => [p.id, p]));
  const linked = selected
    .map((ref, i) => ({ ref, page: byId.get(ref.id) ?? linkedPages?.[i] }))
    .filter(({ ref, page }) => !(linkedPages && isHiddenRef(ref, page)) && matches(page ? pageTitle(page) : ref.name));
  const filtered = data.offered.length !== data.pages.length;
  const others = (showAll ? data.pages : data.offered)
    .filter((p) => !ids.has(p.id) && p.id !== row.id && matches(pageTitle(p)))
    .sort((a, b) => b.last_edited_time - a.last_edited_time);
  const shown = others.slice(0, 100);
  const refOf = (page: Block): PageRef => ({ id: page.id, name: pageTitle(page) });
  // The search keeps the focus: keep typing to link more pages or create one.
  const refocus = () => inputRef.current?.focus();
  const link = (ref: PageRef) => {
    void setRelation(row.id, propertyId, single ? [ref] : [...selected, ref]);
    if (single) return onClose();
    if (q) setQuery("");
    refocus();
  };
  const unlink = (id: string) => {
    void setRelation(row.id, propertyId, selected.filter((r) => r.id !== id));
    refocus();
  };
  const create = async () => {
    const title = q;
    const template = data.target.default_template;
    const id = template ? await addRowFromTemplate(data.target.id, template, { title }) : await addRow(data.target.id, { title });
    setQuery("");
    link({ id, name: title });
  };
  const dbTitle = data.database ? pageTitle(data.database) || "Sin título" : "Base de datos";
  return (
    <div className="relation-picker">
      <div className="relation-picker__search">
        <input
          ref={inputRef}
          className="menu-search"
          autoFocus
          value={query}
          placeholder="Vincula o crea una página…"
          aria-label="Buscar páginas"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="relation-picker__in">
          En
          <PageIcon block={data.database} size={14} />
          <span>{dbTitle}</span>
        </span>
          {(filtered || showAll) && schema.relation_filter && (
            <button
              type="button"
              className={`relation-picker__filter${showAll ? "" : " is-on"}`}
              data-tooltip={showAll ? "Mostrar solo las páginas que cumplen el filtro" : "Mostrar todas las páginas"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setShowAll((v) => !v)}
            >
              <ListFilter size={13} />
              {showAll ? "Todas" : "Filtradas"}
            </button>
          )}
      </div>
      <div className="menu-scroll">
        {linked.length > 0 && (
          <>
            <MenuLabel>{single ? "Página vinculada" : "Vinculado"}</MenuLabel>
            {linked.map(({ ref, page }) => (
              <MenuItem
                key={ref.id}
                className="relation-picker__item"
                onMouseDown={(e) => e.preventDefault()}
                icon={<PageIcon block={page} size={18} />}
                right={
                  <span className="relation-picker__action" data-tooltip="Quitar" aria-label={`Quitar ${ref.name}`}>
                    <Minus size={14} />
                  </span>
                }
                onClick={() => unlink(ref.id)}
              >
                {(page ? pageTitle(page) : ref.name) || "Sin título"}
              </MenuItem>
            ))}
          </>
        )}
        {shown.length > 0 && (
          <MenuLabel>{linked.length ? (single ? "Cambiar por" : "Seleccionar más") : `Páginas en ${dbTitle}`}</MenuLabel>
        )}
        {shown.map((page) => (
          <MenuItem
            key={page.id}
            className="relation-picker__item"
            onMouseDown={(e) => e.preventDefault()}
            icon={<PageIcon block={page} size={18} />}
            right={
              <span className="relation-picker__action" aria-hidden>
                <Plus size={14} />
              </span>
            }
            onClick={() => link(refOf(page))}
          >
            {pageTitle(page) || "Sin título"}
          </MenuItem>
        ))}
        {others.length > shown.length && (
          <p className="menu-empty">{others.length - shown.length} páginas más · escribe para buscar</p>
        )}
        {q ? (
          <MenuItem className="relation-picker__new" icon={<Plus size={16} />} onClick={() => void create()}>
            Nueva página «{q}»
          </MenuItem>
        ) : (
          !linked.length && !shown.length && <p className="menu-empty">No hay páginas en {dbTitle}</p>
        )}
      </div>
    </div>
  );
}

/** Formulas and rollups, re-evaluated whenever the rows they read change. */
export function ComputedValue({
  row,
  propertyId,
  schema,
  collectionId,
}: {
  row: Block;
  propertyId: string;
  schema: PropertySchema;
  collectionId: string;
}) {
  const original =
    schema.type === "rollup" && (schema.rollup?.aggregation === "show_original" || schema.rollup?.aggregation === "show_unique");
  type Result = { items: RollupItem[] } | { formula: FValue } | { value: PropertyValue };
  const result = useLiveQuery(async (): Promise<Result | null> => {
    const collection = await db.collections.get(collectionId);
    if (!collection) return null;
    if (original) return { items: await rollupOriginal(row, propertyId, collection) };
    if (schema.type === "formula") return { formula: await formulaValue(row, propertyId, collection) };
    return { value: await evaluate(row, propertyId, collection) };
  }, [row, propertyId, collectionId, original, schema.type]);
  if (!result) return null;
  if ("items" in result) return result.items.length ? <RollupOriginal items={result.items} /> : null;
  if ("formula" in result) return <FormulaResult value={result.formula ?? null} schema={schema} />;
  const value = result.value;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return <StaticCheck on={value} />;
  if (typeof value === "number") return <NumberValue value={value} schema={schema} />;
  // Rollup dates come back in the date property format.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?(\/|$)/.test(value)) return <span>{formatDate(value)}</span>;
  return <span>{String(value)}</span>;
}

const StaticCheck = ({ on }: { on: boolean }) => (
  <span className={`checkbox checkbox--static${on ? " is-checked" : ""}`} aria-checked={on} role="checkbox">
    {on ? <Check size={12} strokeWidth={3} /> : null}
  </span>
);

const isBlankResult = (v: FValue) => v === null || v === "" || (Array.isArray(v) && v.length === 0) || (isRich(v) && !display(v));

/** A formula's result as drawn: numbers in their format, dates, checkboxes, pages, styled text, and lists as chips. */
function FormulaResult({ value, schema }: { value: FValue; schema: PropertySchema }) {
  if (isBlankResult(value)) return null;
  if (Array.isArray(value)) {
    // Pages read as linked pages; any other item as a chip.
    if (value.every(isPage)) return <Relations refs={value.map((p) => ({ id: p.id, name: p.name }))} />;
    return (
      <span className="formula-list">
        {value
          .filter((v) => !isBlankResult(v))
          .map((v, i) =>
            isPage(v) ? (
              <Relations key={i} refs={[{ id: v.id, name: v.name }]} />
            ) : typeof v === "boolean" ? (
              <StaticCheck key={i} on={v} />
            ) : (
              <span key={i} className="formula-list__item">
                <FormulaItem value={v} schema={schema} />
              </span>
            ),
          )}
      </span>
    );
  }
  if (typeof value === "boolean") return <StaticCheck on={value} />;
  if (typeof value === "number") return Number.isFinite(value) ? <NumberValue value={value} schema={schema} /> : null;
  return <FormulaItem value={value} schema={schema} />;
}

/** One formula value as text: a number, a date, a page, styled text or plain text. */
function FormulaItem({ value, schema }: { value: FValue; schema: PropertySchema }) {
  if (typeof value === "number") return <>{numberText(value, schema)}</>;
  if (isDate(value)) return <>{formatDate(storedDate(value))}</>;
  if (isPage(value)) return <Relations refs={[{ id: value.id, name: value.name }]} />;
  if (isRich(value)) return <RichText value={value} />;
  if (Array.isArray(value)) return <>{display(value)}</>;
  return <>{display(value)}</>;
}

const TEXT_STYLES: Record<string, string> = { b: "is-bold", i: "is-italic", u: "is-underline", s: "is-strike", c: "is-code" };

/** style() and link() results: bold, italic, underline, strikethrough, code, colors, backgrounds and links. */
function RichText({ value }: { value: FRich }) {
  return (
    <span className="rich-text">
      {value.parts.map((part, i) => {
        const cls = (part.styles ?? [])
          .map((st) => TEXT_STYLES[st] ?? (st.endsWith("_background") ? `bg-${st.slice(0, -11)}` : `color-${st}`))
          .join(" ");
        if (part.link) {
          const href = /^[a-z][\w+.-]*:/i.test(part.link) ? part.link : `https://${part.link}`;
          return (
            <a
              key={i}
              className={`rich-text__part rich-text__link ${cls}`}
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {part.text}
            </a>
          );
        }
        return (
          <span key={i} className={`rich-text__part ${cls}`}>
            {part.text}
          </span>
        );
      })}
    </span>
  );
}

/** Text-like values read as a list with commas; tags, people, pages and files keep their own look. */
const COMMA_TYPES: PropertyType[] = ["text", "number", "url", "email", "phone_number", "place", "date", "created_time", "last_edited_time", "formula", "rollup", "auto_increment_id"];

/** A rollup's "Mostrar original": each related value drawn like its property (tags, people, linked pages…). */
function RollupOriginal({ items }: { items: RollupItem[] }) {
  const titles = items.every((it) => it.schema.type === "title");
  // The related pages' titles are linked pages.
  if (titles) return <Relations refs={items.map((it) => ({ id: it.row.id, name: String(it.value ?? "") }))} />;
  return (
    <span className="rollup-original">
      {items.map((it, i) => {
        const comma = COMMA_TYPES.includes(it.schema.type) && i < items.length - 1 ? ", " : null;
        const inner =
          it.schema.type === "checkbox" ? (
            <StaticCheck on={it.value === true} />
          ) : it.schema.type === "title" ? (
            <Relations refs={[{ id: it.row.id, name: String(it.value ?? "") }]} />
          ) : (it.schema.type === "formula" || it.schema.type === "rollup") && typeof it.value === "number" ? (
            numberText(it.value, it.schema)
          ) : (it.schema.type === "formula" || it.schema.type === "rollup") &&
            typeof it.value === "string" &&
            /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?(\/|$)/.test(it.value) ? (
            formatDate(it.value)
          ) : typeof it.value === "boolean" ? (
            <StaticCheck on={it.value} />
          ) : (
            <PropertyDisplay value={it.value} schema={it.schema} />
          );
        return (
          <span key={i} className="rollup-original__item">
            {inner}
            {comma}
          </span>
        );
      })}
    </span>
  );
}

/** A status shown as a checkbox is checked when its option is in the last group (Completo). */
function statusChecked(schema: PropertySchema, value: PropertyValue | undefined) {
  const done = schema.groups?.[schema.groups.length - 1];
  return typeof value === "string" && !!done?.option_ids.includes(value);
}
/** Clicking a status checkbox: checked goes back to the default option, unchecked to the first Completo option. */
function statusToggled(schema: PropertySchema, checked: boolean): string | null {
  if (checked) return statusDefault(schema) ?? null;
  return schema.groups?.[schema.groups.length - 1]?.option_ids[0] ?? null;
}

function optionsOf(schema: PropertySchema, ids: string[]) {
  return ids
    .map((id) => schema.options?.find((o) => o.id === id))
    .filter((o): o is SelectOption => !!o);
}

/** Read-only rendering of any value (board cards, computed cells). */
export function PropertyDisplay({ value, schema }: { value: PropertyValue | undefined; schema: PropertySchema }) {
  if (isEmptyValue(value)) return null;
  switch (schema.type) {
    case "select":
    case "status": {
      if (schema.type === "status" && schema.status_display === "checkbox") return <StaticCheck on={statusChecked(schema, value)} />;
      const option = schema.options?.find((o) => o.id === value);
      return option ? <Tag option={option} status={schema.type === "status"} /> : null;
    }
    case "multi_select": {
      const options = optionsOf(schema, value as string[]);
      if (!options.length) return null;
      return (
        <span className="tags">
          {options.map((o) => (
            <Tag key={o.id} option={o} />
          ))}
        </span>
      );
    }
    case "checkbox":
      return value ? (
        <span className="display-check">
          <Check size={13} /> {schema.name}
        </span>
      ) : null;
    case "date":
    case "created_time":
    case "last_edited_time":
      return <span>{formatDate(String(value), schema)}</span>;
    case "person":
    case "created_by":
    case "last_edited_by":
      return <People names={value as string[]} />;
    case "file":
      return <Files files={value as FileRef[]} />;
    case "relation":
      return <Relations refs={value as PageRef[]} schema={schema} />;
    case "url":
      return <span className="display-url">{String(value)}</span>;
    case "number":
      return typeof value === "number" ? <NumberValue value={value} schema={schema} /> : <span>{String(value)}</span>;
    case "auto_increment_id":
      return <span>{schema.id_prefix ? `${schema.id_prefix}-${value}` : String(value)}</span>;
    case "verification":
      return <VerificationValue state={value === "Caducada" ? "expired" : "verified"} />;
    default:
      return <span>{String(value)}</span>;
  }
}

// ------------------------------------------------------------ cell editor

export function PropertyCell({
  row,
  propertyId,
  schema,
  collectionId,
  variant,
  placeholder = "Vacío",
  autoEdit = false,
  openSignal,
  children,
}: {
  row: Block;
  propertyId: string;
  schema: PropertySchema;
  collectionId: string;
  variant: "table" | "panel";
  placeholder?: string;
  /** Starts in the text editor (a row just inserted with "+"). */
  autoEdit?: boolean;
  /** Opens the editor each time `n` changes (keyboard Enter on a selected table cell); `text` replaces a text value. */
  openSignal?: { n: number; text?: string };
  children?: ReactNode;
}) {
  const value = cellValue(row, propertyId, schema);
  const set = (v: PropertyValue) => setRowValue(row.id, propertyId, v);
  const pop = usePopover();
  const [editing, setEditing] = useState(autoEdit);
  const [cellEl, setCellEl] = useState<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Text typed on a selected cell: it replaces the value in the editor.
  const [seed, setSeed] = useState<string | null>(null);
  // The row can mount before the table marks it as just inserted.
  useEffect(() => {
    if (autoEdit) setEditing(true);
  }, [autoEdit]);
  const textual: PropertyType[] = ["title", "text", "url", "number", "email", "phone_number"];
  useEffect(() => {
    if (!openSignal?.n || COMPUTED_TYPES.includes(schema.type)) return;
    if (schema.type === "checkbox") void set(!value);
    else if (schema.type === "status" && schema.status_display === "checkbox") void set(statusToggled(schema, statusChecked(schema, value)));
    else if (textual.includes(schema.type)) {
      setSeed(openSignal.text ?? null);
      setEditing(true);
    } else if (schema.type === "relation" || !READ_ONLY_TYPES.includes(schema.type)) {
      if (rootRef.current) pop.open(rootRef.current);
    }
    // Only a new signal opens the editor.
  }, [openSignal?.n]);
  // Table editors open over the cell; row-page ones open below it.
  const placement = variant === "table" ? "cover" : "below";
  const cls = `cell cell--${variant} cell--${schema.type}`;
  const empty = <span className="cell__placeholder">{variant === "panel" ? placeholder : ""}</span>;

  if (schema.type === "relation") {
    const refs = (Array.isArray(value) ? value : []) as PageRef[];
    return (
      <>
        <div ref={rootRef} className={cls} onClick={(e) => pop.toggle(e.currentTarget)}>
          {refs.length ? <Relations refs={refs} schema={schema} /> : empty}
          {children}
        </div>
        {pop.anchor && (
          <Popover anchor={pop.anchor} onClose={pop.close} width={380} placement={placement} className="relation-popover">
            <RelationPicker
              row={row}
              propertyId={propertyId}
              schema={schema}
              collectionId={collectionId}
              selected={refs}
              onClose={pop.close}
            />
          </Popover>
        )}
      </>
    );
  }

  if (schema.type === "person" || schema.type === "file") {
    const list = Array.isArray(value) ? value : [];
    // Files dropped from the desktop onto the cell join its files.
    const dropProps =
      schema.type === "file"
        ? {
            onDragOver: (e: React.DragEvent) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "copy";
              e.currentTarget.classList.add("is-file-over");
            },
            onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove("is-file-over"),
            onDrop: (e: React.DragEvent) => {
              if (!e.dataTransfer.files.length) return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.classList.remove("is-file-over");
              const dropped = Array.from(e.dataTransfer.files);
              void storeFiles(dropped).then((added) => set([...(list as FileRef[]), ...added]));
            },
          }
        : {};
    return (
      <>
        <div ref={rootRef} className={cls} onClick={(e) => pop.toggle(e.currentTarget)} {...dropProps}>
          {list.length ? <PropertyDisplay value={value} schema={schema} /> : empty}
          {children}
        </div>
        {pop.anchor && (
          <Popover anchor={pop.anchor} onClose={pop.close} width={schema.type === "file" ? 360 : 280} placement={placement}>
            {schema.type === "person" ? (
              <PeoplePicker
                selected={list as string[]}
                single={schema.limit === 1}
                onChange={(names) => {
                  set(names);
                  // "Limitar: 1 persona": picking someone is the whole answer.
                  if (schema.limit === 1 && names.length) pop.close();
                }}
              />
            ) : (
              <FilesEditor files={list as FileRef[]} onChange={set} />
            )}
          </Popover>
        )}
      </>
    );
  }

  if (schema.type === "verification") {
    return (
      <VerificationCell row={row} className={cls} placement={placement}>
        {children}
      </VerificationCell>
    );
  }

  if (schema.type === "button") {
    return (
      <div className={`${cls} cell--readonly`}>
        <RowButton row={row} schema={schema} />
        {children}
      </div>
    );
  }

  if (COMPUTED_TYPES.includes(schema.type)) {
    return (
      <div className={`${cls} cell--readonly`}>
        <ComputedValue row={row} propertyId={propertyId} schema={schema} collectionId={collectionId} />
        {children}
      </div>
    );
  }

  if (READ_ONLY_TYPES.includes(schema.type)) {
    return (
      <div className={`${cls} cell--readonly`}>
        {isEmptyValue(value) ? empty : <PropertyDisplay value={value} schema={schema} />}
        {children}
      </div>
    );
  }

  if (schema.type === "checkbox") {
    return (
      <div className={cls}>
        <button
          type="button"
          role="checkbox"
          aria-checked={!!value}
          className={`checkbox${value ? " is-checked" : ""}`}
          onClick={() => set(!value)}
        >
          {value ? <Check size={12} strokeWidth={3} /> : null}
        </button>
      </div>
    );
  }

  if (schema.type === "place") {
    const name = typeof value === "string" ? value : "";
    const coords = placeCoords(row, propertyId, value);
    return (
      <>
        <div ref={rootRef} className={cls} onClick={(e) => pop.toggle(e.currentTarget)}>
          {name ? <PlaceValue name={name} coords={coords} /> : empty}
          {children}
        </div>
        {pop.anchor && (
          <Popover anchor={pop.anchor} onClose={pop.close} width={320} placement={placement}>
            <PlaceEditor
              name={name}
              coords={coords}
              onChange={(n, c) => void setPlace(row.id, propertyId, n, c)}
              onClear={() => {
                pop.close();
                void setPlace(row.id, propertyId, "", undefined);
              }}
            />
          </Popover>
        )}
      </>
    );
  }

  if (textual.includes(schema.type)) {
    const shown =
      value === null || value === undefined || value === ""
        ? null
        : schema.type === "number" && typeof value === "number"
          ? numberText(value, schema)
          : String(value);
    return (
      <>
        <div ref={setCellEl} className={`${cls}${editing ? " is-editing" : ""}`} onClick={() => setEditing(true)}>
          {shown === null ? (
            empty
          ) : schema.type === "url" ? (
            <a
              className="cell__url"
              href={/^https?:\/\//.test(shown) ? shown : `https://${shown}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {shown}
            </a>
          ) : (schema.type === "email" || schema.type === "phone_number") && contactHref(schema.type, shown) ? (
            <a className="cell__url" href={contactHref(schema.type, shown)!} onClick={(e) => e.stopPropagation()}>
              {shown}
            </a>
          ) : schema.type === "number" && typeof value === "number" && numberDisplayOf(schema) ? (
            <span className="cell__text">
              <NumberValue value={value} schema={schema} />
            </span>
          ) : schema.type === "text" && richRunsOf(row, propertyId, value) ? (
            <span className="cell__text">
              <RichTextValue runs={richRunsOf(row, propertyId, value)!} />
            </span>
          ) : schema.type === "title" ? (
            <span className="cell__text cell__title">
              {row.format.icon && <PageIcon block={row} size={variant === "table" ? 19 : 16} />}
              <span className="cell__title-text">{shown}</span>
            </span>
          ) : (
            <span className="cell__text">{shown}</span>
          )}
          {children}
        </div>
        {editing && cellEl && schema.type === "text" && (
          <RichCellEditor
            anchor={cellEl}
            runs={
              seed !== null
                ? [{ text: seed }]
                : (richRunsOf(row, propertyId, value) ?? (typeof value === "string" && value ? [{ text: value }] : []))
            }
            onCommit={(text, runs) => {
              setEditing(false);
              setSeed(null);
              void setRichText(row.id, propertyId, text, runs);
            }}
            onCancel={() => {
              setEditing(false);
              setSeed(null);
            }}
          />
        )}
        {editing && cellEl && schema.type !== "text" && (
          <CellEditor
            anchor={cellEl}
            initial={seed ?? (value === null || value === undefined ? "" : String(value))}
            multiline={false}
            title={schema.type === "title"}
            icon={schema.type === "title" && row.format.icon ? <PageIcon block={row} size={variant === "table" ? 19 : 16} /> : null}
            onCommit={(text) => {
              setEditing(false);
              setSeed(null);
              if (schema.type === "number") set(text.trim() === "" || Number.isNaN(Number(text)) ? null : Number(text));
              else if ((schema.type === "email" || schema.type === "phone_number") && text.trim()) {
                // Kept as typed, but only a valid one becomes a mailto:/tel: link.
                set(text.trim());
                if (!contactHref(schema.type, text))
                  toast(schema.type === "email" ? `«${text.trim()}» no es un correo válido` : `«${text.trim()}» no es un teléfono válido`);
              } else set(text);
            }}
            onCancel={() => {
              setEditing(false);
              setSeed(null);
            }}
          />
        )}
      </>
    );
  }

  if (schema.type === "date") {
    const reminder = row.reminders?.[propertyId] ?? "";
    const tz = row.time_zones?.[propertyId];
    return (
      <>
        <div ref={rootRef} className={cls} onClick={(e) => pop.toggle(e.currentTarget)}>
          {value ? (
            <DateValue value={String(value)} reminder={reminder} schema={schema} timeZone={tz} />
          ) : (
            empty
          )}
        </div>
        {pop.anchor && (
          <Popover anchor={pop.anchor} onClose={pop.close} width={252} placement={placement}>
            <DatePicker
              value={typeof value === "string" && !isDynamicDate(value) ? toZone(value, tz) : null}
              onChange={(v) => set(v ? fromZone(v, tz) : v)}
              timeZone={tz}
              onTimeZone={(next) => {
                // The time typed stays as it reads; it's now in the new zone.
                if (typeof value === "string" && value.includes("T") && !isDynamicDate(value)) void set(fromZone(toZone(value, tz), next || undefined));
                void setTimeZone(row.id, propertyId, next);
              }}
              reminder={reminder}
              onReminder={(code) => void setReminder(row.id, propertyId, code)}
              onClear={() => {
                set(null);
                void setReminder(row.id, propertyId, "");
                pop.close();
              }}
            />
            {row.is_template && (
              <div className="menu dynamic-dates">
                <MenuSeparator />
                <MenuLabel>Al usar la plantilla</MenuLabel>
                {DYNAMIC_DATES.map(([token, label]) => (
                  <MenuItem
                    key={token}
                    icon={token === "@now" ? <Clock size={16} /> : <Calendar size={16} />}
                    right={value === token ? <Check size={14} /> : undefined}
                    onClick={() => {
                      set(token);
                      pop.close();
                    }}
                  >
                    {label}
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
        )}
      </>
    );
  }

  if (schema.type === "status" && schema.status_display === "checkbox") {
    const checked = statusChecked(schema, value);
    return (
      <div className={cls}>
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          className={`checkbox${checked ? " is-checked" : ""}`}
          data-tooltip={schema.options?.find((o) => o.id === value)?.value}
          onClick={() => set(statusToggled(schema, checked))}
        >
          {checked ? <Check size={12} strokeWidth={3} /> : null}
        </button>
      </div>
    );
  }

  // select / status / multi_select
  const multi = schema.type === "multi_select";
  const selectedIds = multi
    ? Array.isArray(value)
      ? (value as string[])
      : []
    : typeof value === "string"
      ? [value]
      : [];
  const selected = selectedIds
    .map((id) => schema.options?.find((o) => o.id === id))
    .filter((o): o is SelectOption => !!o);
  return (
    <>
      <div ref={rootRef} className={cls} onClick={(e) => pop.toggle(e.currentTarget)}>
        {selected.length ? (
          <span className="tags">
            {selected.map((o) => (
              <Tag key={o.id} option={o} status={schema.type === "status"} />
            ))}
          </span>
        ) : (
          empty
        )}
      </div>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={variant === "table" ? 240 : 280} placement={placement}>
          <OptionPicker
            collectionId={collectionId}
            propertyId={propertyId}
            schema={schema}
            selectedIds={selectedIds}
            onChange={(ids) => {
              if (multi) set(ids);
              else {
                set(ids[0] ?? null);
                pop.close();
              }
            }}
          />
        </Popover>
      )}
    </>
  );
}

/** Downloads a file value: uploads kept in Xot by their name, links as the browser fetches them. */
async function downloadFile(file: FileRef) {
  const url = await resolveFileUrl(file.url);
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.target = "_blank";
  a.rel = "noopener";
  a.click();
}

/** The full-screen view of an image file: the picture over a dark backdrop; a click or Esc closes it. */
async function viewFullScreen(file: FileRef) {
  if (document.querySelector(".xot-lightbox")) return;
  const overlay = document.createElement("div");
  overlay.className = "xot-lightbox xot-lightbox--top";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", file.name);
  const img = document.createElement("img");
  img.src = await resolveFileUrl(file.url);
  img.alt = file.name;
  overlay.append(img);
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  overlay.addEventListener("mousedown", (e) => e.stopPropagation());
  overlay.addEventListener("click", (e) => e.target !== img && close());
  window.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
}

/** Stores dropped or picked files and returns them as values. */
const storeFiles = (picked: File[]) => Promise.all(picked.map(async (f) => ({ name: f.name, url: await storeFile(f) })));

/**
 * The files cell: the files (drag ⠿ to reorder, "•••" to download, view full
 * screen, open the original, rename or remove), "Subir un archivo" and a link field.
 */
function FilesEditor({ files, onChange }: { files: FileRef[]; onChange: (files: FileRef[]) => void }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [menuIndex, setMenuIndex] = useState<number | null>(null);
  const menuPop = usePopover();
  const upload = async () => {
    const picked = await pickFiles("*/*", true);
    if (!picked.length) return;
    setBusy(true);
    try {
      onChange([...files, ...(await storeFiles(picked))]);
    } finally {
      setBusy(false);
    }
  };
  const embed = () => {
    const url = link.trim();
    if (!url) return;
    const full = /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`;
    let name = full;
    try {
      name = decodeURIComponent(new URL(full).pathname.split("/").pop() || new URL(full).hostname);
    } catch {
      /* keep the link as its name */
    }
    onChange([...files, { name, url: full }]);
    setLink("");
  };
  const moveTo = (to: number) => {
    if (dragIndex === null || dragIndex === to) return;
    const next = [...files];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };
  const rename = (i: number, name: string) => {
    setRenaming(null);
    if (name.trim() && name.trim() !== files[i].name) onChange(files.map((f, j) => (j === i ? { ...f, name: name.trim() } : f)));
  };
  const menuFile = menuIndex !== null ? files[menuIndex] : undefined;
  const act = (fn: () => void) => () => {
    menuPop.close();
    fn();
  };
  return (
    <div className="menu files-editor">
      {files.length > 0 && (
        <div className="files-editor__list">
          {files.map((f, i) => (
            <div
              className={`files-editor__item${dragIndex === i ? " is-dragging" : ""}`}
              key={`${f.url}-${i}`}
              onDragOver={(e) => dragIndex !== null && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                moveTo(i);
                setDragIndex(null);
              }}
            >
              <span
                className="files-editor__grip"
                draggable
                aria-label="Arrastrar para mover"
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                  setDragIndex(i);
                }}
                onDragEnd={() => setDragIndex(null)}
              >
                <GripVertical size={14} />
              </span>
              {isImageFile(f) ? <FileItem file={f} /> : <Paperclip size={16} />}
              {renaming === i ? (
                <input
                  className="field field--sm files-editor__rename"
                  autoFocus
                  defaultValue={f.name}
                  aria-label="Nombre del archivo"
                  onFocus={(e) => e.currentTarget.setSelectionRange(0, f.name.replace(/\.[^.]+$/, "").length)}
                  onBlur={(e) => rename(i, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      rename(i, e.currentTarget.value);
                    }
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setRenaming(null);
                    }
                  }}
                />
              ) : (
                <span className="files-editor__name" title={f.name}>
                  {f.name}
                </span>
              )}
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label="Más acciones"
                data-tooltip="Más acciones"
                onClick={(e) => {
                  setMenuIndex(i);
                  menuPop.open(e.currentTarget);
                }}
              >
                <Ellipsis size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {menuPop.anchor && menuFile && menuIndex !== null && (
        <Popover anchor={menuPop.anchor} onClose={menuPop.close} width={220} align="end">
          <div className="menu">
            <MenuItem icon={<Download size={16} />} onClick={act(() => void downloadFile(menuFile))}>
              Descargar
            </MenuItem>
            {isImageFile(menuFile) && (
              <MenuItem icon={<Maximize2 size={16} />} onClick={act(() => void viewFullScreen(menuFile))}>
                Pantalla completa
              </MenuItem>
            )}
            <MenuItem
              icon={<ArrowUpRight size={16} />}
              onClick={act(() => void resolveFileUrl(menuFile.url).then((u) => u && window.open(u, "_blank", "noopener")))}
            >
              Ver original
            </MenuItem>
            <MenuItem icon={<PenLine size={16} />} onClick={act(() => setRenaming(menuIndex))}>
              Renombrar
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger icon={<Trash size={16} />} onClick={act(() => onChange(files.filter((_, j) => j !== menuIndex)))}>
              Eliminar
            </MenuItem>
          </div>
        </Popover>
      )}
      <div className="files-editor__actions">
        <button type="button" className="xot-btn files-editor__upload" disabled={busy} onClick={() => void upload()}>
          {busy ? "Subiendo…" : "Subir un archivo"}
        </button>
        <form
          className="files-editor__link"
          onSubmit={(e) => {
            e.preventDefault();
            embed();
          }}
        >
          <input
            className="field"
            placeholder="Pega el enlace a un archivo o imagen…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <button type="submit" className="xot-btn xot-btn--primary" disabled={!link.trim()}>
            Insertar
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * The text cell editor: a floating box over the cell, at least as wide as
 * it, whose textarea grows with the text. Enter commits (Shift+Enter is a new
 * line in text properties), Escape cancels.
 */
function CellEditor({
  anchor,
  initial,
  multiline,
  title,
  icon,
  onCommit,
  onCancel,
}: {
  anchor: HTMLElement;
  initial: string;
  multiline: boolean;
  title: boolean;
  icon: ReactNode;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [box, setBox] = useState<{ rect: DOMRect; style: React.CSSProperties } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(text);
    else onCancel();
  };

  useLayoutEffect(() => {
    // The text keeps the cell's metrics, so it doesn't move when the editor opens.
    const cs = getComputedStyle(anchor);
    const style: React.CSSProperties = {
      padding: cs.padding,
      lineHeight: cs.lineHeight,
      fontSize: cs.fontSize,
      fontWeight: title ? 500 : undefined,
    };
    const place = () => setBox({ rect: anchor.getBoundingClientRect(), style });
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, title]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, box?.rect.width]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [box !== null]);

  if (!box) return null;
  const { rect } = box;
  return createPortal(
    <div
      className="cell-editor"
      // A dialog, so clicks in it never count as outside the row peek.
      role="dialog"
      aria-label="Editar valor"
      style={{ ...box.style, top: rect.top, left: rect.left, minWidth: rect.width, maxWidth: Math.max(rect.width, 500) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {icon && <span className="cell-editor__icon">{icon}</span>}
      <textarea
        ref={ref}
        rows={1}
        className="cell-editor__input"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !(multiline && e.shiftKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            finish(true);
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            finish(false);
          }
        }}
      />
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------- date picker

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const WEEKDAY_INITIALS = ["lu", "ma", "mi", "ju", "vi", "sá", "do"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayDate = (day: string) => new Date(`${day}T00:00:00`);

/** "2026-10-16", "16/10/2026" or "16 oct 2026" → "2026-10-16" (null when it isn't a date). */
function parseDay(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\./g, "").replace(/ de /g, " ");
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${pad2(+m[2])}-${pad2(+m[1])}`;
  m = t.match(/^(\d{1,2}) ([a-zé]+),? (\d{4})$/);
  if (m) {
    const month = MONTHS.findIndex((name) => name.startsWith(m![2].slice(0, 3)));
    if (month >= 0) return `${m[3]}-${pad2(month + 1)}-${pad2(+m[1])}`;
  }
  return null;
}

function DateField({
  day,
  time,
  active,
  onFocus,
  onDay,
  onTime,
}: {
  day: string;
  time?: string;
  active: boolean;
  onFocus: () => void;
  onDay: (day: string) => void;
  onTime?: (time: string) => void;
}) {
  const shown = day ? formatDate(day) : "";
  const [text, setText] = useState(shown);
  const [timeText, setTimeText] = useState(time ?? "");
  useEffect(() => setText(shown), [shown]);
  useEffect(() => setTimeText(time ?? ""), [time]);
  const commitDay = () => {
    const next = parseDay(text);
    if (next && next !== day) onDay(next);
    else setText(shown);
  };
  const commitTime = () => {
    const m = timeText.trim().match(/^(\d{1,2}):?(\d{2})?$/);
    if (m && +m[1] < 24 && +(m[2] ?? 0) < 60) onTime?.(`${pad2(+m[1])}:${m[2] ?? "00"}`);
    else setTimeText(time ?? "");
  };
  return (
    <div className={`date-field${active ? " is-active" : ""}`}>
      <input
        className="date-field__day"
        value={text}
        placeholder="Fecha"
        onFocus={onFocus}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitDay}
        onKeyDown={(e) => e.key === "Enter" && commitDay()}
      />
      {onTime && (
        <input
          className="date-field__time"
          value={timeText}
          placeholder="00:00"
          onFocus={onFocus}
          onChange={(e) => setTimeText(e.target.value)}
          onBlur={commitTime}
          onKeyDown={(e) => e.key === "Enter" && commitTime()}
        />
      )}
    </div>
  );
}

/**
 * The date picker: the date as text, a month grid, and switches for an
 * end date and a time. Values are "YYYY-MM-DD", "YYYY-MM-DDTHH:mm" or "start/end".
 */
export function DatePicker({
  value,
  onChange,
  onClear,
  options = true,
  range = false,
  reminder,
  onReminder,
  timeZone,
  onTimeZone,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  onClear?: () => void;
  /** The end date and time switches (filters only pick a day). */
  options?: boolean;
  /** Always a start and an end day ("Está entre" filters). */
  range?: boolean;
  /** "Recordatorio": a lib/reminders.ts code ("" for none), shown when it can be changed. */
  reminder?: string;
  onReminder?: (code: string) => void;
  /** "Zona horaria": the IANA zone the times are in (local when absent), shown when it can be changed and there's a time. */
  timeZone?: string;
  onTimeZone?: (tz: string) => void;
}) {
  const [startPart = "", endPart = ""] = (value ?? "").split("/");
  const [startDay = "", startTime] = startPart.split("T");
  const [endDay = "", endTime] = endPart.split("T");
  const hasEnd = range || !!endPart;
  const hasTime = startPart.includes("T");
  const [editing, setEditing] = useState<"start" | "end">("start");
  const [month, setMonth] = useState(() => {
    const d = startDay ? dayDate(startDay) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const today = isoDay(new Date());

  const write = (next: { startDay: string; startTime?: string; endDay?: string; endTime?: string; withEnd: boolean; withTime: boolean }) => {
    if (!next.startDay) return onChange(null);
    const point = (day: string, time?: string) => (next.withTime ? `${day}T${time || "09:00"}` : day);
    let a = point(next.startDay, next.startTime);
    let b = next.withEnd ? point(next.endDay || next.startDay, next.endTime ?? next.startTime) : "";
    if (b && b < a) [a, b] = [b, a];
    onChange(b ? `${a}/${b}` : a);
  };
  const current = { startDay, startTime, endDay, endTime, withEnd: hasEnd, withTime: hasTime };
  const showMonth = (day: string) => {
    const d = dayDate(day);
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };
  const pick = (day: string) => {
    if (hasEnd && editing === "end") {
      write({ ...current, endDay: day });
      setEditing("start");
    } else {
      write({ ...current, startDay: day, endDay: hasEnd && endDay && endDay < day ? day : endDay });
      if (hasEnd) setEditing("end");
    }
  };

  const first = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  const lo = startDay;
  const hi = hasEnd ? endDay : startDay;

  return (
    <div className="date-picker">
      <div className={`date-picker__fields${hasEnd ? " date-picker__fields--range" : ""}`}>
        <DateField
          day={startDay}
          time={hasTime ? startTime : undefined}
          active={hasEnd && editing === "start"}
          onFocus={() => setEditing("start")}
          onDay={(day) => {
            write({ ...current, startDay: day });
            showMonth(day);
          }}
          onTime={hasTime ? (time) => write({ ...current, startTime: time }) : undefined}
        />
        {hasEnd && (
          <DateField
            day={endDay}
            time={hasTime ? endTime : undefined}
            active={editing === "end"}
            onFocus={() => setEditing("end")}
            onDay={(day) => {
              write({ ...current, endDay: day });
              showMonth(day);
            }}
            onTime={hasTime ? (time) => write({ ...current, endTime: time }) : undefined}
          />
        )}
      </div>
      <div className="date-picker__head">
        <span className="date-picker__month">
          {MONTHS[month.getMonth()]} {month.getFullYear()}
        </span>
        <button type="button" className="date-picker__today" onClick={() => showMonth(today)}>
          Hoy
        </button>
        <button
          type="button"
          className="icon-btn date-picker__nav"
          aria-label="Mes anterior"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          className="icon-btn date-picker__nav"
          aria-label="Mes siguiente"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="date-picker__grid">
        {WEEKDAY_INITIALS.map((d) => (
          <span key={d} className="date-picker__weekday">
            {d}
          </span>
        ))}
        {days.map((d) => {
          const day = isoDay(d);
          const selected = day === lo || day === hi;
          const inRange = hasEnd && lo && hi && day > lo && day < hi;
          return (
            <button
              type="button"
              key={day}
              className={`date-day${d.getMonth() !== month.getMonth() ? " is-outside" : ""}${day === today ? " is-today" : ""}${selected ? " is-selected" : ""}${inRange ? " is-in-range" : ""}`}
              onClick={() => pick(day)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      {(options || onClear) && (
        <div className="menu date-picker__menu">
          <MenuSeparator />
          {options && (
            <>
              <MenuItem
                right={<Switch on={hasEnd} />}
                onClick={() => {
                  write({ ...current, startDay: startDay || today, endDay: startDay || today, withEnd: !hasEnd });
                  setEditing(hasEnd ? "start" : "end");
                }}
              >
                Fecha de finalización
              </MenuItem>
              <MenuItem
                right={<Switch on={hasTime} />}
                onClick={() => {
                  const now = new Date();
                  const time = `${pad2(now.getHours())}:${pad2(Math.floor(now.getMinutes() / 15) * 15)}`;
                  write({ ...current, startDay: startDay || today, startTime: time, endTime: time, withTime: !hasTime });
                }}
              >
                Incluir hora
              </MenuItem>
              {onTimeZone && hasTime && <TimeZoneSetting value={timeZone ?? ""} onPick={onTimeZone} />}
              {onReminder && (
                <ReminderSetting
                  code={reminderCode(reminder ?? "", hasTime)}
                  withTime={hasTime}
                  onPick={(code) => {
                    // A reminder needs a date: today.
                    if (code && !startDay) write({ ...current, startDay: today });
                    if (code) askNotificationPermission();
                    onReminder(code);
                  }}
                />
              )}
            </>
          )}
          {onClear && (
            <>
              {options && <MenuSeparator />}
              <MenuItem onClick={onClear}>Borrar</MenuItem>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The date picker's "Zona horaria" row: local time, or any IANA zone from a searchable list. */
function TimeZoneSetting({ value, onPick }: { value: string; onPick: (tz: string) => void }) {
  const pop = usePopover();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase().replace(/\s+/g, "_");
  const zones = pop.anchor ? timeZones().filter((tz) => tz.toLowerCase().includes(q)) : [];
  const local = localTimeZone();
  return (
    <>
      <MenuItem
        className="date-picker__reminder"
        right={
          <>
            <span className="date-picker__reminder-value">{value ? zoneName(value) : "Hora local"}</span>
            <ChevronDown size={14} />
          </>
        }
        onClick={(e) => pop.toggle(e.currentTarget)}
      >
        Zona horaria
      </MenuItem>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={280} align="end">
          <div className="menu tz-menu">
            <input
              className="menu-search"
              autoFocus
              placeholder="Buscar una zona horaria…"
              aria-label="Buscar una zona horaria"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="menu-scroll">
              {!q && (
                <MenuItem
                  right={!value ? <Check size={14} /> : null}
                  onClick={() => {
                    pop.close();
                    onPick("");
                  }}
                >
                  Hora local · {zoneName(local)}
                </MenuItem>
              )}
              {zones.slice(0, 150).map((tz) => (
                <MenuItem
                  key={tz}
                  right={tz === value ? <Check size={14} /> : null}
                  onClick={() => {
                    pop.close();
                    onPick(tz);
                  }}
                >
                  {zoneName(tz)}
                  <span className="tz-menu__id">{tz}</span>
                </MenuItem>
              ))}
              {!zones.length && <p className="menu-empty">Sin resultados</p>}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

/** The date picker's "Recordatorio" row: the choice on the right, a menu of the others under it. */
function ReminderSetting({ code, withTime, onPick }: { code: string; withTime: boolean; onPick: (code: string) => void }) {
  const pop = usePopover();
  return (
    <>
      <MenuItem
        className="date-picker__reminder"
        right={
          <>
            <span className="date-picker__reminder-value">{reminderLabel(code, withTime)}</span>
            <ChevronDown size={14} />
          </>
        }
        onClick={(e) => pop.toggle(e.currentTarget)}
      >
        Recordatorio
      </MenuItem>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={220} align="end">
          <div className="menu">
            {reminderChoices(withTime).map(([id, label]) => (
              <MenuItem
                key={id || "none"}
                right={id === code ? <Check size={14} /> : null}
                onClick={() => {
                  pop.close();
                  onPick(id);
                }}
              >
                {label}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

// ----------------------------------------------------------- option picker

export function OptionPicker({
  collectionId,
  propertyId,
  schema,
  selectedIds,
  onChange,
}: {
  collectionId: string;
  propertyId: string;
  schema: PropertySchema;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const multi = schema.type === "multi_select";
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const editPop = usePopover();
  const [editingId, setEditingId] = useState<string | null>(null);
  const isStatus = schema.type === "status";
  // Status options are listed under their group, in group order.
  const groupOf = new Map<string, string>();
  for (const g of schema.groups ?? []) for (const id of g.option_ids) groupOf.set(id, g.name);
  const options = isStatus
    ? [...(schema.options ?? [])].sort((a, b) => {
        const order = (schema.groups ?? []).map((g) => g.name);
        return order.indexOf(groupOf.get(a.id) ?? "") - order.indexOf(groupOf.get(b.id) ?? "");
      })
    : (schema.options ?? []);
  const q = query.trim().toLowerCase();
  const filtered = options.filter((o) => o.value.toLowerCase().includes(q));
  const exact = options.some((o) => o.value.toLowerCase() === q);
  const canCreate = q.length > 0 && !exact;
  const total = filtered.length + (canCreate ? 1 : 0);

  useEffect(() => setHighlight(0), [query]);

  const toggle = (id: string) => {
    if (multi) onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
    else onChange(selectedIds[0] === id ? [] : [id]);
  };
  const create = async () => {
    const option = await addOption(collectionId, propertyId, query.trim());
    setQuery("");
    if (option) onChange(multi ? [...selectedIds, option.id] : [option.id]);
  };
  const pick = (index: number) => {
    if (index < filtered.length) toggle(filtered[index].id);
    else if (canCreate) void create();
  };
  const selected = selectedIds
    .map((id) => options.find((o) => o.id === id))
    .filter((o): o is SelectOption => !!o);
  const editing = options.find((o) => o.id === editingId);

  return (
    <div className="option-picker">
      <div className="option-picker__input">
        {selected.map((o) => (
          <Tag key={o.id} option={o} status={isStatus} onRemove={() => toggle(o.id)} />
        ))}
        <input
          autoFocus
          value={query}
          placeholder={selected.length ? "" : "Busca o crea una opción"}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, total - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(highlight);
            } else if (e.key === "Backspace" && !query && selected.length) {
              toggle(selected[selected.length - 1].id);
            }
          }}
        />
      </div>
      {!isStatus && (
        <MenuLabel>{options.length ? "Selecciona una opción o crea una" : "Escribe para crear una opción"}</MenuLabel>
      )}
      <div className="option-picker__list">
        {filtered.map((o, i) => (
          <div key={o.id}>
            {isStatus && groupOf.get(o.id) !== groupOf.get(filtered[i - 1]?.id ?? "") && (
              <MenuLabel>{groupOf.get(o.id) ?? "Sin grupo"}</MenuLabel>
            )}
            <div
              className={`option-row${i === highlight ? " is-highlighted" : ""}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => toggle(o.id)}
            >
              <Tag option={o} status={isStatus} />
              {selectedIds.includes(o.id) && <Check size={14} className="option-row__check" />}
              <button
                type="button"
                className="icon-btn option-row__more"
                aria-label="Editar opción"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingId(o.id);
                  editPop.open(e.currentTarget);
                }}
              >
                <Ellipsis size={15} />
              </button>
            </div>
          </div>
        ))}
        {canCreate && (
          <div
            className={`option-row${highlight === filtered.length ? " is-highlighted" : ""}`}
            onMouseEnter={() => setHighlight(filtered.length)}
            onClick={() => void create()}
          >
            <span className="option-row__create">Crear</span>
            <span className="tag tag--default">{query.trim()}</span>
          </div>
        )}
      </div>
      {editPop.anchor && editing && (
        <Popover anchor={editPop.anchor} onClose={editPop.close} width={220}>
          <OptionEditor
            option={editing}
            onRename={(value) => updateOption(collectionId, propertyId, editing.id, { value })}
            onColor={(color) => updateOption(collectionId, propertyId, editing.id, { color })}
            onDescribe={(description) => updateOption(collectionId, propertyId, editing.id, { description: description || undefined })}
            onDelete={() => {
              editPop.close();
              void deleteOption(collectionId, propertyId, editing.id);
            }}
            isDefault={isStatus && editing.id === statusDefault(schema)}
            onSetDefault={isStatus ? () => void updateSchema(collectionId, propertyId, { default_option: editing.id }) : undefined}
          />
        </Popover>
      )}
    </div>
  );
}

export function OptionEditor({
  option,
  onRename,
  onColor,
  onDelete,
  isDefault,
  onSetDefault,
  onDescribe,
}: {
  option: SelectOption;
  onRename: (value: string) => void;
  onColor: (color: SelectOption["color"]) => void;
  onDelete: () => void;
  /** status: whether new pages start with this option, and how to make it so. */
  isDefault?: boolean;
  onSetDefault?: () => void;
  /** The option's description ("" removes it). */
  onDescribe?: (description: string) => void;
}) {
  const [name, setName] = useState(option.value);
  const [description, setDescription] = useState(option.description ?? "");
  const commit = () => name.trim() && name !== option.value && onRename(name.trim());
  const commitDescription = () =>
    onDescribe && description.trim() !== (option.description ?? "") && onDescribe(description.trim());
  return (
    <div className="menu">
      <div className="menu-pad">
        <input
          className="field"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        {onDescribe && (
          <textarea
            className="field option-editor__desc"
            rows={2}
            value={description}
            placeholder="Agregar una descripción…"
            aria-label="Descripción de la opción"
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        )}
      </div>
      {onSetDefault && (
        <MenuItem icon={<Star size={15} />} disabled={isDefault} onClick={onSetDefault}>
          {isDefault ? "Opción predeterminada" : "Establecer como predeterminada"}
        </MenuItem>
      )}
      <MenuItem icon={<Trash size={15} />} onClick={onDelete}>
        Eliminar
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Colores</MenuLabel>
      {OPTION_COLORS.map((color) => (
        <MenuItem
          key={color}
          icon={<span className={`swatch tag--${color}`} />}
          right={option.color === color ? <Check size={14} /> : null}
          onClick={() => onColor(color)}
        >
          {OPTION_COLOR_LABELS[color]}
        </MenuItem>
      ))}
    </div>
  );
}

// ----------------------------------------------------------- property menu

/**
 * The property menu (column header or row-page property): name and type,
 * then the view actions the caller wires (filter, sort, calculate, freeze,
 * hide, wrap, insert, duplicate) and delete.
 */
/** A "Botón" property's cell: runs the button's actions on its row (set values, open the page). */
function RowButton({ row, schema }: { row: Block; schema: PropertySchema }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ action: Extract<Action, { type: "confirm" }>; done: (ok: boolean) => void } | null>(null);
  const run = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const actions = buttonPropertyActions(schema.button);
    if (!actions.length) return toast("Este botón no tiene acciones: configúralas en «Editar propiedad»");
    setBusy(true);
    try {
      await runActions(actions, {
        origin: "button",
        pageId: row.id,
        source: schema.button?.label || schema.name,
        confirm: async (action) => {
          const ok = await new Promise<boolean>((done) => setConfirm({ action, done }));
          setConfirm(null);
          return ok;
        },
        open: navigate,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="row-button" disabled={busy} onClick={(e) => void run(e)}>
        <MousePointerClick size={14} strokeWidth={1.8} />
        <span>{schema.button?.label || schema.name}</span>
      </button>
      {confirm && (
        <ConfirmDialog
          text={confirm.action.text.map(([text, bold], i) => (bold ? <strong key={i}>{text}</strong> : <span key={i}>{text}</span>))}
          confirm={confirm.action.continue || "Continuar"}
          cancel={confirm.action.cancel || "Cancelar"}
          onDone={confirm.done}
        />
      )}
    </>
  );
}

/** What a "Botón" property can do: anything a button block does, on its own row ("Esta página"). */
const ROW_BUTTON_ACTIONS: ActionType[] = [
  "edit_this",
  "create_page",
  "edit_pages",
  "notify",
  "webhook",
  "variables",
  "open_created",
  "open_page",
  "open_url",
  "confirm",
];

/** "Editar propiedad" for a button: its label and the steps a click runs on its row. */
function ButtonPropertySettings({
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
  const button = schema.button ?? {};
  const pop = usePopover();
  const actions = buttonPropertyActions(button);
  const save = (patch: Partial<NonNullable<PropertySchema["button"]>>) =>
    void updateSchema(collectionId, propertyId, { button: { ...button, ...patch } });
  return (
    <>
      <label className={`menu-field${nested ? " menu-item--nested" : ""}`}>
        <span>Etiqueta</span>
        <input
          className="field field--sm"
          placeholder={schema.name}
          defaultValue={button.label ?? ""}
          onBlur={(e) => save({ label: e.target.value.trim() || undefined })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </label>
      <MenuItem
        className={nested ? "menu-item--nested" : ""}
        icon={<MousePointerClick size={16} />}
        right={<span className="menu-item__value">{actions.length ? `${actions.length} ${actions.length === 1 ? "acción" : "acciones"}` : "Ninguna"}</span>}
        onClick={(e) => pop.toggle(e.currentTarget)}
      >
        Al hacer clic…
      </MenuItem>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={380}>
          <div className="chart-settings button-settings">
            <MenuLabel>Al hacer clic</MenuLabel>
            {actions.length === 0 && <p className="muted button-settings__empty">Este botón aún no hace nada.</p>}
            <ActionsEditor
              actions={actions}
              onChange={(next) => save({ actions: next, set: undefined, open_page: undefined })}
              allowed={ROW_BUTTON_ACTIONS}
              thisCollectionId={collectionId}
              thisLabel="esta página"
            />
          </div>
        </Popover>
      )}
    </>
  );
}

export function PropertyMenu({
  collectionId,
  propertyId,
  schema,
  onClose,
  onFilter,
  onSort,
  onHide,
  calc,
  onCalc,
  frozen,
  onFreeze,
  wrap,
  onWrap,
  onInsert,
  onDuplicate,
  locked = false,
}: {
  collectionId: string;
  propertyId: string;
  schema: PropertySchema;
  onClose: () => void;
  onFilter?: () => void;
  onSort?: (direction: "ascending" | "descending") => void;
  onHide?: () => void;
  calc?: CalcType | null;
  onCalc?: (calc: CalcType | null) => void;
  /** Whether the frozen columns end at this one. */
  frozen?: boolean;
  onFreeze?: () => void;
  wrap?: boolean;
  onWrap?: () => void;
  onInsert?: (side: "left" | "right") => void;
  onDuplicate?: () => void;
  /** A locked database ("Bloquear base de datos"): its properties can't be renamed, edited, added or deleted. */
  locked?: boolean;
}) {
  const [name, setName] = useState(schema.name);
  const [description, setDescription] = useState(schema.description ?? "");
  const [showDescription, setShowDescription] = useState(!!schema.description);
  const commitDescription = () =>
    description.trim() !== (schema.description ?? "") &&
    updateSchema(collectionId, propertyId, { description: description.trim() || undefined });
  const viewActions = !!(onFilter || onSort || onCalc || onFreeze || onWrap || onInsert);
  // Row pages have no view actions, so the property settings show right away.
  const [editing, setEditing] = useState(!viewActions && !locked);
  const [showTypes, setShowTypes] = useState(false);
  const [open, setOpen] = useState<"sort" | "calc" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = () => name.trim() && name !== schema.name && updateSchema(collectionId, propertyId, { name: name.trim() });
  const isTitle = schema.type === "title";
  const run = (fn: () => void) => () => {
    commit();
    fn();
    onClose();
  };
  const caret = (on: boolean) => <ChevronRight size={14} className={on ? "rotate-90" : ""} />;

  return (
    <div className="menu prop-menu">
      <div className="prop-menu__head">
        <button
          type="button"
          className="prop-menu__type"
          aria-label="Tipo de propiedad"
          data-tooltip={PROPERTY_TYPE_LABELS[schema.type]}
          disabled={isTitle || locked}
          onClick={() => {
            setEditing(true);
            setShowTypes((v) => !v);
          }}
        >
          <TypeIcon type={schema.type} size={16} />
        </button>
        <input
          ref={inputRef}
          className="field prop-menu__name"
          autoFocus={!locked}
          readOnly={locked}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              onClose();
            }
          }}
          aria-label="Nombre de la propiedad"
        />
        {!locked && (
          <button
            type="button"
            className={`icon-btn prop-menu__info${showDescription ? " is-active" : ""}`}
            aria-label={schema.description ? "Editar descripción" : "Agregar una descripción"}
            data-tooltip={schema.description ? "Editar descripción" : "Agregar una descripción"}
            onClick={() => setShowDescription((v) => !v)}
          >
            <Info size={16} />
          </button>
        )}
      </div>
      {(showDescription || (locked && schema.description)) && (
        <div className="prop-menu__desc">
          <textarea
            className="field prop-menu__desc-input"
            rows={2}
            autoFocus={!locked && !schema.description}
            readOnly={locked}
            value={description}
            placeholder="Agregar una descripción…"
            aria-label="Descripción de la propiedad"
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        </div>
      )}
      {viewActions && !locked && (
        <MenuItem
          icon={<SlidersHorizontal size={16} />}
          right={!isTitle ? caret(editing) : null}
          onClick={() => (isTitle ? inputRef.current?.select() : setEditing((v) => !v))}
        >
          Editar propiedad
        </MenuItem>
      )}
      {editing && !isTitle && (
        <MenuItem
          className={viewActions ? "menu-item--nested" : ""}
          icon={<TypeIcon type={schema.type} />}
          right={
            <>
              {PROPERTY_TYPE_LABELS[schema.type]}
              {caret(showTypes)}
            </>
          }
          onClick={() => setShowTypes((v) => !v)}
        >
          Tipo
        </MenuItem>
      )}
      {showTypes &&
        CREATABLE_TYPES.map((t) => (
          <MenuItem
            key={t}
            className="menu-item--nested menu-item--nested2"
            icon={<TypeIcon type={t} />}
            right={t === schema.type ? <Check size={14} /> : null}
            onClick={() => {
              void changePropertyType(collectionId, propertyId, t);
              setShowTypes(false);
            }}
          >
            {PROPERTY_TYPE_LABELS[t]}
          </MenuItem>
        ))}
      {editing && schema.type === "formula" && (
        <FormulaSettings collectionId={collectionId} propertyId={propertyId} schema={schema} nested={viewActions} />
      )}
      {editing && schema.type === "rollup" && (
        <RollupSettings collectionId={collectionId} propertyId={propertyId} schema={schema} nested={viewActions} />
      )}
      {editing && schema.type === "person" && (
        <FormatSetting
          label="Limitar"
          choices={PERSON_LIMITS}
          value={String(schema.limit ?? 0)}
          nested={viewActions}
          onPick={(v) => void updateSchema(collectionId, propertyId, { limit: Number(v) || undefined })}
        />
      )}
      {editing && schema.type === "relation" && (
        <RelationSettings collectionId={collectionId} propertyId={propertyId} schema={schema} nested={viewActions} />
      )}
      {editing && schema.type === "number" && (
        <NumberFormatSettings collectionId={collectionId} propertyId={propertyId} schema={schema} nested={viewActions} />
      )}
      {editing && schema.type === "number" && (
        <NumberDisplaySetting collectionId={collectionId} propertyId={propertyId} schema={schema} nested={viewActions} />
      )}
      {editing && ["date", "created_time", "last_edited_time"].includes(schema.type) && (
        <>
          <FormatSetting
            label="Formato de fecha"
            choices={DATE_FORMATS}
            value={schema.date_format ?? "full"}
            nested={viewActions}
            onPick={(f) => void updateSchema(collectionId, propertyId, { date_format: f === "full" ? undefined : f })}
          />
          <FormatSetting
            label="Formato de hora"
            choices={TIME_FORMATS}
            value={schema.time_format ?? "H:mm"}
            nested={viewActions}
            onPick={(time_format) => void updateSchema(collectionId, propertyId, { time_format })}
          />
        </>
      )}
      {editing && schema.type === "button" && (
        <ButtonPropertySettings collectionId={collectionId} propertyId={propertyId} schema={schema} nested={viewActions} />
      )}
      {editing && schema.type === "auto_increment_id" && (
        <label className={`menu-field${viewActions ? " menu-item--nested" : ""}`}>
          <span>Prefijo</span>
          <input
            className="field field--sm"
            placeholder="Ninguno"
            defaultValue={schema.id_prefix ?? ""}
            onBlur={(e) => void updateSchema(collectionId, propertyId, { id_prefix: e.target.value.trim() || undefined })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </label>
      )}
      {editing && schema.type === "status" && (
        <FormatSetting
          label="Mostrar como"
          choices={STATUS_DISPLAYS}
          value={schema.status_display ?? "select"}
          nested={viewActions}
          onPick={(v) => void updateSchema(collectionId, propertyId, { status_display: v === "checkbox" ? "checkbox" : undefined })}
        />
      )}
      {editing && (schema.type === "select" || schema.type === "multi_select" || schema.type === "status") && (
        <OptionsSetting collectionId={collectionId} propertyId={propertyId} schema={schema} />
      )}
      {viewActions && <MenuSeparator />}
      {onFilter && (
        <MenuItem icon={<ListFilter size={16} />} onClick={run(onFilter)}>
          Filtro
        </MenuItem>
      )}
      {onSort && (
        <>
          <MenuItem
            icon={<ArrowUpDown size={16} />}
            right={caret(open === "sort")}
            onClick={() => setOpen((o) => (o === "sort" ? null : "sort"))}
          >
            Ordenar
          </MenuItem>
          {open === "sort" && (
            <>
              <MenuItem className="menu-item--nested" icon={<ArrowUp size={16} />} onClick={run(() => onSort("ascending"))}>
                Orden ascendente
              </MenuItem>
              <MenuItem className="menu-item--nested" icon={<ArrowDown size={16} />} onClick={run(() => onSort("descending"))}>
                Orden descendente
              </MenuItem>
            </>
          )}
        </>
      )}
      {onCalc && (
        <>
          <MenuItem
            icon={<Sigma size={16} />}
            right={
              <>
                {calc ? calcLabel(calc, schema) : null}
                {caret(open === "calc")}
              </>
            }
            onClick={() => setOpen((o) => (o === "calc" ? null : "calc"))}
          >
            Calcular
          </MenuItem>
          {open === "calc" && (
            <>
              <MenuItem
                className="menu-item--nested2"
                right={!calc ? <Check size={14} /> : null}
                onClick={run(() => onCalc(null))}
              >
                Ninguno
              </MenuItem>
              {calcsFor(schema)
                .flat()
                .map((c) => (
                  <CalcChoice
                    key={c}
                    name={c}
                    schema={schema}
                    current={calc}
                    className="menu-item--nested2"
                    nestedClassName="menu-item--nested3"
                    onPick={(picked) => run(() => onCalc(picked))()}
                  />
                ))}
            </>
          )}
        </>
      )}
      {onFreeze && (
        <MenuItem icon={frozen ? <PinOff size={16} /> : <Pin size={16} />} onClick={run(onFreeze)}>
          {frozen ? "Desbloquear columnas" : "Fijar"}
        </MenuItem>
      )}
      {onHide && !isTitle && (
        <MenuItem icon={<EyeOff size={16} />} onClick={run(onHide)}>
          Ocultar
        </MenuItem>
      )}
      {onWrap && (
        <MenuItem icon={<WrapText size={16} />} right={<Switch on={!!wrap} />} onClick={onWrap}>
          Ajustar contenido
        </MenuItem>
      )}
      {!locked && (onInsert || !isTitle) && <MenuSeparator />}
      {onInsert && !locked && (
        <>
          <MenuItem icon={<ArrowLeftToLine size={16} />} onClick={run(() => onInsert("left"))}>
            Insertar a la izquierda
          </MenuItem>
          <MenuItem icon={<ArrowRightToLine size={16} />} onClick={run(() => onInsert("right"))}>
            Insertar a la derecha
          </MenuItem>
        </>
      )}
      {!isTitle && !locked && (
        <>
          {onDuplicate && (
            <MenuItem icon={<CopyPlus size={16} />} onClick={run(onDuplicate)}>
              Duplicar propiedad
            </MenuItem>
          )}
          <MenuItem
            danger
            icon={<Trash size={16} />}
            onClick={() => {
              onClose();
              void deleteProperty(collectionId, propertyId);
            }}
          >
            Eliminar propiedad
          </MenuItem>
        </>
      )}
    </div>
  );
}

const STATUS_DISPLAYS: [string, string][] = [
  ["select", "Selección"],
  ["checkbox", "Casilla"],
];

const PERSON_LIMITS: [string, string][] = [
  ["0", "Sin límite"],
  ["1", "1 persona"],
];

const RELATION_LIMITS: [string, string][] = [
  ["0", "Sin límite"],
  ["1", "1 página"],
];

/** A relation's settings: the database it points to and "Limitar" (no limit or 1 page). */
function RelationSettings({
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
  const info = useLiveQuery(async () => {
    const own = await db.collections.get(collectionId);
    const target = schema.collection_id ? await db.collections.get(schema.collection_id) : undefined;
    return {
      limit: own ? relationLimit(own, propertyId) : 0,
      database: target ? await db.blocks.get(target.parent_id) : undefined,
    };
  }, [collectionId, propertyId, schema]);
  if (!info) return null;
  return (
    <>
      <MenuItem
        className={nested ? "menu-item--nested" : ""}
        disabled
        right={
          <>
            <PageIcon block={info.database} size={14} />
            {info.database ? pageTitle(info.database) || "Sin título" : "No disponible"}
          </>
        }
      >
        Relacionado con
      </MenuItem>
      <FormatSetting
        label="Limitar"
        choices={RELATION_LIMITS}
        value={String(info.limit)}
        nested={nested}
        // 0, not absent, so "Sin límite" sticks on a "Parent item" (1 by default).
        onPick={(v) => void updateSchema(collectionId, propertyId, { limit: Number(v) })}
      />
      {info.database && (
        <MenuItem
          className={nested ? "menu-item--nested" : ""}
          right={<Switch on={!!schema.synced_property} />}
          onClick={() => void setRelationTwoWay(collectionId, propertyId, !schema.synced_property)}
        >
          Mostrar en {pageTitle(info.database) || "Sin título"}
        </MenuItem>
      )}
      <RelationViewSettings collectionId={collectionId} propertyId={propertyId} schema={schema} nested={nested} />
    </>
  );
}

/** A property setting row ("Formato de número  Número ›") that unfolds its choices. */
function FormatSetting({
  label,
  choices,
  value,
  nested,
  onPick,
}: {
  label: string;
  choices: [string, string][];
  value: string;
  nested: boolean;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MenuItem
        className={nested ? "menu-item--nested" : ""}
        right={
          <>
            <span className="menu-item__value">{choices.find(([id]) => id === value)?.[1] ?? value}</span>
            <ChevronRight size={14} className={open ? "rotate-90" : ""} />
          </>
        }
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </MenuItem>
      {open &&
        choices.map(([id, text]) => (
          <MenuItem
            key={id}
            className={nested ? "menu-item--nested2" : "menu-item--nested"}
            right={id === value ? <Check size={14} /> : null}
            onClick={() => onPick(id)}
          >
            {text}
          </MenuItem>
        ))}
    </>
  );
}

/**
 * The options of a select, multi-select or status property: drag to reorder
 * (status: also between groups), "…" to rename, recolour or delete, and
 * "+ Agregar una opción" (per group on status).
 */
function OptionsSetting({ collectionId, propertyId, schema }: { collectionId: string; propertyId: string; schema: PropertySchema }) {
  const options = schema.options ?? [];
  const isStatus = schema.type === "status";
  const editPop = usePopover();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const editing = options.find((o) => o.id === editingId);
  const defaultId = isStatus ? statusDefault(schema) : undefined;
  const groups = isStatus ? (schema.groups ?? []) : [{ id: "", name: "Opciones", color: "default" as const, option_ids: options.map((o) => o.id) }];

  /** Moves the dragged option before `targetId` (into its status group). */
  const moveBefore = (targetId: string, groupId: string) => {
    if (!dragId || dragId === targetId) return;
    const next = options.filter((o) => o.id !== dragId);
    const at = targetId ? next.findIndex((o) => o.id === targetId) : next.length;
    next.splice(at < 0 ? next.length : at, 0, options.find((o) => o.id === dragId)!);
    const patch: Partial<PropertySchema> = { options: next };
    if (isStatus)
      patch.groups = (schema.groups ?? []).map((g) => {
        const ids = g.option_ids.filter((id) => id !== dragId);
        if (g.id !== groupId) return { ...g, option_ids: ids };
        const i = targetId ? ids.indexOf(targetId) : -1;
        ids.splice(i < 0 ? ids.length : i, 0, dragId);
        return { ...g, option_ids: ids };
      });
    void updateSchema(collectionId, propertyId, patch);
  };
  const add = async (groupId: string) => {
    const value = draft.trim();
    setDraft("");
    setAdding(null);
    if (value && !options.some((o) => o.value === value)) await addOption(collectionId, propertyId, value, groupId || undefined);
  };
  const sortBy = (dir: 1 | -1) => {
    setSortOpen(false);
    const next = [...options].sort((a, b) => dir * a.value.localeCompare(b.value, "es", { numeric: true }));
    void updateSchema(collectionId, propertyId, { options: next });
  };

  return (
    <div className="prop-options">
      {!isStatus && (
        <MenuItem
          right={<ChevronRight size={14} className={sortOpen ? "rotate-90" : ""} />}
          onClick={() => setSortOpen((o) => !o)}
        >
          Ordenar
        </MenuItem>
      )}
      {sortOpen && (
        <>
          <MenuItem className="menu-item--nested" onClick={() => sortBy(1)}>
            Alfabético
          </MenuItem>
          <MenuItem className="menu-item--nested" onClick={() => sortBy(-1)}>
            Alfabético inverso
          </MenuItem>
        </>
      )}
      {groups.map((g) => {
        const list = isStatus ? g.option_ids.map((id) => options.find((o) => o.id === id)).filter((o): o is SelectOption => !!o) : options;
        return (
          <div key={g.id || "options"}>
            <div
              className="prop-options__label"
              onDragOver={(e) => dragId && e.preventDefault()}
              onDrop={() => moveBefore(list[0]?.id ?? "", g.id)}
            >
              <span>{g.name}</span>
              {isStatus && (
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  aria-label="Agregar una opción"
                  onClick={() => {
                    setDraft("");
                    setAdding(g.id);
                  }}
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
            {list.map((o) => (
              <div
                key={o.id}
                className={`prop-option${dragId === o.id ? " is-dragging" : ""}`}
                onDragOver={(e) => dragId && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  moveBefore(o.id, g.id);
                  setDragId(null);
                }}
              >
                <span
                  className="prop-option__grip"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", o.id);
                    setDragId(o.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                >
                  <GripVertical size={16} />
                </span>
                <Tag option={o} status={isStatus} />
                {isStatus && o.id === defaultId && <span className="prop-option__default">Predeterminada</span>}
                <button
                  type="button"
                  className="icon-btn icon-btn--sm prop-option__more"
                  aria-label="Editar opción"
                  onClick={(e) => {
                    setEditingId(o.id);
                    editPop.open(e.currentTarget);
                  }}
                >
                  <Ellipsis size={16} />
                </button>
              </div>
            ))}
            {adding === g.id ? (
              <div className="menu-pad">
                <input
                  className="field field--sm"
                  autoFocus
                  placeholder="Nombre de la opción"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void add(g.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      void add(g.id);
                    }
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setAdding(null);
                    }
                  }}
                />
              </div>
            ) : (
              !isStatus && (
                <MenuItem icon={<Plus size={16} />} onClick={() => setAdding(g.id)}>
                  Agregar una opción
                </MenuItem>
              )
            )}
          </div>
        );
      })}
      {editPop.anchor && editing && (
        <Popover anchor={editPop.anchor} onClose={editPop.close} width={220}>
          <OptionEditor
            option={editing}
            onRename={(value) => updateOption(collectionId, propertyId, editing.id, { value })}
            onColor={(color) => updateOption(collectionId, propertyId, editing.id, { color })}
            onDescribe={(description) => updateOption(collectionId, propertyId, editing.id, { description: description || undefined })}
            onDelete={() => {
              editPop.close();
              void deleteOption(collectionId, propertyId, editing.id);
            }}
            isDefault={editing.id === defaultId}
            onSetDefault={isStatus ? () => void updateSchema(collectionId, propertyId, { default_option: editing.id }) : undefined}
          />
        </Popover>
      )}
    </div>
  );
}

/** Adds a property; relations first ask for the database they point to, then how to link it. */
export function AddPropertyMenu({ collectionId, onDone }: { collectionId: string; onDone: () => void }) {
  const [step, setStep] = useState<"type" | "relation">("type");
  const [target, setTarget] = useState<Block | null>(null);
  const [twoWay, setTwoWay] = useState(false);
  const [limit, setLimit] = useState("0");
  const [query, setQuery] = useState("");
  const [dbQuery, setDbQuery] = useState("");
  // Every database, inline ones too, with the page it sits in to tell same names apart.
  const databases = useLiveQuery(async () => {
    if (step !== "relation") return [];
    const blocks = await db.blocks.toArray();
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const seen = new Set<string>();
    return blocks
      .filter((b) => b.alive && b.type === "collection_view_page" && b.collection_id)
      .filter((b) => !seen.has(b.collection_id!) && seen.add(b.collection_id!))
      .map((b) => {
        const parent = b.parent_table === "block" && !isWorkspaceRoot(b.parent_id) ? byId.get(b.parent_id) : undefined;
        return { block: b, title: pageTitle(b) || "Sin título", place: parent ? pageTitle(parent) || "Sin título" : "" };
      })
      .sort((a, b) => a.title.localeCompare(b.title, "es"));
  }, [step]);

  if (step === "relation" && target) {
    const title = pageTitle(target) || "Sin título";
    const self = target.collection_id === collectionId;
    const add = async () => {
      onDone();
      const id = await addRelationProperty(collectionId, target.collection_id!, twoWay);
      if (!id) return;
      if (self && twoWay) await setRelationTwoWay(collectionId, id, true);
      if (limit !== "0") await updateSchema(collectionId, id, { limit: Number(limit) });
    };
    return (
      <div className="menu relation-setup">
        <MenuItem
          right={
            <>
              <PageIcon block={target} size={14} />
              {title}
              <ChevronRight size={14} />
            </>
          }
          onClick={() => setTarget(null)}
        >
          Relacionado con
        </MenuItem>
        <FormatSetting label="Limitar" choices={RELATION_LIMITS} value={limit} nested={false} onPick={setLimit} />
        <MenuItem right={<Switch on={twoWay} />} onClick={() => setTwoWay((on) => !on)}>
          Mostrar en {title}
        </MenuItem>
        <div className="relation-setup__actions">
          <button type="button" className="xot-btn xot-btn--primary" onClick={() => void add()}>
            Agregar relación
          </button>
        </div>
      </div>
    );
  }

  if (step === "relation") {
    const dq = dbQuery.trim().toLowerCase();
    const found = (databases ?? []).filter((d) => d.title.toLowerCase().includes(dq));
    return (
      // Keyed: a new search field (and its autoFocus), not the type search reused.
      <div className="menu" key="relation">
        <input
          className="menu-search"
          autoFocus
          placeholder="Buscar una base de datos…"
          aria-label="Buscar una base de datos"
          value={dbQuery}
          onChange={(e) => setDbQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && found.length) setTarget(found[0].block);
          }}
        />
        <MenuLabel>Relacionar con</MenuLabel>
        <div className="menu-scroll">
          {databases && !found.length && <div className="menu-empty">Sin resultados</div>}
          {found.map(({ block: b, title, place }) => (
            <MenuItem
              key={b.id}
              className={place ? "relation-db--placed" : ""}
              icon={<PageIcon block={b} size={16} />}
              title={place ? `${title} · ${place}` : title}
              onClick={() => setTarget(b)}
            >
              {title}
              {b.collection_id === collectionId ? " (esta base)" : ""}
              {/* A gray location under the name: same-named databases told apart. */}
              {place && <span className="relation-setup__place">{place}</span>}
            </MenuItem>
          ))}
        </div>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const types = CREATABLE_TYPES.filter((t) => PROPERTY_TYPE_LABELS[t].toLowerCase().includes(q));
  return (
    <div className="menu">
      <input
        className="menu-search"
        autoFocus
        placeholder="Buscar o agregar nueva propiedad"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <MenuLabel>Tipo de propiedad</MenuLabel>
      {!types.length && <div className="menu-empty">Sin resultados</div>}
      {types.map((t) => (
        <MenuItem
          key={t}
          icon={<TypeIcon type={t} />}
          onClick={() => {
            if (t === "relation") return setStep("relation");
            onDone();
            void (t === "rollup" ? addRollupProperty(collectionId) : addProperty(collectionId, t));
          }}
        >
          {PROPERTY_TYPE_LABELS[t]}
        </MenuItem>
      ))}
    </div>
  );
}
