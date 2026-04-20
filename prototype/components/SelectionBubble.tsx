"use client";

import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import { useState } from "react";

type Range = { from: number; to: number };

type Props = {
  editor: Editor | null;
  onComment: () => void;
  onStructuralMark: (label: string, range?: Range) => void;
  onIndent: () => void;
  onOutdent: () => void;
};

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11.5 2.5l2 2-8 8-2.5.5.5-2.5 8-8z" />
      <path d="M10 4l2 2" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.5 9.5l3-3" />
      <path d="M7 4.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L10.5 8" />
      <path d="M9 11.5L7.5 13a2.5 2.5 0 0 1-3.5-3.5L5.5 8" />
    </svg>
  );
}

function BulletListIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="3" cy="4" r="0.8" fill="currentColor" />
      <circle cx="3" cy="8" r="0.8" fill="currentColor" />
      <circle cx="3" cy="12" r="0.8" fill="currentColor" />
      <path d="M6 4h8" />
      <path d="M6 8h8" />
      <path d="M6 12h8" />
    </svg>
  );
}

function OrderedListIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <text x="1" y="5.5" fontSize="4" fill="currentColor" stroke="none" fontFamily="inherit">1.</text>
      <text x="1" y="9.5" fontSize="4" fill="currentColor" stroke="none" fontFamily="inherit">2.</text>
      <text x="1" y="13.5" fontSize="4" fill="currentColor" stroke="none" fontFamily="inherit">3.</text>
      <path d="M6 4h8" />
      <path d="M6 8h8" />
      <path d="M6 12h8" />
    </svg>
  );
}

function TaskListIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="3" height="3" rx="0.5" />
      <rect x="1.5" y="6.5" width="3" height="3" rx="0.5" />
      <rect x="1.5" y="10.5" width="3" height="3" rx="0.5" />
      <path d="M2.2 4l0.7 0.7 1.4 -1.4" />
      <path d="M6.5 4h8" />
      <path d="M6.5 8h8" />
      <path d="M6.5 12h8" />
    </svg>
  );
}

