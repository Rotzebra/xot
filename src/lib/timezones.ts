// Date properties' "Zona horaria": a value is stored in this device's local time
// (so filters, sorts and reminders keep working); a zone set on it only changes
// how it's shown and typed: as the wall time in that IANA zone, with its offset.

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Every IANA zone the runtime knows (a short list when it can't say). */
export function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.("timeZone");
    if (all?.length) return all;
  } catch {
    /* older runtime */
  }
  return ["UTC", "America/Bogota", "America/Mexico_City", "America/New_York", "America/Los_Angeles", "Europe/Madrid", "Europe/London", "Asia/Tokyo"];
}

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The wall time of an instant in a zone, as "YYYY-MM-DDTHH:mm". */
function wallTime(t: number, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const localWall = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** Maps each "…T HH:mm" point of a date value (single or "start/end"); days without a time stay as they are. */
const mapPoints = (value: string, fn: (point: string) => string) =>
  value
    .split("/")
    .map((p) => (p.includes("T") ? fn(p.slice(0, 16)) : p))
    .join("/");

/** A stored (local) value as it reads in `tz`. */
export function toZone(value: string, tz: string | undefined) {
  if (!tz) return value;
  return mapPoints(value, (p) => {
    const t = new Date(`${p}:00`).getTime();
    return Number.isNaN(t) ? p : wallTime(t, tz);
  });
}

/** A value typed in `tz`, stored in local time. */
export function fromZone(value: string, tz: string | undefined) {
  if (!tz) return value;
  return mapPoints(value, (p) => {
    const [d, time] = p.split("T");
    const [y, m, day] = d.split("-").map(Number);
    const [h, min] = time.split(":").map(Number);
    const target = Date.UTC(y, m - 1, day, h, min);
    if (Number.isNaN(target)) return p;
    // The instant whose wall time in tz is `p`: start from UTC and correct by the zone's offset (twice, for DST edges).
    let t = target;
    for (let i = 0; i < 2; i++) {
      const [wd, wt] = wallTime(t, tz).split("T");
      const [wy, wm, wday] = wd.split("-").map(Number);
      const [wh, wmin] = wt.split(":").map(Number);
      t += target - Date.UTC(wy, wm - 1, wday, wh, wmin);
    }
    return localWall(t);
  });
}

/** "GMT-5", "GMT+2"… for a zone at a stored value's start. */
export function zoneLabel(tz: string, value?: string) {
  const start = value?.split("/")[0];
  const t = start?.includes("T") ? new Date(`${start.slice(0, 16)}:00`).getTime() : Date.now();
  try {
    const name = new Intl.DateTimeFormat("es", { timeZone: tz, timeZoneName: "shortOffset" })
      .formatToParts(new Date(Number.isNaN(t) ? Date.now() : t))
      .find((p) => p.type === "timeZoneName")?.value;
    return name ?? tz;
  } catch {
    return tz;
  }
}

/** "Bogotá (GMT-5)": a zone's city and offset. */
export const zoneName = (tz: string) => `${tz.split("/").pop()!.replace(/_/g, " ")} (${zoneLabel(tz)})`;
