import { createContext, useContext, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { CollectionView } from "../../lib/model";

/**
 * Views load a limited number of rows (per group on boards) and
 * offer "Load more". The default depends on where the database is shown.
 */
export const LoadLimitContext = createContext(50);

export function useLoadLimit(view: CollectionView) {
  const fallback = useContext(LoadLimitContext);
  const base = view.format.load_limit ?? fallback;
  const [extra, setExtra] = useState(0);
  return [base + extra, () => setExtra((e) => e + base)] as const;
}

export function LoadMore({ hidden, onMore }: { hidden: number; onMore: () => void }) {
  if (hidden <= 0) return null;
  return (
    <button type="button" className="load-more" onClick={onMore}>
      <ChevronDown size={14} /> Cargar más ({hidden})
    </button>
  );
}
