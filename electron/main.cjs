// Xot for macOS: the Vite build served from a private app:// origin, so
// IndexedDB persists between launches and fetch("/import.json") works.
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
  Tray,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DIST = path.join(__dirname, "..", "dist");
// The origin keeps the pre-rename id: IndexedDB data is stored per origin.
const ORIGIN = "app://xotion";

// Traffic light position: the lights are centred on the 36px
// tab bar, and macOS 26 made them bigger and further apart.
const MACOS = process.platform === "darwin" ? parseInt(process.getSystemVersion(), 10) : 0;
const LIGHT = MACOS >= 26 ? 14 : 12;
const TAB_BAR = 36;
const TRAFFIC = { x: LIGHT, y: Math.round((TAB_BAR - LIGHT) / 2) };
const TRAFFIC_INSET = 3 * LIGHT + 2 * (MACOS >= 26 ? 9 : 8) + 1.5 * LIGHT;

// Links the OS can open (the browser, Mail, the phone); file: and the rest stay blocked.
const EXTERNAL = /^(https?|mailto|tel):/i;
// Xot's own URL scheme (package.json build.protocols): xot://<page id>.
const SCHEME = "xot";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serve() {
  protocol.handle("app", async (request) => {
    const { pathname } = new URL(request.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname === "/" ? "/index.html" : pathname)));
    if (!file.startsWith(DIST)) return new Response("Not found", { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
    if (!res?.ok) return new Response("Not found", { status: 404 });
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return new Response(res.body, { headers: { "content-type": type } });
  });
}

// The last window's size, position and zoom state, and the app's light/dark choice, restored on launch.
const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }));
  } catch {
    /* not worth failing over */
  }
}

function savedBounds() {
  try {
    const state = readState();
    if (!state.width || !state.height) return null;
    const area = screen.getDisplayMatching(state).workArea;
    const fits =
      state.width <= area.width &&
      state.height <= area.height &&
      state.x >= area.x &&
      state.y >= area.y &&
      state.x + state.width <= area.x + area.width &&
      state.y + state.height <= area.y + area.height;
    // Off screen (a display was unplugged): keep the size, let macOS place it.
    if (fits) return state;
    return {
      width: Math.min(state.width, area.width),
      height: Math.min(state.height, area.height),
      maximized: state.maximized,
      fullscreen: state.fullscreen,
    };
  } catch {
    return null;
  }
}

// The Xot window used last: its size and place are the ones saved for the next launch.
let lastFocused = null;

/**
 * Xot's windows, without the hidden one that runs recurring automations (automationWin)
 * and the floating Atajo de búsqueda (searchWin).
 */
const appWindows = () => BrowserWindow.getAllWindows().filter((w) => w !== automationWin && w !== searchWin);

/**
 * A new window, on `hash` (a page route like "#/<id>") or on the last page (and its tabs, at launch).
 * `options.tab`: a tab moved out of another window (its route and history), `options.at`: where
 * the window's top left corner goes (a tab dropped outside its window).
 */
