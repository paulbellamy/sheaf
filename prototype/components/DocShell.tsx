"use client";

import { useEffect, useState, type ReactNode } from "react";

import { DocRail } from "./DocRail";

const STORAGE_KEY = "sheaf:doc-rail-collapsed";

export function DocShell({
  activePath,
  activeRef,
  children,
}: {
  activePath?: string;
  activeRef?: string;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // ignore
    }
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <div className={`doc-shell${collapsed ? " collapsed" : ""}`}>
      <div className="doc-rail-wrap">
        <button
          type="button"
          className="rail-toggle"
          onClick={toggle}
          aria-label={collapsed ? "expand sidebar" : "collapse sidebar"}
          title={collapsed ? "expand sidebar" : "collapse sidebar"}
        >
          {collapsed ? "›" : "‹"}
        </button>
        {collapsed ? null : (
          <DocRail activePath={activePath} activeRef={activeRef} />
        )}
      </div>
      <main className="doc-main">{children}</main>
    </div>
  );
}
