"use client";

import { useJson } from "./useJson";

export type DocEntry = {
  path: string;
  title: string;
  workspace: string;
  updated_at: number;
};

export type DraftEntry = {
  draft_id: string;
  base_path: string;
  primary_path: string;
  changed_paths: string[];
  name?: string;
  state: "open" | "submitted";
  author: string;
  workspace: string;
  created_at: number;
};

export type DocsIndex = { docs: DocEntry[]; drafts: DraftEntry[] };

/** Shared loader for `/api/ui/docs` — the doc list + in-flight drafts. */
export function useDocsIndex() {
  return useJson<DocsIndex>("/api/ui/docs", []);
}
