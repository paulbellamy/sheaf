"use client";

import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import { useState } from "react";

type Props = {
  editor: Editor | null;
  onComment: () => void;
  onStructuralMark: (label: string) => void;
  onIndent: () => void;
  onOutdent: () => void;
};

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

  const run = (action: () => void, label: string) => {
    action();
    onStructuralMark(label);
  };

  const applyLink = () => {
    if (!linkUrl) {
      setLinkMode(false);
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: linkUrl }).run();
    onStructuralMark("linked text");
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
              run(() => editor.chain().focus().toggleBold().run(), "bold")
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
              run(() => editor.chain().focus().toggleItalic().run(), "italic")
            }
            aria-label="italic"
            title="italic"
          >
            <em>I</em>
          </button>
          <button
            className="bubble-btn"
            data-active={editor.isActive("code") ? "true" : "false"}
            onClick={() =>
              run(
                () => editor.chain().focus().toggleCode().run(),
                "inline code",
              )
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
            onClick={() => {
              onOutdent();
              onStructuralMark("outdent");
            }}
            aria-label="outdent"
            title="outdent (shift+tab)"
          >
            ⇤
          </button>
          <button
            className="bubble-btn"
            onClick={() => {
              onIndent();
              onStructuralMark("indent");
            }}
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
            ✎
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
