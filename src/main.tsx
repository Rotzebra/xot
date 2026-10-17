import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { CommandSearch } from "./components/CommandSearch";
import { runInBackground } from "./lib/automations";
import "./styles.css";

// The macOS app (Electron) draws its own title bar.
if (navigator.userAgent.includes("Electron")) document.documentElement.dataset.desktop = "";
// Room the traffic lights need on the left of the title bar (it depends on the macOS version).
const inset = new URLSearchParams(location.search).get("inset");
if (inset) document.documentElement.style.setProperty("--traffic-inset", `${parseFloat(inset)}px`);

// Xot.app's hidden window for recurring automations (every window closed): no page, just the run.
if (new URLSearchParams(location.search).has("automations")) void runInBackground();
// Xot.app's floating Atajo de búsqueda: Buscar alone, on a transparent window.
else if (new URLSearchParams(location.search).has("search")) {
  document.documentElement.dataset.commandSearch = "";
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <CommandSearch />
    </StrictMode>,
  );
} else
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
