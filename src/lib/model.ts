// Data model: everything is a
// record in one of three tables. A page is a `block`; a database is a
// `collection_view_page` block that points at a `collection` (the schema) and
// its `collection_view`s (table, board…). Database rows are ordinary `page`
// blocks whose parent_table is "collection".

import type { Action } from "./actions";
import type { Automation, RecurringEvery } from "./automations";

export type ParentTable = "space" | "block" | "collection";
export type BlockType = "page" | "collection_view_page";

export const WORKSPACE_ID = "workspace";

/** Workspaces are root blocks with a "space-…" id; they show in the switcher, not as pages. */
export const isWorkspaceRoot = (id: string) => id.startsWith("space-");

export type PropertyType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "person"
  | "file"
  | "checkbox"
  | "url"
  | "email"
  | "phone_number"
  | "place"
  | "created_time"
  | "last_edited_time"
  | "created_by"
  | "last_edited_by"
  | "button"
  | "auto_increment_id"
  | "relation"
  | "formula"
  | "rollup"
  /** Wikis' "Verificación": the row page's verification (format.verified), set from its menu. */
  | "verification";

/** Types whose value Xot derives instead of storing or editing. */
export const READ_ONLY_TYPES: PropertyType[] = [
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "button",
  "auto_increment_id",
  "formula",
  "rollup",
  "verification",
];

/** Who Xot shows for "Creado por" and "Última edición por": a local workspace has one person. */
export const LOCAL_PERSON = "Tú";

/** Types computed from other values (and other rows) when displayed. */
export const COMPUTED_TYPES: PropertyType[] = ["formula", "rollup"];

/**
 * A formula: formula 2.0 source (see lib/formula.ts), or one of the
 * shapes older imports produced. "unsupported" keeps a source the importer
 * couldn't match; it's evaluated as an expression too.
 */
export type FormulaSpec =
  | { kind: "expression"; source: string }
  | { kind: "equals"; property: string; value: string }
  | { kind: "template"; parts: (string | { property: string })[] }
  | { kind: "days_until_end"; property: string }
  | { kind: "unsupported"; source: string };

/** The rollup "Calcular" choices; "count" is the older name of "count_all". */
export type RollupAggregation =
  | "show_original"
  | "show_unique"
  | "count"
  | "count_all"
  | "count_values"
  | "count_unique"
  | "count_empty"
  | "count_not_empty"
  | "percent_empty"
  | "percent_not_empty"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "earliest_date"
  | "latest_date"
  | "date_range"
  | "checked"
  | "unchecked"
  | "percent_checked"
  | "percent_unchecked"
  | "count_per_group"
  | "percent_per_group";

export interface RollupSpec {
  /** Relation property on this collection. */
  relation: string;
  /** Property on the related rows. */
  target: string;
  aggregation: RollupAggregation;
  /** "Recuento por grupo" / "Porcentaje por grupo": the target status property's group. */
  group_id?: string;
  /** Imported "show as bar"; `number_display` on the property replaces it. */
  show_as?: "bar";
}

/** Numbers and rollups: "Mostrar como" (number, bar or ring), its color, "Dividir entre" and "Mostrar número". */
export interface NumberDisplay {
  as: "number" | "bar" | "ring";
  color?: OptionColor;
  /** The value that fills the bar or ring; 100 when absent (percentages fill at 100%). */
  divide_by?: number;
  /** false hides the number beside the bar or ring. */
  show_number?: boolean;
}

export type OptionColor =
  | "default"
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red";

export interface SelectOption {
  id: string;
  value: string;
  color: OptionColor;
  /** The option's description: a tooltip over the option in its menus and tags. */
  description?: string;
}

/** Status options are bucketed into groups (To-do / In progress / Complete). */
export interface StatusGroup {
  id: string;
  name: string;
  color: OptionColor;
  option_ids: string[];
}

