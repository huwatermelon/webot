import {
  Activity,
  BookOpen,
  Bot,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Cloud,
  Database,
  Eye,
  FileText,
  Gauge,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  PackageCheck,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  Server,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Wifi,
  WifiOff,
  createIcons,
} from "lucide";

const iconSet = {
  Activity,
  BookOpen,
  Bot,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Cloud,
  Database,
  Eye,
  FileText,
  Gauge,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  PackageCheck,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  Server,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Wifi,
  WifiOff,
};

const views = {
  cases: ["WORKSPACE", "微信 Case"],
  overview: ["SYSTEM", "运行概览"],
  accounts: ["INGRESS", "微信账号"],
  assistant: ["INTELLIGENCE", "助手与知识库"],
  release: ["RUNTIME", "运行与发布"],
};

let activeView = views[location.hash.slice(1)]
  ? location.hash.slice(1)
  : "cases";
let settings = null;
let status = null;
let selectedSource = 0;
let dirty = false;
let cases = [];
let workers = {};
let selectedCase = null;
let agentDocument = null;
let agentDirty = false;
let knowledgeDocuments = [];
let selectedKnowledge = null;
let knowledgeDirty = false;
let knowledgeMode = "source";

const content = document.querySelector("#content");
const notice = document.querySelector("#notice");
const saveState = document.querySelector("#save-state");

