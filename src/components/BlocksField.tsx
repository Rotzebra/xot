import { useEffect, useRef } from "react";
import { filterSuggestionItems } from "@blocknote/core";
import { getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { CalendarDays, Clock, FileText } from "lucide-react";
import { useColorScheme } from "../lib/hooks";
import { resolveFileUrl, storeFile } from "../lib/files";
import { dictionary, schema } from "./Editor";

// "Insertar bloques" (button actions): the blocks are written in a small editor of
// their own, instead of as Markdown. "@" offers the dynamic values
// (@hoy, @ahora, @mañana, @ayer, @página) that become mentions when the button runs.

const AT_ITEMS = [
  { word: "hoy", title: "Hoy", subtext: "La fecha del clic", icon: CalendarDays },
  { word: "ahora", title: "Ahora", subtext: "La fecha y hora del clic", icon: Clock },
  { word: "mañana", title: "Mañana", subtext: "El día después del clic", icon: CalendarDays },
  { word: "ayer", title: "Ayer", subtext: "El día antes del clic", icon: CalendarDays },
  { word: "página", title: "Página del botón", subtext: "Una mención de la página", icon: FileText },
];

/** One empty paragraph: nothing to insert. */
const isEmpty = (doc: { type: string; content?: unknown; children?: unknown[] }[]) =>
  doc.every((b) => b.type === "paragraph" && (!Array.isArray(b.content) || !b.content.length) && !b.children?.length);

export default function BlocksField({
  blocks,
  markdown,
  onChange,
}: {
  blocks?: unknown[];
  /** Older buttons: their Markdown, turned into blocks the first time. */
  markdown: string;
  onChange: (blocks: unknown[], markdown: string) => void;
}) {
  const theme = useColorScheme();
  const editor = useCreateBlockNote({
    schema,
    dictionary: { ...dictionary, placeholders: { ...dictionary.placeholders, default: "Escribe o pulsa «/» para ver los bloques" } },
    uploadFile: storeFile,
    resolveFileUrl,
    initialContent: blocks?.length ? (blocks as never) : undefined,
  });
  const changed = useRef(onChange);
  changed.current = onChange;
  const timer = useRef<number | undefined>(undefined);
  const save = useRef(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const doc = editor.document;
    changed.current(isEmpty(doc) ? [] : (doc as unknown[]), isEmpty(doc) ? "" : editor.blocksToMarkdownLossy(doc));
  }).current;

  useEffect(() => {
    if (blocks?.length || !markdown.trim()) return;
    const parsed = editor.tryParseMarkdownToBlocks(markdown);
    if (parsed.length) queueMicrotask(() => editor.replaceBlocks(editor.document, parsed));
    // Once, when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  // Closing the settings saves what was typed last.
  useEffect(() => () => void (timer.current !== undefined && save()), [save]);

  return (
    <div className="blocks-field" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && timer.current !== undefined && save()}>
      <BlockNoteView
        editor={editor}
        theme={theme}
        slashMenu={false}
        onChange={() => {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(save, 400);
        }}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) => filterSuggestionItems(getDefaultReactSlashMenuItems(editor), query)}
        />
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={async (query) =>
            filterSuggestionItems(
              AT_ITEMS.map(({ word, title, subtext, icon: Icon }) => ({
                title,
                subtext,
                aliases: [word],
                group: "Valores al hacer clic",
                icon: <Icon size={18} />,
                onItemClick: () => editor.insertInlineContent([`@${word} `] as never),
              })),
              query,
            )
          }
        />
      </BlockNoteView>
    </div>
  );
}
