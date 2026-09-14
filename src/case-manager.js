import { acceptedMessage } from "./runtime.js";

export class CaseManager {
  constructor({
    config,
    provider,
    sessionStore,
    caseStore,
    transports,
    requesterAccess = () => "public",
    logger = console,
  }) {
    this.config = config;
    this.provider = provider;
    this.sessionStore = sessionStore;
    this.caseStore = caseStore;
    this.transports = transports;
    this.requesterAccess = requesterAccess;
    this.logger = logger;
    this.running = new Map();
    this.queue = [];
    this.rerun = new Set();
    this.forced = new Set();
    this.active = 0;
  }

  paused() {
    return this.caseStore.runtimeSetting("workers_paused", "0") === "1";
  }

  setPaused(value) {
    this.caseStore.setRuntimeSetting("workers_paused", value ? "1" : "0");
    if (!value) this.drain();
    return this.paused();
  }

  caseSettings() {
    return this.config.caseManagement || {};
  }

  async receive(message) {
    const decision = acceptedMessage(message, this.config);
    if (!decision.accepted) return decision;
    const clean = { ...message, text: decision.text || message.text };
    const ingested = this.caseStore.ingest(clean, clean.text);
    if (!ingested.inserted) {
      return { accepted: false, reason: "duplicate", caseId: ingested.caseId };
    }
    await this.sessionStore.append(ingested.caseId, "user", clean.text);
    if (this.caseSettings().autoRun !== false) {
      if (this.running.has(ingested.caseId)) {
        this.rerun.add(ingested.caseId);
        this.caseStore.addProgress(
          ingested.caseId,
          0,
          "收到新消息，当前 worker 完成后继续处理",
        );
      } else {
        this.enqueue(ingested.caseId);
      }
    }
    return {
      accepted: true,
      caseId: ingested.caseId,
      queued: this.caseSettings().autoRun !== false,
    };
  }

  enqueue(caseId, force = false) {
    if (!this.caseStore.caseRow(caseId)) throw new Error("case not found");
    if (this.running.has(caseId) || this.queue.includes(caseId)) {
      return { queued: false, reason: "already-queued" };
    }
    if (force) this.forced.add(caseId);
    this.queue.push(caseId);
    this.caseStore.addProgress(caseId, 0, force ? "人工触发 worker" : "Case 已进入 worker 队列");
    this.drain();
    return { queued: true };
  }

  resumePending() {
    if (this.caseSettings().autoRun === false || this.paused()) {
      return { queued: 0 };
    }
    let queued = 0;
    for (const caseId of this.caseStore.pendingCaseIds()) {
      const result = this.enqueue(caseId);
      if (result.queued) queued += 1;
    }
    return { queued };
  }