function icons() {
  createIcons({ icons: iconSet, attrs: { "stroke-width": 1.8 } });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function listText(value) {
  return (Array.isArray(value) ? value : []).join("\n");
}

function parseList(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[,;\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function duration(seconds) {
  const value = Number(seconds || 0);
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return `${Math.floor(value / 60)} 分钟`;
  if (value < 86400) return `${Math.floor(value / 3600)} 小时`;
  return `${Math.floor(value / 86400)} 天`;
}

function time(value) {
  if (!value) return "尚无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function badge(label, tone = "") {
  return `<span class="badge ${tone}"><span class="status-dot ${tone === "good" ? "ok" : ""}"></span>${escapeHtml(label)}</span>`;
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.classList.remove("hidden");
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => notice.classList.add("hidden"), 4200);
}

function renderMarkdown(value) {
  const lines = String(value || "").split(/\r?\n/);
  const output = [];
  let inCode = false;
  let code = [];
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      output.push(`<p class="preview-list">• ${escapeHtml(line.replace(/^\s*[-*]\s+/, ""))}</p>`);
    } else if (line.trim()) {
      output.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  if (code.length) {
    output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  }
  return output.join("") || `<div class="empty compact"><div>暂无内容</div></div>`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function sourceStatus(source) {
  return status?.padSources?.find((item) => item.id === source.id);
}

function caseTone(value) {
  if (value === "replied") return "good";
  if (value === "failed" || value === "stopped") return "bad";
  if (value === "running" || value === "draft_ready") return "warn";
  return "";
}

function caseStatusLabel(value) {
  return {
    new: "待处理",
    running: "处理中",
    draft_ready: "待发送",
    replied: "已回复",
    failed: "失败",
    stopped: "已停止",
    draft: "草稿",
    sent: "已发送",
  }[value] || value || "未运行";
}

function renderCaseDetail(item) {
  const session = item.workerSession || {};
  const totalTokens =
    Number(session.input_tokens || 0) +
    Number(session.output_tokens || 0) +
    Number(session.reasoning_output_tokens || 0);
  return `
    <div class="case-detail-head">
      <div><h2>${escapeHtml(item.title)}</h2><p class="mono">${escapeHtml(item.case_id)}</p></div>
      <div class="inline-actions">
        ${session.status === "running"
          ? `<button class="button danger" data-action="stop-case" data-case-id="${escapeHtml(item.case_id)}">停止</button>`
          : `<button class="button secondary" data-action="run-case" data-case-id="${escapeHtml(item.case_id)}"><i data-lucide="play"></i><span>运行</span></button>`}
      </div>
    </div>
    ${item.last_error ? `<div class="case-error">${escapeHtml(item.last_error)}</div>` : ""}
    <div class="case-section">
      <h3>Worker 会话</h3>
      <div class="session-grid">
        <span>状态<strong>${escapeHtml(caseStatusLabel(session.status))}</strong></span>
        <span>运行次数<strong>${Number(session.run_count || 0)}</strong></span>
        <span>Codex Session<strong class="mono">${escapeHtml(session.codex_session_id ? session.codex_session_id.slice(0, 12) : "尚未建立")}</strong></span>
        <span>模型<strong>${escapeHtml(session.model || "跟随配置")}</strong></span>
        <span>模型请求<strong>${Number(session.request_count || 0)}</strong></span>
        <span>累计 Token<strong>${totalTokens.toLocaleString("zh-CN")}</strong></span>
        <span>开始<strong>${time(session.started_at)}</strong></span>
        <span>完成<strong>${time(session.finished_at)}</strong></span>
      </div>
      ${session.codex_session_id
        ? `<div class="inline-actions session-actions"><button class="button secondary" data-action="reset-session" data-case-id="${escapeHtml(item.case_id)}"><i data-lucide="refresh-cw"></i><span>重置 Codex Session</span></button></div>`
        : ""}
      <div class="progress-list">
        ${(item.progress || []).map((entry) => `<div class="progress-row ${escapeHtml(entry.level)}"><span>${time(entry.created_at)}</span><strong>${escapeHtml(entry.message)}</strong></div>`).join("") || `<div class="case-muted">暂无进度</div>`}
      </div>
    </div>
    <div class="case-section">
      <h3>回复草稿</h3>
      ${(item.drafts || []).map((draft) => `
        <article class="draft-block">
          <div class="draft-head">
            <span>${badge(caseStatusLabel(draft.status), draft.status === "sent" ? "good" : "warn")} · ${time(draft.created_at)}</span>
            ${draft.status !== "sent" ? `<button class="button primary" data-action="send-draft" data-case-id="${escapeHtml(item.case_id)}" data-draft-id="${Number(draft.id)}"><i data-lucide="send"></i><span>发送</span></button>` : ""}
          </div>
          <div class="draft-text">${escapeHtml(draft.text)}</div>
        </article>
      `).join("") || `<div class="case-muted">暂无 draft</div>`}
    </div>
    <div class="case-section">
      <h3>消息上下文</h3>
      <div class="message-list">
        ${(item.messages || []).map((message) => `
          <div class="message-row ${message.direction === "outgoing" ? "outgoing" : ""}">
            <div><strong>${escapeHtml(message.sender_name || message.sender_id)}</strong><span>${time(message.timestamp)}</span></div>
            <p>${escapeHtml(message.text)}</p>
          </div>
        `).join("")}
      </div>
    </div>`;
}

function renderCases() {
  content.innerHTML = `
    <div class="case-toolbar">
      <div>
        <strong>${cases.length} 个 Case</strong>
        <span>${Number(workers.active || 0)} 运行 · ${Number(workers.queued || 0)} 排队</span>
      </div>
      <label class="worker-switch">
        <span>${workers.paused ? "Worker 已暂停" : "Worker 运行中"}</span>
        <input type="checkbox" data-action="workers-paused" ${workers.paused ? "checked" : ""}>
      </label>
    </div>
    <div class="case-layout">
      <div class="case-list">
        ${cases.map((item) => `
          <button class="case-item ${selectedCase?.case_id === item.case_id ? "active" : ""}" data-case-select="${escapeHtml(item.case_id)}">
            <span class="case-item-head"><strong>${escapeHtml(item.title)}</strong>${badge(caseStatusLabel(item.status), caseTone(item.status))}</span>
            <span class="case-preview">${escapeHtml(item.last_message || "")}</span>
            <span class="case-meta">${escapeHtml(item.source_name)} · ${time(item.last_message_at)} · ${Number(item.draft_count || 0)} drafts</span>
          </button>
        `).join("") || `<div class="empty compact"><div>尚无微信 Case</div></div>`}
      </div>
      <div class="case-detail">
        ${selectedCase ? renderCaseDetail(selectedCase) : `<div class="empty"><div><i data-lucide="inbox"></i><div>选择一个 Case</div></div></div>`}
      </div>
    </div>`;
}

function renderOverview() {
  const readySources = (status.padSources || []).filter(
    (source) => source.health?.ready || source.websocket?.connected,
  ).length;
  const inbound = (status.padSources || []).reduce(
    (sum, source) => sum + Number(source.inboundMessages || 0),
    0,
  );
  const kb = status.knowledgeBase || {};
  content.innerHTML = `
    <div class="section">
      <div class="metric-grid">
        <div class="metric"><div class="metric-top"><span>服务状态</span><i data-lucide="activity"></i></div><strong>运行中</strong><small>已持续 ${duration(status.uptimeSeconds)}</small></div>
        <div class="metric"><div class="metric-top"><span>微信连接</span><i data-lucide="wifi"></i></div><strong>${readySources} / ${status.padSources.length}</strong><small>${status.padSources.length ? "已配置账号" : "尚未配置账号"}</small></div>
        <div class="metric"><div class="metric-top"><span>本次入站</span><i data-lucide="message-square"></i></div><strong>${inbound}</strong><small>进程启动后收到的消息</small></div>
        <div class="metric"><div class="metric-top"><span>发送模式</span><i data-lucide="shield-check"></i></div><strong>${status.outboundMode === "live" ? "正式" : "演练"}</strong><small>${status.outboundMode === "live" ? "允许发送回复" : "不发送真实消息"}</small></div>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><div><h2>账号状态</h2><p>连接与入站运行状态</p></div><button class="button secondary" data-action="probe-all"><i data-lucide="refresh-cw"></i><span>重新检测</span></button></div>
      ${status.padSources.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>账号</th><th>接入</th><th>运行状态</th><th>登录态</th><th>入站</th><th>最近检测</th></tr></thead>
        <tbody>${status.padSources.map((source) => {
          const ready = source.health?.ready || source.websocket?.connected;
          return `<tr>
            <td><strong>${escapeHtml(source.displayName)}</strong><br><span class="mono">${escapeHtml(source.selfId)}</span></td>
            <td>Gateway WebSocket</td>
            <td>${badge(ready ? "就绪" : source.health?.state || "等待", ready ? "good" : "warn")}</td>
            <td>${escapeHtml(source.health?.loginState || (source.health?.online ? "online" : "未知"))}</td>
            <td>${Number(source.inboundMessages || 0)}</td>
            <td>${time(source.health?.checkedAt || source.websocket?.lastConnectedAt)}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>` : `<div class="empty"><div><i data-lucide="users"></i><div>尚未配置微信账号</div></div></div>`}
    </div>
    <div class="section">
      <div class="section-head"><div><h2>个人知识库</h2><p>Git 云端与本地索引状态</p></div>${kb.enabled ? `<button class="button secondary" data-action="sync-kb"><i data-lucide="cloud"></i><span>立即同步</span></button>` : ""}</div>
      <div class="metric-grid">
        <div class="metric"><div class="metric-top"><span>同步状态</span><i data-lucide="cloud"></i></div><strong>${kb.enabled ? (kb.ready ? "已就绪" : "等待") : "未启用"}</strong><small>${kb.lastError ? escapeHtml(kb.lastError) : time(kb.lastSyncAt)}</small></div>
        <div class="metric"><div class="metric-top"><span>Markdown</span><i data-lucide="book-open"></i></div><strong>${Number(kb.noteCount || 0)}</strong><small>当前可检索文档</small></div>
      </div>
    </div>`;
}

function field(label, id, value, options = {}) {
  const full = options.full ? " full" : "";
  const type = options.type || "text";
  const note = options.note ? `<small>${escapeHtml(options.note)}</small>` : "";
  if (options.textarea) {
    return `<div class="field${full}"><label for="${id}"><span>${label}</span>${note}</label><textarea id="${id}" data-dirty>${escapeHtml(value)}</textarea></div>`;
  }
  return `<div class="field${full}"><label for="${id}"><span>${label}</span>${note}</label><input class="input" id="${id}" type="${type}" value="${escapeHtml(value)}" ${options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ""} data-dirty></div>`;
}

function toggle(label, id, checked, detail) {
  return `<div class="toggle-row"><div class="toggle-copy"><strong>${label}</strong><span>${detail}</span></div><label class="switch"><input id="${id}" type="checkbox" ${checked ? "checked" : ""} data-dirty><span></span></label></div>`;
}

function renderAccounts() {
  const sources = settings.pad.sources || [];
  const source = sources[selectedSource];
  content.innerHTML = `
    <div class="section">
      <div class="section-head"><div><h2>账号列表</h2><p>${sources.length} 个接入账号</p></div><button class="button secondary" data-action="add-source"><i data-lucide="plus"></i><span>添加账号</span></button></div>
      <div class="split-layout">
        <div class="account-list">
          ${sources.map((item, index) => `<button class="account-item ${index === selectedSource ? "active" : ""}" data-source-index="${index}">
            <span class="account-avatar"><i data-lucide="user-round"></i></span>
            <span class="account-copy"><strong>${escapeHtml(item.displayName || item.id)}</strong><span>${escapeHtml(item.selfId || "未填写 wxid")}</span></span>
          </button>`).join("")}
        </div>
        <div class="editor">${source ? accountEditor(source) : `<div class="empty"><div><i data-lucide="users"></i><div>添加一个微信账号</div></div></div>`}</div>
      </div>
    </div>`;
}

function accountEditor(source) {
  const current = sourceStatus(source);
  const wsPort = (() => {
    try { return new URL(source.wsUrl).port; } catch { return ""; }
  })();
  return `
    <div class="form-section">
      <div class="section-head"><div><h2>账号信息</h2><p>${current?.health?.lastError ? escapeHtml(current.health.lastError) : current?.health?.ready ? "连接正常" : "等待检测"}</p></div>
        <div class="inline-actions"><button class="button secondary" data-action="test-source"><i data-lucide="activity"></i><span>检测连接</span></button><button class="button danger icon-only" data-action="delete-source" title="删除账号"><i data-lucide="trash-2"></i></button></div>
      </div>
      <div class="form-grid">
        ${field("显示名称", "source-name", source.displayName)}
        ${field("配置 ID", "source-id", source.id)}
        ${field("微信 wxid", "source-wxid", source.selfId, { full: true })}
      </div>
    </div>
    <div class="form-section">
      <div class="section-head"><div><h2>WeChatPad 网关</h2><p>每个账号使用独立凭据和 WebSocket</p></div></div>
      <div class="form-grid three">
        ${field("网关 API", "source-api", source.apiUrl, { full: true, placeholder: "http://127.0.0.1:18102/api" })}
        ${field("网关 WS 端口", "source-ws-port", wsPort, { type: "number", placeholder: "18102" })}
        ${field("WebSocket 地址", "source-ws", source.wsUrl, { full: true, placeholder: "ws://127.0.0.1:18102/ws/wxid" })}
        ${field("Access Code", "source-token", "", { type: "password", note: source.accessTokenConfigured ? "已配置" : "" })}
        ${field("Access Code 文件", "source-token-file", source.accessTokenFile, { full: true })}
      </div>
      ${toggle("启用账号", "source-enabled", source.enabled, "参与消息监听与回复")}
    </div>
    <div class="form-section">
      <h2>监听与触发规则</h2>
      <div class="form-grid">
        ${field("允许私聊 wxid", "source-senders", listText(source.allowedSenderIds), { textarea: true })}
        ${field("允许私聊昵称", "source-nicknames", listText(source.privateNicknameAllowlist), { textarea: true })}
        ${field("监听群聊 ID", "source-groups", listText(source.allowedChatIds), { textarea: true })}
        ${field("群触发词", "source-triggers", listText(source.triggerKeywords), { textarea: true })}
        ${field("机器人名称", "source-bot-names", listText(source.botNames), { textarea: true })}
        ${field("关联自有账号", "source-peers", listText(source.selfChatPeers), { textarea: true })}
      </div>
      ${toggle("允许账号自聊", "source-allow-self", source.allowSelf, "处理发送给同一账号的消息")}
      ${toggle("接收关联账号入站", "source-accept-peers", source.acceptSelfChatPeerMessages, "仅处理关联账号发来的入站副本")}
    </div>`;
}

function renderAssistant() {
  const assistant = settings.assistant;
  const kb = settings.knowledgeBase;
  const caseManagement = settings.caseManagement || {};
  const codex = status.codex || {};
  const effective = codex.effective || {};
  content.innerHTML = `
    <div class="section">
      <div class="section-head"><div><h2>AGENTS.md</h2><p>${escapeHtml(agentDocument?.path || status.agentFile || "当前工作目录")}</p></div><button class="button primary" data-action="save-agent" ${agentDirty ? "" : "disabled"}><i data-lucide="save"></i><span>保存身份与权限</span></button></div>
      <textarea id="agent-editor" class="document-editor" spellcheck="false">${escapeHtml(agentDocument?.content || "")}</textarea>
      <p class="editor-note">这是当前实例的最高层个人策略。System Prompt、Skill 和 KB 可以补充，但不能扩大这里的权限。</p>
    </div>
    <div class="section">
      <div class="section-head"><div><h2>助手后端</h2><p>当前模式：${escapeHtml(assistant.mode)}</p></div></div>
      <div class="form-grid three">
        <div class="field"><label for="assistant-mode">运行模式</label><select id="assistant-mode" data-dirty>
          <option value="codex" ${assistant.mode === "codex" ? "selected" : ""}>本机 Codex</option>
          <option value="echo" ${assistant.mode === "echo" ? "selected" : ""}>Echo</option>
          <option value="webhook" ${assistant.mode === "webhook" ? "selected" : ""}>Webhook</option>
          <option value="openai-compatible" ${assistant.mode === "openai-compatible" ? "selected" : ""}>OpenAI Compatible</option>
        </select></div>
        ${field("历史轮数", "assistant-history", assistant.historyTurns, { type: "number" })}
        ${field("Worker 超时（毫秒）", "assistant-timeout", assistant.timeoutMs, { type: "number", note: "0 表示不限制" })}
        ${field("Codex 可执行文件", "assistant-codex-bin", assistant.codexBin || codex.binary, { full: true })}
        ${field("CODEX_HOME", "assistant-codex-home", assistant.codexHome || codex.home, { full: true })}
        ${field("工作目录", "assistant-working-directory", assistant.workingDirectory || effective.workingDirectory, { full: true })}
        ${field("Codex 模型", "assistant-codex-model", assistant.codexModel || effective.model, { note: "留空则继承本机配置" })}
        ${field("Reasoning Effort", "assistant-reasoning-effort", assistant.reasoningEffort || effective.reasoningEffort, { note: "low / medium / high / xhigh" })}
        ${field("Service Tier", "assistant-service-tier", assistant.serviceTier || effective.serviceTier, { note: "standard / priority / flex" })}
        ${field("LLM Base URL", "assistant-base-url", assistant.llmBaseUrl, { full: true })}
        ${field("OpenAI Compatible 模型", "assistant-model", assistant.llmModel)}
        ${field("API Key", "assistant-api-key", "", { type: "password", note: assistant.llmApiKeyConfigured ? "已配置" : "" })}
        ${field("Webhook URL", "assistant-webhook-url", assistant.webhookUrl, { full: true })}
        ${field("Webhook Token", "assistant-webhook-token", "", { type: "password", note: assistant.webhookTokenConfigured ? "已配置" : "" })}
        ${field("System Prompt", "assistant-prompt", assistant.systemPrompt, { textarea: true, full: true, note: "Codex 模式下作为 developer_instructions 生效" })}
      </div>
      <div class="release-row"><span>本机配置</span><strong>${codex.configPresent ? "已读取" : "未找到"} · ${codex.authPresent ? "认证已就绪" : "认证未就绪"}</strong></div>
      <div class="release-row"><span>配置更新时间</span><code>${escapeHtml(codex.configMtime || "未知")}</code></div>
    </div>
    <div class="section">
      <div class="section-head"><div><h2>Case 自动化</h2><p>入站先形成 Case，再由 worker 生成 draft</p></div></div>
      ${toggle("自动运行 Worker", "case-auto-run", caseManagement.autoRun !== false, "新消息进入后自动生成 draft")}
      ${toggle("自动发送 Draft", "case-auto-send", caseManagement.autoSend !== false, "生成成功后立即回复微信")}
      ${toggle("本人接收中间回复", "case-owner-intermediate-items", caseManagement.ownerIntermediateItems === true, "仅 owner 任务发送 Codex 的自然语言中间 item")}
      <div class="form-grid">
        ${field("Worker 并发", "case-worker-concurrency", caseManagement.workerConcurrency || 2, { type: "number" })}
      </div>
    </div>
    <div class="section">
      <div class="section-head"><div><h2>个人 KB Cloud</h2><p>${status.knowledgeBase?.ready ? `${status.knowledgeBase.noteCount} 篇文档` : "未同步"}</p></div><div class="inline-actions"><button class="button secondary" data-action="new-kb"><i data-lucide="plus"></i><span>新建文档</span></button><button class="button secondary" data-action="sync-kb"><i data-lucide="cloud"></i><span>立即同步</span></button></div></div>
      ${toggle("启用知识库", "kb-enabled", kb.enabled, "检索相关 Markdown 并注入助手上下文")}
      <div class="form-grid">
        ${field("Git Remote", "kb-remote", kb.remote, { full: true })}
        ${field("分支", "kb-branch", kb.branch)}
        ${field("本地目录", "kb-local-dir", kb.localDir)}
        ${field("同步间隔（秒）", "kb-interval", kb.syncIntervalSeconds, { type: "number" })}
        ${field("最多命中文档", "kb-max-notes", kb.maxNotes, { type: "number" })}
        ${field("单篇字符上限", "kb-max-chars", kb.maxCharsPerNote, { type: "number" })}
      </div>
      ${toggle("仅使用 approved 文档", "kb-approved", kb.requireApproved, "Frontmatter 需要 approved: true")}
      <div class="knowledge-studio">
        <aside class="knowledge-list">
          <div class="knowledge-list-head"><strong>Markdown</strong><span>${knowledgeDocuments.length}</span></div>
          ${knowledgeDocuments.map((document) => `
            <button class="knowledge-item ${selectedKnowledge?.file === document.file ? "active" : ""}" data-kb-file="${escapeHtml(document.file)}">
              <i data-lucide="file-text"></i>
              <span><strong>${escapeHtml(document.title)}</strong><small>${escapeHtml(document.file)}</small></span>
              <em class="${document.approved ? "approved" : ""}">${document.approved ? document.audience : "draft"}</em>
            </button>
          `).join("") || `<div class="empty compact"><div>尚无知识文档</div></div>`}
        </aside>
        <div class="knowledge-editor-shell">
          ${selectedKnowledge ? `
            <div class="knowledge-toolbar">
              <input id="knowledge-file" class="input" value="${escapeHtml(selectedKnowledge.file)}" ${selectedKnowledge.hash ? "readonly" : ""} aria-label="知识文档路径">
              <div class="segmented compact">
                <button data-action="knowledge-mode" data-mode="source" class="${knowledgeMode === "source" ? "active" : ""}"><i data-lucide="file-text"></i><span>原文</span></button>
                <button data-action="knowledge-mode" data-mode="preview" class="${knowledgeMode === "preview" ? "active" : ""}"><i data-lucide="eye"></i><span>预览</span></button>
              </div>
              <button class="button danger icon-only" data-action="delete-kb" title="删除文档" ${selectedKnowledge.hash ? "" : "disabled"}><i data-lucide="trash-2"></i></button>
              <button class="button primary" data-action="save-kb" ${knowledgeDirty ? "" : "disabled"}><i data-lucide="save"></i><span>保存</span></button>
            </div>
            <textarea id="knowledge-editor" class="document-editor ${knowledgeMode === "source" ? "" : "hidden"}" spellcheck="false">${escapeHtml(selectedKnowledge.content || "")}</textarea>
            <article class="knowledge-preview ${knowledgeMode === "preview" ? "" : "hidden"}">${renderMarkdown(selectedKnowledge.content || "")}</article>
          ` : `<div class="empty"><div><i data-lucide="book-open"></i><div>选择或新建一篇 Markdown 文档</div></div></div>`}
        </div>
      </div>
    </div>
    <div class="section">
      <h2 style="margin-bottom:16px">发送控制</h2>
      <div class="field"><label>发送模式</label><div class="segmented">
        <button data-action="outbound-mode" data-mode="dry-run" class="${settings.outboundMode !== "live" ? "active" : ""}">演练</button>
        <button data-action="outbound-mode" data-mode="live" class="${settings.outboundMode === "live" ? "active" : ""}">正式</button>
      </div></div>
      ${toggle("网关写操作确认", "pad-write-confirm", settings.pad.requireWriteConfirmation, "请求附带确认标记与唯一请求 ID")}
    </div>`;
}

function renderRelease() {
  const codex = status.codex || {};
  const effective = codex.effective || {};
  content.innerHTML = `
    <div class="section">
      <div class="section-head"><div><h2>运行信息</h2><p>本机 Webot 服务</p></div></div>
      <div class="release-row"><span>版本</span><strong>${escapeHtml(status.version)}</strong></div>
      <div class="release-row"><span>监听地址</span><code>http://127.0.0.1:18120</code></div>
      <div class="release-row"><span>数据目录</span><code>${escapeHtml(status.dataDir)}</code></div>
      <div class="release-row"><span>配置文件</span><code>${escapeHtml(status.settingsFile)}</code></div>
      <div class="release-row"><span>运行通道</span><strong>${escapeHtml(status.channels.join(", ") || "未启用")}</strong></div>
      <div class="release-row"><span>Codex</span><strong>${codex.binaryReady && codex.configPresent ? "可用" : "未就绪"}</strong></div>
      <div class="release-row"><span>Codex 路径</span><code>${escapeHtml(codex.binary || "")}</code></div>
      <div class="release-row"><span>CODEX_HOME</span><code>${escapeHtml(codex.home || "")}</code></div>
      <div class="release-row"><span>有效模型</span><strong>${escapeHtml(effective.model || "本机默认")}</strong></div>
      <div class="release-row"><span>Reasoning / Tier</span><strong>${escapeHtml(effective.reasoningEffort || "默认")} / ${escapeHtml(effective.serviceTier || "默认")}</strong></div>
    </div>
    <div class="section">
      <div class="section-head"><div><h2>发布形态</h2><p>当前平台单文件运行包</p></div></div>
      <div class="metric-grid">
        <div class="metric"><div class="metric-top"><span>服务程序</span><i data-lucide="package-check"></i></div><strong>单文件</strong><small>Node SEA 可执行文件</small></div>
        <div class="metric"><div class="metric-top"><span>配置与会话</span><i data-lucide="database"></i></div><strong>外置</strong><small>用户数据目录独立保存</small></div>
        <div class="metric"><div class="metric-top"><span>源码</span><i data-lucide="shield-check"></i></div><strong>不随包</strong><small>发布包仅含程序与文档</small></div>
      </div>
    </div>`;
}

function render() {
  const [eyebrow, title] = views[activeView];
  document.querySelector("#view-eyebrow").textContent = eyebrow;
  document.querySelector("#view-title").textContent = title;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === activeView);
  });
  if (!settings || !status) {
    content.innerHTML = `<div class="empty"><div><i data-lucide="refresh-cw"></i><div>正在读取运行状态</div></div></div>`;
  } else if (activeView === "cases") renderCases();
  else if (activeView === "overview") renderOverview();
  else if (activeView === "accounts") renderAccounts();
  else if (activeView === "assistant") renderAssistant();
  else renderRelease();
  icons();
}

