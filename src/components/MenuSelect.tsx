import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { MenuItem, Popover, usePopover } from "./ui";
import { DatePicker } from "./database/properties";

// In-line pickers for settings (automations, buttons, template repeats): a
// value that opens a menu, a time typed as "9:00" and a day from the date picker,
// in place of the OS's select, time and date inputs.

/** A value that opens a menu of choices (dropdown buttons), checked on the current one. */
export function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
  width = 220,
}: {
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
  width?: number;
}) {
  const menu = usePopover();
  const current = options.find(([v]) => v === value);
  return (
    <>
      <button
        type="button"
        className={`menu-select ${className}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!menu.anchor}
        onClick={(e) => menu.toggle(e.currentTarget)}
      >
        <span className="menu-select__label">{current?.[1] ?? ""}</span>
        <ChevronDown size={12} />
      </button>
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} width={width}>
          <div className="menu" role="menu">
            {options.map(([v, text]) => (
              <MenuItem
                key={v}
                role="menuitemradio"
                aria-checked={v === value}
                active={v === value}
                right={v === value ? <Check size={14} /> : null}
                onClick={() => {
                  menu.close();
                  if (v !== value) onChange(v);
                }}
              >
                {text}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "09:00" → "9:00" (24 h, as shown in Spanish). */
export const shortTime = (time: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  return m ? `${Number(m[1])}:${m[2]}` : time;
};

/** A time typed as "9:00", "930" or "21" (24 h); stored "HH:mm". */
export function TimeField({ value, onChange, label = "Hora" }: { value: string; onChange: (time: string) => void; label?: string }) {
  const [text, setText] = useState(shortTime(value));
  useEffect(() => setText(shortTime(value)), [value]);
  const commit = () => {
    const m = text.trim().match(/^(\d{1,2})(?::?(\d{2}))?$/);
    if (m && +m[1] < 24 && +(m[2] ?? 0) < 60) {
      const next = `${pad(+m[1])}:${m[2] ?? "00"}`;
      if (next !== value) onChange(next);
      setText(shortTime(next));
    } else setText(shortTime(value));
  };
  return (
    <input
      className="menu-select menu-select--time"
      value={text}
      placeholder="9:00"
      inputMode="numeric"
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setText(shortTime(value));
      }}
    />
  );
}

const longDay = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A day (local midnight, in ms) picked from the date picker; shown as "16 oct 2026". */
export function DayField({ value, onChange, label }: { value: number; onChange: (day: number) => void; label: string }) {
  const picker = usePopover();
  return (
    <>
      <button
        type="button"
        className="menu-select"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={!!picker.anchor}
        onClick={(e) => picker.toggle(e.currentTarget)}
      >
        <span className="menu-select__label">{longDay.format(new Date(value)).replace(/\./g, "")}</span>
        <ChevronDown size={12} />
      </button>
      {picker.anchor && (
        <Popover anchor={picker.anchor} onClose={picker.close} width={280}>
          <DatePicker
            value={isoDay(new Date(value))}
            options={false}
            onChange={(day) => {
              const m = day && /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
              if (m) onChange(new Date(+m[1], +m[2] - 1, +m[3]).getTime());
              picker.close();
            }}
          />
        </Popover>
      )}
    </>
  );
}
