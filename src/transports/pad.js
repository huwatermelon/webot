import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sourceForMessage } from "../ingress-sources.js";
import { normalizePadEnvelope } from "../normalize.js";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const WEBSOCKET_OPEN = 1;

function tokenHeaders(token) {
  return {
    "Content-Type": "application/json",
    ...(token ? { "X-Access-Token": token } : {}),
  };
}

function padSucceeded(response, body) {
  if (!response.ok) return false;
  if (body.Success === false || body.success === false) return false;
  const code = body.Code ?? body.code;
  if (code != null && Number(code) !== 0) return false;
  const baseRet =
    body.BaseResponse?.Ret ??
    body.base_response?.ret ??
    body.Data?.BaseResponse?.Ret;
  if (baseRet != null && Number(baseRet) !== 0) return false;
  return true;
}

function stripAiReplyPrefix(text) {
  return String(text || "").replace(
    /^\s*【AI(?:\s+\d+\/\d+)?】\s*/i,
    "",
  );
}

export function isSameAccountPrivateReply(message = {}, source = {}) {
  if (message.chatType === "group") return false;
  const replyTarget = String(
    message.replyTarget || message.chatId || "",
  ).trim().toLowerCase();
  const selfId = String(source.selfId || message.selfId || "")
    .trim()
    .toLowerCase();
  return Boolean(replyTarget && selfId && replyTarget === selfId);
}

export function formatPadReplyText(text, message = {}, source = {}) {
  if (!source.strictPolicy) return String(text || "");
  const clean = stripAiReplyPrefix(text);
  return isSameAccountPrivateReply(message, source)
    ? `【AI】${clean}`
    : clean;
}

export class PadTransport {
  constructor(config, outboundMode, logger = console) {
    this.config = config;
    this.outboundMode = outboundMode;
    this.logger = logger;
  }

  source(message = {}) {
    const source = this.config.sources?.length
      ? sourceForMessage({ pad: this.config }, message)
      : this.config;
    if (!source) {
      throw new Error(
        `Pad source is not configured: ${message.sourceId || "<empty>"}`,
      );
    }
    return source;
  }

