# Changelog

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
