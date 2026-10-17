import { useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BadgeCheck, Check, ChevronDown, CircleAlert, Clock, X } from "lucide-react";
import type { Block } from "../lib/model";
import type { PageState } from "../lib/db";
import { setFormat } from "../lib/ops";
import { listSnapshots } from "../lib/history";
import { pageState } from "../lib/history";
import { unverifyPage, untilIn, VERIFY_CHOICES, verifyPage, verifyState } from "../lib/wiki";
import { LOCAL_PERSON } from "../lib/model";
import { MenuItem, MenuLabel, MenuSeparator, Modal, Popover, usePopover } from "./ui";

const fullDate = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });
const dayDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });

// ------------------------------------------------------ Personalizar página

type Choice<T> = { id: T; label: string };

function ChoiceSelect<T extends string>({ value, choices, onPick }: { value: T; choices: Choice<T>[]; onPick: (id: T) => void }) {
  const pop = usePopover();
  return (
    <>
      <button type="button" className="xot-select" onClick={(e) => pop.toggle(e.currentTarget)}>
        <span>{choices.find((c) => c.id === value)?.label}</span>
        <ChevronDown size={14} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={240} align="end">
          <div className="menu">
            {choices.map((c) => (
              <MenuItem
                key={c.id}
                right={value === c.id ? <Check size={16} /> : undefined}
                onClick={() => {
                  onPick(c.id);
                  pop.close();
                }}
              >
                {c.label}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

function CustomRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="page-custom__row">
      <div className="page-custom__text">
        <div className="page-custom__title">{title}</div>
        <div className="page-custom__desc">{description}</div>
      </div>
      {children}
    </div>
  );
}

/**
 * "Personalizar página": where the backlinks show (expanded under the
 * title, behind a button, or not at all), whether the discussions at the top
 * show, and how inline comments look.
 */
export function CustomizePageDialog({ block, onClose }: { block: Block; onClose: () => void }) {
  const f = block.format;
  return (
    <Modal onClose={onClose} className="page-custom" label="Personalizar página">
      <div className="page-custom__head">
        <span>Personalizar página</span>
        <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="page-custom__body">
        <CustomRow title="Retroenlaces" description="Las páginas que enlazan o mencionan esta página.">
          <ChoiceSelect
            value={f.backlinks ?? "popover"}
            choices={[
              { id: "expanded", label: "Expandidos" },
              { id: "popover", label: "Mostrar en ventana emergente" },
              { id: "off", label: "Desactivados" },
            ]}
            onPick={(id) => void setFormat(block.id, { backlinks: id === "popover" ? undefined : id })}
          />
        </CustomRow>
        <CustomRow title="Comentarios de la página" description="Los comentarios en la parte superior de la página.">
          <ChoiceSelect
            value={f.page_comments === "off" ? "off" : "on"}
            choices={[
              { id: "on", label: "Expandidos" },
              { id: "off", label: "Desactivados" },
            ]}
            onPick={(id) => void setFormat(block.id, { page_comments: id === "off" ? "off" : undefined })}
          />
        </CustomRow>
        <CustomRow title="Comentarios en línea" description="Cómo se marca el texto comentado en la página.">
          <ChoiceSelect
            value={f.inline_comments === "minimal" ? "minimal" : "default"}
            choices={[
              { id: "default", label: "Predeterminado" },
              { id: "minimal", label: "Mínimo" },
            ]}
            onPick={(id) => void setFormat(block.id, { inline_comments: id === "minimal" ? "minimal" : undefined })}
          />
        </CustomRow>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------ Actualizaciones

type Change = { kind: "added" | "edited" | "removed"; text: string };

/** Inline content (an array of runs, or a plain string) as text. */
function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const o = c as { text?: unknown; content?: unknown; props?: { pageId?: unknown } };
      if (typeof o.text === "string") return o.text;
      if (o.content) return inlineText(o.content);
      return "";
    })
    .join("");
}

const BLOCK_NAMES: Record<string, string> = {
  image: "Imagen",
  video: "Video",
  audio: "Audio",
  file: "Archivo",
  table: "Tabla",
  pageLink: "Enlace a una página",
  database: "Base de datos",
  divider: "Divisor",
  codeBlock: "Código",
};

/** Every block of a body by id, with its text (nested blocks too). */
function flatten(content: unknown[], out = new Map<string, { json: string; text: string }>()) {
  for (const raw of content) {
    const b = raw as { id?: string; type?: string; content?: unknown; children?: unknown[] };
    const { children, ...own } = b;
    const text = inlineText(b.content).trim() || BLOCK_NAMES[b.type ?? ""] || "";
    if (b.id) out.set(b.id, { json: JSON.stringify(own), text });
    if (Array.isArray(children)) flatten(children, out);
  }
  return out;
}

/** What changed from one version of a page to the next. */
function diff(prev: PageState | null, next: PageState): Change[] {
  const changes: Change[] = [];
  if (prev && prev.title !== next.title) changes.push({ kind: "edited", text: `Título: ${next.title || "Sin título"}` });
  if (prev && (prev.icon ?? null) !== (next.icon ?? null)) changes.push({ kind: "edited", text: "Icono" });
  if (prev && (prev.cover ?? null) !== (next.cover ?? null)) changes.push({ kind: "edited", text: "Portada" });
  const a = flatten(prev?.content ?? []);
  const b = flatten(next.content ?? []);
  for (const [id, block] of b) {
    const before = a.get(id);
    if (!before) {
      if (block.text) changes.push({ kind: "added", text: block.text });
    } else if (before.json !== block.json) changes.push({ kind: "edited", text: block.text || before.text });
  }
  for (const [id, block] of a) if (!b.has(id) && block.text) changes.push({ kind: "removed", text: block.text });
  return changes;
}

const KIND_LABEL: Record<Change["kind"], string> = { added: "Añadido", edited: "Editado", removed: "Eliminado" };

/**
 * "Actualizaciones": the page's edits, newest first, each with when
 * and which blocks changed (from the versions "Historial de versiones" keeps).
 */
export function PageUpdates({ block }: { block: Block }) {
  const snapshots = useLiveQuery(() => listSnapshots(block.id), [block.id, block.last_edited_time]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (!snapshots) return null;
  const current = pageState(block);
  const entries: { time: number; changes: Change[]; first: boolean }[] = [];
  // The page now against its last version, then each version against the one before it.
  const states: { time: number; state: PageState }[] = [
    { time: block.last_edited_time, state: current },
    ...snapshots.map((s) => ({ time: s.time, state: s as PageState })),
  ];
  for (let i = 0; i < states.length; i++) {
    const prev = states[i + 1]?.state ?? null;
    // The oldest state against an empty page: everything it had was added then.
    const changes = diff(prev, states[i].state);
    if (!changes.length) continue;
    entries.push({ time: states[i].time, changes, first: false });
  }
  entries.push({ time: block.created_time, changes: [], first: true });
  return (
    <div className="page-updates">
      <div className="page-updates__head">Actualizaciones</div>
      <div className="page-updates__list">
        {entries.map((e, i) => {
          const shown = open.has(i) ? e.changes : e.changes.slice(0, 4);
          return (
            <div key={`${e.time}-${i}`} className="page-update">
              <div className="page-update__line">
                <span className="page-update__avatar">{LOCAL_PERSON.charAt(0)}</span>
                <span className="page-update__who">
                  {LOCAL_PERSON} {e.first ? "creaste la página" : "editaste"}
                </span>
                <span className="page-update__time">{fullDate.format(e.time)}</span>
              </div>
              {!e.first && (
                <ul className="page-update__changes">
                  {shown.map((c, j) => (
                    <li key={j} className={`page-update__change is-${c.kind}`}>
                      <span className="page-update__kind">{KIND_LABEL[c.kind]}</span>
                      <span className="page-update__text">{c.text}</span>
                    </li>
                  ))}
                  {e.changes.length > shown.length && (
                    <li>
                      <button type="button" className="page-update__more" onClick={() => setOpen(new Set(open).add(i))}>
                        {e.changes.length - shown.length} cambios más
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="page-updates__foot">
        <Clock size={14} /> Se guarda una actualización cada 10 minutos de edición.
      </div>
    </div>
  );
}

// ------------------------------------------------------ Verificación

/** "Verificar página": how long the verification lasts, or a date; also renew or remove it. */
export function VerifyMenu({ block, onDone }: { block: Block; onDone: () => void }) {
  const [custom, setCustom] = useState("");
  const v = block.format.verified;
  return (
    <div className="menu verify-menu">
      {v && (
        <>
          <div className="verify-menu__state">
            <VerifyBadgeIcon state={verifyState(v)} />
            <span>
              {verifyState(v) === "expired" ? "Verificación caducada" : "Verificada"} por {LOCAL_PERSON}
              <br />
              <span className="verify-menu__when">
                {v.until === null ? "Indefinidamente" : `${verifyState(v) === "expired" ? "Caducó el" : "Hasta el"} ${dayDate.format(v.until)}`}
              </span>
            </span>
          </div>
          <MenuSeparator />
          <MenuLabel>Volver a verificar</MenuLabel>
        </>
      )}
      {!v && <MenuLabel>Verificar la página</MenuLabel>}
      {VERIFY_CHOICES.map((c) => (
        <MenuItem
          key={c.label}
          onClick={() => {
            void verifyPage(block.id, c.days === null ? null : untilIn(c.days));
            onDone();
          }}
        >
          {c.label}
        </MenuItem>
      ))}
      <div className="verify-menu__custom">
        <span>Hasta</span>
        <input type="date" className="field" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button
          type="button"
          className="xot-btn xot-btn--primary"
          disabled={!custom}
          onClick={() => {
            void verifyPage(block.id, new Date(`${custom}T23:59:59`).getTime());
            onDone();
          }}
        >
          Verificar
        </button>
      </div>
      {v && (
        <>
          <MenuSeparator />
          <MenuItem
            danger
            icon={<X size={18} />}
            onClick={() => {
              void unverifyPage(block.id);
              onDone();
            }}
          >
            Quitar verificación
          </MenuItem>
        </>
      )}
    </div>
  );
}

function VerifyBadgeIcon({ state }: { state: ReturnType<typeof verifyState> }) {
  return state === "expired" ? <CircleAlert size={16} className="verify-icon is-expired" /> : <BadgeCheck size={16} className="verify-icon" />;
}

/** The icon of the "Verificación" property type. */
export const VERIFICATION_ICON = BadgeCheck;

/** A "Verificación" value: Verificada, or Caducada once it expired. */
export function VerificationValue({ state }: { state: "verified" | "expired" }) {
  return (
    <span className={`verification-value${state === "expired" ? " is-expired" : ""}`}>
      <VerifyBadgeIcon state={state} />
      {state === "expired" ? "Caducada" : "Verificada"}
    </span>
  );
}

/** A wiki's "Verificación" cell: the row's verification, set or renewed from the verification menu. */
export function VerificationCell({
  row,
  className,
  placement,
  children,
}: {
  row: Block;
  className: string;
  placement: "cover" | "below";
  children?: ReactNode;
}) {
  const pop = usePopover();
  const state = verifyState(row.format.verified);
  const until = row.format.verified?.until;
  return (
    <>
      <div className={className} onClick={(e) => pop.toggle(e.currentTarget)}>
        {state ? (
          <span className="verification-cell">
            <VerificationValue state={state} />
            {state === "verified" && until != null && <span className="verification-cell__until">hasta el {dayDate.format(until)}</span>}
          </span>
        ) : (
          <span className="cell__placeholder verification-cell__empty">Sin verificar</span>
        )}
        {children}
      </div>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={280} placement={placement}>
          <VerifyMenu block={row} onDone={pop.close} />
        </Popover>
      )}
    </>
  );
}

/** The topbar badge of a verified page; it opens the verification menu. */
export function VerifiedBadge({ block }: { block: Block }) {
  const pop = usePopover();
  const v = block.format.verified;
  const state = verifyState(v);
  if (!state) return null;
  return (
    <>
      <button
        type="button"
        className={`topbar__verified${state === "expired" ? " is-expired" : ""}`}
        data-tooltip={
          state === "expired"
            ? "La verificación caducó"
            : v!.until === null
              ? "Verificada indefinidamente"
              : `Verificada hasta el ${dayDate.format(v!.until)}`
        }
        onClick={(e) => pop.toggle(e.currentTarget)}
      >
        <VerifyBadgeIcon state={state} />
        {state === "expired" ? "Caducada" : "Verificada"}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={280}>
          <VerifyMenu block={block} onDone={pop.close} />
        </Popover>
      )}
    </>
  );
}