export interface PropertySchema {
  name: string;
  type: PropertyType;
  /** The property's description: shown in a tooltip over the column header and the row page's property name. */
  description?: string;
  options?: SelectOption[];
  groups?: StatusGroup[];
  /** number: format id ("number_with_commas", "percent", "colombian_peso"…). */
  number_format?: string;
  /** number, formula and rollup: "Decimales", 0 to 10 places; up to 2 when absent. */
  decimals?: number;
  /** date: date_format ("relative", "MM/DD/YYYY", "DD/MM/YYYY", "YYYY/MM/DD"); full date when absent. */
  date_format?: string;
  /** date: time_format ("h:mm A" 12-hour, "H:mm" 24-hour); the locale's when absent. */
  time_format?: string;
  /** relation: the collection its pages belong to. */
  collection_id?: string;
  /** relation: the matching property on the other side, for two-way relations. */
  synced_property?: string;
  /** relation: the related pages' properties shown beside their title in cells ("Mostrar propiedades"). */
  relation_properties?: string[];
  /** relation: the rules a page must meet to be offered in the relation menu (the relation filter). */
  relation_filter?: { operator: "and" | "or"; filters: Filter[] };
  /** relation and person: "Limitar": 1 links a single page (person: one person); 0 or absent, no limit. */
  limit?: number;
  formula?: FormulaSpec;
  rollup?: RollupSpec;
  /** number and rollup: "Mostrar como" (bar, ring); a plain number when absent. */
  number_display?: NumberDisplay;
  /** status: the option new pages start with ("Predeterminada"); the first group's first option when absent. */
  default_option?: string;
  /** status: "Mostrar como casilla": checked in the last group (Completo), unchecked otherwise. */
  status_display?: "select" | "checkbox";
  /** auto_increment_id: shown before the number ("TAREA-12"). */
  id_prefix?: string;
  /** button: its label (the property's name when absent), the values it sets on the row, and whether it opens the row. */
  button?: {
    label?: string;
    set?: Record<string, PropertyValue>;
    open_page?: boolean;
    /** The steps a click runs (lib/actions.ts); older buttons only have `set` and `open_page`. */
    actions?: Action[];
  };
}

export interface FileRef {
  name: string;
  url: string;
}

/** A piece of a formatted text value: bold, italic, underline, strike or code, a link, or a page or date mention. */
export interface RichRun {
  text: string;
  styles?: ("b" | "i" | "u" | "s" | "c")[];
  link?: string;
  /** A page mention: the page id (`text` is its title when mentioned). */
  page?: string;
  /** A date mention: "YYYY-MM-DD" (`text` is how it read when mentioned). */
  date?: string;
}

/** Where a "Lugar" value is: the name it was set with and its latitude and longitude. */
export interface PlaceCoords {
  name: string;
  lat: number;
  lng: number;
}

/** A related page; `name` is its title when imported, shown if the page isn't here. */
export interface PageRef {
  id: string;
  name: string;
}

/** title/text/url/email/phone/place → string, number/auto id → number,
 *  select/status → option id, multi_select → option ids, person → names,
 *  file → FileRef[], relation → PageRef[], checkbox → boolean,
 *  date → "YYYY-MM-DD", "YYYY-MM-DDTHH:mm" or a "start/end" range. */
export type PropertyValue = string | number | boolean | string[] | FileRef[] | PageRef[] | null;

export interface Block {
  id: string;
  type: BlockType;
  parent_id: string;
  parent_table: ParentTable;
  /** `title` is always present; database rows also store values by property id. */
  properties: Record<string, PropertyValue>;
  /**
   * icon: an emoji or an image URL. inline: a database shown inside a page, not in the sidebar.
   * cover: image URL (or "gradient:N"), cover_position 0 (top) to 1 (bottom).
   */
  format: {
    icon?: string;
    inline?: boolean;
    cover?: string;
    cover_position?: number;
    full_width?: boolean;
    small_text?: boolean;
    /** Inline databases can hide their title, like linked views. */
    hide_title?: boolean;
    /** Page typeface from the "..." menu (Predeterminado / Serif / Mono). */
    page_font?: "default" | "serif" | "mono";
    /** Locked pages can't be edited until unlocked. */
    locked?: boolean;
    /** "Índice": the floating table of contents on the right edge, on unless "off". */
    floating_toc?: "off";
    /** "Personalizar página": backlinks under the title (expanded), behind a button (default) or off. */
    backlinks?: "expanded" | "off";
    /** "Personalizar página": discussions at the top of the page, shown unless "off". */
    page_comments?: "off";
    /** "Personalizar página": inline comments highlighted (default) or minimal (no highlight until hovered). */
    inline_comments?: "minimal";
    /** "Archivar": the page (and its subpages) leaves the sidebar and search until unarchived. */
    archived?: number;
    /** Wiki "Verificación": when it was verified and until when (null: indefinitely). */
    verified?: { at: number; until: number | null };
    /** "Convertir en wiki": a page turned into a database of its subpages (lib/wiki.ts). */
    wiki?: boolean;
  };
  /** When the page went to the trash (deleted for good 30 days later). */
  trashed_time?: number;
  /** BlockNote document for pages. */
  content: unknown[] | null;
  /** Imported Markdown, converted to `content` the first time the page opens. */
  content_markdown?: string;
  collection_id?: string;
  view_ids?: string[];
  /** A database template: a row that never shows in views, copied by "Nuevo". */
  is_template?: boolean;
  /** Date properties' "Recordatorio", by property id: how long before the date (lib/reminders.ts codes). */
  reminders?: Record<string, string>;
  /** Date properties' "Zona horaria", by property id: the IANA zone the value is shown in (lib/timezones.ts). */
  time_zones?: Record<string, string>;
  /** "Lugar" properties' coordinates, by property id; they belong to the value while its name is `name`. */
  places?: Record<string, PlaceCoords>;
  /**
   * Text properties' formatting, by property id: runs whose texts joined are the stored plain value
   * (a value changed elsewhere no longer matches, and shows plain).
   */
  rich?: Record<string, RichRun[]>;
  alive: boolean;
  order: number;
  created_time: number;
  last_edited_time: number;
}

