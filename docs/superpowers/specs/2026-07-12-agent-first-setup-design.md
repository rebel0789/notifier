# Notifier: agent-first setup

## Goal

Publish a small GitHub skill that lets a Codex desktop or CLI user install it
with `npx skills add polychads/notifier`, then ask Codex to set up Telegram
approval notifications without seeing implementation commands.

## User flow

1. The user installs the skill once.
2. The user says `@approval-notifier set up Telegram notifications` in Codex.
3. Codex invokes the bundled helper.
4. The helper asks for the BotFather token in a masked local terminal prompt.
5. The helper shows a fresh `/start` code. The user sends it in a private chat
   with their bot.
6. The helper records only the bot token and paired chat ID in a mode-600 local
   file. Future approval notices go to that chat.

The user does not run Python, find local paths, or edit configuration files.

## Package shape

- `SKILL.md` gives Codex the setup and approval-notification rules.
- `bin/notifier.mjs` is a zero-dependency Node helper. It has `setup`,
  `status`, `send`, and `dry-run` commands.
- `package.json` makes the helper available to package runners, but ordinary
  users use the skill through Codex.
- `tests/` covers notice formatting, secret redaction, duplicate suppression,
  file permissions, and private-chat pairing.
- `README.md` contains only install, setup, behavior, and security details.

## Boundaries

- Telegram is notification-only. A Telegram reply never authorizes an action.
- The skill notifies for protected-action approvals, including a plain-chat
  approval wait while Codex continues safe work. It does not notify for ordinary
  clarification.
- Setup is local and interactive. No bot token, chat ID, or state file enters
  GitHub.
- The helper uses Node's standard library only and has no background process,
  webhook, or polling service after setup.
- An identical notice is sent at most once every 30 minutes.

## Failure behavior

- If unconfigured, Codex explains setup instead of trying to send.
- If delivery fails, Codex reports the failure and does not claim notification
  was delivered.
- If pairing is not from a private chat or does not match the fresh code, setup
  stops without writing a configuration file.

## Validation

- Unit tests run offline with a mocked Telegram transport.
- A dry run proves notice formatting without a token or network call.
- A local status check proves setup remains opt-in.
