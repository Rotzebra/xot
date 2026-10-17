import { useState, type MouseEvent } from "react";
import {
  Activity, AlarmClock, Anchor, Apple, Archive, Atom, Award, Baby, Ban, Bed, Beer, Bell, Bike, Bird, Book, BookOpen,
  Bookmark, Box, Brain, Briefcase, Brush, Bug, Building, Building2, Cake, Calendar, CalendarDays, Camera, Car, Cat,
  ChartBar, ChartLine, ChartPie, Check, CircleAlert, CircleCheck, CircleHelp, CircleX, Clipboard, ClipboardList, Clock,
  Cloud, Code, Coffee, Cog, Compass, Cpu, CreditCard, Crown, Database, Diamond, Dice5, Dog, DollarSign, Droplet,
  Dumbbell, Earth, Eye, Feather, File, FileText, Film, Fish, Flag, FlaskConical, Flame, Flower, Folder, FolderOpen,
  Gamepad2, Gem, Gift, Glasses, Globe, GraduationCap, Hammer, Hand, Hash, Headphones, Heart, Hourglass, House, Image,
  Inbox, Infinity as InfinityIcon, Info, Kanban, Key, Laptop, Layers, LayoutGrid, Leaf, Lightbulb, Link, ListChecks,
  ListTodo, Lock, Mail, Map as MapIcon, MapPin, Medal, Megaphone, MessageCircle, MessageSquare, Mic, Microscope, Monitor, Moon,
  Mountain, Music, Newspaper, Package, Palette, Paperclip, Pencil, PenLine, Phone, PiggyBank, Pill, Pin, Pizza, Plane,
  Puzzle, Rainbow, Receipt, Recycle, Rocket, School, Scissors, Search, Send, Server, Settings, Sheet, Shield, Ship,
  Shirt, ShoppingBag, ShoppingCart, Smartphone, Smile, Snowflake, Sofa, Sparkles, Sprout, SquareCheck, Star,
  Stethoscope, Store, Sun, Table, Tag, Tags, Target, Tent, Terminal, ThumbsUp, Ticket, Timer, Train, TreePine,
  TrendingUp, TriangleAlert, Trophy, Truck, Umbrella, Unlock, User, Users, Utensils, Video, Wallet, Watch, Waves, Wifi,
  Wind, Wine, Wrench, Zap, type LucideIcon,
} from "lucide-react";

