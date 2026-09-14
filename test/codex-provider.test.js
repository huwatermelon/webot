import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCodexArgs,
  codexRuntimeStatus,
  createCodexProvider,
  parseCodexEvents,
} from "../src/codex-provider.js";
import {
  createJsonlTail,
  parseCodexSessionProgressLine,
} from "../src/codex-session-progress.js";

test("parses a Codex session and usage from JSONL", () => {
  const parsed = parseCodexEvents([
    '{"type":"thread.started","thread_id":"session-1"}',
    '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"正在检查配置"}}',
    '{"type":"item.started","item":{"id":"item-2","type":"command_execution"}}',
    '{"type":"item.completed","item":{"id":"item-2","type":"command_execution"}}',
    '{"type":"item.completed","item":{"id":"item-3","type":"agent_message","text":"最终回复"}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"cache_write_input_tokens":5,"output_tokens":12,"reasoning_output_tokens":3}}',
  ].join("\n"));
  assert.equal(parsed.threadId, "session-1");
  assert.deepEqual(parsed.usage, {
    inputTokens: 100,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 5,
    outputTokens: 12,
    reasoningOutputTokens: 3,
  });
  assert.deepEqual(parsed.intermediateMessages, ["正在检查配置"]);
});

test("builds new and resume commands with editable Codex settings", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-codex-"));
  const binary = path.join(directory, "codex");
  await fs.writeFile(binary, "");
  await fs.chmod(binary, 0o700);
  const config = {
    codexBin: binary,
    codexHome: directory,
    workingDirectory: directory,
    codexModel: "test-model",
    reasoningEffort: "high",
    serviceTier: "standard",
    systemPrompt: "称 Owner 为老大。",
  };
  const runtime = codexRuntimeStatus(config);
  assert.equal(runtime.binaryReady, true);
  const fresh = buildCodexArgs(config, {
    outputPath: path.join(directory, "fresh.txt"),
  });
  assert.deepEqual(fresh.slice(0, 1), ["exec"]);
  assert.ok(fresh.includes("-C"));
  assert.ok(fresh.includes("test-model"));
  assert.ok(
    fresh.some((item) => item.startsWith("developer_instructions=")),
  );
  assert.ok(
    fresh.some((item) =>
      item.includes("Never install, stop, restart, signal")),
  );

  const resumed = buildCodexArgs(config, {
    sessionId: "session-1",
    outputPath: path.join(directory, "resume.txt"),
  });
  assert.deepEqual(resumed.slice(0, 2), ["exec", "resume"]);
  assert.ok(resumed.includes("session-1"));
  assert.equal(resumed.includes("-C"), false);
});

test("returns structured Codex results through the provider", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-codex-"));
  const binary = path.join(directory, "codex");
  await fs.writeFile(binary, "");
  await fs.chmod(binary, 0o700);
  const provider = createCodexProvider(
    { codexBin: binary, codexHome: directory },
    {
      requesterAccess: () => "owner",
      searchKnowledge: async (_query, context) => [{
        title: context.access,
        path: "owner/test.md",
        content: "owner knowledge",
      }],
      runCodex: async (_config, request) => {
        await request.onItem?.({
          type: "agent_message",
          text: "处理中",
        });
        return {
          text:
            request.prompt.includes("Access level: owner") &&
            request.prompt.includes("owner knowledge")
              ? "收到"
              : "unexpected",
          sessionId: "session-2",
          model: "test-model",
          usage: { inputTokens: 1 },
        };
      },
    },
  );
  const result = await provider.reply({
    caseId: "case-1",
    message: { text: "当前消息" },
    history: [{ role: "user", content: "当前消息" }],
    onItem(item) {
      assert.equal(item.text, "处理中");
    },
  });
  assert.equal(result.text, "收到");
  assert.equal(result.sessionId, "session-2");
});

test("reads commentary progress from a Codex session JSONL tail", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-tail-"));
  const file = path.join(directory, "session.jsonl");
  const startedAt = Date.now();
  await fs.writeFile(file, "");
  const items = [];
  const tail = createJsonlTail({
    filePath: file,
    onLine(line) {
      const item = parseCodexSessionProgressLine(line, startedAt);
      if (item) items.push(item.text);
    },
  });
  await fs.appendFile(file, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "AgentMessage",
        phase: "commentary",
        content: [{ type: "Text", text: "正在检查" }],
      },
    },
  })}\n${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "AgentMessage",
        phase: "final_answer",
        content: [{ type: "Text", text: "最终回答" }],
      },
    },
  })}\n`);
  tail.close();
  assert.deepEqual(items, ["正在检查"]);
});
