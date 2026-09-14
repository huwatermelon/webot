import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyControlCommand,
  parseControlCommand,
  runtimeOverrides,
} from "../src/control-commands.js";
import { CaseStore } from "../src/case-store.js";
import { SessionStore } from "../src/session-store.js";

test("parses stable owner control commands", () => {
  assert.deepEqual(parseControlCommand("/models"), {
    type: "model",
    action: "list",
  });
  assert.deepEqual(parseControlCommand("/model list"), {
    type: "model",
    action: "list",
  });
  assert.deepEqual(parseControlCommand("/model gpt-5 task"), {
    type: "model",
    action: "set",
    model: "gpt-5",
    task: "task",
  });
  assert.deepEqual(parseControlCommand("/new"), {
    type: "clear",
    action: "reset",
  });
  assert.equal(parseControlCommand("/unknown"), null);
});

test("applies model and effort overrides without invoking a provider", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-command-"));
  const codexHome = path.join(directory, "codex");
  await fs.mkdir(codexHome);
  await fs.writeFile(
    path.join(codexHome, "models_cache.json"),
    JSON.stringify({ models: [{ slug: "gpt-test" }, { slug: "gpt-other" }] }),
  );
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sessionStore = new SessionStore(path.join(directory, "sessions"), 4);
  const config = {
    codexHome,
    codexModel: "gpt-test",
    reasoningEffort: "high",
    serviceTier: "standard",
  };

  const model = await applyControlCommand({
    command: parseControlCommand("/model gpt-other"),
    caseId: "case-1",
    caseStore,
    sessionStore,
    config,
  });
  assert.match(model.text, /gpt-other/);
  assert.equal(runtimeOverrides(caseStore, "case-1").model, "gpt-other");

  const effort = await applyControlCommand({
    command: parseControlCommand("/effort low"),
    caseId: "case-1",
    caseStore,
    sessionStore,
    config,
  });
  assert.match(effort.text, /low/);
  assert.equal(runtimeOverrides(caseStore, "case-1").reasoningEffort, "low");

  await sessionStore.append("case-1", "user", "old context");
  const cleared = await applyControlCommand({
    command: parseControlCommand("/clear"),
    caseId: "case-1",
    caseStore,
    sessionStore,
    config,
  });
  assert.match(cleared.text, /已清理当前会话/);
  assert.deepEqual(runtimeOverrides(caseStore, "case-1"), {
    model: "",
    reasoningEffort: "",
  });
  assert.deepEqual(await sessionStore.history("case-1"), []);
  caseStore.close();
});
