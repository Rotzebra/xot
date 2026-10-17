// Mermaid diagrams for code blocks set to "Mermaid". The library is large, so it
// loads on first use (its own chunk) and everything stays on this device.

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
const load = () => (loading ??= import("mermaid").then((m) => m.default));

/** Renders run one at a time: mermaid keeps global state while it lays out a diagram. */
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

export type MermaidResult = { svg: string } | { error: string };

/** Renders Mermaid source to an SVG string, or the parse error to show instead. */
export function renderMermaid(source: string, dark: boolean): Promise<MermaidResult> {
  const run = async (): Promise<MermaidResult> => {
    const mermaid = await load();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      fontFamily: getComputedStyle(document.body).fontFamily,
    });
    const id = `xot-mermaid-${++seq}`;
    try {
      await mermaid.parse(source);
      const { svg } = await mermaid.render(id, source);
      return { svg };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    } finally {
      // A failed render can leave its scratch element behind in the body.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