/** The "Iconos" set, with lucide outlines; each one with its Spanish search words. */
const ICONS: [string, LucideIcon, string][] = [
  ["house", House, "casa inicio hogar"], ["file-text", FileText, "documento página texto"], ["file", File, "archivo"],
  ["book", Book, "libro"], ["book-open", BookOpen, "libro lectura leer"], ["bookmark", Bookmark, "marcador guardar"],
  ["calendar", Calendar, "calendario fecha"], ["calendar-days", CalendarDays, "calendario días agenda"],
  ["clock", Clock, "reloj hora tiempo"], ["alarm-clock", AlarmClock, "alarma despertador"], ["timer", Timer, "temporizador"],
  ["hourglass", Hourglass, "reloj de arena espera"], ["watch", Watch, "reloj pulsera"], ["bell", Bell, "campana notificación"],
  ["star", Star, "estrella favorito"], ["heart", Heart, "corazón amor"], ["flag", Flag, "bandera"], ["pin", Pin, "chincheta fijar"],
  ["map-pin", MapPin, "ubicación lugar"], ["map", MapIcon, "mapa"], ["globe", Globe, "mundo web internet"], ["earth", Earth, "tierra planeta"],
  ["compass", Compass, "brújula explorar"], ["lightbulb", Lightbulb, "idea bombilla"], ["zap", Zap, "rayo energía"],
  ["flame", Flame, "fuego llama"], ["sun", Sun, "sol día"], ["moon", Moon, "luna noche"], ["cloud", Cloud, "nube"],
  ["umbrella", Umbrella, "paraguas lluvia"], ["snowflake", Snowflake, "nieve copo invierno"], ["wind", Wind, "viento"],
  ["droplet", Droplet, "gota agua"], ["waves", Waves, "olas mar"], ["rainbow", Rainbow, "arcoíris"], ["leaf", Leaf, "hoja planta"],
  ["sprout", Sprout, "brote planta crecer"], ["tree", TreePine, "árbol pino bosque"], ["flower", Flower, "flor"],
  ["mountain", Mountain, "montaña"], ["coffee", Coffee, "café taza"], ["pizza", Pizza, "pizza comida"], ["apple", Apple, "manzana fruta"],
  ["cake", Cake, "pastel cumpleaños"], ["utensils", Utensils, "cubiertos comida restaurante"], ["wine", Wine, "vino copa"],
  ["beer", Beer, "cerveza"], ["music", Music, "música nota"], ["headphones", Headphones, "audífonos auriculares"],
  ["mic", Mic, "micrófono"], ["camera", Camera, "cámara foto"], ["image", Image, "imagen foto"], ["film", Film, "película cine"],
  ["video", Video, "video"], ["palette", Palette, "paleta color arte"], ["brush", Brush, "pincel"], ["pen-line", PenLine, "pluma escribir"],
  ["pencil", Pencil, "lápiz editar"], ["feather", Feather, "pluma"], ["scissors", Scissors, "tijeras"],
  ["briefcase", Briefcase, "maletín trabajo"], ["building", Building, "edificio empresa"], ["building-2", Building2, "edificio oficina"],
  ["store", Store, "tienda"], ["shopping-cart", ShoppingCart, "carrito compras"], ["shopping-bag", ShoppingBag, "bolsa compras"],
  ["credit-card", CreditCard, "tarjeta pago"], ["wallet", Wallet, "billetera cartera"], ["dollar", DollarSign, "dólar dinero"],
  ["piggy-bank", PiggyBank, "alcancía ahorro"], ["receipt", Receipt, "recibo factura"], ["chart-bar", ChartBar, "gráfico barras"],
  ["chart-line", ChartLine, "gráfico línea"], ["chart-pie", ChartPie, "gráfico circular"], ["trending-up", TrendingUp, "tendencia subir"],
  ["target", Target, "objetivo meta diana"], ["trophy", Trophy, "trofeo premio"], ["medal", Medal, "medalla"], ["award", Award, "premio insignia"],
  ["gift", Gift, "regalo"], ["rocket", Rocket, "cohete lanzamiento"], ["plane", Plane, "avión viaje"], ["car", Car, "carro auto coche"],
  ["bike", Bike, "bicicleta"], ["ship", Ship, "barco"], ["train", Train, "tren"], ["truck", Truck, "camión envío"],
  ["user", User, "usuario persona"], ["users", Users, "usuarios equipo personas"], ["smile", Smile, "sonrisa cara"],
  ["hand", Hand, "mano"], ["thumbs-up", ThumbsUp, "me gusta pulgar"], ["message-circle", MessageCircle, "mensaje chat"],
  ["message-square", MessageSquare, "comentario mensaje"], ["mail", Mail, "correo email"], ["send", Send, "enviar"],
  ["phone", Phone, "teléfono llamada"], ["inbox", Inbox, "bandeja entrada"], ["archive", Archive, "archivo caja"],
  ["folder", Folder, "carpeta"], ["folder-open", FolderOpen, "carpeta abierta"], ["clipboard", Clipboard, "portapapeles"],
  ["clipboard-list", ClipboardList, "lista tareas"], ["list-checks", ListChecks, "lista verificación"], ["list-todo", ListTodo, "pendientes tareas"],
  ["square-check", SquareCheck, "casilla hecho"], ["circle-check", CircleCheck, "completado listo"], ["check", Check, "visto hecho"],
  ["tag", Tag, "etiqueta"], ["tags", Tags, "etiquetas"], ["hash", Hash, "numeral almohadilla"], ["link", Link, "enlace vínculo"],
  ["paperclip", Paperclip, "clip adjunto"], ["key", Key, "llave clave"], ["lock", Lock, "candado privado"], ["unlock", Unlock, "abierto desbloquear"],
  ["shield", Shield, "escudo seguridad"], ["eye", Eye, "ojo ver"], ["search", Search, "buscar lupa"], ["settings", Settings, "configuración ajustes"],
  ["cog", Cog, "engranaje"], ["wrench", Wrench, "llave herramienta"], ["hammer", Hammer, "martillo"], ["code", Code, "código programación"],
  ["terminal", Terminal, "terminal consola"], ["cpu", Cpu, "procesador chip"], ["database", Database, "base de datos"],
  ["server", Server, "servidor"], ["laptop", Laptop, "portátil computador"], ["monitor", Monitor, "pantalla monitor"],
  ["smartphone", Smartphone, "celular móvil"], ["wifi", Wifi, "wifi red"], ["gamepad", Gamepad2, "videojuego control"],
  ["puzzle", Puzzle, "rompecabezas"], ["dice", Dice5, "dado juego"], ["graduation-cap", GraduationCap, "graduación estudio"],
  ["school", School, "escuela colegio"], ["brain", Brain, "cerebro mente"], ["atom", Atom, "átomo ciencia"],
  ["flask", FlaskConical, "matraz laboratorio"], ["microscope", Microscope, "microscopio"], ["stethoscope", Stethoscope, "salud médico"],
  ["pill", Pill, "pastilla medicina"], ["dumbbell", Dumbbell, "pesa ejercicio gimnasio"], ["activity", Activity, "actividad pulso"],
  ["baby", Baby, "bebé"], ["dog", Dog, "perro mascota"], ["cat", Cat, "gato mascota"], ["bird", Bird, "pájaro ave"], ["fish", Fish, "pez"],
  ["bug", Bug, "bicho error"], ["sparkles", Sparkles, "destellos brillo"], ["crown", Crown, "corona"], ["gem", Gem, "gema joya"],
  ["diamond", Diamond, "diamante rombo"], ["infinity", InfinityIcon, "infinito"], ["anchor", Anchor, "ancla"], ["box", Box, "caja"],
  ["package", Package, "paquete"], ["layers", Layers, "capas"], ["layout-grid", LayoutGrid, "cuadrícula"], ["kanban", Kanban, "tablero"],
  ["table", Table, "tabla"], ["sheet", Sheet, "hoja tabla"], ["newspaper", Newspaper, "periódico noticias"], ["megaphone", Megaphone, "megáfono anuncio"],
  ["ticket", Ticket, "boleto entrada"], ["tent", Tent, "carpa campamento"], ["sofa", Sofa, "sofá"], ["bed", Bed, "cama dormir"],
  ["shirt", Shirt, "camisa ropa"], ["glasses", Glasses, "gafas lentes"], ["circle-alert", CircleAlert, "alerta"],
  ["triangle-alert", TriangleAlert, "advertencia peligro"], ["info", Info, "información"], ["circle-help", CircleHelp, "ayuda pregunta"],
  ["ban", Ban, "prohibido"], ["circle-x", CircleX, "cancelar error"], ["recycle", Recycle, "reciclar"],
];
const BY_NAME = new Map(ICONS.map((i) => [i[0], i]));

