// The page's bridge to the macOS app: only what the native chrome needs to follow it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xotDesktop", {
  setTheme: (mode) => ipcRenderer.send("xot:theme", mode),
  // Exportar > PDF: the page's export HTML, printed to a PDF file by the app
  // (options: { pageSize: "A4" | "Letter" | "Legal" | "A3" | "Tabloid", scale: 0.1-2 }).
  printToPDF: (html, options) => ipcRenderer.invoke("xot:print-to-pdf", html, options),
  // Files and folders opened with Xot (Finder, the Dock) for the page to import: { name, data }
  // for a file (its bytes), { name, files: [{ path, data }] } for a folder.
  onOpenFile: (callback) => {
    ipcRenderer.on("xot:open-file", (_event, file) => callback(file));
    ipcRenderer.send("xot:open-file-ready");
  },
  // Reminders: the page sends every one it finds; the app notifies when they're due,
  // with or without a window open, and the window shows its toast.
  setReminders: (list) => ipcRenderer.send("xot:reminders", list),
  onReminder: (callback) => {
    ipcRenderer.on("xot:reminder", (_event, reminder) => callback(reminder));
  },
  // The ones already fired (also at launch, before any window): the page's Bandeja de entrada keeps them.
  firedReminders: () => ipcRenderer.invoke("xot:fired-reminders"),
  // Recurring automations: when the next one is due, so the app runs it with every window closed
  // (`done`: the hidden window that ran them finished).
  setNextAutomation: (at, done = false) => ipcRenderer.send("xot:next-automation", at, done),
  // "Marcador web": { title, description, image, icon } of a link, or null.
  linkPreview: (url) => ipcRenderer.invoke("xot:link-preview", url),
  // A notification from a button or an automation, shown by the app: clicking it opens the page.
  notify: (n) => ipcRenderer.send("xot:notify", n),
  // Preferencias > App de escritorio, kept by the app: { commandSearch, searchShortcut, menuBarIcon,
  // openAtLogin, shortcutActive }. setPrefs resolves with them (and `error` when a shortcut can't be used).
  getPrefs: () => ipcRenderer.invoke("xot:prefs"),
  setPrefs: (patch) => ipcRenderer.invoke("xot:prefs", patch),
  onPrefs: (callback) => {
    const listener = (_event, prefs) => callback(prefs);
    ipcRenderer.on("xot:prefs", listener);
    return () => ipcRenderer.removeListener("xot:prefs", listener);
  },
  // The floating Atajo de búsqueda: shown again (start over), hide it, open a picked page in a window.
  onSearchShown: (callback) => ipcRenderer.on("xot:search-shown", () => callback()),
  hideSearch: () => ipcRenderer.send("xot:search-hide"),
  openRoute: (route, newTab = false) => ipcRenderer.send("xot:open-route", route, newTab),
  // The Dock's badge: Bandeja de entrada's unread count.
  setBadge: (count) => ipcRenderer.send("xot:badge", count),
  // A tab moved to a new window ({ route, back, forward, pinned, pinnedRoute }), at a screen point or not.
  moveTabToWindow: (tab, at) => ipcRenderer.send("xot:tab-window", tab, at),
  // Preferencias > Zona horaria: an IANA zone the pages run in, or "" for macOS's.
  setTimeZone: (tz) => ipcRenderer.send("xot:timezone", tz),
  // A picture of the page under the tab bar (a data URL), for the tab's preview.
  capturePage: () => ipcRenderer.invoke("xot:capture-page"),
});
