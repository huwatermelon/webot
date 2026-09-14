#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const files = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
}).split("\0").filter(Boolean);

const forbiddenPaths = [
  /(^|\/)monitor(\/|$)/i,
  /(^|\/)(voice|voices|audio-profile|speech-profile)(\/|$)/i,
  /\.(sqlite|sqlite3|db|log|amr|silk|wav|mp3|m4a)$/i,
];

const forbiddenText = [
  /\/Users\/[^/\s]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/,
];

const violations = [];
for (const file of files) {
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    violations.push(`${file}: forbidden path`);
    continue;
  }
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  const pattern = forbiddenText.find((candidate) => candidate.test(text));
  if (pattern) violations.push(`${file}: forbidden text ${pattern}`);
}

if (violations.length) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`public tree check passed (${files.length} tracked files)\n`);
