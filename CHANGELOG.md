# Changelog

## 0.1.3

- Reworked the chat into a live, streaming transcript: tool steps (Terminal, Read file, Search, Git, …) now appear inline as they run — each with a status icon, summary, and live output — so progress is always visible instead of hidden in a collapsed panel.
- Added a pinned "working" status bar above the composer with an animated spinner, current phase, an elapsed timer, live thinking/output token counts, and a Stop button, plus a "typing" indicator on the in-progress reply.
- Fixed horizontal overflow that could push approval and change-review prompts (and their buttons) off-screen: the webview no longer scrolls sideways, long commands and file paths wrap, diffs scroll inside their own box, action buttons wrap and stay visible, and the approval area caps its height with the actions kept in view.

## 0.1.2

- Added live progress in the chat while the agent works: a persistent status card shows the current phase (Preparing, Thinking, Responding, or the running tool), an elapsed timer, and live thinking/output token counts, with an inline Stop button.
- Stream the model's reasoning ("thinking") into a collapsible, auto-expanding block under the in-progress reply so long local-model turns no longer look frozen.

## 0.1.1

- Fixed an HTTP 500 (`System message must be at the beginning`) from the KAT-Coder / Qwen3 chat template by sending a single leading system message: the system prompt and repository context are now merged, the post-change verification reminder is a user message, and compaction memory is a user message.
- Hardened the model client to guarantee at most one leading system message per request (leading system messages are merged; any later system message is demoted to a user message).

## 0.1.0

- Added OpenAI-compatible local model streaming with KAT-Coder defaults.
- Added Ask, Edit, and Agent execution modes.
- Added repository, editor, diagnostics, Git, edit, diff, and terminal tools.
- Added per-file and per-hunk change review.
- Added permissions, workspace boundaries, redaction, cancellation, and iteration limits.
- Added persistent conversations, token usage, context compaction, and audit logging.
- Added unit tests, Extension Development Host configuration, model scripts, and VSIX packaging.
