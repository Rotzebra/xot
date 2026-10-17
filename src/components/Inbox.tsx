import { Fragment, type MouseEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckCheck,
  Ellipsis,
  Inbox as InboxIcon,
  ListFilter,
  Mail,
  MailOpen,
  PanelRight,
  X,
  Zap,
} from "lucide-react";
import type { InboxEntry } from "../lib/db";
import { navigate, openInNewTab, pageTitle, useBlock, useStoredState, wantsNewTab } from "../lib/hooks";
import {
  archiveAll,
  archiveEntry,
  markAllRead,
  markRead,
  markUnread,
  unarchiveEntry,
  useInbox,
  type InboxFilter,
} from "../lib/inbox";
import { MenuItem, MenuLabel, MenuSeparator, PageIcon, Popover, Switch, usePopover } from "./ui";

const relative = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const shortDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });

/** "Justo ahora", "hace 5 minutos", "ayer"…, then the date, as the inbox shows it. */
function when(time: number) {
  const s = (Date.now() - time) / 1000;
  if (s < 60) return "Justo ahora";
  if (s < 3600) return relative.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return relative.format(-Math.floor(s / 3600), "hour");
  if (s < 7 * 86400) return relative.format(-Math.floor(s / 86400), "day");
  return shortDate.format(time).replace(".", "");
}

const FILTERS: [InboxFilter, string][] = [
  ["all", "Todas"],
  ["unread", "No leídas"],
  ["archived", "Archivadas"],
];

const EMPTY: Record<InboxFilter, [string, string]> = {
  all: ["Estás al día", "Los recordatorios aparecerán aquí cuando llegue su hora."],
  unread: ["No hay notificaciones sin leer", "Todo lo de la bandeja ya está leído."],
  archived: ["No hay notificaciones archivadas", "Lo que archives aparecerá aquí."],
};

/**
 * The "Bandeja de entrada" (the sidebar's panel, or docked beside the page
 * with "Fijar"): the reminders that fired, newest first. A click opens the page
 * or row and marks the entry read; each row can be marked unread or archived,
 * the filter shows the unread or the archive, and "..." archives in bulk and
 * groups the list by page.
 */
