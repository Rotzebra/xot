import { ChevronsRight, Menu } from "lucide-react";

/** The closed-sidebar toggle's icon: "≡" at rest, "»" while hovered (CSS swaps them). */
export function SidebarOpenIcon() {
  return (
    <>
      <span className="topbar__sidebar-rest" aria-hidden="true">
        <Menu size={18} />
      </span>
      <span className="topbar__sidebar-hover" aria-hidden="true">
        <ChevronsRight size={18} />
      </span>
    </>
  );
}
