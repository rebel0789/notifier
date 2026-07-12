import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const skillPath = new URL("../SKILL.md", import.meta.url);
const readmePath = new URL("../../../README.md", import.meta.url);

test("skill covers setup and both approval-wait cases without Telegram authorization", async () => {
  const content = (await readFile(skillPath, "utf8")).toLowerCase();
  assert.match(content, /set up telegram notifications/);
  assert.match(content, /local setup page/);
  assert.match(content, /plain-chat approval wait/);
  assert.match(content, /telegram never authorizes/);
  assert.match(content, /ordinary clarification/);
});

test("README shows a global Skills CLI install and a natural-language setup request", async () => {
  const content = await readFile(readmePath, "utf8");
  assert.match(content, /npx skills add rebel0789\/notifier --skill approval-notifier -g -a codex/);
  assert.match(content, /@approval-notifier set up Telegram notifications/);
  assert.match(content, /local setup page/);
  assert.match(content, /exact pairing code/);
  assert.equal(content.includes("terminal prompt"), false);
  assert.equal(content.includes("Paste your token into this chat"), false);
});
