---
name: approval-notifier
description: Use when a Codex user asks to set up Telegram approval notifications, or when an external action needs explicit approval before it can proceed.
---

# Approval notifier

Telegram never authorizes an action. Approval must arrive in Codex.

When the user asks to set up Telegram notifications:

1. Find this skill's directory and run its bundled `bin/notifier.mjs setup`
   helper with Node.
2. The helper prompts for the BotFather token in a masked local terminal prompt.
   Do not ask the user to paste a token into chat.
3. The helper gives the user a fresh `/start` code to send in a private chat
   with the bot.
4. Report only that setup succeeded or the safe error code. Never expose a
   token, chat ID, or secret value.

Before asking for or waiting on approval for a protected external action,
including a plain-chat approval wait while safe work continues:

1. Run `bin/notifier.mjs status`.
2. If configured, run `bin/notifier.mjs send` with concise non-secret task,
   action, impact, rollback, and approval phrase values.
3. If sending fails, say that delivery failed and do not proceed.

Do not notify for ordinary clarification. The helper suppresses an identical
notice for 30 minutes.
