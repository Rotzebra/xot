import { useState } from "react";
import { Check, Search, X } from "lucide-react";
import type { CollectionView, ParentTable, PropertyValue } from "../lib/model";
import { navigate } from "../lib/hooks";
import { applyGalleryTemplate, blockText, GALLERY, GALLERY_CATEGORIES, type GalleryBlock, type GalleryTemplate } from "../lib/templateGallery";
import { isDynamicDate, resolveDynamicDate } from "../lib/templates";
import { formatDate, Tag, TypeIcon } from "./database/properties";
import { viewIcon } from "./database/DatabaseView";
import { Modal, toast } from "./ui";

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * "Plantillas": the template gallery, local. Templates by category on the
 * left (with a search), the chosen one previewed on the right, and "Usar plantilla"
 * builds it as a new page or database in the workspace and opens it.
 */
export function TemplateGallery({ parent, onClose }: { parent: [ParentTable, string]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(GALLERY[0].id);
  const [busy, setBusy] = useState(false);
  const q = fold(query.trim());
  const shown = GALLERY.filter((t) => !q || fold(`${t.name} ${t.description} ${t.category}`).includes(q));
  const t = GALLERY.find((x) => x.id === current) ?? GALLERY[0];
  const use = async () => {
    setBusy(true);
    try {
      const id = await applyGalleryTemplate(t, parent);
      onClose();
      navigate(id);
      toast(`Se añadió «${t.name}»`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal className="template-gallery" label="Plantillas" onClose={onClose}>
      <aside className="template-gallery__nav">
        <div className="template-gallery__heading">Plantillas</div>
        <label className="template-gallery__search">
          <Search size={14} />
          <input autoFocus placeholder="Buscar plantillas…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="template-gallery__list">
          {GALLERY_CATEGORIES.map((category) => {
            const items = shown.filter((x) => x.category === category);
            if (!items.length) return null;
            return (
              <div key={category}>
                <div className="template-gallery__category">{category}</div>
                {items.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    className={`template-gallery__item${x.id === t.id ? " is-active" : ""}`}
                    onClick={() => setCurrent(x.id)}
                    onDoubleClick={() => void use()}
                  >
                    <span className="template-gallery__icon">{x.icon}</span>
                    <span className="template-gallery__name">{x.name}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {!shown.length && <div className="menu-empty">Sin resultados</div>}
        </div>
      </aside>
      <section className="template-gallery__main">
        <header className="template-gallery__top">
          <div className="template-gallery__about">
            <div className="template-gallery__title">{t.name}</div>
            <div className="template-gallery__desc">
              {t.database ? "Base de datos" : "Página"} · {t.description}
            </div>
          </div>
          <button type="button" className="xot-btn xot-btn--primary" disabled={busy} onClick={() => void use()}>
            Usar plantilla
          </button>
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="template-gallery__preview" key={t.id}>
          <div className="template-preview">
            <div className="template-preview__icon">{t.icon}</div>
            <h1 className="template-preview__title">{t.name}</h1>
            {t.database ? <DatabasePreview t={t} /> : <BlocksPreview blocks={t.blocks ?? []} />}
          </div>
        </div>
      </section>
    </Modal>
  );
}

function BlocksPreview({ blocks }: { blocks: GalleryBlock[] }) {
  return (
    <div className="template-preview__body">
      {blocks.map((b, i) => {
        const text = blockText(b);
        switch (b.type) {
          case "heading":
            return (
              <div key={i} className={`template-preview__h${b.props?.level ?? 1}`}>
                {text}
              </div>
            );
          case "bulletListItem":
            return (
              <div key={i} className="template-preview__li">
                <span className="template-preview__bullet">•</span>
                {text || <span className="template-preview__ph">Lista</span>}
              </div>
            );
          case "checkListItem":
            return (
              <div key={i} className="template-preview__li">
                <span className={`checkbox${b.props?.checked ? " is-checked" : ""}`}>{b.props?.checked ? <Check size={12} /> : null}</span>
                {text || <span className="template-preview__ph">Tarea pendiente</span>}
              </div>
            );
          case "callout":
            return (
              <div key={i} className="template-preview__callout">
                <span>{String(b.props?.icon ?? "💡")}</span>
                {text}
              </div>
            );
          case "divider":
            return <hr key={i} className="template-preview__divider" />;
          default:
            return (
              <p key={i} className="template-preview__p">
                {text}
              </p>
            );
        }
      })}
    </div>
  );
}

function DatabasePreview({ t }: { t: GalleryTemplate }) {
  const d = t.database!;
  const now = Date.now();
  const props = Object.entries(d.props);
  const cell = (key: string, v: PropertyValue | undefined) => {
    const prop = d.props[key];
    if (v === undefined || v === null || v === "") return null;
    const options = prop.options ?? [];
    const tag = (name: string) => {
      const i = options.findIndex(([value]) => value === name);
      return <Tag key={name} option={{ id: name, value: name, color: options[i]?.[1] ?? "default" }} status={prop.type === "status"} />;
    };
    if (prop.type === "select" || prop.type === "status") return tag(String(v));
    if (prop.type === "multi_select" && Array.isArray(v)) return (v as string[]).map(tag);
    if (prop.type === "checkbox") return <span className={`checkbox${v ? " is-checked" : ""}`}>{v ? <Check size={12} /> : null}</span>;
    if (prop.type === "date" && typeof v === "string") return formatDate(isDynamicDate(v) ? resolveDynamicDate(v, now) : v);
    if (prop.type === "person" && Array.isArray(v)) return (v as string[]).join(", ");
    return String(v);
  };
  return (
    <div className="template-preview__db">
      <div className="template-preview__tabs">
        {d.views.map((v, i) => {
          const Icon = viewIcon({ type: v.type, format: {} } as CollectionView);
          return (
            <span key={v.name} className={`template-preview__tab${i === 0 ? " is-active" : ""}`}>
              <Icon size={14} />
              {v.name}
            </span>
          );
        })}
      </div>
      <div className="template-preview__table">
        <div className="template-preview__row template-preview__row--head">
          {props.map(([key, p]) => (
            <span key={key} className="template-preview__cell">
              <TypeIcon type={p.type} size={14} />
              {p.name}
            </span>
          ))}
        </div>
        {d.rows.map((r, i) => (
          <div key={i} className="template-preview__row">
            {props.map(([key]) => (
              <span key={key} className={`template-preview__cell${key === "title" ? " template-preview__cell--title" : ""}`}>
                {key === "title" ? r.title : cell(key, r[key])}
              </span>
            ))}
          </div>
        ))}
      </div>
      {!!d.templates?.length && (
        <div className="template-preview__templates">
          Incluye {d.templates.length === 1 ? "la plantilla" : "las plantillas"}{" "}
          {d.templates.map((tp) => `«${tp.title}»`).join(", ")}
          {d.templates.some((tp) => Object.values(tp.values ?? {}).some(isDynamicDate)) ? ", con la fecha del día en que crees cada página" : ""}.
        </div>
      )}
    </div>
  );
}
