import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(
  new URL("../ui/admin.html", import.meta.url),
  "utf8",
);
const javascript = fs.readFileSync(
  new URL("../ui/admin.js", import.meta.url),
  "utf8",
);
const css = fs.readFileSync(
  new URL("../ui/admin.css", import.meta.url),
  "utf8",
);

test("admin navigation keeps cases, knowledge, and settings only", () => {
  assert.match(html, /data-view="cases"/);
  assert.match(html, /data-view="knowledge"/);
  assert.match(html, /data-view="settings"/);
  assert.doesNotMatch(html, /data-view="overview"/);
  assert.doesNotMatch(html, /data-view="release"/);
});

test("admin header owns worker and auto reply controls", () => {
  assert.match(html, /id="worker-toggle"/);
  assert.match(html, /data-action="workers-toggle"/);
  assert.match(html, /id="auto-reply-toggle"/);
  assert.match(html, /data-action="auto-reply-toggle"/);
  assert.doesNotMatch(javascript, /data-action="workers-paused"/);
  assert.doesNotMatch(javascript, /id="case-auto-send"/);
});

test("case workspace groups named sessions and reloads on runtime revision changes", () => {
  assert.match(html, /name="webot-runtime-revision"/);
  assert.match(javascript, /caseSessionOptions/);
  assert.match(javascript, /data-case-session/);
  assert.match(javascript, /class="case-session-select"/);
  assert.match(javascript, /reloadForRuntimeRevisionChange/);
  assert.match(javascript, /window\.location\.reload\(\)/);
});

test("case list width is narrower, draggable, persistent, and mobile-safe", () => {
  assert.match(javascript, /caseListDefaultWidth = 300/);
  assert.match(javascript, /data-case-resizer/);
  assert.match(javascript, /setPointerCapture/);
  assert.match(javascript, /caseListWidthStorageKey/);
  assert.match(javascript, /window\.localStorage\.setItem/);
  assert.match(javascript, /event\.key === "ArrowLeft"/);
  assert.match(javascript, /event\.key === "ArrowRight"/);
  assert.match(css, /--case-list-width: 300px/);
  assert.match(css, /\.case-resizer \{[^}]*cursor: col-resize/);
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*\.case-resizer \{ display: none; \}/);
});

test("knowledge editing is independent and knowledge configuration lives in settings", () => {
  assert.match(javascript, /function renderKnowledge\(\)/);
  assert.match(javascript, /function knowledgeSettingsMarkup\(\)/);
  assert.match(javascript, /KB 路径与同步/);
  assert.match(javascript, /data-settings-fold="knowledge"/);
  assert.match(javascript, /\$\{knowledgeSettingsMarkup\(\)\}/);
  const knowledgeView = javascript.slice(
    javascript.indexOf("function renderKnowledge()"),
    javascript.indexOf("function renderSettings()"),
  );
  assert.doesNotMatch(knowledgeView, /KB 路径与同步/);
  assert.match(knowledgeView, /data-action="new-kb"/);
  assert.match(javascript, /data-settings-fold="accounts"/);
  assert.match(javascript, /data-settings-fold="agents"/);
  assert.match(javascript, /data-settings-fold="assistant"/);
  assert.doesNotMatch(
    javascript,
    /data-settings-fold="(?:accounts|knowledge|agents|assistant)"\s+open/,
  );
});
