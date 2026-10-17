import { db } from "./db";
import { createPage, emptyQuery, shortId, uuid } from "./ops";
import { resolveContent, resolveDynamicDate } from "./templates";
import {
  LOCAL_PERSON,
  type Block,
  type Collection,
  type CollectionView,
  type OptionColor,
  type ParentTable,
  type PropertySchema,
  type PropertyType,
  type PropertyValue,
  type ViewType,
} from "./model";

// "Plantillas": a template gallery, kept locally. Each template is data —
// a page (icon, title, BlockNote body) or a database (properties, views, sample
// rows and its own database templates) — that the gallery previews and that
// "Usar plantilla" builds in the workspace. Dates are dynamic ("@today+3"), so
// the sample rows land around the day the template is used.

type Text = string | { text: string; bold?: boolean; italic?: boolean };
export type GalleryBlock = { type: string; props?: Record<string, unknown>; text?: Text[]; children?: GalleryBlock[] };

export interface GalleryProp {
  name: string;
  type: PropertyType;
  /** select, multi_select, status: option names and colors, in order. */
  options?: [string, OptionColor][];
}

export interface GalleryView {
  type: ViewType;
  name: string;
  /** board: the property (key) it groups by; calendar/timeline: the date property. */
  by?: string;
}

/** Values by property key: option names for selects, "@today+N" for dates. */
type GalleryValues = Record<string, PropertyValue>;

export interface GalleryTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  /** A page: its body. */
  blocks?: GalleryBlock[];
  /** A database: its properties by key ("title" is the name column), views, rows and templates. */
  database?: {
    props: Record<string, GalleryProp>;
    views: GalleryView[];
    rows: (GalleryValues & { title: string })[];
    templates?: { title: string; icon?: string; values?: GalleryValues; blocks?: GalleryBlock[]; default?: boolean }[];
  };
}

export const GALLERY_CATEGORIES = ["Trabajo", "Personal", "Estudios"];

// ------------------------------------------------------------------ blocks

const h = (level: 1 | 2 | 3, text: string): GalleryBlock => ({ type: "heading", props: { level }, text: [text] });
const p = (...text: Text[]): GalleryBlock => ({ type: "paragraph", text });
const li = (text: string): GalleryBlock => ({ type: "bulletListItem", text: [text] });
const todo = (text: string, checked = false): GalleryBlock => ({ type: "checkListItem", props: { checked }, text: [text] });
const callout = (icon: string, text: string): GalleryBlock => ({ type: "callout", props: { icon }, text: [text] });
const divider: GalleryBlock = { type: "divider" };
const empty: GalleryBlock = { type: "paragraph" };

/** BlockNote's JSON for the blocks (ids are given when the page is first saved). */
export function toContent(blocks: GalleryBlock[]): unknown[] {
  return blocks.map((b) => ({
    type: b.type,
    props: { ...b.props },
    content: b.type === "divider" ? undefined : (b.text ?? []).map((t) => ({
      type: "text",
      text: typeof t === "string" ? t : t.text,
      styles: typeof t === "string" ? {} : { ...(t.bold ? { bold: true } : {}), ...(t.italic ? { italic: true } : {}) },
    })),
    children: b.children ? toContent(b.children) : [],
  }));
}

/** The plain text of a block, for the preview. */
export const blockText = (b: GalleryBlock) => (b.text ?? []).map((t) => (typeof t === "string" ? t : t.text)).join("");

// --------------------------------------------------------------- templates

const STATUS: [string, OptionColor][] = [
  ["Por hacer", "gray"],
  ["En curso", "blue"],
  ["Hecho", "green"],
];
const PRIORITY: [string, OptionColor][] = [
  ["Alta", "red"],
  ["Media", "yellow"],
  ["Baja", "green"],
];