  async request(path, body, message = {}) {
    const source = this.source(message);
    if (this.outboundMode !== "live") {
      this.logger.info("pad outbound dry-run", {
        path,
        chatId: body.to || body.ToWxid,
        sourceId: source.id,
        bytes: body.content
          ? Buffer.byteLength(body.content)
          : body.Content
            ? Buffer.byteLength(body.Content)
            : undefined,
      });
      return { ok: true, dryRun: true };
    }

    const payload = { ...body };
    if (this.config.requireWriteConfirmation) {
      payload.confirm = true;
      payload.request_id = crypto.randomUUID();
    }
    const response = await fetch(
      `${source.apiUrl.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: tokenHeaders(source.accessToken),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!padSucceeded(response, result)) {
      throw new Error(`Pad send failed (${response.status})`);
    }
    return { ok: true, result };
  }

  send(message, text) {
    const source = this.source(message);
    const content = formatPadReplyText(text, message, source);
    return this.request("/v1/messages/send-text", {
      to: message.replyTarget || message.chatId,
      content,
      type: 1,
      at: "",
    }, message);
  }

  sendImage(chatId, base64, message = {}) {
    return this.request("/v1/messages/send-image", {
      to: chatId,
      data_base64: base64,
    }, message);
  }

  async sendArtifact(message, artifact = {}) {
    const filePath = path.resolve(String(artifact.path || ""));
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
      throw new Error(
        "WeChat attachment must be a nonempty regular file of at most 64 MiB",
      );
    }
    const data = fs.readFileSync(filePath);
    if (data.length !== stat.size) {
      throw new Error("WeChat attachment changed size while reading");
    }
    const filename = path.basename(String(artifact.filename || filePath));
    if (
      !filename ||
      Buffer.byteLength(filename) > 255 ||
      /[\x00-\x1f\x7f]/.test(filename)
    ) {
      throw new Error("invalid WeChat attachment name");
    }
    const extension = path.extname(filename).toLowerCase();
    const isImage =
      String(artifact.kind || "").toLowerCase() === "image" ||
      String(artifact.mime || "").toLowerCase().startsWith("image/") ||
      IMAGE_EXTENSIONS.has(extension);
    const to = message.replyTarget || message.chatId;
    if (isImage) {
      return this.request("/Msg/UploadImg", {
        ToWxid: to,
        Base64: data.toString("base64"),
      }, message);
    }
    if (!this.config.requireWriteConfirmation) {
      throw new Error(
        "WeChat file cards require the confirmed-write Pad API",
      );
    }
    return this.request("/Msg/SendFile", {
      ToWxid: to,
      FileName: filename,
      Base64: data.toString("base64"),
    }, message);
  }
}

export class PadWebSocketClient {
  constructor(config, sourceValue, onMessage, logger = console) {
    this.config = config;
    this.source =
      typeof sourceValue === "string"
        ? { id: "default", displayName: "default", selfId: sourceValue, ...config }
        : sourceValue;
    this.onMessage = onMessage;
    this.logger = logger;
    this.socket = null;
    this.stopped = true;
    this.attempt = 0;
    this.timer = null;
    this.connectTimer = null;
    this.connectTimeoutMs = Math.max(
      1_000,
      Number(
        this.config.websocketConnectTimeoutMs ||
          DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
      ),
    );
    this.state = {
      connected: false,
      connectionState: "idle",
      lastConnectedAt: "",
      lastDisconnectedAt: "",
      lastMessageAt: "",
      lastError: "",
      reconnects: 0,
    };
  }

  start() {
    if (!this.config.wsUrl) return;
    if (typeof WebSocket !== "function") {
      throw new Error("Pad WebSocket requires Node.js 22 or newer");
    }
    this.stopped = false;
    this.connect();
  }

  clearConnectTimer() {
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  disconnect(socket, error = "") {
    if (this.socket !== socket) return;
    this.clearConnectTimer();
    this.socket = null;
    this.state.connected = false;
    this.state.connectionState = this.stopped ? "stopped" : "disconnected";
    this.state.lastDisconnectedAt = new Date().toISOString();
    if (error) this.state.lastError = error;
    if (!this.stopped) this.reconnect();
  }

  connect() {
    if (this.stopped || this.socket || this.timer) return;
    let socket;
    try {
      const url = new URL(this.config.wsUrl);
      if (this.config.accessToken && !url.searchParams.has("access_token")) {
        url.searchParams.set("access_token", this.config.accessToken);
      }
      socket = new WebSocket(url);
    } catch (error) {
      this.state.lastError = String(error.message || error);
      this.state.connectionState = "disconnected";
      this.reconnect();
      return;
    }
    this.socket = socket;
    this.state.connectionState = "connecting";
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket || this.state.connected) return;
      this.disconnect(
        socket,
        `websocket connection timed out after ${this.connectTimeoutMs}ms`,
      );
    }, this.connectTimeoutMs);
    this.connectTimer.unref?.();

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.clearConnectTimer();
      this.attempt = 0;
      this.state.connected = true;
      this.state.connectionState = "connected";
      this.state.lastConnectedAt = new Date().toISOString();
      this.state.lastError = "";
      this.logger.info("pad websocket connected", {
        sourceId: this.source.id,
        selfId: this.source.selfId,
      });
    });
    socket.addEventListener("message", async (event) => {
      if (this.socket !== socket) return;
      try {
        this.state.lastMessageAt = new Date().toISOString();
        const raw =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof Blob
              ? await event.data.text()
              : Buffer.from(event.data).toString("utf8");
        const envelope = JSON.parse(raw);
        for (const message of normalizePadEnvelope(envelope, this.source)) {
          await this.onMessage(message);
        }
      } catch (error) {
        this.state.lastError = error.message;
        this.logger.error("invalid pad websocket event", {
          sourceId: this.source.id,
          error: error.message,
        });
      }
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.disconnect(socket, "websocket error");
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      const reason = String(event?.reason || "").trim();
      this.disconnect(socket, reason || this.state.lastError);
    });
  }

  reconnect() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.logger.warn("pad websocket disconnected", {
      sourceId: this.source.id,
      retryMs: delay,
    });
    this.state.connectionState = "reconnecting";
    this.timer = setTimeout(() => {
      this.timer = null;
      this.state.reconnects += 1;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.clearConnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.state.connected = false;
    this.state.connectionState = "stopped";
    if (socket?.readyState === WEBSOCKET_OPEN) {
      try {
        socket.close();
      } catch {
        // The service is stopping; the socket is already detached.
      }
    }
  }

  status() {
    return {
      sourceId: this.source.id,
      ...this.state,
    };
  }
}