export interface Collection {
  id: string;
  /** The collection_view_page block that owns it. */
  parent_id: string;
  schema: Record<string, PropertySchema>;
  description?: string;
  /** Template pages offered by "Nuevo", in order. */
  template_ids?: string[];
  /** The template new rows start from ("Establecer como predeterminada"); empty pages when absent. */
  default_template?: string;
  /** Order of the properties on a row page (collection_page_properties); missing ones go last. */
  page_properties?: string[];
  /** Row page visibility by property id; "show" when absent. Hidden ones sit behind "N propiedades más". */
  property_visibility?: Record<string, PropertyVisibility>;
  /** "Personalizar diseño": the rest of the row pages' layout (pinned properties, sections, panel, tabs, comments). */
  page_layout?: PageLayout;
  /** Sub-items: the self-relation pair that nests rows (subitem_property is `children`). */
  subitems?: { parent: string; children: string };
  /** Sub-items turned off by hand: a pair named "Elemento principal" no longer nests rows. */
  subitems_off?: boolean;
  /** "Automatizaciones" (⚡): what runs when pages are added or edited, or on a schedule (lib/automations.ts). */
  automations?: Automation[];
  /** Templates set to "Repetir": a page is made from each on its schedule (lib/automations.ts runs them). */
  template_repeats?: TemplateRepeat[];
}

/** A template's "Repetir": every N days, weeks, months or years at a time, from a start day. */
export interface TemplateRepeat {
  template_id: string;
  every: RecurringEvery;
  interval: number;
  /** "HH:mm", local time. */
  time: string;
  /** week: the days it runs (0 Sunday … 6 Saturday). */
  weekdays?: number[];
  /** The day it starts (local midnight). */
  start: number;
  /** The last time a page was due (made then, or when Xot opened after it); when it was set up, at first. */
  last_due?: number;
}

export type PropertyVisibility = "show" | "hide" | "hide_if_empty" | "section";

/** The database page layout, shared by every page of the database. */
export interface PageLayout {
  /** Properties shown under the title, side by side (up to 4). */
  pinned?: string[];
  /** Named groups of properties, after the others; each property is in one at most. */
  sections?: { id: string; name: string; properties: string[] }[];
  /** The properties sit in a details panel on the right of the page instead of above its content. */
  panel?: boolean;
  /** Relation properties whose related pages show as tabs under the properties. */
  tabs?: string[];
  /** "off": the comment button beside each property is hidden. */
  property_comments?: "off";
  /** "off": the page's discussions aren't shown above its content. */
  discussions?: "off";
}

export type ViewType = "table" | "board" | "list" | "gallery" | "calendar" | "timeline" | "chart" | "feed" | "form" | "dashboard" | "map";

export type ChartType = "column" | "bar" | "line" | "donut" | "number";
export type Aggregator = "count" | "sum" | "average" | "min" | "max";