function readAccountForm() {
  const source = settings.pad.sources[selectedSource];
  if (!source || !document.querySelector("#source-id")) return;
  Object.assign(source, {
    displayName: document.querySelector("#source-name").value.trim(),
    id: document.querySelector("#source-id").value.trim(),
    selfId: document.querySelector("#source-wxid").value.trim(),
    apiUrl: document.querySelector("#source-api").value.trim(),
    wsUrl: document.querySelector("#source-ws")?.value.trim() ?? source.wsUrl,
    accessToken: document.querySelector("#source-token").value,
    accessTokenFile: document.querySelector("#source-token-file").value.trim(),
    enabled: document.querySelector("#source-enabled").checked,
    allowedSenderIds: parseList(document.querySelector("#source-senders").value),
    privateNicknameAllowlist: parseList(document.querySelector("#source-nicknames").value),
    allowedChatIds: parseList(document.querySelector("#source-groups").value),
    triggerKeywords: parseList(document.querySelector("#source-triggers").value),
    botNames: parseList(document.querySelector("#source-bot-names").value),
    selfChatPeers: parseList(document.querySelector("#source-peers").value),
    allowSelf: document.querySelector("#source-allow-self").checked,
    acceptSelfChatPeerMessages: document.querySelector("#source-accept-peers").checked,
  });
}

