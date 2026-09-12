import { describe, expect, it } from "vitest";

import { renderReadMe } from "./readme";

/**
 * The ReadMe text is parameterized two ways (step 4): the daemon's real origin
 * for the curl fallback, and a standalone mode with no live event stream.
 */
describe("renderReadMe", () => {
  it("interpolates the daemon's real origin into the curl fallback", () => {
    const text = renderReadMe({ publicUrl: "http://127.0.0.1:4242" });
    // Leads with the CLI tail and points curl at the real bound port.
    expect(text).toContain("sheaf events follow --role agent");
    expect(text).toContain("http://127.0.0.1:4242/api/ui/drafts/stream");
    // The old hard-coded default is gone when a publicUrl is supplied.
    expect(text).not.toContain("31415");
  });

  it("falls back to a default origin when none is supplied", () => {
    const text = renderReadMe();
    expect(text).toContain("sheaf events follow --role agent");
    expect(text).toContain("http://localhost:31415/api/ui/drafts/stream");
  });

  it("replaces the whole subscribe section in standalone mode", () => {
    const text = renderReadMe({ standalone: true });
    // No daemon → no Monitor invocation of the CLI tail, no curl loop, no port.
    // (It may still name `sheaf events follow` to tell the agent NOT to run it.)
    expect(text).not.toContain("command: 'sheaf events follow --role agent'");
    expect(text).not.toContain("/api/ui/drafts/stream");
    expect(text).not.toContain("31415");
    // Tells the agent to poll ListThreads instead.
    expect(text).toContain("no live events");
    expect(text.toLowerCase()).toContain("poll");
    expect(text).toContain("ListThreads(ref:");
    // The rest of the guide is intact.
    expect(text).toContain("## Tools you'll use");
  });
});