export interface ChartConfig {
  type: ChartType;
  /** Category axis (not used by "number"). */
  group_by?: string;
  aggregator: Aggregator;
  /** Property aggregated by sum/average/min/max. */
  property?: string;
  sort: "manual" | "x-ascending" | "x-descending" | "y-ascending" | "y-descending";
  hide_empty?: boolean;
  /** Overrides the property's number format, e.g. "colombian_peso". */
  number_format?: string;
  data_labels?: "none" | "value" | "name" | "name_and_value";
  height?: "small" | "medium" | "large";
  /** A second property that splits each bar into stacked parts (lines: one line each). */
  series_by?: string;
  /** Running totals: each category adds the ones before it. */
  cumulative?: boolean;
  /** line: a smooth curve instead of straight segments. */
  smooth?: boolean;
  /** line: the area under the line is filled. */
  area?: boolean;
  /** false hides the grid lines. */
  grid?: boolean;
  /** Names on the axes (the grouped property and the value). */
  axis_names?: boolean;
  /** A legend under the chart (on by default for series and donuts). */
  legend?: boolean;
  /** Colors: each option's own (auto), a fixed set, or shades of one color. */
  palette?: "auto" | "colorful" | "blue" | "green" | "orange" | "purple" | "pink" | "gray";
  /** Darker shades for bigger values. */
  color_by_value?: boolean;
  /** Categories whose value is 0 are left out. */
  omit_zero?: boolean;
  /** Category keys left out of the chart. */
  hidden_groups?: string[];
}

/** A form question: its own wording (the property's name when absent) and how it is answered. */
export interface FormQuestion {
  title?: string;
  description?: string;
  /** text and title: a long answer (several lines) or a short one; text is long and the title short when absent. */
  long?: boolean;
  /** select, status and multi-select: a dropdown instead of the options laid out. */
  dropdown?: boolean;
  /** multi-select and relation: the most options or pages that can be picked. */
  max?: number;
  /** Conditional logic: asked only when that earlier question's answer includes one of these options. */
  show_if?: { property: string; options: string[] };
}

export interface DashboardRow {
  id: string;
  height: number;
  /** View ids; each widget view can show any collection. */
  widgets: string[];
  /** How wide each widget is against the others in its row (1 when absent). */
  widths?: Record<string, number>;
}

/** Table footer calculations (the "Calcular" row). */
export type CalcType =
  | "count_all"
  | "count_values"
  | "count_unique"
  | "empty"
  | "not_empty"
  | "percent_empty"
  | "percent_not_empty"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "checked"
  | "unchecked"
  | "percent_checked"
  | "percent_unchecked"
  | "earliest_date"
  | "latest_date"
  | "date_range"
  // Status: "Recuento por grupo" / "Porcentaje por grupo", with the status group's id.
  | `count_per_group:${string}`
  | `percent_per_group:${string}`;

export interface ViewProperty {
  property: string;
  visible: boolean;
  width?: number;
  /** table: this column wraps (true) or stays on one line (false); the view's table_wrap when absent. */
  wrap?: boolean;
}

export type FilterOperator =
  | "contains"
  | "does_not_contain"
  | "is"
  | "is_not"
  | "starts_with"
  | "ends_with"
  | "is_empty"
  | "is_not_empty"
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after"
  /** Value "YYYY-MM-DD/YYYY-MM-DD": both days included. */
  | "is_between"
  /** Value "surrounding_day|week|month|year": the current day, week, month or year. */
  | "is_within";

export interface Filter {
  id: string;
  property: string;
  operator: FilterOperator;
  value?: PropertyValue;
}

/** A conditional color rule: pages that meet `filter` show in `color`, the whole row or card, or just the rule's property cell. */
export interface ColorRule {
  id: string;
  filter: Filter;
  color: OptionColor;
  target: "row" | "cell";
}

export interface Sort {
  id: string;
  property: string;
  direction: "ascending" | "descending";
}

/** A nested filter group ("Agregar grupo de filtros"): its rules joined by its own operator. */
export interface FilterGroupBase {
  id: string;
  operator: "and" | "or";
  filters: Filter[];
}

/** Groups can hold groups after their rules: they nest three levels (the view's rules, a group, a group in it). */
export interface FilterGroup extends FilterGroupBase {
  groups?: FilterGroupBase[];
}

export interface Query {
  filter_operator: "and" | "or";
  filters: Filter[];
  /** Advanced filter groups, joined to the top-level rules by `filter_operator`. */
  filter_groups?: FilterGroup[];
  sort: Sort[];
}

export interface BoardColumn {
  /** Option id (or status group id when grouping by group); null is the "no value" column. */
  value: string | null;
  hidden?: boolean;
}