function readAssistantForm() {
  if (!document.querySelector("#assistant-mode")) return;
  Object.assign(settings.assistant, {
    mode: document.querySelector("#assistant-mode").value,
    historyTurns: Number(document.querySelector("#assistant-history").value),
    timeoutMs: Number(document.querySelector("#assistant-timeout").value),
    llmBaseUrl: document.querySelector("#assistant-base-url").value.trim(),
    llmModel: document.querySelector("#assistant-model").value.trim(),
    llmApiKey: document.querySelector("#assistant-api-key").value,
    webhookUrl: document.querySelector("#assistant-webhook-url").value.trim(),
    webhookToken: document.querySelector("#assistant-webhook-token").value,
    systemPrompt: document.querySelector("#assistant-prompt").value,
    codexBin: document.querySelector("#assistant-codex-bin").value.trim(),
    codexHome: document.querySelector("#assistant-codex-home").value.trim(),
    workingDirectory: document.querySelector("#assistant-working-directory").value.trim(),
    codexModel: document.querySelector("#assistant-codex-model").value.trim(),
    reasoningEffort: document.querySelector("#assistant-reasoning-effort").value.trim(),
    serviceTier: document.querySelector("#assistant-service-tier").value.trim(),
  });
  Object.assign(settings.knowledgeBase, {
    enabled: document.querySelector("#kb-enabled").checked,
    remote: document.querySelector("#kb-remote").value.trim(),
    branch: document.querySelector("#kb-branch").value.trim(),
    localDir: document.querySelector("#kb-local-dir").value.trim(),
    syncIntervalSeconds: Number(document.querySelector("#kb-interval").value),
    maxNotes: Number(document.querySelector("#kb-max-notes").value),
    maxCharsPerNote: Number(document.querySelector("#kb-max-chars").value),
    requireApproved: document.querySelector("#kb-approved").checked,
  });
  settings.caseManagement = {
    autoRun: document.querySelector("#case-auto-run").checked,
    autoSend: document.querySelector("#case-auto-send").checked,
    ownerIntermediateItems: document.querySelector(
      "#case-owner-intermediate-items",
    ).checked,
    workerConcurrency: Number(
      document.querySelector("#case-worker-concurrency").value,
    ),
  };
  settings.pad.requireWriteConfirmation = document.querySelector("#pad-write-confirm").checked;
}

