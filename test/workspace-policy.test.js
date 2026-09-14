import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_AGENTS_MD,
  WorkspacePolicy,
} from "../src/workspace-policy.js";

test("creates and safely updates a user-owned AGENTS.md", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-agent-"));
  const workspace = path.join(directory, "workspace");
  const policy = new WorkspacePolicy(workspace);

  const created = await policy.ensure();
  assert.equal(created.content, DEFAULT_AGENTS_MD);
  assert.equal(created.path, path.join(workspace, "AGENTS.md"));

  const updated = await policy.write(
    `${created.content}\n## Personal\n\n- Call me 老大.\n`,
    created.hash,
  );
  assert.notEqual(updated.hash, created.hash);
  assert.equal((await fs.stat(updated.path)).mode & 0o777, 0o600);

  await assert.rejects(
    policy.write("stale", created.hash),
    (error) => error.code === "FILE_CONFLICT",
  );
});
