import type { Node as PMNode } from "@tiptap/pm/model";

export function extractMarkedRange(
  doc: PMNode,
  markName: string,
  threadId: string,
): { from: number; to: number; text: string } | null {
  let from: number | null = null;
  let to: number | null = null;
  const lines: string[] = [];
  let currentLine = "";
  let pendingMarker: string | null = null;
  const listStack: Array<{ kind: "bullet" | "ordered"; n: number }> = [];

  const pushLine = () => {
    if (currentLine.trim().length > 0) lines.push(currentLine);
    currentLine = "";
  };

  const walk = (node: PMNode, basePos: number) => {
    const name = node.type.name;

    if (node.isText) {
      const marked = node.marks.some(
        (m) => m.type.name === markName && m.attrs.threadId === threadId,
      );
      if (marked) {
        if (from === null) from = basePos;
        to = basePos + node.nodeSize;
        currentLine += node.text ?? "";
      }
      return;
    }

    if (name === "hardBreak") {
      pushLine();
      return;
    }

    const pushedList =
      name === "bulletList"
        ? (listStack.push({ kind: "bullet", n: 0 }), true)
        : name === "orderedList"
          ? (listStack.push({ kind: "ordered", n: 1 }), true)
          : false;

    if (name === "listItem") {
      const top = listStack[listStack.length - 1];
      if (top?.kind === "bullet") pendingMarker = "• ";
      else if (top?.kind === "ordered") {
        pendingMarker = `${top.n}. `;
        top.n += 1;
      }
    }

    const blockStart = name === "paragraph" || name === "heading";
    if (blockStart) {
      const prefix = pendingMarker ?? "";
      pendingMarker = null;
      pushLine();
      currentLine = prefix;
    }

    const childBase = name === "doc" ? basePos : basePos + 1;
    let offset = childBase;
    node.forEach((child) => {
      walk(child, offset);
      offset += child.nodeSize;
    });

    if (blockStart) pushLine();
    if (pushedList) listStack.pop();
  };

  walk(doc, 0);
  pushLine();

  if (from === null || to === null) return null;
  return { from, to, text: lines.join("\n") };
}