function readCurrentForm() {
  if (activeView === "accounts") readAccountForm();
  if (activeView === "assistant") readAssistantForm();
}

async function load() {
  const [settingsBody, statusBody, casesBody, agentBody, knowledgeBody] = await Promise.all([
    api("/api/admin/settings"),
    api("/api/admin/status"),
    api("/api/admin/cases"),
    api("/api/admin/agent"),
    api("/api/admin/kb/documents"),
  ]);
  settings = settingsBody.settings;
  status = statusBody;
  cases = casesBody.cases || [];
  workers = casesBody.workers || {};
  agentDocument = agentBody.document;
  agentDirty = false;
  knowledgeDocuments = knowledgeBody.documents || [];
  if (selectedKnowledge?.file) {
    const match = knowledgeDocuments.find(
      (document) => document.file === selectedKnowledge.file,
    );
    selectedKnowledge = match
      ? (
          await api(
            `/api/admin/kb/document?file=${encodeURIComponent(match.file)}`,
          )
        ).document
      : null;
  } else if (knowledgeDocuments[0]) {
    selectedKnowledge = (
      await api(
        `/api/admin/kb/document?file=${encodeURIComponent(knowledgeDocuments[0].file)}`,
      )
    ).document;
  }
  knowledgeDirty = false;
  if (
    selectedCase &&
    !cases.some((item) => item.case_id === selectedCase.case_id)
  ) {
    selectedCase = null;
  }
  settings.pad ||= { sources: [] };
  settings.pad.sources ||= [];
  document.querySelector("#service-dot").classList.add("ok");
  document.querySelector("#service-label").textContent = "服务运行中";
  dirty = false;
  saveState.textContent = "";
  render();
}