function createWindow(hash = "", options = {}) {
  const saved = appWindows().length === 0 ? savedBounds() : null;
  // An extra window copies the
  // focused one's size, 20px down and to the right.
  const ref = !saved && lastFocused && !lastFocused.isDestroyed() ? lastFocused : null;
  const from = ref && (({ x, y, width, height }) => ({ x: x + 20, y: y + 20, width, height }))(ref.getNormalBounds());
  const at = options.at && Number.isFinite(options.at.x) && Number.isFinite(options.at.y) ? { x: Math.round(options.at.x), y: Math.round(options.at.y) } : null;
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    ...(saved && { x: saved.x, y: saved.y, width: saved.width, height: saved.height }),
    ...from,
    ...at,
    minWidth: 640,
    minHeight: 480,
    title: "Xot",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: TRAFFIC,
    backgroundColor: background(),
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      // The PDF block shows files in Chromium's viewer.
      plugins: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  win.once("ready-to-show", () => {
    if (saved?.maximized) win.maximize();
    if (saved?.fullscreen) win.setFullScreen(true);
    win.show();
  });
  win.on("focus", () => (lastFocused = win));
  win.on("close", () => {
    if (lastFocused !== win) return;
    saveState({ ...win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
  });
  win.on("closed", () => lastFocused === win && (lastFocused = null));

  // Crash and freeze watchdogs: a crashed page reloads, a hung one offers to.
  let restarting = false;
  win.webContents.on("render-process-gone", (_event, details) => {
    if (restarting) return void (restarting = false);
    if (details.reason !== "clean-exit" && details.reason !== "killed") win.webContents.reload();
  });
  win.on("unresponsive", async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Esperar", "Recargar"],
      defaultId: 1,
      message: "Xot no responde",
      detail: "Puedes esperar a que la página termine o recargarla.",
    });
    if (response !== 1 || win.isDestroyed()) return;
    restarting = true;
    win.webContents.forcefullyCrashRenderer();
    win.webContents.reload();
  });

  // Fullscreen hides the traffic lights: the tab bar drops their gap.
  const setFull = (on) =>
    void win.webContents.executeJavaScript(`document.documentElement.toggleAttribute("data-fullscreen", ${on})`);
  win.on("enter-full-screen", () => setFull(true));
  win.on("leave-full-screen", () => setFull(false));
  win.webContents.on("did-finish-load", () => {
    setFull(win.isFullScreen());
    // The zoom factor is restored on launch.
    const saved = readState().zoom;
    if (typeof saved === "number" && saved >= ZOOM_MIN && saved <= ZOOM_MAX) win.webContents.setZoomFactor(saved);
    placeLights(win);
  });
  // ⌘ + scroll wheel zooms in steps, like the View menu.
  win.webContents.on("zoom-changed", (_event, direction) => zoom(win, direction === "in" ? 1 : -1));

  // Links to the outside world (URLs, mail) go to the OS; a link to one of
  // Xot's own pages (⌘⇧-click) opens it in a new window; a file of the page
  // ("Ver original", a file's download button) opens in a plain viewer window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const { pathname } = URL.canParse(url) ? new URL(url) : { pathname: "" };
    if (url.startsWith(`${ORIGIN}/`) && (pathname === "/" || pathname === "/index.html")) createWindow(new URL(url).hash);
    else if (url.startsWith(`${ORIGIN}/`) || url.startsWith(`blob:${ORIGIN}/`))
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1000,
          height: 760,
          title: "Xot",
          backgroundColor: background(),
          autoHideMenuBar: true,
          // Chromium's PDF viewer is a plugin.
          webPreferences: { sandbox: true, contextIsolation: true, plugins: true },
        },
      };
    else if (url.startsWith(`${SCHEME}:`)) openPage(url);
    else if (EXTERNAL.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(ORIGIN)) {
      event.preventDefault();
      if (EXTERNAL.test(url)) void shell.openExternal(url);
    }
  });

  // Right click: spelling suggestions, links, images and the clipboard.
  win.webContents.on("context-menu", (_event, p) => {
    const items = [];
    for (const word of p.dictionarySuggestions) items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) });
    if (p.misspelledWord)
      items.push(
        {
          label: "Añadir al diccionario",
          click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord),
        },
        { type: "separator" },
      );
    if (p.linkURL && EXTERNAL.test(p.linkURL))
      items.push(
        { label: "Abrir enlace", click: () => void shell.openExternal(p.linkURL) },
        { label: "Copiar enlace", click: () => clipboard.writeText(p.linkURL) },
        { type: "separator" },
      );
    if (p.mediaType === "image")
      items.push({ label: "Copiar imagen", click: () => win.webContents.copyImageAt(p.x, p.y) }, { type: "separator" });
    items.push(
      { role: "cut", label: "Cortar", enabled: p.editFlags.canCut, visible: p.isEditable },
      { role: "copy", label: "Copiar", enabled: p.editFlags.canCopy },
      { role: "paste", label: "Pegar", enabled: p.editFlags.canPaste, visible: p.isEditable },
      { role: "selectAll", label: "Seleccionar todo" },
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Trackpad swipes move through the history, like the title bar arrows.
  win.on("swipe", (_event, direction) => {
    if (direction === "left") goBack(win);
    else if (direction === "right") goForward(win);
  });

  // The launch window reopens the last session's tabs (App.tsx keeps them),
  // unless the app quit with "Salir sin guardar las pestañas".
  const restore = saved && !hash && !options.tab && !readState().discardTabs;
  if (saved && readState().discardTabs) saveState({ discardTabs: false });
  // A tab moved here (Mover la pestaña a una nueva ventana): the page starts with it, history included.
  const tab = options.tab ? `&tab=${encodeURIComponent(JSON.stringify(options.tab))}` : "";
  const route = options.tab ? `#${options.tab.route}` : hash;
  void win.loadURL(`${ORIGIN}/index.html?inset=${TRAFFIC_INSET}${restore ? "&restore=1" : ""}${tab}${route}`);
  return win;
}

/** The page route in a xot:// link ("xot://<id>", or "xot://<id>?b=<block>"), or "" for anything else. */
const routeOf = (url) => {
  const rest = url.replace(new RegExp(`^${SCHEME}:/*`, "i"), "").replace(/\/+(?=\?|$)/, "");
  return /^[\w-]+(\?[\w=&-]*)?$/.test(rest) ? `#/${rest}` : "";
};

/** Opens a xot:// link in the frontmost window (or a new one). */
function openPage(url) {
  openRoute(routeOf(url));
}

/**
 * Shows a page route ("#/<id>") in the frontmost window, or in a new one; `newTab`: in a new tab
 * of that window. A pinned tab keeps its page: the route opens in a new tab.
 */
function openRoute(route, newTab = false) {
  const focused = BrowserWindow.getFocusedWindow();
  const win = (focused && appWindows().includes(focused) ? focused : null) ?? lastFocused ?? appWindows()[0];
  if (!win || win.isDestroyed()) return void createWindow(route);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!route) return;
  void tab(win, "open", { route: route.replace(/^#/, ""), newTab }).then(
    (done) => !done && !win.isDestroyed() && void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}`),
  );
}

/** The window background behind the page, so a resize or reload never flashes the other theme. */
const background = () => (nativeTheme.shouldUseDarkColors ? "#191919" : "#ffffff");

/**
 * Keeps the traffic lights centred on the tab bar at every zoom
 * level, and never lets the bar's start padding get narrower than the lights.
 */
function placeLights(win) {
  if (process.platform !== "darwin" || win.isDestroyed()) return;
  const z = win.webContents.getZoomFactor();
  win.setWindowButtonPosition({
    x: Math.round(z >= 1 ? LIGHT * z : LIGHT),
    y: Math.max(0, Math.round((Math.ceil(TAB_BAR * z) - LIGHT) / 2)),
  });
  const inset = z < 1 ? TRAFFIC_INSET / z : TRAFFIC_INSET;
  void win.webContents.executeJavaScript(
    `document.documentElement.style.setProperty("--traffic-inset", "${inset}px")`,
  );
}

// Zoom: ±10% per step (ELECTRON_ZOOM_INCREMENT), between 50% and 490%.
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4.9;

/** Zoom in or out by one step (0 resets), then move the traffic lights with the bar. */
function zoom(win, step) {
  if (!win) return;
  const wc = win.webContents;
  const next = step ? wc.getZoomFactor() + Math.sign(step) * ZOOM_STEP : 1;
  const factor = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 10) / 10));
  wc.setZoomFactor(factor);
  saveState({ zoom: factor });
  // Chromium keeps the zoom per origin: every window changed with this one.
  BrowserWindow.getAllWindows().forEach(placeLights);
}

/**
 * Tab commands: the page keeps its tabs (App.tsx, window.xotTab). Resolves
 * false when the page didn't handle it (a file viewer window, or a last tab).
 */
function tab(win, action, arg = null) {
  if (!win) return Promise.resolve(false);
  return win.webContents
    .executeJavaScript(`window.xotTab?.(${JSON.stringify(action)}, ${JSON.stringify(arg)}) ?? false`)
    .catch(() => false);
}

/** Cerrar pestaña (⌘W): the window's last tab closes the window. */
function closeTab(win) {
  void tab(win, "close").then((closed) => !closed && win && !win.isDestroyed() && win.close());
}

/** Menu items for shortcuts the page implements: it handles the key itself first, the menu only on click. */
function sendKey(win, key, shift = false) {
  void win?.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, metaKey: true, shiftKey: ${shift} }))`,
  );
}

