import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Download } from "lucide-react";
import type { Block } from "../lib/model";
import { setFormat } from "../lib/ops";
import { Popover, usePopover } from "./ui";

/**
 * "Color y degradado": the solid covers (red, yellow, blue and beige
 * tones) and soft gradients. Stored as "gradient:N", so the order stays put.
 */
const GRADIENTS = [
  "#f7d9d5",
  "#f2e3b7",
  "#cee3f7",
  "#f0efed",
  "linear-gradient(120deg, #f7d9d5 0%, #e8deee 50%, #cee3f7 100%)",
  "linear-gradient(160deg, #fde2c8 0%, #f6c6d8 45%, #c9d6f7 100%)",
  // CSS stand-ins for the other gradients; appended so stored "gradient:N" indexes stay stable.
  "linear-gradient(135deg, #ffd3a5 0%, #fd6585 100%)",
  "linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)",
  "linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)",
  "linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)",
];

export const randomGradient = () => `gradient:${Math.floor(Math.random() * GRADIENTS.length)}`;

/** "Agregar portada" picks a random color or gradient. */
export const randomCover = randomGradient;

/** Image URL for a stored cover: a local file ("/…") or any URL. */
export const coverSrc = (cover: string) => cover;

export const gradientOf = (cover: string) =>
  cover.startsWith("gradient:") ? GRADIENTS[Number(cover.slice(9)) % GRADIENTS.length] : null;

/** Saves the cover image, like the action bar's "Descargar". */
function downloadCover(cover: string) {
  const a = document.createElement("a");
  a.href = coverSrc(cover);
  a.download = cover.startsWith("data:") ? "portada" : decodeURIComponent(cover.split(/[?#]/)[0].split("/").pop() || "portada");
  a.target = "_blank";
  a.rel = "noopener";
  a.click();
}

/**
 * The banner above a page. Its hover bar is the cover's action bar:
 * "Cambiar" opens the picker, "Reposicionar" drags the image, the arrow downloads it.
 */
export function PageCover({ block }: { block: Block }) {
  const cover = block.format.cover!;
  const saved = block.format.cover_position ?? 0.5;
  // Reposition mode: the unsaved position while dragging.
  const [draft, setDraft] = useState<number | null>(null);
  const picker = usePopover();
  const imgRef = useRef<HTMLImageElement>(null);
  const gradient = gradientOf(cover);
  const position = draft ?? saved;
  // In the trash, like a locked page: no cover controls until it's restored.
  const locked = !!block.format.locked || !block.alive;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const img = imgRef.current;
    if (draft === null || !img || !img.naturalWidth) return;
    if ((e.target as HTMLElement).closest(".page-cover__actions")) return;
    e.preventDefault();
    const box = img.getBoundingClientRect();
    // How far the rendered image overflows the banner (object-fit: cover).
    const overflow = (box.width * img.naturalHeight) / img.naturalWidth - box.height;
    if (overflow < 1) return;
    const startY = e.clientY;
    const start = draft;
    const onMove = (ev: PointerEvent) =>
      setDraft(Math.min(1, Math.max(0, start + (ev.clientY - startY) / overflow)));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className={`page-cover${draft !== null ? " is-repositioning" : ""}`}
      onPointerDown={onPointerDown}
    >
      {gradient ? (
        <div className="page-cover__fill" style={{ background: gradient }} />
      ) : (
        <img
          ref={imgRef}
          src={coverSrc(cover)}
          alt=""
          draggable={false}
          style={{ objectPosition: `center ${(1 - position) * 100}%` }}
        />
      )}
      {draft !== null && <div className="page-cover__hint">Arrastra la imagen para cambiar su posición</div>}
      {/* Shown on :hover in CSS (so a cover added under a still pointer has it too), and while in use. */}
      {!locked && (
        <div
          className={`page-cover__column${block.format.full_width ? " page-cover__column--full" : ""}${
            picker.anchor ? " is-open" : ""
          }`}
        >
          <div className="page-cover__actions">
            {draft === null ? (
              <>
                <button type="button" onClick={(e) => picker.toggle(e.currentTarget)}>
                  Cambiar
                </button>
                {!gradient && (
                  <>
                    <span className="page-cover__sep" />
                    <button type="button" onClick={() => setDraft(saved)}>
                      Reposicionar
                    </button>
                    <span className="page-cover__sep" />
                    <button
                      type="button"
                      className="page-cover__icon-btn"
                      aria-label="Descargar"
                      data-tooltip="Descargar"
                      onClick={() => downloadCover(cover)}
                    >
                      <Download size={14} />
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    void setFormat(block.id, { cover_position: draft });
                    setDraft(null);
                  }}
                >
                  Guardar posición
                </button>
                <span className="page-cover__sep" />
                <button type="button" onClick={() => setDraft(null)}>
                  Cancelar
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {picker.anchor && (
        <Popover anchor={picker.anchor} onClose={picker.close} width={540} align="end">
          <CoverPicker
            onPick={(value) => {
              void setFormat(block.id, value ? { cover: value, cover_position: 0.5 } : { cover: undefined });
              picker.close();
            }}
          />
        </Popover>
      )}
    </div>
  );
}

/** The cover picker: Galería / Subir / Enlace tabs, with "Quitar" on the right. */
function CoverPicker({ onPick }: { onPick: (cover: string | undefined) => void }) {
  const [tab, setTab] = useState<"gallery" | "upload" | "link">("gallery");
  const [link, setLink] = useState("");

  const upload = (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" && onPick(reader.result);
    reader.readAsDataURL(file);
  };

  return (
    <div className="cover-picker">
      <div className="cover-picker__tabs">
        {(
          [
            ["gallery", "Galería"],
            ["upload", "Subir"],
            ["link", "Enlace"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`cover-picker__tab${tab === id ? " is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <button type="button" className="cover-picker__tab cover-picker__remove" onClick={() => onPick(undefined)}>
          Quitar
        </button>
      </div>
      <div className="cover-picker__body">
        {tab === "gallery" && (
          <>
            <div className="cover-picker__label">Color y degradado</div>
            <div className="cover-picker__grid">
              {GRADIENTS.map((g, i) => (
                <button
                  key={g}
                  type="button"
                  className="cover-picker__item"
                  style={{ background: g }}
                  aria-label={`Degradado ${i + 1}`}
                  onClick={() => onPick(`gradient:${i}`)}
                />
              ))}
            </div>
          </>
        )}
        {tab === "upload" && (
          <div className="cover-picker__center">
            <label className="cover-picker__upload">
              Subir archivo
              <input type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
            </label>
            <div className="cover-picker__note">Las imágenes más anchas que 1500 píxeles funcionan mejor.</div>
          </div>
        )}
        {tab === "link" && (
          <form
            className="cover-picker__center"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^(https?:|data:image\/)/.test(link.trim())) onPick(link.trim());
            }}
          >
            <input
              className="cover-picker__input"
              autoFocus
              placeholder="Pega un enlace de imagen…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
            <button type="submit" className="primary-btn cover-picker__submit">
              Enviar
            </button>
            <div className="cover-picker__note">Funciona con cualquier imagen de la web.</div>
          </form>
        )}
      </div>
    </div>
  );
}
