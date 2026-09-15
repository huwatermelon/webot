import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BROKER_URL = "http://127.0.0.1:19231";

export function activationSuppressed(text) {
  return /(?:不要|不用|暂不|先不|别)(?:自动|受控)?重启|do not restart|no restart/i.test(
    String(text || ""),
  );
}

export async function sourceCandidate({
  env = process.env,
  repoDir = env.WEBOT_REPO_DIR || process.cwd(),
  run = execFileAsync,
  readFile = fs.readFile,
} = {}) {
  if (String(env.WEBOT_RUNTIME_MODE || "") !== "source") return null;
  const currentRevision = String(env.WEBOT_SOURCE_REVISION || "").trim();
  const { stdout } = await run(
    "/usr/bin/git",
    ["-C", path.resolve(repoDir), "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );
  const revision = String(stdout || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(revision) || revision === currentRevision) {
    return null;
  }
  const packageJson = JSON.parse(
    await readFile(path.join(path.resolve(repoDir), "package.json"), "utf8"),
  );
  const version = String(packageJson.version || "").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Webot package version is not semantic");
  }
  return { version, revision };
}

export function createSourceActivator({
  env = process.env,
  fetchImpl = fetch,
  candidate = sourceCandidate,
} = {}) {
  const brokerUrl = String(
    env.WEBOT_ACTIVATION_BROKER_URL
      || env.SEATALK_MONITOR_URL
      || DEFAULT_BROKER_URL,
  ).replace(/\/+$/, "");
  return {
    async activate({ caseId, message, sourceId }) {
      if (activationSuppressed(message?.text)) {
        return { requested: false, reason: "explicitly-suppressed" };
      }
      const next = await candidate({ env });
      if (!next) return { requested: false, reason: "source-current" };
      const response = await fetchImpl(
        `${brokerUrl}/api/webot_source_activation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            case_id: String(caseId || ""),
            requester_access: "owner",
            service: "com.huwatermelon.webot",
            action: "restart",
            expected_version: next.version,
            expected_source_revision: next.revision,
            expected_source_id: String(sourceId || ""),
          }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) {
        throw new Error(
          `Webot activation broker rejected the candidate: ${
            body.error || `HTTP ${response.status}`
          }`,
        );
      }
      return {
        requested: true,
        version: next.version,
        revision: next.revision,
        activationId: String(body.activation_id || ""),
      };
    },
  };
}