/**
 * Deshacer/Rehacer run the app's own undo: in a text field the
 * text's history, anywhere else the page's (trash, move), which App.tsx keeps on ⌘Z.
 */
function undo(win, redo) {
  if (!win) return;
  void win.webContents
    .executeJavaScript(
      '!!document.activeElement?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")',
    )
    .then((editing) => {
      if (!editing) sendKey(win, "z", redo);
      else if (redo) win.webContents.redo();
      else win.webContents.undo();
    });
}

/** Atrás / Adelante walk the active tab's own history (App.tsx); a window without tabs uses its own. */
function goBack(win) {
  void tab(win, "back").then((done) => {
    const history = !done && win && !win.isDestroyed() ? win.webContents.navigationHistory : null;
    if (history?.canGoBack()) history.goBack();
  });
}

function goForward(win) {
  void tab(win, "forward").then((done) => {
    const history = !done && win && !win.isDestroyed() ? win.webContents.navigationHistory : null;
    if (history?.canGoForward()) history.goForward();
  });
}

app.setName("Xot");

// The app used to be called Xotion: move its data folder once so nothing is lost.
const legacyData = path.join(app.getPath("appData"), "Xotion");
const userData = path.join(app.getPath("appData"), "Xot");
if (fs.existsSync(legacyData) && !fs.existsSync(userData)) fs.renameSync(legacyData, userData);
app.setPath("userData", userData);

// One Xot at a time: a second process can't take IndexedDB's
// lock on the same data folder, so a second launch focuses the running one.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on("second-instance", (_event, argv) => {
  const link = argv.find((arg) => arg.startsWith(`${SCHEME}:`));
  if (link) return openPage(link);
  const win = appWindows()[0];
  if (!win) return void createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
});

// xot:// links (Copiar enlace in the app) open the page here.
// Only Xot.app claims the scheme: `npm run app:dev` must not take its links away.
// A link that arrives before the window exists is opened by the first window.
let launchRoute = "";
if (app.isPackaged) app.setAsDefaultProtocolClient(SCHEME);
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady() && appWindows().length) openPage(url);
  else launchRoute = routeOf(url);
});

// Files opened with Xot (Finder, the Dock) become pages or databases
// (open-file): the page imports them where Importar would (App.tsx). Files that
// arrive before a page is listening wait for the first one that is.
const pendingFiles = [];
const fileTargets = new Set();
function sendFile(file) {
  const win = [BrowserWindow.getFocusedWindow(), lastFocused, ...BrowserWindow.getAllWindows()].find(
    (w) => w && !w.isDestroyed() && fileTargets.has(w.webContents.id),
  );
  if (!win) return void pendingFiles.push(file);
  win.webContents.send("xot:open-file", file);
  if (win.isMinimized()) win.restore();
  win.focus();
}
// A file goes as its bytes (the page reads its encoding and format: text, an export's .zip,
// Word, PDF…); a folder (an unzipped export) as every file in it, by path.
const FOLDER_LIMIT = { files: 20000, bytes: 2 * 1024 ** 3 };
async function readFolder(root) {
  const base = path.dirname(root);
  const files = [];
  let bytes = 0;
  const walk = async (dir) => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || files.length >= FOLDER_LIMIT.files || bytes > FOLDER_LIMIT.bytes) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const data = await fs.promises.readFile(full);
        bytes += data.length;
        files.push({ path: path.relative(base, full).split(path.sep).join("/"), data });
      }
    }
  };
  await walk(root);
  return files;
}
async function readOpened(file) {
  const name = path.basename(file);
  const stat = await fs.promises.stat(file);
  if (stat.isDirectory()) return { name, files: await readFolder(file) };
  return { name, data: await fs.promises.readFile(file) };
}
app.on("open-file", (event, file) => {
  event.preventDefault();
  readOpened(file)
    .then(sendFile)
    .catch(() => {});
  if (app.isReady() && !appWindows().length) createWindow();
});
ipcMain.on("xot:open-file-ready", (event) => {
  fileTargets.add(event.sender.id);
  event.sender.once("destroyed", () => fileTargets.delete(event.sender.id));
  pendingFiles.splice(0).forEach(sendFile);
});

// The page's Apariencia (system, light or dark) drives the native chrome too:
// menus, the window background and the traffic lights follow it.
const THEMES = ["system", "light", "dark"];
ipcMain.on("xot:theme", (_event, mode) => {
  const next = THEMES.includes(mode) ? mode : "system";
  if (nativeTheme.themeSource === next) return;
  nativeTheme.themeSource = next;
  saveState({ theme: next });
});
nativeTheme.on("updated", () => BrowserWindow.getAllWindows().forEach((w) => w.setBackgroundColor(background())));

