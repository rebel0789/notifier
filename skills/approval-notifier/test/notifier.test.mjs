import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ConfigError,
  PairingError,
  formatNotice,
  loadConfig,
  run,
  sendNotice,
  startBrowserSetup,
  setupConfig,
} from "../bin/notifier.mjs";

const T0 = new Date("2026-07-12T12:00:00.000Z");
const TEST_TOKEN = ["123456", "example_fake_token_for_test_abcdefghijk"].join(":");

function notice(overrides = {}) {
  return {
    task: "Database migration",
    action: "Apply the migration",
    impact: "Short write pause",
    rollback: "Restore the pre-migration backup",
    approvalPhrase: "Approved database migration",
    ...overrides,
  };
}

function fakeTransport(responses = []) {
  const calls = [];
  return {
    calls,
    request: async (token, method, payload) => {
      calls.push({ token, method, payload });
      return responses.shift() ?? { ok: true, result: true };
    },
  };
}

async function temporaryPaths() {
  const home = await mkdtemp(join(tmpdir(), "notifier-test-"));
  return {
    home,
    configPath: join(home, "config.json"),
    statePath: join(home, "state.json"),
  };
}

test("formats notices without token-shaped text or line injection", () => {
  const message = formatNotice(
    notice({
      action: `Apply with token ${TEST_TOKEN}`,
      impact: "First line\nsecond line",
    }),
  );

  assert.equal(message.includes(TEST_TOKEN), false);
  assert.match(message, /\[redacted\]/);
  assert.match(message, /First line second line/);
  assert.match(message, /Reply in Codex with: Approved database migration/);
});

test("sends once then suppresses the same notice for thirty minutes", async () => {
  const paths = await temporaryPaths();
  const transport = fakeTransport();
  const config = { token: TEST_TOKEN, chatId: 42 };

  assert.equal(
    await sendNotice(config, notice(), {
      now: T0,
      request: transport.request,
      statePath: paths.statePath,
    }),
    "sent",
  );
  assert.equal(
    await sendNotice(config, notice(), {
      now: new Date(T0.getTime() + 29 * 60_000),
      request: transport.request,
      statePath: paths.statePath,
    }),
    "deduped",
  );
  assert.equal(
    await sendNotice(config, notice(), {
      now: new Date(T0.getTime() + 31 * 60_000),
      request: transport.request,
      statePath: paths.statePath,
    }),
    "sent",
  );

  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0].method, "sendMessage");
  assert.equal(transport.calls[0].payload.chat_id, 42);
  assert.equal(JSON.stringify(transport.calls[0].payload).includes(TEST_TOKEN), false);
  assert.equal((await stat(paths.statePath)).mode & 0o077, 0);
});

test("rejects an insecure configuration file", async () => {
  const paths = await temporaryPaths();
  await writeFile(
    paths.configPath,
    JSON.stringify({ version: 1, token: TEST_TOKEN, chatId: 42 }),
    { mode: 0o644 },
  );

  await assert.rejects(() => loadConfig(paths.configPath), ConfigError);
});

test("pairs only a fresh private start message with the generated nonce", async () => {
  const paths = await temporaryPaths();
  const transport = fakeTransport([
    { ok: true, result: { id: 1, is_bot: true } },
    { ok: true, result: [{ update_id: 100 }] },
    {
      ok: true,
      result: [
        {
          update_id: 101,
          message: {
            text: "/start wrong",
            chat: { id: 42, type: "private" },
            from: { id: 42 },
          },
        },
        {
          update_id: 102,
          message: {
            text: "/start aabb",
            chat: { id: 42, type: "private" },
            from: { id: 42 },
          },
        },
      ],
    },
  ]);

  const path = await setupConfig({
    configPath: paths.configPath,
    promptSecret: async () => TEST_TOKEN,
    promptContinue: async () => {},
    request: transport.request,
    randomBytes: () => Buffer.from("aabb", "hex"),
    maxPolls: 1,
  });

  assert.equal(path, paths.configPath);
  assert.equal((await stat(paths.configPath)).mode & 0o077, 0);
  assert.equal((await loadConfig(paths.configPath)).chatId, 42);
});

test("refuses pairing when the fresh private start message is absent", async () => {
  const paths = await temporaryPaths();
  const transport = fakeTransport([
    { ok: true, result: { id: 1, is_bot: true } },
    { ok: true, result: [] },
    { ok: true, result: [] },
  ]);

  await assert.rejects(
    () =>
      setupConfig({
        configPath: paths.configPath,
        promptSecret: async () => TEST_TOKEN,
        promptContinue: async () => {},
        request: transport.request,
        randomBytes: () => Buffer.from("aabb", "hex"),
        maxPolls: 1,
      }),
    PairingError,
  );
});

test("browser setup shows a fresh pairing code and only accepts its private chat", async () => {
  const paths = await temporaryPaths();
  let openedUrl;
  const transport = fakeTransport([
    { ok: true, result: { id: 1, is_bot: true } },
    { ok: true, result: [{ update_id: 100 }] },
    { ok: true, result: [] },
    {
      ok: true,
      result: [
        {
          update_id: 101,
          message: {
            text: "/start aabb",
            chat: { id: 42, type: "private" },
            from: { id: 42 },
          },
        },
      ],
    },
  ]);

  const session = await startBrowserSetup({
    configPath: paths.configPath,
    request: transport.request,
    randomBytes: () => Buffer.from("aabb", "hex"),
    openBrowser: async (url) => {
      openedUrl = url;
    },
    pollIntervalMs: 5,
    timeoutMs: 500,
  });

  assert.match(openedUrl, /^http:\/\/127\.0\.0\.1:/);
  const page = await fetch(openedUrl);
  assert.equal(page.status, 200);
  const pairing = await fetch(openedUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: TEST_TOKEN }),
  });

  assert.match(await pairing.text(), /\/start aabb/);
  await session.done;
  assert.equal((await loadConfig(paths.configPath)).chatId, 42);
});

test("dry-run needs no configuration or Telegram request", async () => {
  const output = [];
  const exitCode = await run(
    [
      "dry-run",
      "--task",
      "Release",
      "--action",
      "Deploy",
      "--impact",
      "Brief reconnect",
      "--rollback",
      "Redeploy the previous release",
      "--approval-phrase",
      "Approved release",
    ],
    {
      home: "/path/that/does/not/exist",
      request: async () => assert.fail("dry-run must not contact Telegram"),
      print: (line) => output.push(line),
      printError: () => assert.fail("dry-run must not fail"),
    },
  );

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /Approved release/);
});