export function InboxPanel({
  onClose,
  onPin,
  docked = false,
}: {
  onClose: () => void;
  /** Docks the panel beside the page (the sidebar's popover only). */
  onPin?: () => void;
  docked?: boolean;
}) {
  const [filter, setFilter] = useStoredState<InboxFilter>("xotion:inbox:filter", "all");
  const [grouped, setGrouped] = useStoredState("xotion:inbox:group", false);
  const entries = useInbox(filter);
  const all = useInbox("all");
  const unread = all?.some((e) => !e.read) ?? false;
  const filterPop = usePopover();
  const morePop = usePopover();
  const [title, hint] = EMPTY[filter];

  // "Agrupar por página": one block per page, in the order of its newest entry.
  const groups: { pageId: string; entries: InboxEntry[] }[] = [];
  for (const e of entries ?? []) {
    const g = grouped ? groups.find((x) => x.pageId === e.page_id) : undefined;
    if (g) g.entries.push(e);
    else groups.push({ pageId: grouped ? e.page_id : e.id, entries: [e] });
  }

  return (
    <div className={`inbox${docked ? " inbox--docked" : ""}`}>
      <div className="inbox__head">
        <span className="inbox__title">
          {filter === "archived" ? "Archivadas" : filter === "unread" ? "No leídas" : "Bandeja de entrada"}
        </span>
        <span className="inbox__head-actions">
          <button
            type="button"
            className={`icon-btn${filter !== "all" ? " is-active" : ""}`}
            aria-label="Filtrar"
            data-tooltip="Filtrar"
            onClick={(e) => filterPop.toggle(e.currentTarget)}
          >
            <ListFilter size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Marcar todo como leído"
            data-tooltip="Marcar todo como leído"
            disabled={!unread}
            onClick={() => void markAllRead()}
          >
            <CheckCheck size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Más opciones"
            data-tooltip="Más opciones"
            onClick={(e) => morePop.toggle(e.currentTarget)}
          >
            <Ellipsis size={16} />
          </button>
          {docked ? (
            <button type="button" className="icon-btn" aria-label="Cerrar" data-tooltip="Cerrar" onClick={onClose}>
              <X size={16} />
            </button>
          ) : (
            onPin && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Fijar el panel"
                data-tooltip="Fijar el panel"
                onClick={onPin}
              >
                <PanelRight size={16} />
              </button>
            )
          )}
        </span>
      </div>
      {filterPop.anchor && (
        <Popover anchor={filterPop.anchor} onClose={filterPop.close} width={220} align="end">
          <div className="menu">
            <MenuLabel>Mostrar</MenuLabel>
            {FILTERS.map(([id, label]) => (
              <MenuItem
                key={id}
                right={filter === id ? <Check size={16} /> : undefined}
                onClick={() => {
                  setFilter(id);
                  filterPop.close();
                }}
              >
                {label}
              </MenuItem>
            ))}
          </div>
        </Popover>
      )}
      {morePop.anchor && (
        <Popover anchor={morePop.anchor} onClose={morePop.close} width={240} align="end">
          <div className="menu">
            <MenuItem
              icon={<Archive size={18} />}
              onClick={() => {
                morePop.close();
                void archiveAll(false);
              }}
            >
              Archivar todo
            </MenuItem>
            <MenuItem
              icon={<Archive size={18} />}
              onClick={() => {
                morePop.close();
                void archiveAll(true);
              }}
            >
              Archivar leídos
            </MenuItem>
            <MenuSeparator />
            <MenuItem right={<Switch on={grouped} />} onClick={() => setGrouped(!grouped)}>
              Agrupar por página
            </MenuItem>
          </div>
        </Popover>
      )}
      {entries && entries.length === 0 && (
        <div className="inbox__empty">
          <InboxIcon size={32} strokeWidth={1.5} />
          <span>{title}</span>
          <span className="inbox__empty-hint">{hint}</span>
        </div>
      )}
      <div className="inbox__list">
        {groups.map((g) => (
          <Fragment key={g.pageId}>
            {grouped && <InboxGroupHead pageId={g.pageId} entry={g.entries[0]} count={g.entries.length} />}
            {g.entries.map((e) => (
              <InboxRow key={e.id} entry={e} onOpen={docked ? () => {} : onClose} nested={grouped} />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function InboxGroupHead({ pageId, entry, count }: { pageId: string; entry: InboxEntry; count: number }) {
  const page = useBlock(pageId);
  return (
    <div className="inbox__group">
      <PageIcon block={page} size={16} />
      <span className="inbox__group-name">{page ? pageTitle(page) : entry.title}</span>
      <span className="inbox__group-count">{count}</span>
    </div>
  );
}

function InboxRow({ entry, onOpen, nested }: { entry: InboxEntry; onOpen: () => void; nested?: boolean }) {
  const page = useBlock(entry.page_id);
  const open = (e: MouseEvent) => {
    void markRead(entry.id);
    if (!entry.page_id) return;
    if (wantsNewTab(e)) openInNewTab(entry.page_id);
    else navigate(entry.page_id);
    onOpen();
  };
  return (
    <div
      className={`inbox__row${entry.read ? "" : " is-unread"}${nested ? " inbox__row--nested" : ""}`}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
    >
      <span className="inbox__dot" aria-hidden />
      <span className="inbox__icon">
        {entry.kind === "automation" && !page ? <Zap size={18} strokeWidth={1.8} /> : <PageIcon block={page} size={20} />}
      </span>
      <span className="inbox__text">
        <span className="inbox__name">{page ? pageTitle(page) : entry.title}</span>
        <span className="inbox__body">
          {entry.kind === "automation"
            ? `${entry.source ? `${entry.source} · ` : ""}${entry.body}`
            : entry.body.startsWith("Recordatorio") || entry.body.startsWith("Verificación")
              ? entry.body
              : `Recordatorio · ${entry.body}`}
        </span>
      </span>
      <span className="inbox__time">{when(entry.time)}</span>
      <span className="inbox__row-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label={entry.read ? "Marcar como no leído" : "Marcar como leído"}
          data-tooltip={entry.read ? "Marcar como no leído" : "Marcar como leído"}
          onClick={(e) => {
            e.stopPropagation();
            void (entry.read ? markUnread(entry.id) : markRead(entry.id));
          }}
        >
          {entry.read ? <Mail size={16} /> : <MailOpen size={16} />}
        </button>
        <button
          type="button"
          className="icon-btn inbox__archive"
          aria-label={entry.archived ? "Desarchivar" : "Archivar"}
          data-tooltip={entry.archived ? "Desarchivar" : "Archivar"}
          onClick={(e) => {
            e.stopPropagation();
            void (entry.archived ? unarchiveEntry(entry.id) : archiveEntry(entry.id));
          }}
        >
          {entry.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
        </button>
      </span>
    </div>
  );
}
