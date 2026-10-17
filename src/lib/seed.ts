import { db } from "./db";
import { addRow, createDatabase, createPage, uuid } from "./ops";
import { WORKSPACE_ID } from "./model";

let seeding: Promise<void> | null = null;

/** First run: a welcome page and a sample task database. */
export function seedIfEmpty() {
  // One transaction so live queries see the finished workspace, not a half-seeded one.
  seeding ??= db.transaction("rw", db.blocks, db.collections, db.views, async () => {
    if ((await db.blocks.count()) > 0) return;

    const tasks = await createDatabase("space", WORKSPACE_ID, { title: "Tareas", icon: "✅" });
    const collection = await db.collections.get(tasks.collectionId);
    const [todo, doing, done] = collection!.schema[tasks.statusId].options!;
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    const rows: [string, string, number][] = [
      ["Diseñar la portada", done.id, -3],
      ["Escribir la documentación", doing.id, 1],
      ["Revisar las métricas de la semana", doing.id, 2],
      ["Preparar la demo", todo.id, 5],
      ["Planificar el próximo sprint", todo.id, 8],
    ];
    let order = Date.now();
    for (const [title, status, offset] of rows)
      await addRow(
        tasks.collectionId,
        { title, [tasks.statusId]: status, [tasks.dateId]: day(offset) },
        order++,
      );

    const welcomeId = uuid();
    await createPage("space", WORKSPACE_ID, {
      id: welcomeId,
      order: 0,
      properties: { title: "Primeros pasos" },
      format: { icon: "👋" },
      content: [
        {
          type: "paragraph",
          content: "Bienvenido a Xot: tus páginas y bases de datos, guardadas en tu equipo.",
        },
        { type: "heading", props: { level: 2 }, content: "Lo básico" },
        { type: "checkListItem", props: { checked: true }, content: "Abre Xot" },
        {
          type: "checkListItem",
          props: { checked: false },
          content: [
            { type: "text", text: "Escribe ", styles: {} },
            { type: "text", text: "/", styles: { code: true } },
            { type: "text", text: " para insertar títulos, listas, tablas, imágenes o subpáginas", styles: {} },
          ],
        },
        {
          type: "checkListItem",
          props: { checked: false },
          content: "Arrastra el asa ⋮⋮ a la izquierda de un bloque para moverlo",
        },
        {
          type: "checkListItem",
          props: { checked: false },
          content: "Selecciona texto para darle formato",
        },
        { type: "heading", props: { level: 2 }, content: "Bases de datos" },
        {
          type: "paragraph",
          content:
            "Cada fila es una página. Cambia entre la vista de tabla y la de tablero, filtra, ordena y arrastra tarjetas entre columnas.",
        },
        { type: "pageLink", props: { pageId: tasks.blockId } },
        { type: "paragraph", content: "" },
      ],
    });
  });
  return seeding;
}
