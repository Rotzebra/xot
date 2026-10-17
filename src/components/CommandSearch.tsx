import { useEffect, useState } from "react";
import { OPEN_TAB_EVENT } from "../lib/hooks";
import { desktop } from "../lib/desktop";
import { QuickFind } from "./QuickFind";
import { installTooltips } from "./ui";

/**
 * Command Search: Buscar alone, in the app's floating window ("?search=1",
 * electron/main.cjs). A page picked here opens in the last Xot window used (⌘↵: in a new tab
 * there); Escape or a click elsewhere hides the window, and each time it shows it starts over.
 */
export function CommandSearch() {
  const [round, setRound] = useState(0);
  useEffect(() => {
    installTooltips();
    const app = desktop();
    app?.onSearchShown?.(() => setRound((r) => r + 1));
    // QuickFind navigates this window: the route goes to the app instead, and this one stays blank.
    const onHash = () => {
      const route = window.location.hash;
      if (!route || route === "#") return;
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      app?.openRoute?.(route);
    };
    const onTab = (e: Event) => app?.openRoute?.(`#/${(e as CustomEvent<string>).detail}`, true);
    window.addEventListener("hashchange", onHash);
    window.addEventListener(OPEN_TAB_EVENT, onTab);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(OPEN_TAB_EVENT, onTab);
    };
  }, []);
  return <QuickFind key={round} onClose={() => desktop()?.hideSearch?.()} />;
}
