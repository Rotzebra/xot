import { useSyncExternalStore } from "react";
import { liveQuery } from "dexie";
import { MessageSquareText } from "lucide-react";
import { db } from "../../lib/db";
import { PropertyThreads } from "../Comments";
import { Popover, usePopover } from "../ui";

// Comments on property values: how many open threads each page's property has,
// kept in one shared live query (tables show a count on every commented cell).

let counts = new Map<string, number>();
const listeners = new Set<() => void>();
let started = false;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    liveQuery(() => db.threads.filter((t) => !!t.metadata?.property && !t.resolved).toArray()).subscribe((threads) => {
      const next = new Map<string, number>();
      for (const t of threads) {
        const key = `${t.page_id}:${t.metadata.property}`;
        next.set(key, (next.get(key) ?? 0) + t.comments.length);
      }
      counts = next;
      for (const l of listeners) l();
    });
  }
  return () => listeners.delete(listener);
}

export function usePropertyCommentCount(pageId: string, propertyId: string) {
  return useSyncExternalStore(subscribe, () => counts.get(`${pageId}:${propertyId}`) ?? 0);
}

/** The comment bubble by a property's value: the count when it has comments, else on hover; opens its threads. */
export function PropertyCommentButton({ pageId, propertyId, readOnly }: { pageId: string; propertyId: string; readOnly?: boolean }) {
  const count = usePropertyCommentCount(pageId, propertyId);
  const pop = usePopover();
  if (readOnly && !count) return null;
  return (
    <>
      <button
        type="button"
        className={`prop-comment-btn${count ? " has-comments" : ""}${pop.anchor ? " is-open" : ""}`}
        aria-label={count ? `${count} comentarios` : "Comentar"}
        data-tooltip={count ? undefined : "Comentar"}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          pop.toggle(e.currentTarget);
        }}
      >
        <MessageSquareText size={14} />
        {count > 0 && <span>{count}</span>}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={360} align="end">
          <div className="prop-comments" onMouseDown={(e) => e.stopPropagation()}>
            <PropertyThreads pageId={pageId} propertyId={propertyId} readOnly={readOnly} />
          </div>
        </Popover>
      )}
    </>
  );
}
