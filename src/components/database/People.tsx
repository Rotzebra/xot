import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, Ellipsis, Mail, Plus, Trash, Upload, X } from "lucide-react";
import { db, type Person } from "../../lib/db";
import { LOCAL_USER } from "../../lib/comments";
import { FILE_SCHEME, pickFiles, resolveFileUrl, storeFile } from "../../lib/files";
import { MenuItem, MenuLabel, MenuSeparator, Popover, usePopover } from "../ui";
import { isValidEmail } from "./properties";

// "Persona" values are names; the people directory (db.people) adds each one's
// email and photo, shown on their avatar and on the card that opens on hover.

/** Adds a name to the directory (kept when it's already there). */
async function rememberPerson(name: string) {
  if (!(await db.people.get(name))) await db.people.put({ name, created_time: Date.now() });
}

export async function updatePerson(name: string, patch: Partial<Omit<Person, "name">>) {
  const current = (await db.people.get(name)) ?? { name, created_time: Date.now() };
  await db.people.put({ ...current, ...patch });
}

/** The directory entries for these names (missing ones are just names). */
function usePeople(names: string[]) {
  const people = useLiveQuery(() => db.people.bulkGet(names), [names.join("\u0000")]);
  return new Map((people ?? []).flatMap((p) => (p ? [[p.name, p] as const] : [])));
}

function useResolved(url: string | undefined) {
  const [resolved, setResolved] = useState(url && !url.startsWith(FILE_SCHEME) ? url : "");
  useEffect(() => {
    let alive = true;
    if (!url) setResolved("");
    else void resolveFileUrl(url).then((u) => alive && setResolved(u));
    return () => {
      alive = false;
    };
  }, [url]);
  return resolved;
}