// Reminders (lib/reminders.ts): every window sends the workspace's reminders as it
// finds them, and the app notifies when each is due, with or without a window open.
// A reminder fires once (the ids it showed are kept), and one that came due while
// Xot was closed fires at launch, within a day. Clicking the notification opens the page.
const REMINDER_MISSED = 24 * 3600 * 1000;
const remindersFile = () => path.join(app.getPath("userData"), "reminders.json");
// list: the latest from the page; known: ids scheduled before their time; fired: ids shown.
let reminders = { list: [], known: {}, fired: {} };
let reminderTimer = null;
const reminderTargets = new Set();
// macOS drops a notification's click handler if the object is collected.
const shownNotifications = new Set();

const validReminder = (r) =>
  !!r &&
  typeof r.id === "string" &&
  r.id.length <= 600 &&
  Number.isFinite(r.at) &&
  typeof r.pageId === "string" &&
  /^[\w-]{1,80}$/.test(r.pageId) &&
  typeof r.title === "string" &&
  typeof r.body === "string";
const cleanReminder = (r) => ({ id: r.id, at: r.at, pageId: r.pageId, title: r.title.slice(0, 200), body: r.body.slice(0, 400) });
const timesById = (o) =>
  Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([, at]) => Number.isFinite(at)));

function loadReminders() {
  try {
    const saved = JSON.parse(fs.readFileSync(remindersFile(), "utf8"));
    reminders = {
      list: Array.isArray(saved.list) ? saved.list.filter(validReminder).map(cleanReminder) : [],
      known: timesById(saved.known),
      fired: timesById(saved.fired),
    };
  } catch {
    /* none yet */
  }
}

/** A native notification; clicking it opens the page (`pageId`, when there is one). */
function showNotification(title, body, pageId) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  shownNotifications.add(n);
  n.on("click", () => {
    shownNotifications.delete(n);
    openRoute(pageId ? `#/${pageId}` : "");
  });
  n.on("close", () => shownNotifications.delete(n));
  n.show();
}

function notifyReminder(r) {
  showNotification(r.title, r.body, r.pageId);
  // The window in front shows it too (an in-app toast).
  const win = [BrowserWindow.getFocusedWindow(), lastFocused, ...BrowserWindow.getAllWindows()].find(
    (w) => w && !w.isDestroyed() && reminderTargets.has(w.webContents.id),
  );
  win?.webContents.send("xot:reminder", r);
}

/** Fires what is due, remembers what is coming and waits for the next one (an hour at most). */
function runReminders() {
  clearTimeout(reminderTimer);
  const now = Date.now();
  const known = {};
  const fired = {};
  for (const [id, at] of Object.entries(reminders.fired)) if (at > now - 2 * REMINDER_MISSED) fired[id] = at;
  for (const r of reminders.list) {
    if (fired[r.id]) continue;
    if (r.at > now) known[r.id] = r.at;
    // Due: only if it was scheduled before its time; one set for a time already gone never fires.
    else if (reminders.known[r.id] && r.at > now - REMINDER_MISSED) {
      fired[r.id] = r.at;
      notifyReminder(r);
    }
  }
  reminders = { list: reminders.list.filter((r) => r.at > now - REMINDER_MISSED), known, fired };
  try {
    fs.writeFileSync(remindersFile(), JSON.stringify(reminders));
  } catch {
    /* kept in memory */
  }
  const next = Math.min(...Object.values(known));
  if (Number.isFinite(next)) reminderTimer = setTimeout(runReminders, Math.min(next - now + 50, 3600 * 1000));
}

ipcMain.on("xot:reminders", (event, list) => {
  if (!Array.isArray(list) || !event.senderFrame?.url.startsWith(ORIGIN)) return;
  if (!reminderTargets.has(event.sender.id)) {
    reminderTargets.add(event.sender.id);
    event.sender.once("destroyed", () => reminderTargets.delete(event.sender.id));
  }
  reminders.list = list.filter(validReminder).slice(0, 5000).map(cleanReminder);
  runReminders();
});

// The page's Bandeja de entrada asks for what fired while no window could show it.
ipcMain.handle("xot:fired-reminders", (event) => {
  if (!event.senderFrame?.url.startsWith(ORIGIN)) return [];
  return reminders.list.filter((r) => reminders.fired[r.id] && r.at <= Date.now());
});

// Notifications from buttons and automations (lib/actions.ts), also from the hidden automations window.
ipcMain.on("xot:notify", (event, n) => {
  if (!event.senderFrame?.url.startsWith(ORIGIN) || !n || typeof n.title !== "string" || typeof n.body !== "string") return;
  const pageId = typeof n.pageId === "string" && /^[\w-]{1,80}$/.test(n.pageId) ? n.pageId : "";
  showNotification(n.title.slice(0, 200), n.body.slice(0, 400), pageId);
});

// Recurring automations (lib/automations.ts): an open window runs them itself and says when the
// next one is due. With every window closed (Xot stays in the Dock), the app loads a hidden
// window at that time that only runs the ones due, reports the next one and is closed again.
let automationNext = null;
let automationTimer = null;
let automationWin = null;
let automationRan = 0;

function scheduleAutomations() {
  clearTimeout(automationTimer);
  if (!Number.isFinite(automationNext)) return;
  // A hidden run that left one due (it failed) waits a minute before the next try.
  const at = Math.max(automationNext + 1000, automationRan + 60 * 1000);
  automationTimer = setTimeout(runAutomations, Math.min(Math.max(at - Date.now(), 0), 3600 * 1000));
}

function runAutomations() {
  if (!Number.isFinite(automationNext) || automationNext > Date.now()) return scheduleAutomations();
  // An open window runs them on its own timer, and reports the next one.
  if (appWindows().length || automationWin) return void (automationTimer = setTimeout(runAutomations, 60 * 1000));
  automationRan = Date.now();
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  automationWin = win;
  // A run that hangs is closed after two minutes.
  const stop = setTimeout(() => !win.isDestroyed() && win.destroy(), 120 * 1000);
  win.on("closed", () => {
    clearTimeout(stop);
    if (automationWin === win) automationWin = null;
    scheduleAutomations();
  });
  void win.loadURL(`${ORIGIN}/index.html?automations=1`);
}

