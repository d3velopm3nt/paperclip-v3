import { useEffect } from "react";
import { NavLink, Outlet } from "@/lib/router";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { cn } from "../lib/utils";

const tabClass = (isActive: boolean) =>
  cn(
    "px-3 py-2 text-sm border-b-2 -mb-px transition-colors",
    isActive
      ? "border-primary text-foreground font-medium"
      : "border-transparent text-muted-foreground hover:text-foreground",
  );

export function FounderView() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Founder" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 pt-4 pb-0 shrink-0">
        <h1 className="text-xl font-semibold mb-3">Founder Overview</h1>
        <nav className="flex gap-1">
          <NavLink to="/founder" end className={({ isActive }) => tabClass(isActive)}>
            Overview
          </NavLink>
          <NavLink to="/founder/topics" className={({ isActive }) => tabClass(isActive)}>
            Topics
          </NavLink>
          <NavLink to="/founder/settings" className={({ isActive }) => tabClass(isActive)}>
            Settings
          </NavLink>
        </nav>
      </div>
      <div className="flex-1 overflow-auto p-6">
        <Outlet />
      </div>
    </div>
  );
}
