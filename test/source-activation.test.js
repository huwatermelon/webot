import assert from "node:assert/strict";
import test from "node:test";
import {
  activationSuppressed,
  createSourceActivator,
  sourceCandidate,
} from "../src/source-activation.js";

test("detects explicit requests not to restart", () => {
  assert.equal(activationSuppressed("先不重启，提交代码就行"), true);
  assert.equal(activationSuppressed("修好后自动重启"), false);
});

test("resolves a committed source candidate newer than the runtime", async () => {
  const result = await sourceCandidate({
    env: {
      WEBOT_RUNTIME_MODE: "source",
      WEBOT_SOURCE_REVISION: "1".repeat(40),
    },
    repoDir: "/repo",
    run: async () => ({ stdout: `${"2".repeat(40)}\n` }),
    readFile: async () => JSON.stringify({ version: "0.6.15" }),
  });
  assert.deepEqual(result, {
    version: "0.6.15",
    revision: "2".repeat(40),
  });
});

test("submits owner source activation to the external broker", async () => {
  let request = null;
  const activator = createSourceActivator({
    env: { WEBOT_ACTIVATION_BROKER_URL: "http://127.0.0.1:19231/" },
    candidate: async () => ({
      version: "0.6.15",
      revision: "3".repeat(40),
    }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { ok: true, activation_id: "activation-1" };
        },
      };
    },
  });
  const result = await activator.activate({
    caseId: "case-1",
    message: { text: "修复并发布" },
    sourceId: "small-opt",
  });
  assert.equal(result.requested, true);
  assert.equal(request.url, "http://127.0.0.1:19231/api/webot_source_activation");
  assert.deepEqual(JSON.parse(request.options.body), {
    case_id: "case-1",
    requester_access: "owner",
    service: "com.huwatermelon.webot",
    action: "restart",
    expected_version: "0.6.15",
    expected_source_revision: "3".repeat(40),
    expected_source_id: "small-opt",
  });
});
