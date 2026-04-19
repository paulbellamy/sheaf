export type Thread = {
  id: string;
  note: string;
  state: "open" | "accepted" | "declined";
  createdAt: number;
};

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}
