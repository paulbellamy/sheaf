"use client";

import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { useMemo } from "react";

type Props = ReactNodeViewProps;

export function CodeBlockView({ node, updateAttributes, extension }: Props) {
  const language: string = node.attrs.language ?? "";
  const wrap: boolean = !!node.attrs.wrap;

  const languages = useMemo<string[]>(() => {
    const ll = (extension.options as { lowlight?: { listLanguages: () => string[] } }).lowlight;
    const names = ll?.listLanguages?.() ?? [];
    return ["", ...names.sort()];
  }, [extension]);

  return (
    <NodeViewWrapper className="code-block" data-wrap={wrap ? "true" : "false"}>
      <div className="code-block-header" contentEditable={false}>
        <select
          className="code-lang"
          value={language}
          onChange={(e) => updateAttributes({ language: e.target.value || null })}
          aria-label="language"
        >
          {languages.map((l) => (
            <option key={l || "plain"} value={l}>
              {l || "plain"}
            </option>
          ))}
        </select>
        <label className="code-wrap">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => updateAttributes({ wrap: e.target.checked })}
          />
          <span>wrap</span>
        </label>
      </div>
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