export const GALLERY: GalleryTemplate[] = [
  {
    id: "tasks",
    name: "Lista de tareas",
    category: "Trabajo",
    description: "Organiza el trabajo en un tablero por estado, con prioridad, responsable y fecha límite.",
    icon: "✅",
    database: {
      props: {
        title: { name: "Tarea", type: "title" },
        status: { name: "Estado", type: "status", options: STATUS },
        priority: { name: "Prioridad", type: "select", options: PRIORITY },
        due: { name: "Fecha límite", type: "date" },
        owner: { name: "Responsable", type: "person" },
      },
      views: [
        { type: "board", name: "Tablero", by: "status" },
        { type: "table", name: "Todas las tareas" },
        { type: "calendar", name: "Calendario", by: "due" },
      ],
      rows: [
        { title: "Preparar la presentación", status: "En curso", priority: "Alta", due: "@today+2", owner: [LOCAL_PERSON] },
        { title: "Revisar el presupuesto", status: "Por hacer", priority: "Media", due: "@today+5", owner: [LOCAL_PERSON] },
        { title: "Enviar el informe semanal", status: "Por hacer", priority: "Baja", due: "@today+7" },
        { title: "Reunión de arranque", status: "Hecho", priority: "Media", due: "@today-2", owner: [LOCAL_PERSON] },
      ],
      templates: [
        {
          title: "Nueva tarea",
          icon: "📌",
          default: true,
          values: { status: "Por hacer", priority: "Media", due: "@today+7", owner: [LOCAL_PERSON] },
          blocks: [h(2, "Contexto"), p(""), h(2, "Lista de verificación"), todo(""), todo("")],
        },
      ],
    },
  },
  {
    id: "meetings",
    name: "Notas de reunión",
    category: "Trabajo",
    description: "Una base de datos de reuniones con agenda, notas y próximos pasos, fechada al crearla.",
    icon: "🗓️",
    database: {
      props: {
        title: { name: "Reunión", type: "title" },
        date: { name: "Fecha", type: "date" },
        kind: {
          name: "Tipo",
          type: "select",
          options: [
            ["Seguimiento", "blue"],
            ["Planificación", "purple"],
            ["Retrospectiva", "orange"],
            ["1:1", "green"],
          ],
        },
        people: { name: "Asistentes", type: "person" },
      },
      views: [
        { type: "table", name: "Todas las reuniones" },
        { type: "calendar", name: "Calendario", by: "date" },
      ],
      rows: [
        { title: "Planificación del trimestre", date: "@today-3", kind: "Planificación", people: [LOCAL_PERSON] },
        { title: "Seguimiento semanal", date: "@today", kind: "Seguimiento", people: [LOCAL_PERSON] },
      ],
      templates: [
        {
          title: "Reunión",
          icon: "🗓️",
          default: true,
          values: { date: "@now", kind: "Seguimiento", people: [LOCAL_PERSON] },
          blocks: [h(2, "Agenda"), li(""), h(2, "Notas"), p(""), h(2, "Próximos pasos"), todo("")],
        },
      ],
    },
  },
  {
    id: "roadmap",
    name: "Hoja de ruta",
    category: "Trabajo",
    description: "Planifica proyectos en una línea de tiempo y sigue su avance por estado y trimestre.",
    icon: "🗺️",
    database: {
      props: {
        title: { name: "Proyecto", type: "title" },
        status: { name: "Estado", type: "status", options: STATUS },
        quarter: {
          name: "Trimestre",
          type: "select",
          options: [
            ["T1", "gray"],
            ["T2", "blue"],
            ["T3", "purple"],
            ["T4", "pink"],
          ],
        },
        dates: { name: "Fechas", type: "date" },
      },
      views: [
        { type: "timeline", name: "Línea de tiempo", by: "dates" },
        { type: "board", name: "Por estado", by: "status" },
        { type: "table", name: "Tabla" },
      ],
      rows: [
        { title: "Nuevo sitio web", status: "En curso", quarter: "T4", dates: "@today-10/@today+20" },
        { title: "App móvil", status: "Por hacer", quarter: "T1", dates: "@today+25/@today+70" },
        { title: "Migración de datos", status: "Hecho", quarter: "T3", dates: "@today-45/@today-12" },
      ],
    },
  },
  {
    id: "project-doc",
    name: "Documento de proyecto",
    category: "Trabajo",
    description: "Una página para explicar un proyecto: resumen, objetivos, alcance, cronograma y riesgos.",
    icon: "📄",
    blocks: [
      callout("💡", "Resume en dos frases qué se va a construir y por qué."),
      h(2, "Resumen"),
      p(""),
      h(2, "Objetivos"),
      li("Objetivo principal"),
      li("Cómo sabremos que funcionó"),
      h(2, "Alcance"),
      h(3, "Incluye"),
      li(""),
      h(3, "No incluye"),
      li(""),
      h(2, "Cronograma"),
      todo("Diseño"),
      todo("Desarrollo"),
      todo("Lanzamiento"),
      h(2, "Riesgos"),
      p(""),
    ],
  },
  {
    id: "journal",
    name: "Diario",
    category: "Personal",
    description: "Una entrada por día con estado de ánimo y preguntas para reflexionar; la plantilla pone la fecha de hoy.",
    icon: "📔",
    database: {
      props: {
        title: { name: "Entrada", type: "title" },
        date: { name: "Fecha", type: "date" },
        mood: {
          name: "Estado de ánimo",
          type: "select",
          options: [
            ["Genial", "green"],
            ["Bien", "blue"],
            ["Normal", "gray"],
            ["Difícil", "orange"],
          ],
        },
      },
      views: [
        { type: "list", name: "Entradas" },
        { type: "calendar", name: "Calendario", by: "date" },
      ],
      rows: [{ title: "Primer día", date: "@today", mood: "Bien" }],
      templates: [
        {
          title: "Entrada diaria",
          icon: "📔",
          default: true,
          values: { date: "@today" },
          blocks: [h(3, "¿Por qué estoy agradecido hoy?"), p(""), h(3, "¿Qué salió bien?"), p(""), h(3, "¿Qué haría distinto?"), p("")],
        },
      ],
    },
  },
  {
    id: "habits",
    name: "Seguimiento de hábitos",
    category: "Personal",
    description: "Marca cada día los hábitos que cumpliste y mira tu progreso en la tabla.",
    icon: "🌱",
    database: {
      props: {
        title: { name: "Día", type: "title" },
        date: { name: "Fecha", type: "date" },
        exercise: { name: "Ejercicio", type: "checkbox" },
        reading: { name: "Lectura", type: "checkbox" },
        meditation: { name: "Meditación", type: "checkbox" },
        water: { name: "Agua", type: "checkbox" },
      },
      views: [{ type: "table", name: "Semana" }],
      rows: [
        { title: "Lunes", date: "@today-2", exercise: true, reading: true, meditation: false, water: true },
        { title: "Martes", date: "@today-1", exercise: false, reading: true, meditation: true, water: true },
        { title: "Miércoles", date: "@today", exercise: true, reading: false, meditation: false, water: false },
      ],
      templates: [{ title: "Día", icon: "🌱", default: true, values: { date: "@today" } }],
    },
  },
  {
    id: "reading",
    name: "Lista de lectura",
    category: "Personal",
    description: "Libros, artículos y pódcasts por leer, en curso y terminados, con tu calificación.",
    icon: "📚",
    database: {
      props: {
        title: { name: "Título", type: "title" },
        author: { name: "Autor", type: "text" },
        status: {
          name: "Estado",
          type: "select",
          options: [
            ["Por leer", "gray"],
            ["Leyendo", "blue"],
            ["Leído", "green"],
          ],
        },
        kind: {
          name: "Tipo",
          type: "select",
          options: [
            ["Libro", "brown"],
            ["Artículo", "purple"],
            ["Pódcast", "pink"],
          ],
        },
        rating: {
          name: "Calificación",
          type: "select",
          options: [
            ["⭐️⭐️⭐️⭐️⭐️", "yellow"],
            ["⭐️⭐️⭐️⭐️", "yellow"],
            ["⭐️⭐️⭐️", "yellow"],
          ],
        },
      },
      views: [
        { type: "board", name: "Por estado", by: "status" },
        { type: "gallery", name: "Galería" },
        { type: "table", name: "Tabla" },
      ],
      rows: [
        { title: "Cien años de soledad", author: "Gabriel García Márquez", status: "Leído", kind: "Libro", rating: "⭐️⭐️⭐️⭐️⭐️" },
        { title: "Hábitos atómicos", author: "James Clear", status: "Leyendo", kind: "Libro" },
        { title: "Cómo tomar notas", author: "", status: "Por leer", kind: "Artículo" },
      ],
    },
  },
  {
    id: "weekly",
    name: "Planificador semanal",
    category: "Personal",
    description: "Una página con las prioridades de la semana y una lista de pendientes para cada día.",
    icon: "🗒️",
    blocks: [
      callout("🎯", "Las tres cosas más importantes de esta semana."),
      todo(""),
      todo(""),
      todo(""),
      divider,
      ...["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"].flatMap((d) => [h(3, d), todo("")]),
      h(3, "Fin de semana"),
      todo(""),
      empty,
    ],
  },
  {
    id: "class-notes",
    name: "Apuntes de clase",
    category: "Estudios",
    description: "Apuntes por materia y fecha, con una plantilla para cada clase y sus tareas pendientes.",
    icon: "🎓",
    database: {
      props: {
        title: { name: "Tema", type: "title" },
        subject: {
          name: "Materia",
          type: "select",
          options: [
            ["Matemáticas", "blue"],
            ["Historia", "brown"],
            ["Biología", "green"],
          ],
        },
        date: { name: "Fecha", type: "date" },
        kind: {
          name: "Tipo",
          type: "select",
          options: [
            ["Clase", "gray"],
            ["Lectura", "purple"],
            ["Examen", "red"],
          ],
        },
      },
      views: [
        { type: "board", name: "Por materia", by: "subject" },
        { type: "table", name: "Todos los apuntes" },
      ],
      rows: [
        { title: "Derivadas", subject: "Matemáticas", date: "@today-1", kind: "Clase" },
        { title: "La Revolución francesa", subject: "Historia", date: "@today", kind: "Lectura" },
        { title: "Parcial de células", subject: "Biología", date: "@today+6", kind: "Examen" },
      ],
      templates: [
        {
          title: "Clase",
          icon: "🎓",
          default: true,
          values: { date: "@today", kind: "Clase" },
          blocks: [h(2, "Ideas clave"), li(""), h(2, "Preguntas"), p(""), h(2, "Tareas"), todo("")],
        },
      ],
    },
  },
];