/** Table and list grouping (collection_group_by). */
export interface GroupBy {
  property: string;
  /** Group order: the property's own order ("manual"), or by name/value. */
  sort?: "manual" | "ascending" | "descending";
  hide_empty?: boolean;
  /** status: one group per option (default) or per status group. */
  mode?: "option" | "group";
  /** dates: relative buckets (Hoy, Ayer, Últimos 7 días…) or by day, week, month or year. */
  date_by?: "relative" | "day" | "week" | "month" | "year";
  /** text, URL, email, phone: one group per exact value (default) or per first letter. */
  text_by?: "exact" | "alphabetical";
  /** numbers: ranges of `step` from `start` to `end`; 0 to 1000 by 100 when absent. */
  number_range?: { start: number; end: number; step: number };
  /** Group keys hidden from the view ("Grupos ocultos"). */
  hidden?: string[];
  /** Group keys in a dragged order; used while `sort` is "manual". */
  order?: string[];
}

export interface CollectionView {
  id: string;
  type: ViewType;
  name: string;
  parent_id: string;
  collection_id: string;
  format: {
    properties: ViewProperty[];
    /** A wiki's "Inicio" view: it shows the wiki page's own content instead of rows. */
    wiki_home?: boolean;
    board_group_by?: string;
    /** Status boards can group by option or by status group. */
    board_group_mode?: "option" | "group";
    /** Column order and visibility; options missing here are appended. */
    board_columns?: BoardColumn[];
    board_hide_empty?: boolean;
    /** board: how its groups are ordered and bucketed (dates, text, numbers), as in table grouping. */
    board_group?: Pick<GroupBy, "sort" | "date_by" | "text_by" | "number_range">;
    /** board: "Subagrupar", a second groupable property that splits the board into swimlanes. */
    board_sub_group_by?: string;
    /** Tint columns with their option color (the default). */
    board_color_columns?: boolean;
    /** board: card width (card size); medium when absent. */
    board_card_size?: "small" | "medium" | "large";
    /** board: card preview above the title, like gallery_cover; none when absent. */
    board_cover?: { type: "none" | "page_cover" | "page_content" | "property"; property?: string };
    /** board: what each group's header counts (group calculation); the number of cards when absent. */
    board_calc?: { property: string; calc: CalcType };
    /** false: table cells stay on one line. */
    table_wrap?: boolean;
    /** table: false drops the lines between columns ("Mostrar líneas verticales"). */
    table_vertical_lines?: boolean;
    /** table: false hides the rows' page icons beside their titles ("Mostrar icono de página"). */
    show_page_icon?: boolean;
    /** table: calculation shown under each column, by property id. */
    table_calcs?: Record<string, CalcType>;
    /** table: the first N visible columns stay put when scrolling sideways ("Inmovilizar"). */
    table_frozen_column_index?: number;
    /** table: the title column was dragged, so it keeps its place in `properties` instead of leading. */
    table_title_moved?: boolean;
    chart?: ChartConfig;
    /** form: the questions (property ids) that must be answered before "Enviar". */
    form_required?: string[];
    /** form: the text under the form's title. */
    form_description?: string;
    /** form: each question's own wording and settings, by property id. */
    form_questions?: Record<string, FormQuestion>;
    /** form: its icon, cover and title (the database's when absent), the button's label and the screen after sending. */
    form?: { icon?: string; cover?: string; title?: string; submit_label?: string; sent_title?: string; sent_message?: string };
    /** map: the "Lugar" property that places the pins ("Mapa por"). */
    map_by?: string;
    /** calendar: the date property that places cards. */
    calendar_by?: string;
    /** calendar: a month grid (default) or a single week. */
    calendar_range?: "month" | "week";
    /** calendar: false drops the Saturday and Sunday columns. */
    calendar_show_weekends?: boolean;
    /** gallery: what fills the card preview. */
    gallery_cover?: { type: "none" | "page_cover" | "page_content" | "property"; property?: string };
    gallery_card_size?: "small" | "medium" | "large";
    /** gallery and board: "contain" fits the whole preview image ("Ajustar contenido multimedia"). */
    gallery_cover_aspect?: "cover" | "contain";
    /** dashboard: its rows of widgets, and filters every widget applies (by property name, on databases that have it). */
    dashboard?: { rows: DashboardRow[]; filters?: Filter[] };
    /** timeline: date property (a range, or start/end pair) and zoom. */
    timeline_by?: string;
    timeline_by_end?: string;
    timeline_zoom?: "hours" | "day" | "week" | "bi_week" | "month" | "quarter" | "year" | "5_years";
    /** timeline: the property table on the left ("Mostrar tabla"); shown when absent. */
    timeline_show_table?: boolean;
    /** timeline: the table's property columns after the title, in order. */
    timeline_table_properties?: string[];
    /** timeline: the self-relation pair whose links are drawn as arrows between bars ("Dependencias"). */
    timeline_dependencies?: {
      blocked_by: string;
      blocking: string;
      /**
       * What happens to the bars a moved bar blocks: they move only when they'd start before it ends
       * (default), they move by as much to keep their gap, or they stay.
       */
      shift?: "overlap" | "gap" | "none";
      /** Shifted bars never start on a Saturday or Sunday, and their length counts only weekdays. */
      skip_weekends?: boolean;
    };
    /** timeline: day (timestamp) the view opens on; today when absent. */
    timeline_center?: number;
    /** Rows loaded before "Load more" (per group on boards). */
    load_limit?: number;
    /**
     * board and gallery: the view's own manual order (page_sort), row ids first to
     * last; rows not listed follow in the global order. Absent: the global order.
     */
    page_sort?: string[];
    /** "Establecer como predeterminada > Para esta vista": the template this view's new pages start from ("" a blank page); the database's when absent. */
    default_template?: string;
    /** Where rows open: side peek (default), center peek or the full page. */
    open_pages_in?: "side" | "center" | "full";
    /** table: sub-items nested under their parent (default), shown flat as a property, or off. */
    subitems_display?: "nested" | "property" | "off";
    /** Which rows the view's filter applies to: all (default), top-level ones (with all their sub-items) or sub-items (under every parent). */
    subitems_filter?: "both" | "parents" | "subitems";
    /** Nested sub-items start expanded instead of behind their parent's toggle. */
    subitems_expanded?: boolean;
    /** table and list: rows bucketed into collapsible groups. */
    group_by?: GroupBy;
    /** "Color condicional": rows, cards or cells tinted when their page meets a rule (the first rule that matches wins). */
    color_rules?: ColorRule[];
  };
  query2: Query;
}

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  title: "Título",
  text: "Texto",
  number: "Número",
  select: "Seleccionar",
  multi_select: "Selección múltiple",
  date: "Fecha",
  status: "Estado",
  person: "Personas",
  file: "Archivos y multimedia",
  checkbox: "Casilla",
  url: "URL",
  email: "Correo electrónico",
  phone_number: "Teléfono",
  place: "Lugar",
  created_time: "Fecha de creación",
  last_edited_time: "Última edición",
  created_by: "Creado por",
  last_edited_by: "Última edición por",
  button: "Botón",
  auto_increment_id: "ID",
  relation: "Relación",
  formula: "Fórmula",
  rollup: "Rollup",
  verification: "Verificación",
};

