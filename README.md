# Notifier

Telegram notifications when Codex needs your approval for an external action.
Approval stays in Codex. Telegram replies do not approve anything.

## Install for Codex

Run this once:

```sh
npx skills add rebel0789/notifier --skill approval-notifier -g -a codex
```

Start a new Codex session after installing.

## Set up Telegram

Create a bot with [@BotFather](https://t.me/BotFather), then tell Codex:

```
@approval-notifier set up Telegram notifications
```

Codex starts a local setup prompt. Enter the BotFather token there, not in
chat. It gives you a one-time `/start` code. Send that code to your bot in a
private Telegram chat.

## Use

When Codex needs your approval for a deploy, migration, restart, configuration
change, or another external action, it sends a Telegram notice first. Reply in
Codex with the requested approval phrase.

The notifier also covers a plain-chat approval wait when Codex continues safe
work while waiting. It does not send notices for ordinary questions.

Identical notices are limited to one every 30 minutes.

## Privacy and safety

- The bot token and paired chat ID stay in a private local file.
- The repository contains no credentials.
- Telegram is notification-only. It cannot approve, cancel, or trigger work.
- Setup has no background service, webhook, or open local server.

## Remove

Remove the installed skill with your Skills CLI, then delete the local notifier
configuration from your Codex home folder if you no longer want notifications.

## Development

```sh
npm test
```
