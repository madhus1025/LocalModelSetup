import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked } from "marked";
import type {
  AgentMode,
  ChangeReviewRequest,
  ExtensionToWebviewMessage,
  PermissionRequest,
  RunStatus,
  WebviewState,
  WebviewToExtensionMessage
} from "../../shared/protocol";
import "./styles.css";

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const app = requiredElement("app");
let state: WebviewState | undefined;
let renderedConversationId: string | undefined;
let renderedMessageFingerprint = "";
let messageRenderTimer: number | undefined;
const pendingMessageRenders = new Set<string>();
const reasoningByMessageId = new Map<string, string>();
const userExpandedThoughts = new Set<string>();
let runElapsedTimer: number | undefined;
let runStartedAtMs = 0;

for (const [name, language] of Object.entries({
  bash,
  cpp,
  csharp,
  css,
  go,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  python,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml
})) {
  hljs.registerLanguage(name, language);
}

app.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">◆</span>
      <span>Local Agent</span>
    </div>
    <div class="top-actions">
      <button id="new-conversation" class="icon-button" title="New conversation" aria-label="New conversation">＋</button>
      <button id="clear-context" class="icon-button" title="Clear context" aria-label="Clear context">⌫</button>
      <button id="settings" class="icon-button" title="Settings" aria-label="Settings">⚙</button>
    </div>
  </header>
  <section class="session-row">
    <select id="conversation-select" aria-label="Conversation history"></select>
    <button id="model-status" class="status-button" type="button"></button>
  </section>
  <section id="messages" class="messages" aria-label="Chat history"></section>
  <section id="run-status" class="run-status" aria-live="polite"></section>
  <section id="activity" class="activity" aria-label="Tool activity"></section>
  <section id="approval-region"></section>
  <footer class="composer">
    <div class="composer-controls">
      <label>
        <span class="sr-only">Execution mode</span>
        <select id="mode">
          <option value="ask">Ask</option>
          <option value="edit">Edit</option>
          <option value="agent">Agent</option>
        </select>
      </label>
      <div id="token-usage" class="token-usage"></div>
      <button id="retry" class="text-button" type="button">Retry</button>
    </div>
    <textarea id="prompt" rows="3" placeholder="Ask about this repository…" aria-label="Agent request"></textarea>
    <div class="send-row">
      <span class="hint">Enter to send · Shift+Enter for newline</span>
      <button id="stop" class="danger-button hidden" type="button">Stop</button>
      <button id="send" class="primary-button" type="button">Send</button>
    </div>
  </footer>
  <div id="toast-region" class="toast-region" aria-live="assertive"></div>