document.addEventListener("input", (event) => {
  if (event.target.id === "agent-editor") {
    agentDirty = true;
    document.querySelector('[data-action="save-agent"]')?.removeAttribute("disabled");
    return;
  }
  if (event.target.id === "knowledge-editor") {
    knowledgeDirty = true;
    selectedKnowledge.content = event.target.value;
    document.querySelector('[data-action="save-kb"]')?.removeAttribute("disabled");
    return;
  }
  if (event.target.id === "knowledge-file") {
    knowledgeDirty = true;
    selectedKnowledge.file = event.target.value;
    document.querySelector('[data-action="save-kb"]')?.removeAttribute("disabled");
    return;
  }
  if (!event.target.matches("[data-dirty]")) return;
  dirty = true;
  saveState.textContent = "未保存";
  if (event.target.id === "source-ws-port") {
    const source = settings.pad.sources[selectedSource];
    const port = event.target.value.trim();
    const wxid = document.querySelector("#source-wxid").value.trim();
    document.querySelector("#source-ws").value =
      port && wxid ? `ws://127.0.0.1:${port}/ws/${wxid}` : "";
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-dirty]")) {
    dirty = true;
    saveState.textContent = "未保存";
  }
});

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav) {
    readCurrentForm();
    activeView = nav.dataset.view;
    history.replaceState(null, "", `#${activeView}`);
    render();
    return;
  }
  const sourceButton = event.target.closest("[data-source-index]");
  if (sourceButton) {
    readAccountForm();
    selectedSource = Number(sourceButton.dataset.sourceIndex);
    render();
    return;
  }
  const caseButton = event.target.closest("[data-case-select]");
  if (caseButton) {
    selectedCase = (
      await api(
        `/api/admin/case?caseId=${encodeURIComponent(caseButton.dataset.caseSelect)}`,
      )
    ).case;
    render();
    if (window.matchMedia("(max-width: 620px)").matches) {
      document.querySelector(".case-detail")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
    return;
  }
  const knowledgeButton = event.target.closest("[data-kb-file]");
  if (knowledgeButton) {
    if (knowledgeDirty && !confirm("当前知识文档尚未保存，仍要切换吗？")) return;
    selectedKnowledge = (
      await api(
        `/api/admin/kb/document?file=${encodeURIComponent(knowledgeButton.dataset.kbFile)}`,
      )
    ).document;
    knowledgeDirty = false;
    render();
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  try {
    if (action === "add-source") {
      readAccountForm();
      settings.pad.sources.push({
        id: `account-${settings.pad.sources.length + 1}`,
        displayName: `微信账号 ${settings.pad.sources.length + 1}`,
        selfId: "",
        enabled: true,
        wsUrl: "",
        apiUrl: "http://127.0.0.1:18102/api",
        accessToken: "",
        accessTokenFile: "",
        allowSelf: false,
        selfChatPeers: [],
        acceptSelfChatPeerMessages: false,
        allowedChatIds: [],
        allowedSenderIds: [],
        privateNicknameAllowlist: [],
        triggerKeywords: ["webot"],
        botNames: ["Webot"],
      });
      selectedSource = settings.pad.sources.length - 1;
      dirty = true;
      saveState.textContent = "未保存";
      render();
    } else if (action === "delete-source") {
      settings.pad.sources.splice(selectedSource, 1);
      selectedSource = Math.max(0, selectedSource - 1);
      dirty = true;
      saveState.textContent = "未保存";
      render();
    } else if (action === "outbound-mode") {
      settings.outboundMode = event.target.closest("[data-mode]").dataset.mode;
      dirty = true;
      saveState.textContent = "未保存";
      render();
    } else if (action === "test-source") {
      readAccountForm();
      if (dirty) throw new Error("请先保存配置");
      const result = await api("/api/admin/opt/test", {
        method: "POST",
        body: JSON.stringify({ sourceId: settings.pad.sources[selectedSource].id }),
      });
      showNotice(result.source.ready ? "连接检测通过" : `连接未就绪：${result.source.lastError || result.source.state}`);
      await load();
    } else if (action === "sync-kb") {
      if (knowledgeDirty) throw new Error("请先保存当前知识文档");
      const result = await api("/api/admin/kb/sync", { method: "POST" });
      showNotice(result.knowledgeBase.ready ? "知识库同步完成" : `同步失败：${result.knowledgeBase.lastError}`);
      await load();
    } else if (action === "save-agent") {
      agentDocument = (
        await api("/api/admin/agent", {
          method: "PUT",
          body: JSON.stringify({
            content: document.querySelector("#agent-editor").value,
            baseHash: agentDocument.hash,
          }),
        })
      ).document;
      agentDirty = false;
      showNotice("AGENTS.md 已保存，下一个 worker 会读取新策略");
      render();
    } else if (action === "new-kb") {
      if (knowledgeDirty && !confirm("当前知识文档尚未保存，仍要新建吗？")) return;
      const date = new Date().toISOString().slice(0, 10);
      selectedKnowledge = {
        file: "owner/new-note.md",
        content: `---\napproved: true\naudience: owner\nupdated: ${date}\n---\n# 新知识\n\n`,
        hash: "",
      };
      knowledgeDirty = true;
      knowledgeMode = "source";
      render();
      document.querySelector("#knowledge-file")?.focus();
    } else if (action === "knowledge-mode") {
      if (selectedKnowledge && document.querySelector("#knowledge-editor")) {
        selectedKnowledge.content = document.querySelector("#knowledge-editor").value;
      }
      knowledgeMode = event.target.closest("[data-mode]").dataset.mode;
      render();
    } else if (action === "save-kb") {
      selectedKnowledge.content = document.querySelector("#knowledge-editor").value;
      selectedKnowledge.file = document.querySelector("#knowledge-file").value.trim();
      selectedKnowledge = (
        await api("/api/admin/kb/document", {
          method: "PUT",
          body: JSON.stringify({
            file: selectedKnowledge.file,
            content: selectedKnowledge.content,
            baseHash: selectedKnowledge.hash || "",
          }),
        })
      ).document;
      knowledgeDirty = false;
      knowledgeDocuments = (
        await api("/api/admin/kb/documents")
      ).documents;
      showNotice("知识文档已保存");
      render();
    } else if (action === "delete-kb") {
      if (!confirm(`删除 ${selectedKnowledge.file}？`)) return;
      await api("/api/admin/kb/document", {
        method: "DELETE",
        body: JSON.stringify({
          file: selectedKnowledge.file,
          baseHash: selectedKnowledge.hash,
        }),
      });
      selectedKnowledge = null;
      knowledgeDirty = false;
      knowledgeDocuments = (
        await api("/api/admin/kb/documents")
      ).documents;
      if (knowledgeDocuments[0]) {
        selectedKnowledge = (
          await api(
            `/api/admin/kb/document?file=${encodeURIComponent(knowledgeDocuments[0].file)}`,
          )
        ).document;
      }
      showNotice("知识文档已删除");
      render();
    } else if (action === "probe-all") {
      for (const source of settings.pad.sources) {
        await api("/api/admin/opt/test", {
          method: "POST",
          body: JSON.stringify({ sourceId: source.id }),
        });
      }
      await load();
    } else if (action === "run-case") {
      const target = event.target.closest("[data-case-id]");
      await api("/api/admin/case/run", {
        method: "POST",
        body: JSON.stringify({ caseId: target.dataset.caseId }),
      });
      await refreshCases(true);
    } else if (action === "stop-case") {
      const target = event.target.closest("[data-case-id]");
      await api("/api/admin/case/stop", {
        method: "POST",
        body: JSON.stringify({ caseId: target.dataset.caseId }),
      });
      await refreshCases(true);
    } else if (action === "reset-session") {
      const target = event.target.closest("[data-case-id]");
      if (!confirm("重置后下一次将创建新的 Codex Session，继续吗？")) return;
      await api("/api/admin/case/session/reset", {
        method: "POST",
        body: JSON.stringify({ caseId: target.dataset.caseId }),
      });
      await refreshCases(true);
    } else if (action === "send-draft") {
      const target = event.target.closest("[data-draft-id]");
      if (!confirm("发送这个 draft 到微信？")) return;
      await api("/api/admin/case/send", {
        method: "POST",
        body: JSON.stringify({
          caseId: target.dataset.caseId,
          draftId: Number(target.dataset.draftId),
        }),
      });
      await refreshCases(true);
    } else if (action === "workers-paused") {
      await api("/api/admin/workers/pause", {
        method: "POST",
        body: JSON.stringify({ paused: event.target.checked }),
      });
      await refreshCases(false);
    }
  } catch (error) {
    showNotice(error.message, true);
  }
});

