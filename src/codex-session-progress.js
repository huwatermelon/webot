import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export function locateCodexSessionFile(sessionId, codexHome = "") {
  const id = String(sessionId || "").trim();
  if (!id) return "";
  const base = path.join(
    path.resolve(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
    "sessions",
  );
  try {
    const result = spawnSync(
      "find",
      [base, "-name", `*${id}.jsonl`, "-print", "-quit"],
      { encoding: "utf8", timeout: 10_000 },
    );
    return String(result.stdout || "").trim().split(/\n/)[0] || "";
  } catch {
    return "";
  }
}

export function parseCodexSessionProgressLine(line, runStartedAt = 0) {
  let event;
  try {
    event = JSON.parse(String(line || ""));
  } catch {
    return null;
  }
  const timestamp = Date.parse(String(event?.timestamp || ""));
  if (
    !Number.isFinite(timestamp) ||
    timestamp < Number(runStartedAt || 0) - 1_000
  ) {
    return null;
  }
  const payload = event?.payload || {};
  const item = payload.type === "item_completed" ? payload.item : payload;
  if (
    item?.type !== "AgentMessage" ||
    item?.phase !== "commentary"
  ) {
    return null;
  }
  const text = (item.content || [])
    .filter((part) => part?.type === "Text")
    .map((part) => String(part.text || ""))
    .join("")
    .trim();
  return text ? { type: "agent_message", text } : null;
}

export function createJsonlTail({
  filePath,
  startOffset = 0,
  onLine = () => {},
}) {
  const decoder = new StringDecoder("utf8");
  let offset = Math.max(0, Number(startOffset || 0));
  let buffer = "";

  const push = (text) => {
    buffer += String(text || "");
    const lines = buffer.split(/\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  };

  const poll = () => {
    if (!filePath || !fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < offset) {
      offset = 0;
      buffer = "";
    }
    if (stat.size === offset) return;
    const fd = fs.openSync(filePath, "r");
    try {
      while (offset < stat.size) {
        const length = Math.min(256 * 1024, stat.size - offset);
        const chunk = Buffer.allocUnsafe(length);
        const bytesRead = fs.readSync(fd, chunk, 0, length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        push(decoder.write(chunk.subarray(0, bytesRead)));
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  return {
    poll,
    close() {
      poll();
      push(decoder.end());
      if (buffer.trim()) onLine(buffer);
      buffer = "";
    },
  };
}