/**
 * Older imports turned "Porcentaje por grupo" (a status rollup shown as a bar, like the
 * Projects template's "Completion") into "count". Those read again as the share of related rows in
 * the status's last group (Complete). Returns the collections it changed.
 */
export function repairStatusRollups(collections: Collection[]): Collection[] {
  const byId = new Map(collections.map((c) => [c.id, c]));
  const changed: Collection[] = [];
  for (const c of collections) {
    let schema: Record<string, PropertySchema> | undefined;
    for (const [id, p] of Object.entries(c.schema)) {
      const r = p.rollup;
      if (p.type !== "rollup" || !r || r.aggregation !== "count" || r.show_as !== "bar") continue;
      const target = byId.get(c.schema[r.relation]?.collection_id ?? "")?.schema[r.target];
      const group = target?.type === "status" ? target.groups?.at(-1) : undefined;
      if (!group) continue;
      schema ??= { ...c.schema };
      schema[id] = { ...p, rollup: { ...r, aggregation: "percent_per_group", group_id: group.id } };
    }
    if (schema) changed.push({ ...c, schema });
  }
  return changed;
}

/** A status property's default option: the one set as "Predeterminada", else the first group's first option. */
export function statusDefault(schema: PropertySchema): string | undefined {
  const ids = new Set((schema.options ?? []).map((o) => o.id));
  if (schema.default_option && ids.has(schema.default_option)) return schema.default_option;
  return schema.groups?.find((g) => g.option_ids.some((id) => ids.has(id)))?.option_ids.find((id) => ids.has(id)) ?? schema.options?.[0]?.id;
}

export const OPTION_COLORS: OptionColor[] = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];

export const OPTION_COLOR_LABELS: Record<OptionColor, string> = {
  default: "Predeterminado",
  gray: "Gris",
  brown: "Marrón",
  orange: "Naranja",
  yellow: "Amarillo",
  green: "Verde",
  blue: "Azul",
  purple: "Morado",
  pink: "Rosa",
  red: "Rojo",
};
