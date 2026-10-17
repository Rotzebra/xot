// Number formats and relative dates, keyed by their stored ids.

const CURRENCIES: Record<string, string> = {
  dollar: "USD",
  canadian_dollar: "CAD",
  australian_dollar: "AUD",
  euro: "EUR",
  pound: "GBP",
  yen: "JPY",
  ruble: "RUB",
  rupee: "INR",
  won: "KRW",
  yuan: "CNY",
  real: "BRL",
  lira: "TRY",
  rupiah: "IDR",
  franc: "CHF",
  hong_kong_dollar: "HKD",
  new_zealand_dollar: "NZD",
  krona: "SEK",
  norwegian_krone: "NOK",
  mexican_peso: "MXN",
  rand: "ZAR",
  new_taiwan_dollar: "TWD",
  danish_krone: "DKK",
  zloty: "PLN",
  baht: "THB",
  forint: "HUF",
  koruna: "CZK",
  shekel: "ILS",
  chilean_peso: "CLP",
  philippine_peso: "PHP",
  dirham: "AED",
  colombian_peso: "COP",
  riyal: "SAR",
  ringgit: "MYR",
  leu: "RON",
  argentine_peso: "ARS",
  uruguayan_peso: "UYU",
  peruvian_sol: "PEN",
};

/** Number formats, in the menu's order: plain, separators, percent, then every currency. */
export const NUMBER_FORMATS: [string, string][] = [
  ["number", "Número"],
  ["number_with_commas", "Número con separadores"],
  ["percent", "Porcentaje"],
  ["dollar", "Dólar estadounidense"],
  ["canadian_dollar", "Dólar canadiense"],
  ["australian_dollar", "Dólar australiano"],
  ["euro", "Euro"],
  ["pound", "Libra esterlina"],
  ["yen", "Yen"],
  ["ruble", "Rublo"],
  ["rupee", "Rupia india"],
  ["won", "Won"],
  ["yuan", "Yuan"],
  ["real", "Real brasileño"],
  ["lira", "Lira turca"],
  ["rupiah", "Rupia indonesia"],
  ["franc", "Franco suizo"],
  ["hong_kong_dollar", "Dólar de Hong Kong"],
  ["new_zealand_dollar", "Dólar neozelandés"],
  ["krona", "Corona sueca"],
  ["norwegian_krone", "Corona noruega"],
  ["mexican_peso", "Peso mexicano"],
  ["rand", "Rand sudafricano"],
  ["new_taiwan_dollar", "Nuevo dólar taiwanés"],
  ["danish_krone", "Corona danesa"],
  ["zloty", "Esloti"],
  ["baht", "Baht"],
  ["forint", "Forinto"],
  ["koruna", "Corona checa"],
  ["shekel", "Séquel"],
  ["chilean_peso", "Peso chileno"],
  ["philippine_peso", "Peso filipino"],
  ["dirham", "Dírham"],
  ["colombian_peso", "Peso colombiano"],
  ["riyal", "Riyal"],
  ["ringgit", "Ringgit"],
  ["leu", "Leu rumano"],
  ["argentine_peso", "Peso argentino"],
  ["uruguayan_peso", "Peso uruguayo"],
  ["peruvian_sol", "Sol peruano"],
];

/** The "Decimales" choices: the default, or 0 to 10 places shown as an example ("1,00"). */
export const DECIMAL_CHOICES: [string, string][] = [
  ["default", "Predeterminado"],
  ...Array.from({ length: 11 }, (_, n) => [String(n), n ? `1,${"0".repeat(n)}` : "1"] as [string, string]),
];

// Spanish locales skip the separator below 10.000 ("1200,5"); numbers here always group ("1.200,5").
const ALWAYS_GROUP = { useGrouping: "always" } as unknown as Intl.NumberFormatOptions;

/** A number in one of these formats; `decimals` (0 to 10) fixes the places shown, otherwise up to 2. */
export function formatNumber(value: number, format?: string, compact = false, decimals?: number): string {
  if (!Number.isFinite(value)) return "";
  const fixed = decimals === undefined || compact ? undefined : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  const options: Intl.NumberFormatOptions = compact
    ? { ...ALWAYS_GROUP, notation: "compact", maximumFractionDigits: 1 }
    : ALWAYS_GROUP;
  const currency = format ? CURRENCIES[format] : undefined;
  if (currency)
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency,
      maximumFractionDigits: compact ? 1 : Number.isInteger(value) ? 0 : 2,
      ...options,
      ...fixed,
    }).format(value);
  if (format === "percent")
    return new Intl.NumberFormat("es", { style: "percent", maximumFractionDigits: 2, ...ALWAYS_GROUP, ...fixed }).format(value);
  if (format === "number_with_commas" || compact)
    return new Intl.NumberFormat("es", { maximumFractionDigits: 2, ...options, ...fixed }).format(value);
  if (decimals !== undefined) return value.toFixed(decimals);
  return String(Math.round(value * 100) / 100);
}

/** Relative date tokens stored in filters ("one_month_ago"…). */
export const RELATIVE_DATES: Record<string, string> = {
  today: "Hoy",
  tomorrow: "Mañana",
  yesterday: "Ayer",
  one_week_ago: "Hace una semana",
  one_week_from_now: "Dentro de una semana",
  one_month_ago: "Hace un mes",
  one_month_from_now: "Dentro de un mes",
};

const iso = (d: Date) => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

/** The user's local day as "YYYY-MM-DD" (toISOString alone gives the UTC day). */
export const localDay = (d = new Date()) => iso(d);

/** "relative:one_month_ago" → today's equivalent "YYYY-MM-DD"; other values pass through. */
export function resolveDate(value: string): string {
  if (!value.startsWith("relative:")) return value;
  const d = new Date();
  switch (value.slice(9)) {
    case "tomorrow":
      d.setDate(d.getDate() + 1);
      break;
    case "yesterday":
      d.setDate(d.getDate() - 1);
      break;
    case "one_week_ago":
      d.setDate(d.getDate() - 7);
      break;
    case "one_week_from_now":
      d.setDate(d.getDate() + 7);
      break;
    case "one_month_ago":
      d.setMonth(d.getMonth() - 1);
      break;
    case "one_month_from_now":
      d.setMonth(d.getMonth() + 1);
      break;
  }
  return iso(d);
}

const relative = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const shortDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });
const longDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });

/** "Editado hace 5 min" within a day, then "Editado el 22 abr" for the topbar. */
export function editedLabel(time: number) {
  const s = Math.round((time - Date.now()) / 1000);
  if (s > -60) return "Editado justo ahora";
  if (s > -3600) return `Editado ${relative.format(Math.round(s / 60), "minute")}`;
  if (s > -86400) return `Editado ${relative.format(Math.round(s / 3600), "hour")}`;
  const sameYear = new Date(time).getFullYear() === new Date().getFullYear();
  return `Editado el ${(sameYear ? shortDate : longDate).format(time).replace(".", "")}`;
}