async function refreshCases(includeDetail = false) {
  const body = await api("/api/admin/cases");
  cases = body.cases || [];
  workers = body.workers || {};
  if (includeDetail && selectedCase) {
    selectedCase = (
      await api(
        `/api/admin/case?caseId=${encodeURIComponent(selectedCase.case_id)}`,
      )
    ).case;
  }
  render();
}

window.setInterval(() => {
  if (activeView === "cases" && !dirty) {
    refreshCases(Boolean(selectedCase)).catch(() => {});
  }
}, 3000);

document.querySelector("#save-button").addEventListener("click", async () => {
  try {
    readCurrentForm();
    saveState.textContent = "保存中";
    const body = await api("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    settings = body.settings;
    dirty = false;
    saveState.textContent = "已保存";
    showNotice("配置已生效");
    status = await api("/api/admin/status");
    render();
  } catch (error) {
    saveState.textContent = "保存失败";
    showNotice(error.message, true);
  }
});

document.querySelector("#refresh-button").addEventListener("click", () => {
  readCurrentForm();
  if (dirty) {
    showNotice("存在未保存配置", true);
    return;
  }
  load().catch((error) => showNotice(error.message, true));
});

load().catch((error) => {
  document.querySelector("#service-label").textContent = "服务不可用";
  showNotice(error.message, true);
  render();
});
