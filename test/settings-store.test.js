import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { SettingsStore } from "../src/settings-store.js";
import { serializeConfig } from "../src/settings-store.js";

test("redacts secrets and preserves them by account id", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-settings-"));
  const file = path.join(directory, "settings.json");
  const store = new SettingsStore(file);
  await store.load();
  await store.save({
    assistant: { llmApiKey: "llm-secret" },
    pad: {
      sources: [
        { id: "first", accessToken: "first-secret" },
        { id: "second", accessToken: "second-secret" },
      ],
    },
  });

  const publicValue = store.publicSettings();
  assert.equal(publicValue.assistant.llmApiKey, "");
  assert.equal(publicValue.assistant.llmApiKeyConfigured, true);
  assert.equal(publicValue.pad.sources[0].accessToken, "");

  await store.save({
    assistant: { llmApiKey: "" },
    pad: {
      sources: [
        { id: "second", accessToken: "" },
        { id: "first", accessToken: "" },
      ],
    },
  });
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(persisted.assistant.llmApiKey, "llm-secret");
  assert.equal(persisted.pad.sources[0].accessToken, "second-secret");
  assert.equal(persisted.pad.sources[1].accessToken, "first-secret");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("serialized opt settings omit callback compatibility fields", () => {
  const config = loadConfig({}, {
    channels: ["pad"],
    policy: {
      ownerSenderIds: ["owner_wxid", "wxid_small"],
    },
    pad: {
      sources: [{
        id: "small",
        displayName: "小号",
        selfId: "wxid_small",
        wsUrl: "ws://127.0.0.1:18102/ws/wxid_small",
        apiUrl: "http://127.0.0.1:18102/api",
        accessToken: "secret",
        ingressMode: "callback",
        callbackUrl: "http://legacy.invalid/webhooks/pad",
        manageCallback: true,
      }],
    },
  });

  const source = serializeConfig(config).pad.sources[0];
  assert.deepEqual(
    serializeConfig(config).policy.ownerSenderIds,
    ["owner_wxid", "wxid_small"],
  );
  assert.equal(source.wsUrl, "ws://127.0.0.1:18102/ws/wxid_small");
  assert.equal("ingressMode" in source, false);
  assert.equal("callbackUrl" in source, false);
  assert.equal("manageCallback" in source, false);
});

test("new installations use an isolated workspace under the data directory", () => {
  const config = loadConfig({
    WEBOT_DATA_DIR: "/tmp/webot-user-data",
  });
  assert.equal(
    config.assistant.workingDirectory,
    "/tmp/webot-user-data/workspace",
  );
  assert.equal(config.assistant.timeoutMs, 0);
  assert.equal(config.caseManagement.ownerIntermediateItems, false);
});

test("worker timeout and owner intermediate items are configurable", () => {
  const config = loadConfig({}, {
    assistant: { timeoutMs: -1 },
    caseManagement: { ownerIntermediateItems: true },
  });
  assert.equal(config.assistant.timeoutMs, 0);
  assert.equal(config.caseManagement.ownerIntermediateItems, true);
});