`;

const messagesElement = requiredElement("messages");
const activityElement = requiredElement("activity");
const approvalRegion = requiredElement("approval-region");
const promptElement = requiredElement<HTMLTextAreaElement>("prompt");
const modeElement = requiredElement<HTMLSelectElement>("mode");
const conversationSelect =
  requiredElement<HTMLSelectElement>("conversation-select");

bind("new-conversation", () => post({ type: "newConversation" }));
bind("clear-context", () => post({ type: "clearContext" }));
bind("settings", () => post({ type: "openSettings" }));
bind("model-status", () => post({ type: "checkModel" }));
bind("retry", () => post({ type: "retry" }));
bind("stop", () => post({ type: "stop" }));
bind("send", sendPrompt);

modeElement.addEventListener("change", () => {
  post({ type: "setMode", mode: modeElement.value as AgentMode });
});
conversationSelect.addEventListener("change", () => {
  post({ type: "selectConversation", id: conversationSelect.value });
});
promptElement.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendPrompt();
  }
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data as ExtensionToWebviewMessage;
  if (message.type === "state") {
    state = message.state;
    vscode.setState({ activeConversationId: state.activeConversationId });
    render();
  } else if (message.type === "assistantDelta") {
    if (state !== undefined) {
      const target = state.messages.find(
        (candidate) => candidate.id === message.messageId
      );
      if (target !== undefined) {
        target.content += message.delta;
        renderedMessageFingerprint = messageFingerprint(state);
        scheduleMessageRender(target.id);
      }
    }
  } else if (message.type === "reasoningDelta") {
    reasoningByMessageId.set(
      message.messageId,
      (reasoningByMessageId.get(message.messageId) ?? "") + message.delta
    );
    scheduleMessageRender(message.messageId);
  } else if (message.type === "notice") {
    showToast(message.level, message.text);
  } else if (message.type === "focusInput") {
    promptElement.focus();
  }
});

post({ type: "ready" });

function render(): void {
  if (state === undefined) {
    return;
  }
  renderHeaderState(state);
  if (renderedConversationId !== state.activeConversationId) {
    reasoningByMessageId.clear();
    userExpandedThoughts.clear();
  }
  const fingerprint = messageFingerprint(state);
  if (
    renderedConversationId !== state.activeConversationId ||
    renderedMessageFingerprint !== fingerprint
  ) {
    renderMessages(state);
    renderedConversationId = state.activeConversationId;
    renderedMessageFingerprint = fingerprint;
  }
  renderActivity(state);
  renderRunStatus(state);
  renderApproval(state.pendingPermission, state.pendingReview);
  renderComposerState(state);
}

function renderHeaderState(current: WebviewState): void {
  conversationSelect.innerHTML = current.conversations
    .map(
      (conversation) =>
        `<option value="${escapeAttribute(conversation.id)}"${
          conversation.id === current.activeConversationId ? " selected" : ""
        }>${escapeHtml(conversation.title)}</option>`
    )
    .join("");
  conversationSelect.disabled = current.isRunning;

  const status = requiredElement("model-status");
  status.className = `status-button status-${current.model.state}`;
  status.textContent =
    current.model.state === "ready"
      ? `● ${current.model.name}`
      : current.model.state === "checking"
        ? "◌ Checking model"
        : current.model.state === "unavailable"
          ? "● Model offline"
          : "○ Check model";
  status.title = current.model.detail ?? current.model.endpoint;
}

function renderMessages(current: WebviewState): void {
  const wasNearBottom =
    messagesElement.scrollHeight -
      messagesElement.scrollTop -
      messagesElement.clientHeight <
    80;
  messagesElement.innerHTML =
    current.messages.length === 0
      ? `<div class="empty-state">
          <div class="empty-icon">⌘</div>
          <h2>Work locally</h2>
          <p>Ask a question, review an edit, or let the agent inspect, change, and verify this repository.</p>
        </div>`
      : current.messages
          .map(
            (message) => `
          <article class="message message-${message.role} message-${message.state}" data-message-id="${escapeAttribute(message.id)}">
            <div class="message-label">${message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "Context"}</div>
            <div class="message-content" id="message-${escapeAttribute(message.id)}"></div>
            ${message.state === "streaming" ? '<span class="streaming-dot" aria-label="Streaming"></span>' : ""}
          </article>`
          )
          .join("");
  for (const message of current.messages) {
    renderMessageContent(message.id, message.content);
  }
  if (wasNearBottom) {
    scrollToBottom();
  }
}

function renderMessageContent(id: string, content: string): void {
  const element = document.getElementById(`message-${id}`);
  if (element === null) {
    return;
  }

  const rendered = marked.parse(content, {
    gfm: true,
    breaks: true,
    async: false
  });
  const contentHtml = DOMPurify.sanitize(String(rendered), {
    USE_PROFILES: { html: true }
  });
  element.innerHTML = thoughtsMarkup(id) + contentHtml;

  const details = element.querySelector<HTMLDetailsElement>("details.thoughts");
  if (details !== null) {
    details.addEventListener("toggle", () => {
      if (details.open) {
        userExpandedThoughts.add(id);
      } else {
        userExpandedThoughts.delete(id);
      }
    });
    const body = details.querySelector<HTMLElement>(".thoughts-body");
    if (body !== null && details.open) {
      body.scrollTop = body.scrollHeight;
    }
  }

  element.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block as HTMLElement);
  });
  element.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      const href = anchor.getAttribute("href");
      if (href === null) {
        return;
      }
      if (/^https?:\/\//i.test(href)) {
        return;
      }
      event.preventDefault();
      const parsed = parseFileReference(href);
      post({ type: "openFile", path: parsed.path, line: parsed.line });
    });
  });
}

function thoughtsMarkup(id: string): string {
  const reasoning = reasoningByMessageId.get(id);
  if (reasoning === undefined || reasoning.trim().length === 0) {
    return "";
  }
  const open =
    isMessageStreaming(id) || userExpandedThoughts.has(id) ? " open" : "";
  return `<details class="thoughts"${open}>
    <summary><span class="thoughts-icon" aria-hidden="true">✧</span> Thinking</summary>
    <div class="thoughts-body">${escapeHtml(reasoning)}</div>
  </details>`;
}

function isMessageStreaming(id: string): boolean {
  return (
    state?.messages.some(
      (message) => message.id === id && message.state === "streaming"
    ) ?? false
  );
}

function scheduleMessageRender(id: string): void {
  pendingMessageRenders.add(id);
  if (messageRenderTimer !== undefined) {
    return;
  }
  messageRenderTimer = window.setTimeout(() => {
    messageRenderTimer = undefined;
    if (state === undefined) {
      pendingMessageRenders.clear();
      return;
    }
    for (const messageId of pendingMessageRenders) {
      const message = state.messages.find(
        (candidate) => candidate.id === messageId
      );
      if (message !== undefined) {
        renderMessageContent(message.id, message.content);
      }
    }
    pendingMessageRenders.clear();
    scrollToBottom();
  }, 75);
}

function renderActivity(current: WebviewState): void {
  if (current.activities.length === 0) {
    activityElement.innerHTML = "";
    return;
  }
  activityElement.innerHTML = `
    <details ${current.isRunning ? "open" : ""}>
      <summary>Tool activity (${current.activities.length})</summary>
      <div class="activity-list">
        ${current.activities
          .map(
            (activity) => `
          <div class="activity-item activity-${activity.state}">
            <span class="activity-state">${activityIcon(activity.state)}</span>
            <div>
              <strong>${escapeHtml(activity.name)}</strong>
              <div>${escapeHtml(activity.summary)}</div>
              ${activity.detail === undefined ? "" : `<small>${escapeHtml(activity.detail)}</small>`}
            </div>
          </div>`
          )
          .join("")}
      </div>
    </details>`;
}

function renderRunStatus(current: WebviewState): void {
  const container = requiredElement("run-status");
  const status = current.isRunning ? current.runStatus : undefined;
  if (status === undefined) {
    container.innerHTML = "";
    stopRunElapsedTimer();
    return;
  }

  if (document.getElementById("run-spinner") === null) {
    container.innerHTML = `
      <div class="run-card">
        <span id="run-spinner" class="run-spinner" aria-hidden="true"></span>
        <div class="run-body">
          <div class="run-head">
            <strong id="run-phase"></strong>
            <span id="run-elapsed" class="run-elapsed"></span>
          </div>
          <div id="run-counts" class="run-counts"></div>
          <div id="run-thought" class="run-thought"></div>
        </div>
        <button id="run-stop" class="danger-button" type="button">Stop</button>
      </div>`;
    requiredElement<HTMLButtonElement>("run-stop").addEventListener(
      "click",
      () => post({ type: "stop" })
    );
  }

  requiredElement("run-phase").textContent = runPhaseLabel(status);

  const counts: string[] = [];
  if (status.reasoningTokens > 0) {
    counts.push(`${formatNumber(status.reasoningTokens)} thinking`);
  }
  if (status.outputTokens > 0) {
    counts.push(`${formatNumber(status.outputTokens)} output`);
  }
  requiredElement("run-counts").textContent = counts.join(" · ");

  const thought = requiredElement("run-thought");
  const showThought =
    typeof status.thought === "string" &&
    status.thought.length > 0 &&
    (status.phase === "thinking" || status.phase === "preparing");
  thought.textContent = showThought ? (status.thought ?? "") : "";
  thought.classList.toggle("hidden", !showThought);

  runStartedAtMs = Date.parse(status.startedAt);
  updateRunElapsed();
  startRunElapsedTimer();
}

function runPhaseLabel(status: RunStatus): string {
  switch (status.phase) {
    case "thinking":
      return "Thinking…";
    case "responding":
      return "Responding…";
    case "tool":
      return `Running ${status.toolName ?? "tool"}…`;
    case "finalizing":
      return "Finalizing…";
    default:
      return "Preparing…";
  }
}

function updateRunElapsed(): void {
  const element = document.getElementById("run-elapsed");
  if (element === null || runStartedAtMs === 0) {
    return;
  }
  const seconds = Math.max(0, Math.round((Date.now() - runStartedAtMs) / 1000));
  element.textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function startRunElapsedTimer(): void {
  if (runElapsedTimer !== undefined) {
    return;
  }
  runElapsedTimer = window.setInterval(updateRunElapsed, 1_000);
}

function stopRunElapsedTimer(): void {
  if (runElapsedTimer !== undefined) {
    window.clearInterval(runElapsedTimer);
    runElapsedTimer = undefined;
  }
  runStartedAtMs = 0;
}

function renderApproval(
  permission: PermissionRequest | undefined,
  review: ChangeReviewRequest | undefined
): void {
  if (permission !== undefined) {
    approvalRegion.innerHTML = `
      <section class="approval-card danger-card">
        <h3>${escapeHtml(permission.title)}</h3>
        <pre>${escapeHtml(permission.detail)}</pre>
        <ul>${permission.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
        <div class="approval-actions">
          <button id="deny-permission" class="secondary-button">Deny</button>
          <button id="allow-permission" class="danger-button">Allow once</button>
        </div>
      </section>`;
    bind("deny-permission", () =>
      post({
        type: "permissionDecision",
        permissionId: permission.id,
        allow: false
      })
    );
    bind("allow-permission", () =>
      post({
        type: "permissionDecision",
        permissionId: permission.id,
        allow: true
      })
    );
    return;
  }
  if (review !== undefined) {
    approvalRegion.innerHTML = renderReview(review);
    bind("reject-review", () =>
      post({
        type: "reviewDecision",
        reviewId: review.id,
        action: "reject",
        selectedHunkIds: []
      })
    );
    bind("apply-review", () => {
      const selected = [
        ...approvalRegion.querySelectorAll<HTMLInputElement>(
          'input[data-hunk-id]:checked'
        )
      ].map((input) => input.dataset.hunkId!);
      if (selected.length === 0) {
        showToast("warning", "Select at least one hunk.");
        return;
      }
      post({
        type: "reviewDecision",
        reviewId: review.id,
        action: "apply",
        selectedHunkIds: selected
      });
    });
    approvalRegion
      .querySelectorAll<HTMLButtonElement>("[data-open-diff]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          post({
            type: "openDiff",
            reviewId: review.id,
            path: button.dataset.openDiff!
          });
        });
      });
    approvalRegion
      .querySelectorAll<HTMLButtonElement>("[data-apply-file]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const filePath = button.dataset.applyFile!;
          const selected = review.files
            .find((file) => file.path === filePath)!
            .hunks.map((hunk) => hunk.id);
          post({
            type: "reviewDecision",
            reviewId: review.id,
            action: "apply",
            selectedHunkIds: selected
          });
        });
      });
    return;
  }
  approvalRegion.innerHTML = "";
}

function renderReview(review: ChangeReviewRequest): string {
  return `
    <section class="approval-card review-card">
      <div class="review-heading">
        <div>
          <span class="eyebrow">Change review</span>
          <h3>${escapeHtml(review.title)}</h3>
        </div>
        <span class="file-count">${review.files.length} file${review.files.length === 1 ? "" : "s"}</span>
      </div>
      <div class="review-files">
        ${review.files
          .map(
            (file) => `
          <details open class="review-file">
            <summary>
              <span>${escapeHtml(file.path)}</span>
              <span class="diff-stats"><b>+${file.additions}</b> <i>-${file.deletions}</i></span>
            </summary>
            <div class="file-actions">
              <button class="text-button" data-open-diff="${escapeAttribute(file.path)}">Open diff</button>
              <button class="text-button" data-apply-file="${escapeAttribute(file.path)}">Apply file</button>
            </div>
            ${file.hunks
              .map(
                (hunk) => `
              <label class="hunk">
                <div class="hunk-heading">
                  <input type="checkbox" data-hunk-id="${escapeAttribute(hunk.id)}" checked>
                  <span>@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</span>
                </div>
                <pre>${hunk.lines.map(renderDiffLine).join("\n")}</pre>
              </label>`
              )
              .join("")}
          </details>`
          )
          .join("")}
      </div>
      <div class="approval-actions">
        <button id="reject-review" class="secondary-button">Reject</button>
        <button id="apply-review" class="primary-button">Apply selected</button>
      </div>
    </section>`;
}

function renderComposerState(current: WebviewState): void {
  modeElement.value = current.mode;
  modeElement.disabled = current.isRunning;
  promptElement.disabled = current.isRunning;
  requiredElement<HTMLButtonElement>("send").disabled = current.isRunning;
  requiredElement<HTMLButtonElement>("retry").disabled =
    current.isRunning || !current.messages.some((message) => message.role === "user");
  requiredElement("stop").classList.toggle("hidden", !current.isRunning);

  const usage = requiredElement("token-usage");
  const percentage = Math.min(
    100,
    Math.round((current.usage.totalTokens / current.contextLimit) * 100)
  );
  usage.innerHTML = `
    <span title="${current.usage.estimated ? "Estimated token usage" : "Server-reported token usage"}">
      ${formatNumber(current.usage.totalTokens)} / ${formatNumber(current.contextLimit)}
    </span>
    <progress class="usage-bar" max="100" value="${percentage}" aria-label="Context usage ${percentage}%"></progress>`;
}

function sendPrompt(): void {
  const text = promptElement.value.trim();
  if (text.length === 0 || state?.isRunning === true) {
    return;
  }
  post({ type: "sendMessage", text, mode: modeElement.value as AgentMode });
  promptElement.value = "";
}

function showToast(level: "info" | "warning" | "error", text: string): void {
  const region = requiredElement("toast-region");
  const toast = document.createElement("div");
  toast.className = `toast toast-${level}`;
  toast.textContent = text;
  region.append(toast);
  setTimeout(() => toast.remove(), 6_000);
}

function post(message: WebviewToExtensionMessage): void {
  vscode.postMessage(message);
}

function bind(id: string, handler: () => void): void {
  requiredElement<HTMLButtonElement>(id).addEventListener("click", handler);
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing required element #${id}.`);
  }
  return element as T;
}

function scrollToBottom(): void {
  messagesElement.scrollTop = messagesElement.scrollHeight;
}

function activityIcon(stateValue: string): string {
  switch (stateValue) {
    case "running":
      return "◌";
    case "succeeded":
      return "✓";
    case "failed":
      return "!";
    default:
      return "■";
  }
}

function renderDiffLine(line: string): string {
  const className = line.startsWith("+")
    ? "diff-add"
    : line.startsWith("-")
      ? "diff-delete"
      : "diff-context";
  return `<span class="${className}">${escapeHtml(line)}</span>`;
}

function parseFileReference(value: string): { path: string; line?: number } {
  const decoded = decodeURIComponent(value.replace(/^file:\/\//, ""));
  const match = /^(.*?)(?:#L?(\d+))?$/.exec(decoded);
  if (match === null) {
    return { path: decoded };
  }
  const line = match[2] === undefined ? undefined : Number(match[2]);
  return line === undefined ? { path: match[1]! } : { path: match[1]!, line };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(value);
}

function messageFingerprint(current: WebviewState): string {
  return current.messages
    .map(
      (message) =>
        `${message.id}:${message.state}:${message.content.length}`
    )
    .join("|");
}