/** The ten icon colors. */
const COLORS: [string, string][] = [
  ["Gris", "#91918e"],
  ["Gris claro", "#c3c2bf"],
  ["Marrón", "#9f6b53"],
  ["Naranja", "#d9730d"],
  ["Amarillo", "#cb912f"],
  ["Verde", "#448361"],
  ["Azul", "#337ea9"],
  ["Morado", "#9065b0"],
  ["Rosa", "#c14c8a"],
  ["Rojo", "#d44c47"],
];

const RECENT_KEY = "xot:recent-icons";
const COLOR_KEY = "xot:icon-color";

function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((e) => typeof e === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function remember(key: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...readRecent().filter((e) => e !== key)].slice(0, 20)));
  } catch {
    /* storage unavailable */
  }
}

/** The clicked outline, painted in `color`, as a self-contained SVG icon (works everywhere format.icon images do). */
function svgIcon(svg: SVGSVGElement, color: string) {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.removeAttribute("class");
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", "24");
  copy.setAttribute("height", "24");
  copy.setAttribute("stroke", color);
  copy.setAttribute("stroke-width", "2");
  return `data:image/svg+xml;utf8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
}

/** The icon popover's "Iconos" tab: filter, the color swatches, Recientes, then the whole set. */
export function IconsTab({ onPick }: { onPick: (icon: string) => void }) {
  const [query, setQuery] = useState("");
  const [color, setColor] = useState(() => {
    try {
      return COLORS.find((c) => c[1] === localStorage.getItem(COLOR_KEY))?.[1] ?? COLORS[0][1];
    } catch {
      return COLORS[0][1];
    }
  });
  const [swatches, setSwatches] = useState(false);
  const [recent] = useState(readRecent);

  const pick = (e: MouseEvent<HTMLButtonElement>, name: string, tone: string) => {
    const svg = e.currentTarget.querySelector("svg");
    if (!svg) return;
    remember(`${name}|${tone}`);
    onPick(svgIcon(svg, tone));
  };
  const chooseColor = (tone: string) => {
    setColor(tone);
    setSwatches(false);
    try {
      localStorage.setItem(COLOR_KEY, tone);
    } catch {
      /* storage unavailable */
    }
  };

  const q = query.trim().toLowerCase();
  const found = q ? ICONS.filter(([name, , words]) => name.includes(q) || words.split(" ").some((w) => w.startsWith(q))) : ICONS;
  const recents = q
    ? []
    : recent.flatMap((key) => {
        const [name, tone] = key.split("|");
        const entry = BY_NAME.get(name);
        return entry && tone ? [{ entry, tone }] : [];
      });

  const grid = (items: { entry: (typeof ICONS)[number]; tone: string }[], prefix: string) => (
    <div className="emoji-picker__grid">
      {items.map(({ entry: [name, Icon, words], tone }) => (
        <button
          type="button"
          key={`${prefix}-${name}-${tone}`}
          className="emoji-picker__item emoji-picker__icon"
          aria-label={words.split(" ")[0]}
          data-tooltip={words.split(" ")[0]}
          onClick={(e) => pick(e, name, tone)}
        >
          <Icon size={20} strokeWidth={2} color={tone} />
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="emoji-picker__bar">
        <input
          className="menu-search emoji-picker__search"
          placeholder="Filtrar…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="emoji-picker__tool"
          aria-label="Color del icono"
          data-tooltip="Color"
          aria-expanded={swatches}
          onClick={() => setSwatches((v) => !v)}
        >
          <span className="emoji-picker__swatch" style={{ background: color }} />
        </button>
      </div>
      {swatches && (
        <div className="emoji-picker__colors" role="listbox" aria-label="Color del icono">
          {COLORS.map(([label, tone]) => (
            <button
              type="button"
              key={tone}
              role="option"
              aria-selected={tone === color}
              aria-label={label}
              data-tooltip={label}
              className={`emoji-picker__color${tone === color ? " is-active" : ""}`}
              onClick={() => chooseColor(tone)}
            >
              <span className="emoji-picker__swatch" style={{ background: tone }} />
            </button>
          ))}
        </div>
      )}
      <div className="emoji-picker__body">
        {recents.length > 0 && (
          <section className="emoji-picker__section">
            <div className="emoji-picker__label">Recientes</div>
            {grid(recents, "recent")}
          </section>
        )}
        <section className="emoji-picker__section">
          <div className="emoji-picker__label">{q ? "Resultados" : "Iconos"}</div>
          {found.length ? (
            grid(
              found.map((entry) => ({ entry, tone: color })),
              "all",
            )
          ) : (
            <div className="emoji-picker__empty">Sin resultados</div>
          )}
        </section>
      </div>
    </>
  );
}
