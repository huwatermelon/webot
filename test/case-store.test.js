import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaseManager } from "../src/case-manager.js";
import { CaseStore } from "../src/case-store.js";
import { SessionStore } from "../src/session-store.js";

function message(id = "message-1") {
  return {
    transport: "pad",
    sourceId: "small",
    sourceName: "小号",
    messageId: id,
    timestamp: Date.now(),
    chatType: "private",
    chatId: "owner_wxid",
    conversationId: "self-pair:owner_wxid--wxid_small",
    senderId: "owner_wxid",
    senderName: "Owner",
    selfId: "wxid_small",
    replyTarget: "owner_wxid",
    direction: "incoming",
    selfConversation: true,
    selfPeer: true,
    text: "ping",
    mentions: [],
  };
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

test("persists a WeChat case, worker session, draft, and send result", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-case-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sent = [];
  const config = {
    assistant: { mode: "echo", llmModel: "" },
    caseManagement: { autoRun: false, autoSend: false, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply({ codexSessionId }) {
        assert.equal(codexSessionId, "");
        return {
          text: "pong",
          sessionId: "codex-session-1",
          model: "test-model",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 20,
            cacheWriteInputTokens: 10,
            outputTokens: 12,
            reasoningOutputTokens: 3,
          },
        };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send(target, text) {
          sent.push({ target, text });
          return { ok: true, dryRun: true };
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const received = await manager.receive(message());
  assert.equal(received.accepted, true);
  assert.equal(caseStore.listCases().length, 1);

  manager.enqueue(received.caseId, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const detail = caseStore.detail(received.caseId);
  assert.equal(detail.status, "draft_ready");
  assert.equal(detail.workerSession.status, "draft_ready");
  assert.equal(detail.workerSession.codex_session_id, "codex-session-1");
  assert.equal(detail.workerSession.model, "test-model");
  assert.equal(detail.workerSession.request_count, 1);
  assert.equal(detail.workerSession.input_tokens, 100);
  assert.equal(detail.workerSession.output_tokens, 12);
  assert.equal(detail.drafts[0].text, "pong");

  await manager.sendDraft(received.caseId, detail.drafts[0].id);
  assert.equal(sent.length, 1);
  assert.equal(caseStore.detail(received.caseId).status, "replied");
  assert.equal(caseStore.resetCodexSession(received.caseId), true);
  assert.equal(
    caseStore.detail(received.caseId).workerSession.codex_session_id,
    "",
  );
  caseStore.close();
});

test("persists and sends owner attachments with the draft", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-artifact-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const artifact = path.join(directory, "answer.mp4");
  await fs.writeFile(artifact, "video");
  const sent = [];
  const config = {
    assistant: { mode: "codex", llmModel: "" },
    caseManagement: { autoRun: false, autoSend: false, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply() {
        return {
          text: "视频发你了。",
          artifacts: [{ path: artifact, filename: "answer.mp4", kind: "file" }],
        };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send(_target, text) {
          sent.push({ type: "text", text });
          return { ok: true, dryRun: true };
        },
        async sendArtifact(_target, value) {
          sent.push({ type: "artifact", value });
          return { ok: true, dryRun: true, filename: value.filename };
        },
      },
    },
    requesterAccess: () => "owner",
    logger: { info() {}, warn() {}, error() {} },
  });

  const received = await manager.receive(message("artifact-message"));
  manager.enqueue(received.caseId, true);
  await waitFor(() => manager.status().active === 0);
  const draft = caseStore.detail(received.caseId).drafts[0];
  assert.deepEqual(draft.artifacts, [{
    path: artifact,
    filename: "answer.mp4",
    kind: "file",
  }]);

  await manager.sendDraft(received.caseId, draft.id);
  assert.deepEqual(sent, [
    { type: "text", text: "视频发你了。" },
    {
      type: "artifact",
      value: { path: artifact, filename: "answer.mp4", kind: "file" },
    },
  ]);
  assert.equal(caseStore.detail(received.caseId).drafts[0].outbound.artifacts.length, 1);
  caseStore.close();
});

test("reruns a case when another message arrives during an active worker", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-rerun-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const replies = [];
  let releaseFirst;
  const firstReply = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const manager = new CaseManager({
    config: {
      assistant: { mode: "echo", llmModel: "" },
      caseManagement: { autoRun: true, autoSend: false, workerConcurrency: 1 },
      pad: {
        sources: [{
          id: "small",
          strictPolicy: true,
          allowSelf: false,
          selfChatPeers: new Set(["owner_wxid"]),
          acceptSelfChatPeerMessages: true,
          allowedChatIds: new Set(),
          allowedSenderIds: new Set(),
          privateNicknameAllowlist: new Set(),
          triggerKeywords: new Set(["webot"]),
          botNames: new Set(["Webot"]),
        }],
      },
      policy: {
        blockedSenderIds: new Set(),
        allowSelf: false,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        groupTriggers: new Set(["webot"]),
      },
      identity: { botNames: new Set(["Webot"]) },
    },
    provider: {
      async reply({ message: current }) {
        replies.push(current.text);
        if (replies.length === 1) await firstReply;
        return `reply:${current.text}`;
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  await manager.receive(message("message-1"));
  await waitFor(() => replies.length === 1);
  await manager.receive({ ...message("message-2"), text: "second" });
  assert.equal(manager.status().queued, 1);
  releaseFirst();
  await waitFor(() => replies.length === 2);
  await waitFor(() => manager.status().active === 0);
  assert.deepEqual(replies, ["ping", "second"]);
  assert.equal(caseStore.detail("wechat:small:self-pair:owner_wxid--wxid_small").drafts.length, 2);
  caseStore.close();
});

test("drain mode stops starting new workers without persisting a pause", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-drain-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  let replies = 0;
  const config = {
    assistant: { mode: "codex", llmModel: "" },
    caseManagement: { autoRun: true, autoSend: false, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply() {
        replies += 1;
        return "unused";
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  const draining = manager.beginDrain();
  assert.equal(draining.draining, true);
  assert.equal(draining.paused, false);
  await manager.receive(message("drain-message"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(replies, 0);
  assert.equal(manager.status().queued, 1);
  assert.equal(caseStore.detail("wechat:small:self-pair:owner_wxid--wxid_small").status, "new");
  caseStore.close();
});

test("combines all unprocessed messages into one new Codex turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-pending-turn-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const receivedTurns = [];
  const config = {
    assistant: { mode: "codex", llmModel: "" },
    caseManagement: { autoRun: false, autoSend: false, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply({ message: current, currentMessageCount }) {
        receivedTurns.push({ text: current.text, currentMessageCount });
        return { text: "done", sessionId: "session-1" };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  const first = await manager.receive(message("message-1"));
  await manager.receive({ ...message("message-2"), text: "继续" });
  manager.enqueue(first.caseId, true);
  await waitFor(() => manager.status().active === 0);

  assert.deepEqual(receivedTurns, [{
    text: "ping\n继续",
    currentMessageCount: 2,
  }]);
  assert.equal(
    caseStore.detail(first.caseId).workerSession.last_processed_message_id,
    2,
  );
  caseStore.close();
});

test("sends a completed draft to its original trigger message", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-draft-target-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sent = [];
  let releaseFirst;
  const firstReply = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const config = {
    assistant: { mode: "codex", llmModel: "" },
    caseManagement: {
      autoRun: true,
      autoSend: true,
      ownerIntermediateItems: false,
      workerConcurrency: 1,
    },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  let calls = 0;
  const manager = new CaseManager({
    config,
    provider: {
      async reply({ message: current }) {
        calls += 1;
        if (calls === 1) await firstReply;
        return `reply:${current.text}`;
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send(target, text) {
          sent.push({ messageId: target.messageId, text });
          return { ok: true, dryRun: false };
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await manager.receive(message("message-1"));
  await waitFor(() => calls === 1);
  await manager.receive({ ...message("message-2"), text: "继续" });
  releaseFirst();
  await waitFor(() => manager.status().active === 0 && sent.length === 2);

  assert.deepEqual(sent, [
    { messageId: "message-1", text: "reply:ping" },
    { messageId: "message-2", text: "reply:继续" },
  ]);
  caseStore.close();
});

test("restores pending cases into the worker queue after startup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-pending-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sent = [];
  const config = {
    assistant: { mode: "echo", llmModel: "" },
    caseManagement: { autoRun: true, autoSend: true, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const ingestOnly = new CaseManager({
    config: {
      ...config,
      caseManagement: { ...config.caseManagement, autoRun: false },
    },
    provider: { async reply() { return "unused"; } },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });
  const received = await ingestOnly.receive(message());
  assert.equal(caseStore.detail(received.caseId).status, "new");

  const manager = new CaseManager({
    config,
    provider: {
      async reply() {
        return {
          text: "restored reply",
          sessionId: "restored-session",
          model: "test-model",
        };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send(target, text) {
          sent.push({ target, text });
          return { ok: true, dryRun: false, messageId: "outbound-1" };
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.deepEqual(manager.resumePending(), { queued: 1 });
  await waitFor(() => manager.status().active === 0);
  const detail = caseStore.detail(received.caseId);
  assert.equal(detail.status, "replied");
  assert.equal(detail.workerSession.codex_session_id, "restored-session");
  assert.equal(detail.workerSession.request_count, 1);
  assert.equal(detail.drafts[0].status, "sent");
  assert.equal(sent.length, 1);
  caseStore.close();
});

test("reuses the persisted Codex session on the next case run", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-resume-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sessions = [];
  const config = {
    assistant: { mode: "codex", codexModel: "test-model", llmModel: "" },
    caseManagement: { autoRun: false, autoSend: false, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply({ codexSessionId }) {
        sessions.push(codexSessionId);
        return {
          text: `reply-${sessions.length}`,
          sessionId: codexSessionId || "session-persisted",
          model: "test-model",
        };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  const received = await manager.receive(message());
  manager.enqueue(received.caseId, true);
  await waitFor(() => manager.status().active === 0);
  manager.enqueue(received.caseId, true);
  await waitFor(() => manager.status().active === 0);

  assert.deepEqual(sessions, ["", "session-persisted"]);
  const detail = caseStore.detail(received.caseId);
  assert.equal(detail.workerSession.codex_session_id, "session-persisted");
  assert.equal(detail.workerSession.request_count, 2);
  caseStore.close();
});

test("sends natural-language intermediate items only for owner tasks", async () => {
  async function runFor(access) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), `webot-intermediate-${access}-`),
    );
    const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
    const sent = [];
    const config = {
      assistant: { mode: "codex", codexModel: "test-model", llmModel: "" },
      caseManagement: {
        autoRun: false,
        autoSend: false,
        ownerIntermediateItems: true,
        workerConcurrency: 1,
      },
      pad: {
        sources: [{
          id: "small",
          strictPolicy: true,
          allowSelf: false,
          selfChatPeers: new Set(["owner_wxid"]),
          acceptSelfChatPeerMessages: true,
          allowedChatIds: new Set(),
          allowedSenderIds: new Set(),
          privateNicknameAllowlist: new Set(),
          triggerKeywords: new Set(["webot"]),
          botNames: new Set(["Webot"]),
        }],
      },
      policy: {
        blockedSenderIds: new Set(),
        allowSelf: false,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        groupTriggers: new Set(["webot"]),
      },
      identity: { botNames: new Set(["Webot"]) },
    };
    const manager = new CaseManager({
      config,
      provider: {
        async reply({ onItem }) {
          await onItem({
            type: "agent_message",
            text: "正在检查配置",
          });
          await onItem({
            type: "agent_message",
            text: "正在检查配置",
          });
          return { text: "检查完成", sessionId: "session-1" };
        },
      },
      sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
      caseStore,
      transports: {
        pad: {
          async send(target, text) {
            sent.push({ target, text });
            return { ok: true, dryRun: false };
          },
        },
      },
      requesterAccess: () => access,
      logger: { info() {}, warn() {}, error() {} },
    });
    const received = await manager.receive(message());
    manager.enqueue(received.caseId, true);
    await waitFor(() => manager.status().active === 0);
    caseStore.close();
    return sent;
  }

  assert.deepEqual(
    (await runFor("owner")).map((item) => item.text),
    ["收到，开始处理。", "正在检查配置"],
  );
  assert.deepEqual(await runFor("public"), []);
});
