function headers(token) {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export class HookTransport {
  constructor(config, outboundMode, logger = console) {
    this.config = config;
    this.outboundMode = outboundMode;
    this.logger = logger;
  }

  async send(message, text) {
    const isGroup = message.chatType === "group";
    const path = isGroup ? "/send_group_msg" : "/send_private_msg";
    const body = {
      [isGroup ? "group_id" : "user_id"]: message.chatId,
      message: [{ type: "text", data: { text } }],
    };

    if (this.outboundMode !== "live") {
      this.logger.info("hook outbound dry-run", {
        chatType: message.chatType,
        chatId: message.chatId,
        bytes: Buffer.byteLength(text),
      });
      return { ok: true, dryRun: true };
    }

    const response = await fetch(
      `${this.config.apiUrl.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: headers(this.config.accessToken),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status === "failed" || result.retcode > 0) {
      throw new Error(`Hook send failed (${response.status})`);
    }
    return { ok: true, result };
  }
}