/** A person's round avatar: their photo, or the first letter of their name. */
export function PersonAvatar({ name, person, size }: { name: string; person?: Person; size?: number }) {
  const src = useResolved(person?.avatar);
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.55) } : undefined;
  return (
    <span className={`person__avatar${src ? " person__avatar--photo" : ""}`} style={style}>
      {src ? <img src={src} alt="" /> : name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** The profile card: photo, name and email. */
function PersonCard({ name, person, rect }: { name: string; person?: Person; rect: DOMRect }) {
  const top = rect.bottom + 6 + 120 > window.innerHeight ? rect.top - 6 - 110 : rect.bottom + 6;
  return createPortal(
    <div className="person-card" role="tooltip" style={{ top, left: Math.min(rect.left, window.innerWidth - 270) }}>
      <PersonAvatar name={name} person={person} size={44} />
      <div className="person-card__text">
        <div className="person-card__name">{name}</div>
        {person?.email ? (
          <a className="person-card__email" href={`mailto:${person.email}`} onClick={(e) => e.stopPropagation()}>
            {person.email}
          </a>
        ) : (
          <div className="person-card__email person-card__email--none">Sin correo</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** People in a cell or card: avatar and name, with their card after a short hover. */
export function People({ names }: { names: string[] }) {
  const directory = usePeople(names);
  const [card, setCard] = useState<{ name: string; rect: DOMRect } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span className="people">
      {names.map((name, i) => (
        <span
          className="person"
          key={`${name}-${i}`}
          onMouseEnter={(e) => {
            const el = e.currentTarget;
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => el.isConnected && setCard({ name, rect: el.getBoundingClientRect() }), 500);
          }}
          onMouseLeave={() => {
            window.clearTimeout(timer.current);
            setCard(null);
          }}
        >
          <PersonAvatar name={name} person={directory.get(name)} />
          <span className="person__name">{name}</span>
        </span>
      ))}
      {card && <PersonCard name={card.name} person={directory.get(card.name)} rect={card.rect} />}
    </span>
  );
}

/** "Editar perfil": a person's email and photo. */
function PersonEditor({ name, person }: { name: string; person?: Person }) {
  const [email, setEmail] = useState(person?.email ?? "");
  useEffect(() => setEmail(person?.email ?? ""), [person?.email]);
  const invalid = !!email.trim() && !isValidEmail(email);
  const saveEmail = () => {
    const next = email.trim();
    if (next !== (person?.email ?? "") && !invalid) void updatePerson(name, { email: next || undefined });
  };
  return (
    <div className="menu person-editor">
      <div className="person-editor__head">
        <PersonAvatar name={name} person={person} size={36} />
        <span className="person-editor__name">{name}</span>
      </div>
      <label className="menu-field">
        <span>Correo</span>
        <input
          className={`field field--sm${invalid ? " field--invalid" : ""}`}
          placeholder="nombre@ejemplo.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={saveEmail}
          onKeyDown={(e) => e.key === "Enter" && saveEmail()}
        />
      </label>
      {invalid && <p className="person-editor__error">No es un correo válido</p>}
      <MenuSeparator />
      <MenuItem
        icon={<Upload size={16} />}
        onClick={async () => {
          const [file] = await pickFiles("image/*");
          if (file) await updatePerson(name, { avatar: await storeFile(file) });
        }}
      >
        {person?.avatar ? "Cambiar foto" : "Subir foto"}
      </MenuItem>
      {person?.avatar && (
        <MenuItem icon={<Trash size={16} />} onClick={() => void updatePerson(name, { avatar: undefined })}>
          Quitar foto
        </MenuItem>
      )}
      {person?.email && (
        <MenuItem icon={<Mail size={16} />} onClick={() => window.open(`mailto:${person.email}`, "_blank")}>
          Enviar correo
        </MenuItem>
      )}
    </div>
  );
}

/**
 * The person picker: the selected people as chips, then everyone, with a search that
 * can add a name. "…" edits a person's email and photo. `single` (Limitar: 1 persona) swaps the choice.
 */
export function PeoplePicker({
  selected,
  onChange,
  single = false,
}: {
  selected: string[];
  onChange: (names: string[]) => void;
  single?: boolean;
}) {
  const [query, setQuery] = useState("");
  const editPop = usePopover();
  const [editing, setEditing] = useState<string | null>(null);
  const people = useLiveQuery(async () => {
    const names = new Set<string>([LOCAL_USER.username, ...(await db.people.toCollection().primaryKeys())]);
    const collections = await db.collections.toArray();
    const props = collections.flatMap((c) => Object.entries(c.schema).filter(([, p]) => p.type === "person").map(([id]) => [c.id, id] as const));
    if (props.length)
      await db.blocks.each((b) => {
        if (b.parent_table !== "collection") return;
        for (const [cid, pid] of props) {
          const v = b.parent_id === cid ? b.properties[pid] : undefined;
          if (Array.isArray(v)) for (const n of v) if (typeof n === "string" && n.trim()) names.add(n);
        }
      });
    return [...names].sort((a, b) => a.localeCompare(b, "es"));
  });
  const directory = usePeople(people ?? []);
  const q = query.trim();
  const shown = (people ?? []).filter((n) => n.toLowerCase().includes(q.toLowerCase()));
  const pick = (names: string[]) => onChange(single ? names.slice(-1) : names);
  const toggle = (name: string) => pick(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  const exact = (people ?? []).some((n) => n.toLowerCase() === q.toLowerCase());
  const add = () => {
    void rememberPerson(q);
    pick([...selected, q]);
    setQuery("");
  };
  return (
    <div className="option-picker people-picker">
      <div className="option-picker__input">
        {selected.map((name) => (
          <span className="person person--chip" key={name}>
            <PersonAvatar name={name} person={directory.get(name)} />
            <span className="person__name">{name}</span>
            <button type="button" aria-label={`Quitar ${name}`} onClick={() => toggle(name)}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          autoFocus
          placeholder={selected.length ? "" : "Buscar personas…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && q) {
              e.preventDefault();
              e.stopPropagation();
              // An existing name (or the only match) is picked; a new one is added.
              const match = (people ?? []).find((n) => n.toLowerCase() === q.toLowerCase()) ?? (shown.length === 1 ? shown[0] : null);
              if (match) {
                if (!selected.includes(match)) pick([...selected, match]);
                setQuery("");
              } else add();
            }
            if (e.key === "Backspace" && !query && selected.length) onChange(selected.slice(0, -1));
          }}
        />
      </div>
      <MenuLabel>{single ? "Selecciona a una persona" : "Selecciona a una o más personas"}</MenuLabel>
      <div className="option-picker__list">
        {shown.map((name) => (
          <div key={name} className="people-picker__row">
            <MenuItem
              icon={<PersonAvatar name={name} person={directory.get(name)} />}
              right={selected.includes(name) ? <Check size={14} /> : null}
              onClick={() => toggle(name)}
            >
              {name}
              {directory.get(name)?.email && <span className="people-picker__email">{directory.get(name)!.email}</span>}
            </MenuItem>
            <button
              type="button"
              className="icon-btn icon-btn--sm people-picker__more"
              aria-label={`Editar perfil de ${name}`}
              data-tooltip="Editar perfil"
              onClick={(e) => {
                setEditing(name);
                editPop.open(e.currentTarget);
              }}
            >
              <Ellipsis size={15} />
            </button>
          </div>
        ))}
        {q && !exact && (
          <MenuItem icon={<Plus size={16} />} onClick={add}>
            Agregar «{q}»
          </MenuItem>
        )}
      </div>
      {editPop.anchor && editing && (
        <Popover anchor={editPop.anchor} onClose={editPop.close} width={260}>
          <PersonEditor name={editing} person={directory.get(editing)} />
        </Popover>
      )}
    </div>
  );
}
