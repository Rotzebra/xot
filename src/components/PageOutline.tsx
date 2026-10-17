import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { headingsOf, type Heading, type XotEditor } from "./Editor";

const readHeadings = (editor: XotEditor) => headingsOf(editor.document as unknown as Parameters<typeof headingsOf>[0]);

const headingEl = (id: string) => document.querySelector<HTMLElement>(`.bn-block[data-id="${CSS.escape(id)}"]`);

/**
 * The floating "Índice": a rail of short lines on the right edge of the
 * page, one per heading, with the current one highlighted. Hovering it lists
 * the headings; a click scrolls to one. Rendered as the scroller's first child.
 */
export function PageOutline({ editor }: { editor: XotEditor }) {
  const ref = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<Heading[]>(() => readHeadings(editor));
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<{ top: number; room: boolean }>({ top: 0, room: true });

  useEffect(() => {
    // Typing changes the document on every key; keep the list while its headings stay the same.
    const sync = () =>
      setHeadings((cur) => {
        const next = readHeadings(editor);
        return JSON.stringify(next) === JSON.stringify(cur) ? cur : next;
      });
    sync();
    return editor.onChange(sync);
  }, [editor]);

  // The rail starts 18px below the title's top, and hides when the column leaves no room beside it.
  useLayoutEffect(() => {
    const scroller = ref.current?.parentElement;
    if (!scroller) return;
    const measure = () => {
      const title = scroller.querySelector<HTMLElement>(".page-header__title");
      if (!title) return;
      const s = scroller.getBoundingClientRect();
      const t = title.getBoundingClientRect();
      // The rail's own 8px top padding comes off.
      const top = Math.round(t.top - s.top + scroller.scrollTop + 18 - 8);
      const room = s.right - t.right >= 40;
      setLayout((cur) => (cur.top === top && cur.room === room ? cur : { top, room }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    const page = scroller.querySelector(".page");
    if (page) ro.observe(page);
    return () => ro.disconnect();
  }, [headings.length]);

  // The current heading: the last one above the top third of the view.
  useEffect(() => {
    const scroller = ref.current?.parentElement;
    if (!scroller || headings.length < 2) return;
    const update = () => {
      const limit = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let current = 0;
      headings.forEach((h, i) => {
        const el = headingEl(h.id);
        if (el && el.getBoundingClientRect().top <= limit) current = i;
      });
      setActive(current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [headings]);

  if (headings.length < 2) return null;

  const go = (id: string) => {
    headingEl(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setOpen(false);
  };

  return (
    <div ref={ref} className="page-outline" hidden={!layout.room}>
      <div
        className="page-outline__hover"
        style={{ top: layout.top }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {open ? (
          <nav className="page-outline__panel" aria-label="Índice">
            {headings.map((h, i) => (
              <button
                key={h.id}
                type="button"
                className={`page-outline__item${i === active ? " is-active" : ""}`}
                style={{ paddingLeft: 8 + (Math.min(h.level, 4) - 1) * 12 }}
                onClick={() => go(h.id)}
              >
                {h.text || "Sin título"}
              </button>
            ))}
          </nav>
        ) : (
          <div className="page-outline__rail" aria-hidden>
            {headings.map((h, i) => (
              <span
                key={h.id}
                className={`page-outline__line${h.level >= 3 ? " page-outline__line--3" : ""}${
                  i === active ? " is-active" : ""
                }`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