  drain() {
    if (this.paused()) return;
    const concurrency = Math.max(
      1,
      Math.min(Number(this.caseSettings().workerConcurrency || 2), 8),
    );
    while (this.active < concurrency && this.queue.length) {
      const caseId = this.queue.shift();
      this.active += 1;
      this.run(caseId)
        .catch((error) => {
          this.logger.error("case worker failed", {
            caseId,
            error: error.message,
          });
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  async run(caseId) {
    if (this.running.has(caseId)) return;
    const previousSession = this.caseStore.workerSession(caseId);
    const force = this.forced.delete(caseId);
    let pending = this.caseStore.pendingMessages(
      caseId,
      previousSession?.last_processed_message_id || 0,
    );
    if (!pending.length && force) {
      const latest = this.caseStore.latestMessage(caseId);
      if (latest) pending = [latest];
    }
    if (!pending.length) return;
    const trigger = pending[pending.length - 1];
    const cutoffMessageId = trigger.id;
    const session = this.caseStore.startRun(caseId, cutoffMessageId);
    const controller = new AbortController();
    this.running.set(caseId, controller);
    this.caseStore.addProgress(caseId, session.run_count, "worker 开始处理");
    const sentIntermediate = new Set();
    const onItem = async (item) => {
      if (this.caseSettings().ownerIntermediateItems !== true) return;
      if (this.requesterAccess(trigger.message) !== "owner") return;
      if (item?.type !== "agent_message") return;
      const text = String(item.text || "").trim();
      if (!text || sentIntermediate.has(text)) return;
      const transport = this.transports[trigger.message.transport];
      if (!transport) return;
      sentIntermediate.add(text);
      try {
        const outbound = await transport.send(trigger.message, text);
        this.caseStore.addProgress(
          caseId,
          session.run_count,
          outbound.dryRun ? "中间回复演练发送完成" : "中间回复已发送",
        );
      } catch (error) {
        this.caseStore.addProgress(
          caseId,
          session.run_count,
          `中间回复发送失败：${error.message}`,
          "warn",
        );
        this.logger.warn("intermediate item send failed", {
          caseId,
          error: error.message,
        });
      }
    };
    try {
      await onItem({
        type: "agent_message",
        text: "收到，开始处理。",
      });
      const history = await this.sessionStore.history(caseId);
      const currentText = pending
        .map((item) => String(item.text || item.message?.text || "").trim())
        .filter(Boolean)
        .join("\n");
      const currentMessage = {
        ...trigger.message,
        text: currentText || trigger.message.text,
      };
      this.caseStore.addProgress(caseId, session.run_count, "正在生成 draft");
      const providerResult = await this.provider.reply({
        caseId,
        codexSessionId: session.codex_session_id || "",
        message: currentMessage,
        history,
        currentMessageCount: pending.length,
        signal: controller.signal,
        onItem,
      });
      const result = typeof providerResult === "string"
        ? { text: providerResult }
        : providerResult;
      const reply = String(result?.text || "").trim();
      if (!reply) throw new Error("assistant returned no text");
      const owner = this.requesterAccess(trigger.message) === "owner";
      const artifacts = owner && Array.isArray(result?.artifacts)
        ? result.artifacts
        : [];
      if (!owner && result?.artifacts?.length) {
        this.caseStore.addProgress(
          caseId,
          session.run_count,
          "已忽略非 owner 请求中的本地附件",
          "warn",
        );
      }
      if (controller.signal.aborted) throw new Error("worker stopped");
      this.caseStore.recordProviderResult(caseId, result);
      const draftId = this.caseStore.addDraft(
        caseId,
        reply,
        result.model ||
          this.config.assistant.codexModel ||
          this.config.assistant.llmModel ||
          this.config.assistant.mode,
        {
          triggerMessageId: trigger.id,
          inputCutoffMessageId: cutoffMessageId,
          artifacts,
        },
      );
      await this.sessionStore.append(caseId, "assistant", reply);
      this.caseStore.addProgress(caseId, session.run_count, `draft #${draftId} 已生成`);
      this.caseStore.finishRun(
        caseId,
        "draft_ready",
        "",
        cutoffMessageId,
      );
      if (this.caseSettings().autoSend !== false) {
        await this.sendDraft(caseId, draftId);
      }
    } catch (error) {
      const stopped = controller.signal.aborted;
      const status = stopped ? "stopped" : "failed";
      this.caseStore.addProgress(
        caseId,
        session.run_count,
        stopped ? "worker 已停止" : `worker 失败：${error.message}`,
        stopped ? "warn" : "error",
      );
      this.caseStore.finishRun(caseId, status, error.message);
      if (!stopped) throw error;
    } finally {
      this.running.delete(caseId);
      if (this.rerun.delete(caseId)) this.enqueue(caseId);
    }
  }

  async sendDraft(caseId, draftId) {
    const draft = this.caseStore.draft(caseId, draftId);
    if (!draft) throw new Error("draft not found");
    if (draft.status === "sent") return { alreadySent: true };
    const target = draft.trigger_message_id
      ? this.caseStore.messageByRowId(caseId, draft.trigger_message_id)
      : this.caseStore.latestMessage(caseId);
    if (!target) throw new Error("case has no reply target");
    const transport = this.transports[target.message.transport];
    if (!transport) throw new Error("reply transport is unavailable");
    const textOutbound = await transport.send(target.message, draft.text);
    const artifactOutbounds = [];
    for (const artifact of draft.artifacts || []) {
      if (typeof transport.sendArtifact !== "function") {
        throw new Error("reply transport cannot send attachments");
      }
      artifactOutbounds.push(
        await transport.sendArtifact(target.message, artifact),
      );
    }
    const outbound = {
      ok: true,
      dryRun:
        Boolean(textOutbound?.dryRun) &&
        artifactOutbounds.every((item) => item?.dryRun),
      text: textOutbound,
      artifacts: artifactOutbounds,
    };
    this.caseStore.markSent(caseId, draftId, outbound);
    this.caseStore.addProgress(
      caseId,
      0,
      outbound.dryRun ? `draft #${draftId} 演练发送完成` : `draft #${draftId} 已发送`,
    );
    return outbound;
  }

  stop(caseId) {
    this.queue = this.queue.filter((queuedCaseId) => queuedCaseId !== caseId);
    this.rerun.delete(caseId);
    this.forced.delete(caseId);
    const controller = this.running.get(caseId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  resetSession(caseId) {
    if (this.running.has(caseId)) {
      throw new Error("cannot reset a running case");
    }
    return this.caseStore.resetCodexSession(caseId);
  }

  stopAll() {
    this.queue = [];
    this.rerun.clear();
    this.forced.clear();
    for (const controller of this.running.values()) controller.abort();
  }

  status() {
    return {
      paused: this.paused(),
      active: this.active,
      queued: this.queue.length + this.rerun.size,
      runningCaseIds: [...this.running.keys()],
    };
  }
}
