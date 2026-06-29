import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSheafApp } from "../app";
import { StubBackend } from "../backend/stub";
import {
  BUILD_VOICE_GUIDE_MARKER,
  VOICE_GUIDE_PATH,
  defaultStyleConfig,
} from "./profile";

const PARA =
  "The team shipped the change on a Tuesday. Nobody noticed at first. Then the " +
  "numbers moved and we knew it worked. We kept it small and watched the graphs. ";

describe("style HTTP routes", () => {
  let root: string;
  let backend: StubBackend;
  let app: ReturnType<typeof buildSheafApp>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sheaf-style-routes-"));
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "notes", "a.md"), `# A\n${PARA}${PARA}`);
    await fs.writeFile(path.join(root, "notes", "b.md"), `# B\n${PARA}${PARA}`);
    backend = new StubBackend(root);
    app = buildSheafApp(backend);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const inject = (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        host: "localhost",
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      payload: payload !== undefined ? JSON.stringify(payload) : undefined,
    });

  it("GET returns the default config", async () => {
    const res = await inject("GET", "/api/ui/style/config");
    expect(res.statusCode).toBe(200);
    expect(res.json().config.enabled).toBe(true);
  });

  it("PUT persists a config the agent can read back", async () => {
    const config = defaultStyleConfig();
    config.enabled = false;
    config.exemplar_count = 4;
    config.exclude_globs = ["**/Private/**"];

    const put = await inject("PUT", "/api/ui/style/config", config);
    expect(put.statusCode).toBe(200);

    const stored = await backend.readStyleConfig();
    expect(stored.enabled).toBe(false);
    expect(stored.exemplar_count).toBe(4);
    expect(stored.exclude_globs).toEqual(["**/Private/**"]);

    const get = await inject("GET", "/api/ui/style/config");
    expect(get.json().config.exclude_globs).toEqual(["**/Private/**"]);
  });

  it("PUT rejects an invalid config", async () => {
    const res = await inject("PUT", "/api/ui/style/config", { enabled: "yes" });
    expect(res.statusCode).toBe(400);
  });

  it("POST build computes metrics, creates the guide doc, and posts a request thread", async () => {
    const res = await inject("POST", "/api/ui/style/build");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.thread_id).toMatch(/^thrd_/);
    expect(body.doc_count).toBe(2);
    expect(body.word_count).toBeGreaterThan(0);

    // Visible, user-editable guide doc was created.
    const guide = await backend.readDoc(VOICE_GUIDE_PATH, "main");
    expect(guide.md).toContain("Voice Guide");

    // The agent will see a build-voice-guide request thread.
    const threads = await backend.listThreads({ path: VOICE_GUIDE_PATH, ref: "main" });
    expect(threads).toHaveLength(1);
    const thread = await backend.readThread(threads[0].id);
    expect(thread.messages[0].author).toBe("user");
    expect(thread.messages[0].body.startsWith(BUILD_VOICE_GUIDE_MARKER)).toBe(true);
  });
});