export function SelectionBubble({
  editor,
  onComment,
  onStructuralMark,
  onIndent,
  onOutdent,
}: Props) {
  const [linkMode, setLinkMode] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  if (!editor) return null;

  const currentRange = (): Range | undefined => {
    const { from, to } = editor.state.selection;
    return from !== to ? { from, to } : undefined;
  };

  // Formatting mark toggles (bold/italic/underline/strike/code) let the
  // editor handle the transaction; the Manuscript's transaction reconciler
  // creates or removes the matching margin thread automatically. That keeps
  // Cmd+B, toolbar clicks, and undo/redo in one place.
  const runMark = (action: () => void) => {
    action();
  };

  const runWithRange = (action: () => void, label: string) => {
    const range = currentRange();
    action();
    onStructuralMark(label, range);
  };

  const describeBlock = (): string => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      if (editor.isActive("heading", { level })) return `H${level}`;
    }
    if (editor.isActive("bulletList")) return "bullet list";
    if (editor.isActive("orderedList")) return "numbered list";
    if (editor.isActive("taskList")) return "task list";
    if (editor.isActive("blockquote")) return "blockquote";
    if (editor.isActive("codeBlock")) return "code block";
    return "¶";
  };

  const toggleBlock = (
    kind: "heading" | "bulletList" | "orderedList" | "taskList",
  ) => {
    const range = currentRange();
    const before = describeBlock();
    const chain = editor.chain().focus();
    switch (kind) {
      case "heading":
        chain.toggleHeading({ level: 2 }).run();
        break;
      case "bulletList":
        chain.toggleBulletList().run();
        break;
      case "orderedList":
        chain.toggleOrderedList().run();
        break;
      case "taskList":
        chain.toggleTaskList().run();
        break;
    }
    const after = describeBlock();
    if (before === after) return;
    onStructuralMark(`${before} → ${after}`, range);
  };

  const applyLink = () => {
    if (!linkUrl) {
      setLinkMode(false);
      return;
    }
    const range = currentRange();
    editor.chain().focus().extendMarkRange("link").setLink({ href: linkUrl }).run();
    onStructuralMark("linked text", range);
    setLinkUrl("");
    setLinkMode(false);
  };

  return (
    <BubbleMenu editor={editor} className="selection-bubble">
      {!linkMode ? (
        <div className="bubble-row">
          <button
            className="bubble-btn"
            data-active={editor.isActive("bold") ? "true" : "false"}
            onClick={() =>
              runMark(() => editor.chain().focus().toggleBold().run())
            }
            aria-label="bold"
            title="bold"
          >
            <strong>B</strong>
          </button>
          <button
            className="bubble-btn"
            data-active={editor.isActive("italic") ? "true" : "false"}
            onClick={() =>
              runMark(() => editor.chain().focus().toggleItalic().run())
            }
            aria-label="italic"
            title="italic"
          >
            <em>I</em>
          </button>
          <button
            className="bubble-btn"
            data-active={editor.isActive("underline") ? "true" : "false"}
            onClick={() =>
              runMark(() => editor.chain().focus().toggleUnderline().run())
            }
            aria-label="underline"
            title="underline"
          >
            <span style={{ textDecoration: "underline" }}>U</span>
          </button>
          <button
            className="bubble-btn"
            data-active={editor.isActive("strike") ? "true" : "false"}
            onClick={() =>
              runMark(() => editor.chain().focus().toggleStrike().run())
            }
            aria-label="strikethrough"
            title="strikethrough"
          >
            <s>S</s>
          </button>
          <button
            className="bubble-btn"
            data-active={editor.isActive("code") ? "true" : "false"}
            onClick={() =>
              runMark(() => editor.chain().focus().toggleCode().run())
            }
            aria-label="inline code"
            title="inline code"
          >
            {"</>"}
          </button>
          <button
            className="bubble-btn"
            onClick={() => setLinkMode(true)}
            aria-label="link"
            title="link"
          >
            <LinkIcon />
          </button>
          <span className="bubble-sep" />
          <button
            className="bubble-btn"
            data-active={editor.isActive("heading", { level: 2 }) ? "true" : "false"}
            onClick={() => toggleBlock("heading")}
            aria-label="heading"
            title="heading"
          >
            H
          </button>
          <span className="bubble-sep" />
          <button
            className="bubble-btn"
            data-active={editor.isActive("bulletList") ? "true" : "false"}
            onClick={() => toggleBlock("bulletList")}
            aria-label="bullet list"
            title="bullet list"
          >
            <BulletListIcon />
          </button>
          <button
            className="bubble-btn"
            data-active={editor.isActive("orderedList") ? "true" : "false"}
            onClick={() => toggleBlock("orderedList")}
            aria-label="numbered list"
            title="numbered list"
          >
            <OrderedListIcon />
          </button>
          <button
            className="bubble-btn"
            data-active={editor.isActive("taskList") ? "true" : "false"}
            onClick={() => toggleBlock("taskList")}
            aria-label="task list"
            title="task list"
          >
            <TaskListIcon />
          </button>
          <span className="bubble-sep" />
          <button
            className="bubble-btn"
            onClick={() => runWithRange(onOutdent, "outdent")}
            aria-label="outdent"
            title="outdent (shift+tab)"
          >
            ⇤
          </button>
          <button
            className="bubble-btn"
            onClick={() => runWithRange(onIndent, "indent")}
            aria-label="indent"
            title="indent (tab)"
          >
            ⇥
          </button>
          <span className="bubble-sep" />
          <button
            className="bubble-btn"
            onClick={onComment}
            aria-label="comment"
            title="note"
          >
            <PencilIcon />
          </button>
        </div>
      ) : (
        <div className="bubble-row link-row">
          <input
            autoFocus
            className="bubble-input"
            placeholder="https://…"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLinkMode(false);
                setLinkUrl("");
              }
            }}
          />
          <button className="bubble-btn" onClick={applyLink}>
            ↵
          </button>
        </div>
      )}
    </BubbleMenu>
  );
}
