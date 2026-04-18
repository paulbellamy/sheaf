export type DraftVariant = {
  id: string;
  author: string;
  replacement: string;
  note: string;
};

export type Thread = {
  id: string;
  anchorText: string;
  variants: DraftVariant[];
  activeVariantId: string;
  state: "open" | "accepted" | "declined";
  createdAt: number;
};

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}