ipcMain.on("xot:next-automation", (event, at, done) => {
  if (!event.senderFrame?.url.startsWith(ORIGIN)) return;
  // null: no recurring automation; anything else that isn't a time keeps the last one.
  if (at === null || Number.isFinite(at)) {
    automationNext = at;
    saveState({ nextAutomation: at });
  }
  const win = automationWin;
  if (done && win && !win.isDestroyed() && event.sender === win.webContents) win.destroy();
  else scheduleAutomations();
});

// "Marcador web": a page's title, description, picture and icon (electron/linkPreview.cjs).
ipcMain.handle("xot:link-preview", (_event, url) => require("./linkPreview.cjs").fetchLinkPreview(url).catch(() => null));

// Exportar > PDF: the export's HTML goes through a hidden window into Chromium's PDF printer
// (a temporary file, since pages with images are too long for a data: URL).
const PAGE_SIZES = ["A4", "Letter", "Legal", "A3", "Tabloid"];
ipcMain.handle("xot:print-to-pdf", async (_event, html, options) => {
  // Exportar's "Formato de página" and "Porcentaje de escala".
  const pageSize = PAGE_SIZES.includes(options?.pageSize) ? options.pageSize : "A4";
  const scale = Math.min(2, Math.max(0.1, Number(options?.scale) || 1));
  const file = path.join(require("node:os").tmpdir(), `xot-export-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(file, String(html));
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    await win.loadFile(file);
    return await win.webContents.printToPDF({ printBackground: true, pageSize, scale });
  } finally {
    win.destroy();
    fs.rmSync(file, { force: true });
  }
});

// ------------------------------------------------------------------ App de escritorio
// Configuración > Preferencias > App de escritorio: the app keeps
// them (window-state.json), since the Atajo de búsqueda and the menu bar icon work with every
// window closed. Each window reads them, changes them and hears every change ("xot:prefs").

// The default differs from other apps' common Shift+CommandOrControl+K so they can run side by side.
const SEARCH_SHORTCUT = "Alt+CommandOrControl+K";
const PREF_DEFAULTS = { commandSearch: true, searchShortcut: SEARCH_SHORTCUT, menuBarIcon: true };
let prefs = { ...PREF_DEFAULTS };

function loadPrefs() {
  const saved = readState().prefs ?? {};
  prefs = {
    commandSearch: typeof saved.commandSearch === "boolean" ? saved.commandSearch : PREF_DEFAULTS.commandSearch,
    searchShortcut: typeof saved.searchShortcut === "string" && saved.searchShortcut ? saved.searchShortcut : SEARCH_SHORTCUT,
    menuBarIcon: typeof saved.menuBarIcon === "boolean" ? saved.menuBarIcon : PREF_DEFAULTS.menuBarIcon,
  };
}

/** "Abrir Xot al iniciar sesión": macOS's login items. `npm run app:dev` (not packaged) only remembers it. */
function openAtLogin() {
  if (!app.isPackaged) return !!readState().openAtLogin;
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setOpenAtLogin(on) {
  saveState({ openAtLogin: on });
  if (!app.isPackaged) return true;
  try {
    app.setLoginItemSettings({ openAtLogin: on });
  } catch {
    /* checked below */
  }
  if (openAtLogin() === on) return true;
  // macOS can refuse it (System Settings > Login Items).
  void dialog.showMessageBox({
    type: "warning",
    message: "Abrir al iniciar sesión",
    detail:
      "macOS impidió que Xot configurara la opción “Abrir al iniciar sesión”. Esto puede ocurrir cuando el inicio de Xot ya está configurado en los ajustes del sistema. Revisa Ajustes del Sistema > General > Ítems de inicio.",
  });
  return false;
}

const desktopPrefs = () => ({ ...prefs, openAtLogin: openAtLogin(), shortcutActive: shortcutActive });

function broadcastPrefs() {
  const current = desktopPrefs();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("xot:prefs", current);
  updateTray();
}

// The Atajo de búsqueda: a system-wide shortcut that shows Xot's search over any app.
let shortcutActive = false;
/** Registers the shortcut in use; false when another app holds it (or it isn't a valid accelerator). */
function applyShortcut() {
  globalShortcut.unregisterAll();
  shortcutActive = false;
  if (!prefs.commandSearch || !prefs.searchShortcut) return true;
  try {
    shortcutActive = globalShortcut.register(prefs.searchShortcut, toggleSearch);
  } catch {
    shortcutActive = false;
  }
  return shortcutActive;
}

/** Rule for global shortcuts on macOS: Option, Control or Command, plus a key. */
const validShortcut = (accelerator) => {
  const parts = String(accelerator).split("+");
  const key = parts.pop();
  return !!key && parts.some((p) => /^(Alt|Option|Control|Ctrl|Command|Cmd|CommandOrControl|CmdOrCtrl|Super|Meta)$/i.test(p));
};

/** Changes the app's preferences; resolves with them, or with `error` when a shortcut can't be used. */
function setPrefs(patch) {
  if (!patch || typeof patch !== "object") return desktopPrefs();
  if (typeof patch.openAtLogin === "boolean") setOpenAtLogin(patch.openAtLogin);
  const next = { ...prefs };
  if (typeof patch.commandSearch === "boolean") next.commandSearch = patch.commandSearch;
  if (typeof patch.menuBarIcon === "boolean") next.menuBarIcon = patch.menuBarIcon;
  if (typeof patch.searchShortcut === "string") {
    if (!validShortcut(patch.searchShortcut)) return { ...desktopPrefs(), error: "modifier" };
    next.searchShortcut = patch.searchShortcut;
  }
  const previous = prefs;
  prefs = next;
  if (!applyShortcut() && next.searchShortcut !== previous.searchShortcut) {
    // Taken by another app: keep the one that worked.
    prefs = previous;
    applyShortcut();
    broadcastPrefs();
    return { ...desktopPrefs(), error: "in-use" };
  }
  saveState({ prefs });
  broadcastPrefs();
  return desktopPrefs();
}

ipcMain.handle("xot:prefs", (event, patch) => {
  if (!event.senderFrame?.url.startsWith(ORIGIN)) return null;
  return patch ? setPrefs(patch) : desktopPrefs();
});

// The floating search: a window without a frame over the screen
// in use, with Buscar alone (main.tsx, "?search=1"). A page picked there opens in the last Xot
// window used (or a new one); it hides on Escape, on a click elsewhere or on the shortcut again.
let searchWin = null;
const SEARCH_SIZE = { width: 795, height: 560 };

function createSearchWindow() {
  const win = new BrowserWindow({
    ...SEARCH_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    // A panel takes the keyboard without bringing Xot's other windows forward.
    type: "panel",
    hiddenInMissionControl: true,
    title: "Xot - Atajo de búsqueda",
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "preload.cjs") },
  });
  // Over full-screen apps too, on whichever Space is showing.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on("blur", () => !win.isDestroyed() && win.hide());
  win.on("closed", () => searchWin === win && (searchWin = null));
  void win.loadURL(`${ORIGIN}/index.html?search=1`);
  return win;
}

function showSearch() {
  if (!searchWin || searchWin.isDestroyed()) searchWin = createSearchWindow();
  const win = searchWin;
  // Centred on the display with the pointer, a fifth of the way down.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - SEARCH_SIZE.width) / 2),
    y: Math.round(workArea.y + workArea.height / 5 - 12),
    ...SEARCH_SIZE,
  });
  const reveal = () => {
    win.show();
    win.focus();
    win.webContents.send("xot:search-shown");
  };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", reveal);
  else reveal();
}

function hideSearch() {
  if (searchWin && !searchWin.isDestroyed() && searchWin.isVisible()) searchWin.hide();
}

function toggleSearch() {
  if (searchWin && !searchWin.isDestroyed() && searchWin.isVisible() && searchWin.isFocused()) hideSearch();
  else showSearch();
}

ipcMain.on("xot:search-hide", (event) => {
  if (searchWin && event.sender === searchWin.webContents) hideSearch();
});
// A page picked in the floating search (or in any window, for a new tab).
ipcMain.on("xot:open-route", (event, route, newTab) => {
  if (!event.senderFrame?.url.startsWith(ORIGIN) || typeof route !== "string" || !/^#\/[\w?=&-]*$/.test(route)) return;
  hideSearch();
  openRoute(route, newTab === true);
});

// The menu bar icon: a click shows the search,
// a right click its menu. It needs the Atajo de búsqueda on.
let tray = null;

function trayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Activar/desactivar atajo de búsqueda",
      accelerator: prefs.searchShortcut,
      registerAccelerator: false,
      click: () => toggleSearch(),
    },
    { label: "Cambiar atajo del Atajo de búsqueda", click: () => openPreferences() },
    { type: "separator" },
    { label: "Abrir Xot al iniciar sesión", type: "checkbox", checked: openAtLogin(), click: (item) => (setOpenAtLogin(item.checked), broadcastPrefs()) },
    { label: "Mostrar Xot en la barra de menú", type: "checkbox", checked: true, click: () => setPrefs({ menuBarIcon: false }) },
    { type: "separator" },
    { label: "Salir de Xot", click: () => app.quit() },
  ]);
}

function updateTray() {
  const enabled = prefs.menuBarIcon && prefs.commandSearch;
  if (!enabled) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(__dirname, "trayTemplate.png"));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("Xot");
    tray.on("click", () => toggleSearch());
    tray.on("right-click", () => tray?.popUpContextMenu(trayMenu()));
  }
}

/** Configuración > Preferencias in the last window used (or a new one). */
function openPreferences() {
  const win = (lastFocused && !lastFocused.isDestroyed() ? lastFocused : null) ?? appWindows()[0];
  if (!win) {
    const created = createWindow();
    created.webContents.once("did-finish-load", () => setTimeout(() => !created.isDestroyed() && sendKey(created, ","), 800));
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  sendKey(win, ",");
}

// The Dock's badge: the unread count of Bandeja de entrada (Sidebar's), sent by the windows.
ipcMain.on("xot:badge", (event, count) => {
  if (!event.senderFrame?.url.startsWith(ORIGIN) || !Number.isFinite(count)) return;
  app.dock?.setBadge(count > 0 ? String(Math.min(Math.floor(count), 999)) : "");
});

// "Mover la pestaña a una nueva ventana", or a tab dropped outside its window: a window with that
// tab and its history. `at`: the screen point it was dropped on.
ipcMain.on("xot:tab-window", (event, moved, at) => {
  if (!event.senderFrame?.url.startsWith(ORIGIN) || !moved || typeof moved.route !== "string") return;
  const routes = (list) => (Array.isArray(list) ? list.filter((r) => typeof r === "string").slice(-50) : []);
  const tab = { route: moved.route, back: routes(moved.back), forward: routes(moved.forward), pinned: moved.pinned === true };
  if (typeof moved.pinnedRoute === "string") tab.pinnedRoute = moved.pinnedRoute;
  const point = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x - 120, y: at.y - 18 } : undefined;
  createWindow("", { tab, at: point });
});

// Tab previews: a picture of the page under the tab bar,
// small enough to keep one per tab.
ipcMain.handle("xot:capture-page", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !event.senderFrame?.url.startsWith(ORIGIN)) return null;
  const { width, height } = win.getContentBounds();
  const top = Math.ceil(TAB_BAR * event.sender.getZoomFactor());
  if (height - top < 40) return null;
  try {
    const image = await event.sender.capturePage({ x: 0, y: top, width, height: height - top });
    return image.isEmpty() ? null : image.resize({ width: 480, quality: "good" }).toDataURL();
  } catch {
    return null;
  }
});

// Preferencias > Zona horaria chosen by hand: the pages run in that zone (Chromium's time zone
// override, set on every page before it loads), so dates, "Hoy" and reminders follow it.
// "" follows macOS's.
let timeZone = "";
const validZone = (tz) => {
  if (tz === "") return true;
  try {
    return typeof tz === "string" && tz.length < 64 && !!new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    return false;
  }
};

function applyTimeZone(wc) {
  if (wc.isDestroyed()) return;
  try {
    if (!wc.debugger.isAttached()) {
      if (!timeZone) return;
      wc.debugger.attach("1.3");
    }
    void wc.debugger.sendCommand("Emulation.setTimezoneOverride", { timezoneId: timeZone }).catch(() => {});
  } catch {
    /* DevTools' own debugger, or a page going away */
  }
}

app.on("web-contents-created", (_event, wc) => applyTimeZone(wc));

ipcMain.on("xot:timezone", (event, tz) => {
  if (!event.senderFrame?.url.startsWith(ORIGIN) || !validZone(tz) || tz === timeZone) return;
  timeZone = tz;
  saveState({ timeZone });
  for (const w of BrowserWindow.getAllWindows()) applyTimeZone(w.webContents);
});

app.on("will-quit", () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  if (!primary) return;
  const zone = readState().timeZone;
  if (validZone(zone)) timeZone = zone;
  loadPrefs();
  applyShortcut();
  updateTray();
  const theme = readState().theme;
  if (THEMES.includes(theme)) nativeTheme.themeSource = theme;
  serve();
  // Reminders keep firing from the last list the page sent, before any window opens.
  loadReminders();
  runReminders();
  powerMonitor.on("resume", runReminders);
  // Recurring automations keep their schedule from the last time a window reported it.
  const nextAutomation = readState().nextAutomation;
  if (Number.isFinite(nextAutomation)) automationNext = nextAutomation;
  scheduleAutomations();
  powerMonitor.on("resume", scheduleAutomations);
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
  // The Dock menu has a single item.
  app.dock?.setMenu(Menu.buildFromTemplate([{ label: "Nueva ventana", click: () => createWindow() }]));
  app.setAboutPanelOptions({
    applicationName: "Xot",
    applicationVersion: app.getVersion(),
    version: "",
    authors: ["Rotzebra"],
    copyright: "© 2026 Rotzebra · GPL-3.0",
    credits: "Páginas, bases de datos y automatizaciones guardadas en tu equipo.",
  });
  createWindow(launchRoute);
  app.on("activate", () => appWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());

/** The app's menus, in Spanish (Electron's built-in role menus are English-only). */
function menuTemplate() {
  const sep = { type: "separator" };
  const hidden = (accelerator, run) => ({
    label: accelerator,
    accelerator,
    visible: false,
    acceleratorWorksWhenHidden: true,
    click: (_item, win) => run(win),
  });
  return [
    {
      label: "Xot",
      submenu: [
        { role: "about", label: "Acerca de Xot" },
        sep,
        // The page opens the workspace menu, where Apariencia lives.
        { label: "Preferencias…", accelerator: "Cmd+,", click: (_item, win) => sendKey(win, ",") },
        sep,
        { role: "services", label: "Servicios" },
        sep,
        { role: "hide", label: "Ocultar Xot" },
        { role: "hideOthers", label: "Ocultar otros" },
        { role: "unhide", label: "Mostrar todo" },
        sep,
        // Quit without saving tabs: the next launch doesn't reopen this session's tabs.
        {
          label: "Cerrar sin guardar las pestañas",
          click: () => {
            saveState({ discardTabs: true });
            app.quit();
          },
        },
        { role: "quit", label: "Salir" },
      ],
    },
    {
      label: "Archivo",
      submenu: [
        { label: "Nueva pestaña", accelerator: "CmdOrCtrl+T", click: (_item, win) => void tab(win, "new") },
        { label: "Nueva ventana", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        {
          label: "Volver a abrir la última pestaña cerrada",
          accelerator: "CmdOrCtrl+Shift+T",
          click: (_item, win) => void tab(win, "reopen"),
        },
        // ⌘N makes a page (the page handles it first).
        {
          label: "Nueva página",
          accelerator: "CmdOrCtrl+N",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: (_item, win) => sendKey(win, "n"),
        },
        sep,
        { label: "Cerrar pestaña", accelerator: "CmdOrCtrl+W", click: (_item, win) => closeTab(win) },
        { role: "close", label: "Cerrar ventana", accelerator: "CmdOrCtrl+Shift+W", visible: false },
        sep,
        { label: "Imprimir...", click: (_item, win) => win?.webContents.print() },
      ],
    },
    {
      label: "Editar",
      submenu: [
        { label: "Deshacer", accelerator: "CmdOrCtrl+Z", click: (_item, win) => undo(win, false) },
        { label: "Rehacer", accelerator: "CmdOrCtrl+Shift+Z", click: (_item, win) => undo(win, true) },
        sep,
        { role: "cut", label: "Cortar" },
        { role: "copy", label: "Copiar" },
        // The page copies the link on ⌘L (PageView); the name is the window's title.
        { label: "Copiar el enlace a la página actual", accelerator: "CmdOrCtrl+L", click: (_item, win) => sendKey(win, "l") },
        {
          label: "Copiar el nombre de la página actual",
          accelerator: "CmdOrCtrl+Alt+L",
          click: (_item, win) => void (win && clipboard.writeText(win.webContents.getTitle())),
        },
        { role: "paste", label: "Pegar" },
        { role: "pasteAndMatchStyle", label: "Pegar y combinar formato" },
        // Hidden ⌘⇧V: paste as plain text.
        {
          label: "Pegar y combinar formato",
          accelerator: "CmdOrCtrl+Shift+V",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: (_item, win) => win?.webContents.pasteAndMatchStyle(),
        },
        { role: "selectAll", label: "Seleccionar todo" },
        sep,
        // Find in page: the page shows its search box (FindBar.tsx) on these keys.
        { label: "Buscar…", accelerator: "CmdOrCtrl+F", click: (_item, win) => sendKey(win, "f") },
        {
          label: "Buscar y reemplazar…",
          accelerator: "CmdOrCtrl+Alt+F",
          click: (_item, win) => void win?.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("xot:find", { detail: "replace" }))'),
        },
        { label: "Buscar siguiente", accelerator: "CmdOrCtrl+G", click: (_item, win) => sendKey(win, "g") },
        { label: "Buscar anterior", accelerator: "CmdOrCtrl+Shift+G", click: (_item, win) => sendKey(win, "G", true) },
        sep,
        {
          label: "Voz",
          submenu: [
            { role: "startSpeaking", label: "Empezar locución" },
            { role: "stopSpeaking", label: "Detener locución" },
          ],
        },
      ],
    },
    {
      label: "Ver",
      submenu: [
        { role: "reload", label: "Recargar" },
        // ⌘⇧R renames the open page, so the forced reload moves to ⌥⌘R.
        { role: "forceReload", label: "Forzar recarga", accelerator: "CmdOrCtrl+Alt+R" },
        { role: "toggleDevTools", label: "Activar/desactivar herramientas de desarrollo" },
        sep,
        {
          label: "Mostrar/Ocultar la barra lateral",
          accelerator: "CmdOrCtrl+\\",
          // The page toggles it on ⌘\ (and handles the shortcut itself first).
          click: (_item, win) =>
            void win?.webContents.executeJavaScript(
              'window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\\\", metaKey: true }))',
            ),
        },
        // The page handles ⌘⇧L itself.
        {
          label: "Cambiar entre modo claro y oscuro",
          accelerator: "CmdOrCtrl+Shift+L",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: (_item, win) => sendKey(win, "L", true),
        },
        sep,
        { label: "Acercar", accelerator: "CmdOrCtrl+Plus", click: (_item, win) => zoom(win, 1) },
        { label: "Acercar", accelerator: "CmdOrCtrl+=", visible: false, click: (_item, win) => zoom(win, 1) },
        { label: "Alejar", accelerator: "CmdOrCtrl+-", click: (_item, win) => zoom(win, -1) },
        { label: "Tamaño original", accelerator: "CmdOrCtrl+0", click: (_item, win) => zoom(win, 0) },
        { role: "togglefullscreen", label: "Mostrar/ocultar pantalla completa" },
      ],
    },
    {
      label: "Historial",
      submenu: [
        { label: "Atrás", accelerator: "CmdOrCtrl+[", click: (_item, win) => goBack(win) },
        { label: "Adelante", accelerator: "CmdOrCtrl+]", click: (_item, win) => goForward(win) },
        // The page handles ⌘⇧U itself.
        {
          label: "Ir a la página superior",
          accelerator: "CmdOrCtrl+Shift+U",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: (_item, win) => sendKey(win, "U", true),
        },
      ],
    },
    {
      label: "Ventana",
      role: "window",
      submenu: [
        { role: "minimize", label: "Minimizar" },
        { role: "zoom", label: "Zoom" },
        sep,
        { label: "Mostrar pestaña anterior", accelerator: "Ctrl+Shift+Tab", click: (_item, win) => void tab(win, "step", -1) },
        { label: "Mostrar pestaña siguiente", accelerator: "Ctrl+Tab", click: (_item, win) => void tab(win, "step", 1) },
        // Hidden tab shortcuts: ⌘1–⌘8 pick a tab, ⌘9 the last one.
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => hidden(`CmdOrCtrl+${n}`, (win) => void tab(win, "select", n === 9 ? -1 : n - 1))),
        hidden("CmdOrCtrl+Alt+Left", (win) => void tab(win, "step", -1)),
        hidden("CmdOrCtrl+Alt+Right", (win) => void tab(win, "step", 1)),
        hidden("CmdOrCtrl+Shift+[", (win) => void tab(win, "step", -1)),
        hidden("CmdOrCtrl+Shift+]", (win) => void tab(win, "step", 1)),
        sep,
        { role: "front", label: "Primer plano" },
      ],
    },
    {
      label: "Ayuda",
      role: "help",
      submenu: [
        // Keyboard shortcuts help (⌘⌥/): the page shows it (KeyboardShortcuts.tsx) and handles the key first.
        {
          label: "Atajos del teclado",
          accelerator: "CmdOrCtrl+Alt+/",
          click: (_item, win) =>
            void (win ?? lastFocused)?.webContents.executeJavaScript('window.dispatchEvent(new Event("xot:shortcuts"))'),
        },
        sep,
        {
          label: "Solución de problemas",
          submenu: [
            { label: "Mostrar los datos de Xot en Finder", click: () => void shell.openPath(app.getPath("userData")) },
            {
              label: "Restablecer y borrar todos los datos locales",
              click: async () => {
                const { response } = await dialog.showMessageBox({
                  type: "warning",
                  buttons: ["Cancelar", "Borrar y reiniciar"],
                  defaultId: 0,
                  cancelId: 0,
                  message: "¿Borrar los datos locales de Xot?",
                  detail: "Se borran todas las páginas guardadas en este equipo. Al reiniciar, Xot vuelve a cargar el espacio de trabajo inicial.",
                });
                if (response !== 1) return;
                await session.defaultSession.clearStorageData();
                app.relaunch();
                app.exit(0);
              },
            },
          ],
        },
      ],
    },
  ];
}
