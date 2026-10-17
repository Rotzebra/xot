import { useContext, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Settings2, Smile } from "lucide-react";
import { db } from "../lib/db";
import { OPTION_COLORS, OPTION_COLOR_LABELS, type OptionColor } from "../lib/model";
import { runActions, type Action, type ActionType } from "../lib/actions";
import { navigate } from "../lib/hooks";
import { ActionsEditor } from "./ActionsEditor";
import { PageContext } from "./DatabaseEmbed";
import { ConfirmDialog, EmojiPicker, MenuLabel, Popover, iconUrl, toast, usePopover } from "./ui";

/** One step of a button (lib/actions.ts). */
export type ButtonAction = Action;

export interface ButtonProps {
  label: string;
  /** Built-in icon path ("/icons/…svg"), image URL or emoji. */
  icon: string;
  color: string;
  /** JSON list of Action. */
  actions: string;
  /** Older buttons: the database page a new page is added to. */
  databaseId: string;
  pageTitle: string;
}

function parseActions(props: ButtonProps, legacyCollection?: string | null): Action[] {
  if (props.actions) {
    try {
      return JSON.parse(props.actions) as Action[];
    } catch {
      return [];
    }
  }
  if (legacyCollection)
    return [
      { type: "create_page", collectionId: legacyCollection, title: props.pageTitle },
      { type: "open_created", from: 0 },
    ];
  return [];
}

/** What a button block can do; "Editar propiedad" only on a database page. */
const BLOCK_ACTIONS: ActionType[] = [
  "insert_blocks",
  "create_page",
  "edit_pages",
  "edit_this",
  "notify",
  "webhook",
  "variables",
  "open_created",
  "open_page",
  "open_url",
  "confirm",
];

/**
 * The button block. A click runs its actions in order (lib/actions.ts): insert
 * blocks, add or edit pages, notify, send a webhook, open a page or link, confirm…
 * Label, icon, color and actions are edited from the gear shown on hover.
 */
export function XotButton({
  props,
  onChange,
  onInsert,
}: {
  props: ButtonProps;
  onChange: (p: Partial<ButtonProps>) => void;
  /** "Insertar bloques": the editor adds the blocks (or older buttons' Markdown) next to the button, or at the start or end of the page. */
  onInsert?: (content: unknown[] | string, position: "above" | "below" | "start" | "end", pageId?: string) => void;
}) {
  const settings = usePopover();
  const pageId = useContext(PageContext);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ action: Extract<Action, { type: "confirm" }>; done: (ok: boolean) => void } | null>(null);
  const legacy = useLiveQuery(
    async () => (props.databaseId && !props.actions ? ((await db.blocks.get(props.databaseId))?.collection_id ?? null) : null),
    [props.databaseId, props.actions],
  );
  const actions = parseActions(props, legacy);

  const run = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!actions.some((a) => a.type !== "unsupported")) return settings.open(e.currentTarget);
    setBusy(true);
    try {
      const result = await runActions(actions, {
        origin: "button",
        pageId: pageId || undefined,
        source: props.label || "Botón",
        confirm: async (action) => {
          const ok = await new Promise<boolean>((done) => setConfirm({ action, done }));
          setConfirm(null);
          return ok;
        },
        insert: (content, position) => onInsert?.(content, position, pageId || undefined),
        open: navigate,
      });
      if (actions.some((a) => a.type === "edit_pages") && !result.cancelled)
        toast(`${result.edited} ${result.edited === 1 ? "página editada" : "páginas editadas"}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const icon = props.icon ? iconUrl(props.icon) : null;
  return (
    <div className="xot-button-wrap" contentEditable={false}>
      <button type="button" className={`xot-button xot-button--${props.color}`} onClick={run} disabled={busy}>
        <ButtonIcon icon={props.icon} url={icon} />
        <span className="xot-button__label">{props.label || "Botón"}</span>
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm xot-button__gear"
        aria-label="Configurar botón"
        onClick={(e) => settings.toggle(e.currentTarget)}
      >
        <Settings2 size={14} />
      </button>
      {settings.anchor && (
        <Popover anchor={settings.anchor} onClose={settings.close} width={380}>
          <ButtonSettings props={props} actions={actions} pageId={pageId} onChange={onChange} />
        </Popover>
      )}
      {confirm && (
        <ConfirmDialog
          text={confirm.action.text.map(([text, bold], i) => (bold ? <strong key={i}>{text}</strong> : <span key={i}>{text}</span>))}
          confirm={confirm.action.continue || "Continuar"}
          cancel={confirm.action.cancel || "Cancelar"}
          onDone={confirm.done}
        />
      )}
    </div>
  );
}

function ButtonIcon({ icon, url }: { icon: string; url: string | null }) {
  // The gray line icons follow the text color, so they stay visible in dark mode.
  if (url && /\/icons\/[^/?]*_gray\.svg/.test(icon))
    return <span className="xot-button__icon xot-button__icon--mask" style={{ WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")` }} />;
  if (url) return <img className="xot-button__icon" src={url} alt="" width={20} height={20} />;
  return icon ? <span className="xot-button__icon">{icon}</span> : null;
}

function ButtonSettings({
  props,
  actions,
  pageId,
  onChange,
}: {
  props: ButtonProps;
  actions: Action[];
  pageId: string;
  onChange: (p: Partial<ButtonProps>) => void;
}) {
  const iconPop = usePopover();
  // A button on a database page can edit that page ("Editar propiedad").
  const host = useLiveQuery(async () => (pageId ? await db.blocks.get(pageId) : undefined), [pageId]);
  const rowCollection = host?.parent_table === "collection" ? host.parent_id : undefined;
  const save = (next: Action[]) => onChange({ actions: JSON.stringify(next), databaseId: "", pageTitle: "" });
  const url = props.icon ? iconUrl(props.icon) : null;

  return (
    <div className="chart-settings button-settings">
      <div className="button-settings__name">
        <button
          type="button"
          className="icon-btn button-settings__icon"
          aria-label="Icono del botón"
          title="Icono"
          onClick={(e) => iconPop.toggle(e.currentTarget)}
        >
          {props.icon ? <ButtonIcon icon={props.icon} url={url} /> : <Smile size={16} />}
        </button>
        <input
          className="field field--sm"
          defaultValue={props.label}
          placeholder="Nombre del botón"
          onBlur={(e) => onChange({ label: e.target.value })}
          autoFocus
          aria-label="Nombre"
        />
      </div>
      {iconPop.anchor && (
        <Popover anchor={iconPop.anchor} onClose={iconPop.close} width={408}>
          <EmojiPicker
            onPick={(icon) => {
              onChange({ icon });
              iconPop.close();
            }}
            onRemove={() => {
              onChange({ icon: "" });
              iconPop.close();
            }}
          />
        </Popover>
      )}
      <label className="setting">
        <span>Color</span>
        <select className="field field--sm" value={props.color} onChange={(e) => onChange({ color: e.target.value })}>
          {OPTION_COLORS.map((c: OptionColor) => (
            <option key={c} value={c}>
              {OPTION_COLOR_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <MenuLabel>Al hacer clic</MenuLabel>
      {actions.length === 0 && <p className="muted button-settings__empty">Este botón aún no hace nada.</p>}
      <ActionsEditor
        actions={actions}
        onChange={save}
        allowed={rowCollection ? BLOCK_ACTIONS : BLOCK_ACTIONS.filter((t) => t !== "edit_this")}
        thisCollectionId={rowCollection}
        thisLabel="esta página"
      />
    </div>
  );
}