// ------------------------------------------------------------------- build

/** "Usar plantilla": the template as a new page or database under `parent`; resolves to its id. */
export async function applyGalleryTemplate(t: GalleryTemplate, parent: [ParentTable, string]): Promise<string> {
  const at = Date.now();
  if (!t.database)
    return createPage(parent[0], parent[1], {
      properties: { title: t.name },
      format: { icon: t.icon },
      content: resolveContent(toContent(t.blocks ?? []), at),
    });
  const d = t.database;
  const blockId = uuid();
  const collectionId = uuid();
  const ids: Record<string, string> = { title: "title" };
  const schema: Record<string, PropertySchema> = {};
  for (const [key, prop] of Object.entries(d.props)) {
    const id = key === "title" ? "title" : shortId();
    ids[key] = id;
    const s: PropertySchema = { name: prop.name, type: prop.type };
    if (prop.options) s.options = prop.options.map(([value, color]) => ({ id: shortId(), value, color }));
    // A status sorts its options into the three groups.
    if (prop.type === "status" && s.options)
      s.groups = ["Por hacer", "En curso", "Completado"].map((name, i) => ({
        id: shortId(),
        name,
        color: s.options![i]?.color ?? "gray",
        option_ids: s.options![i] ? [s.options![i].id] : [],
      }));
    schema[id] = s;
  }
  const value = (key: string, v: PropertyValue): PropertyValue => {
    const s = schema[ids[key]];
    if (!s) return v;
    const option = (name: string) => s.options?.find((o) => o.value === name)?.id ?? name;
    if ((s.type === "select" || s.type === "status") && typeof v === "string") return option(v);
    if (s.type === "multi_select" && Array.isArray(v)) return (v as string[]).map(option);
    return v;
  };
  // Rows' dates land around today; templates keep theirs dynamic.
  const values = (vals: GalleryValues, dynamic: boolean) =>
    Object.fromEntries(
      Object.entries(vals)
        .filter(([key]) => ids[key])
        .map(([key, v]) => {
          const resolved = !dynamic && typeof v === "string" && schema[ids[key]]?.type === "date" ? resolveDynamicDate(v, at) : v;
          return [ids[key], value(key, resolved)];
        }),
    );
  const order = Object.keys(d.props).map((key) => ({ property: ids[key], visible: true }));
  const views: CollectionView[] = d.views.map((v) => ({
    id: uuid(),
    type: v.type,
    name: v.name,
    parent_id: blockId,
    collection_id: collectionId,
    format: {
      properties: order.map((o) => ({ ...o })),
      ...(v.type === "board" && v.by ? { board_group_by: ids[v.by] } : {}),
      ...(v.type === "calendar" && v.by ? { calendar_by: ids[v.by] } : {}),
      ...(v.type === "timeline" && v.by ? { timeline_by: ids[v.by] } : {}),
      ...(v.type === "gallery" ? { gallery_cover: { type: "page_content" as const } } : {}),
    },
    query2: emptyQuery(),
  }));
  const page = (props: Record<string, PropertyValue>, i: number, extra: Partial<Block> = {}): Block => ({
    id: uuid(),
    type: "page",
    parent_id: collectionId,
    parent_table: "collection",
    properties: props,
    format: {},
    content: null,
    alive: true,
    order: at + i,
    created_time: at,
    last_edited_time: at,
    ...extra,
  });
  const rows = d.rows.map((r, i) => page(values(r, false), i));
  const templates = (d.templates ?? []).map((tp, i) =>
    page({ ...values(tp.values ?? {}, true), title: tp.title }, i, {
      is_template: true,
      format: tp.icon ? { icon: tp.icon } : {},
      content: tp.blocks ? toContent(tp.blocks) : null,
    }),
  );
  const defaultTemplate = d.templates?.findIndex((tp) => tp.default) ?? -1;
  const collection: Collection = {
    id: collectionId,
    parent_id: blockId,
    schema,
    template_ids: templates.map((tp) => tp.id),
    default_template: defaultTemplate >= 0 ? templates[defaultTemplate].id : undefined,
  };
  await db.transaction("rw", db.blocks, db.collections, db.views, async () => {
    await db.collections.add(collection);
    await db.views.bulkAdd(views);
    await db.blocks.bulkAdd([...rows, ...templates]);
    await db.blocks.add({
      id: blockId,
      type: "collection_view_page",
      parent_id: parent[1],
      parent_table: parent[0],
      properties: { title: t.name },
      format: { icon: t.icon },
      content: null,
      collection_id: collectionId,
      view_ids: views.map((v) => v.id),
      alive: true,
      order: at,
      created_time: at,
      last_edited_time: at,
    });
  });
  return blockId;
}
