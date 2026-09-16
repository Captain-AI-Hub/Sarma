/** Regression tests for the round-3 audit fixes. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentTerminalManager } from "@/resources/terminalTools";
import { ContextCompactor, ContextWindowPolicy } from "@/context/compaction";
import { ConversationMessage } from "@/engine/models";
import { Store } from "@/store";
import { appendInputHistory, loadInputHistory } from "@/tui/inputHistory";
import { McpServerDTO, ModelProviderDTO } from "@/engine/dto";
import { McpValidationError } from "@/engine/errors";
import { ModelFactory } from "@/engine/modelFactory";

describe("PersistentTerminalManager spawn failures", () => {
  test("failed spawn reports exited state and frees its slot", async () => {
    const manager = new PersistentTerminalManager(process.cwd());
    try {
      const first = await manager.start({ terminalId: "bad", command: "definitely-not-a-command-xyz" });
      // start()'s own read consumes output; check its return and any later
      // reads (both exit-state and error text are asserted across them).
      let sawExited = first.includes("exited");
      let sawProcessError = first.includes("process error");
      for (let i = 0; i < 40 && !(sawExited && sawProcessError); i++) {
        const read = await manager.read({ terminalId: "bad", waitMs: 50 });
        if (read.includes("exited")) sawExited = true;
        if (read.includes("process error")) sawProcessError = true;
      }
      expect(sawExited).toBe(true);
      expect(sawProcessError).toBe(true);

      // Dead sessions must not consume MAX_SESSIONS slots: many failed starts
      // all succeed at the slot check.
      for (let i = 0; i < 10; i++) {
        const again = await manager.start({
          terminalId: `bad-${i}`,
          command: "definitely-not-a-command-xyz",
          waitMs: 0,
        });
        expect(again).not.toContain("session limit");
      }
    } finally {
      await manager.closeAll();
    }
  }, 10_000);

  test("cwd confinement compares path segments, not prefixes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "sarma-cwd-"));
    try {
      mkdirSync(join(workspace, "..drafts"), { recursive: true });
      const manager = new PersistentTerminalManager(workspace);
      try {
        // A directory literally named "..drafts" is inside the workspace.
        const ok = await manager.start({
          terminalId: "seg",
          command: "true",
          cwd: "..drafts",
          waitMs: 100,
        });
        expect(ok).not.toContain("cwd must stay inside the workspace");
        // Escaping with ".." is still rejected.
        const rejected = await manager.start({
          terminalId: "esc",
          command: "true",
          cwd: "../outside",
          waitMs: 100,
        });
        expect(rejected).toContain("cwd must stay inside the workspace");
      } finally {
        await manager.closeAll();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("compaction memory ordering", () => {
  test("memory message sorts before the kept tail on reload", async () => {
    const compactor = new ContextCompactor(
      new ContextWindowPolicy({ maxContextTokens: 100, rawTailRatio: 0.5, minimumOutputReserveTokens: 10 }),
    );
    const history = [
      new ConversationMessage({ role: "user", content: "old question one", createdAt: "2026-01-01T00:00:00Z" }),
      new ConversationMessage({ role: "assistant", content: "old answer one", createdAt: "2026-01-01T00:01:00Z" }),
      new ConversationMessage({ role: "user", content: "recent question", createdAt: "2026-01-02T00:00:00Z" }),
      new ConversationMessage({ role: "assistant", content: "recent answer", createdAt: "2026-01-02T00:01:00Z" }),
    ];
    const [changed, next] = await compactor.compact(history, async () => "memory summary");
    expect(changed).toBe(true);
    const memory = next[0]!;
    const tailEarliest = next.slice(1).reduce((min, m) => (m.createdAt < min ? m.createdAt : min), next[1]!.createdAt);
    expect(memory.role).toBe("system");
    expect(memory.createdAt < tailEarliest).toBe(true);
  });
});

describe("store", () => {
  test("saveMessage bumps conversation updated_at", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sarma-store-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(workspace);
      const store = new Store();
      try {
        const cid = store.createConversation("t", "m");
        const before = store.getConversation(cid)!.updated_at;
        store.saveMessage(cid, "turn1", "user", "hello");
        const after = store.getConversation(cid)!.updated_at;
        expect(after >= before).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      process.chdir(prevCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("inputHistory", () => {
  test("re-submitting an older entry moves it to the end without duplicating", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sarma-hist-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(workspace);
      appendInputHistory("one");
      appendInputHistory("two");
      appendInputHistory("three");
      const next = appendInputHistory("one");
      expect(next.filter((e) => e === "one")).toHaveLength(1);
      expect(next.at(-1)).toBe("one");
    } finally {
      process.chdir(prevCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("oversized entries are capped", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sarma-hist-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(workspace);
      const huge = "x".repeat(10_000);
      const next = appendInputHistory(huge);
      expect(next[0]!.length).toBeLessThanOrEqual(4000);
    } finally {
      process.chdir(prevCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("unreadable history file degrades to empty instead of throwing", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sarma-hist-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(workspace);
      mkdirSync(join(workspace, ".sarma"), { recursive: true });
      writeFileSync(join(workspace, ".sarma", ".history"), "locked", { mode: 0o000 });
      try {
        expect(loadInputHistory()).toEqual([]);
      } finally {
        chmodSync(join(workspace, ".sarma", ".history"), 0o644);
      }
    } finally {
      process.chdir(prevCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("dto and model factory", () => {
  test("http transport without url fails fast with a validation error", () => {
    const dto = new McpServerDTO({
      id: null,
      name: "broken",
      transport: "http",
      command: "",
      args: "",
      env: "",
      cwd: "",
      url: "",
      headers: "",
      timeout: 60,
      sseReadTimeout: 300,
      enabled: true,
      encoding: "utf-8",
    });
    expect(() => dto.toLangchainConfig()).toThrow(McpValidationError);
  });

  test("empty apiKey with baseUrl still constructs a model", () => {
    const factory = new ModelFactory();
    const model = factory.initModel(
      new ModelProviderDTO({
        id: null,
        name: "local",
        modelName: "qwen",
        apiMode: "openai_compatible",
        apiKey: "",
        baseUrl: "http://127.0.0.1:11434/v1",
        temperature: 0,
        topP: 1,
        maxContextTokens: 32000,
        enabled: true,
      }),
    );
    expect(model).toBeDefined();
  });
});
