# Notifier Public Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an independent public GitHub skill that lets Codex users set up Telegram approval notifications through a natural-language setup request.

**Architecture:** The repository contains one `approval-notifier` skill and a
zero-dependency Node helper stored inside that skill directory. The Skills CLI
installs the whole directory. Codex reads `SKILL.md`, invokes the helper for
setup and sending, and keeps bot credentials in a private local file outside
the repository.

**Tech Stack:** Node.js 20+, built-in `node:test`, GitHub, Skills CLI format.

## Global Constraints

- Repository: public `rebel0789/notifier`, independent of Polychads.
- Install command: `npx skills add rebel0789/notifier --skill approval-notifier -g -a codex`.
- No npm publication, third-party packages, background process, webhook, or
  Telegram-based authorization.
- No secret values in source, tests, README examples, command output, or Git.
- Human copy stays direct and specific.

---

### Task 1: Node notification helper

**Files:**
- Create: `skills/approval-notifier/bin/notifier.mjs`
- Create: `skills/approval-notifier/test/notifier.test.mjs`
- Create: `package.json`

**Interfaces:**
- Produces `run(argv, dependencies)` for command dispatch.
- Produces `setupConfig(dependencies)`, `sendNotice(config, notice, dependencies)`,
  `formatNotice(notice)`, and `loadConfig(path)`.
- Commands: `setup`, `status`, `dry-run`, `send`.

- [ ] Write tests for redaction, a 30-minute duplicate window, mode-600
  config/state files, dry-run without Telegram access, and fresh private-chat
  pairing.
- [ ] Run `node --test skills/approval-notifier/test/notifier.test.mjs` and
  confirm it fails because the helper is absent.
- [ ] Implement the helper using only Node built-ins. Use an injected transport
  in tests and `fetch` only in the live transport. Write config and state
  atomically with mode 600.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Codex skill and public documentation

**Files:**
- Create: `skills/approval-notifier/SKILL.md`
- Create: `README.md`
- Create: `LICENSE`

**Interfaces:**
- `SKILL.md` tells Codex when to use the notifier and how to run the bundled
  helper without showing consumers implementation commands.
- `README.md` gives install, setup, use, limits, and removal instructions.

- [ ] Write a text-contract test requiring the skill to cover setup, explicit
  approval gates, plain-chat waits, and Telegram's notification-only boundary.
- [ ] Run it and confirm it fails because the documentation files are absent.
- [ ] Write the skill, README, and MIT license. The README uses the Skills CLI
  command and asks users to say `@approval-notifier set up Telegram
  notifications` after installation.
- [ ] Run all tests and confirm they pass.

### Task 3: Repository publication and consumer proof

**Files:**
- Modify: `README.md` if the real GitHub URL differs.

- [ ] Initialize the local repository, set its default branch to `main`, and
  inspect the complete staged diff for secret-shaped content.
- [ ] Create a public GitHub repository at `rebel0789/notifier`, add it as
  `origin`, commit the implementation, and push `main`.
- [ ] Verify the public repository URL and inspect the remote default branch.
- [ ] Run an offline dry-run and `status`; do not run setup or send a Telegram
  message.
