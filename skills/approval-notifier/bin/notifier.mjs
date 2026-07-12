#!/usr/bin/env node

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const DEDUPE_MS = 30 * 60 * 1000;
const TOKEN_PATTERN = /\b\d{5,12}:[A-Za-z0-9_-]{20,}\b/g;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~-]{12,}/gi;
const URL_CREDENTIAL_PATTERN = /https?:\/\/[^\s/@:]+:[^\s/@]+@/g;
const MAX_FIELD_LENGTH = 280;

export class ConfigError extends Error {}
export class PairingError extends Error {}
export class DeliveryError extends Error {}
export class ValidationError extends Error {}

function privateMode(mode) {
  return (mode & 0o077) === 0;
}

function cleanText(value) {
  const flattened = String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const redacted = flattened
    .replace(TOKEN_PATTERN, "[redacted]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(URL_CREDENTIAL_PATTERN, "https://[redacted]@");
  if (!redacted || redacted.length > MAX_FIELD_LENGTH) throw new ValidationError("invalid_notice");
  return redacted;
}

function normalizedNotice(notice) {
  return {
    task: cleanText(notice.task),
    action: cleanText(notice.action),
    impact: cleanText(notice.impact),
    rollback: cleanText(notice.rollback),
    approvalPhrase: cleanText(notice.approvalPhrase),
  };
}

export function formatNotice(notice) {
  const item = normalizedNotice(notice);
  return [
    "Codex approval needed",
    `Task: ${item.task}`,
    `Action: ${item.action}`,
    `Impact: ${item.impact}`,
    `Rollback: ${item.rollback}`,
    `Reply in Codex with: ${item.approvalPhrase}`,
  ].join("\n");
}

function noticeKey(notice) {
  return createHash("sha256")
    .update(JSON.stringify(normalizedNotice(notice)))
    .digest("hex");
}

async function requirePrivateFile(path, absentMessage) {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new ConfigError(absentMessage);
  }
  if (!privateMode(details.mode)) throw new ConfigError("notifier_insecure_permissions");
}

function validateConfig(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    typeof value.token !== "string" ||
    !value.token ||
    /\s/.test(value.token) ||
    !Number.isInteger(value.chatId) ||
    value.chatId === 0
  ) {
    throw new ConfigError("notifier_invalid_config");
  }
  return { token: value.token, chatId: value.chatId };
}

export async function loadConfig(path) {
  await requirePrivateFile(path, "notifier_not_configured");
  try {
    return validateConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("notifier_invalid_config");
  }
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    if (handle) await handle.close();
    await unlink(temporary).catch(() => {});
    throw new ConfigError("notifier_storage_error");
  }
}

function maxUpdateId(updates) {
  return Math.max(0, ...updates.map((item) => Number.isInteger(item?.update_id) ? item.update_id : 0));
}

function matchedPrivateStart(updates, nonce, baseline) {
  const expected = `/start ${nonce}`;
  for (const update of updates) {
    const message = update?.message;
    const chat = message?.chat;
    const sender = message?.from;
    if (
      update?.update_id > baseline &&
      message?.text === expected &&
      chat?.type === "private" &&
      Number.isInteger(chat.id) &&
      sender?.id === chat.id
    ) {
      return chat.id;
    }
  }
  return undefined;
}

export async function setupConfig({
  configPath,
  promptSecret,
  promptContinue,
  request,
  randomBytes = nodeRandomBytes,
  maxPolls = 12,
}) {
  try {
    await stat(configPath);
    throw new ConfigError("notifier_already_configured");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
  }
  if (!Number.isInteger(maxPolls) || maxPolls < 1) throw new PairingError("notifier_pairing_failed");
  const token = String(await promptSecret("BotFather token: ")).trim();
  if (!token || /\s/.test(token)) throw new PairingError("notifier_token_invalid");

  await request(token, "getMe", {});
  const initial = await request(token, "getUpdates", { timeout: 0, limit: 100 });
  if (!Array.isArray(initial?.result)) throw new PairingError("notifier_pairing_failed");
  let baseline = maxUpdateId(initial.result);
  const nonce = randomBytes(16).toString("hex");
  await promptContinue(`Send /start ${nonce} to the bot in a private Telegram chat, then press Enter: `);

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const response = await request(token, "getUpdates", {
      offset: baseline + 1,
      timeout: 20,
      limit: 10,
    });
    if (!Array.isArray(response?.result)) throw new PairingError("notifier_pairing_failed");
    const chatId = matchedPrivateStart(response.result, nonce, baseline);
    if (chatId !== undefined) {
      await writePrivateJson(configPath, { version: 1, token, chatId });
      return configPath;
    }
    baseline = Math.max(baseline, maxUpdateId(response.result));
  }
  throw new PairingError("notifier_private_start_not_received");
}

async function readState(path, now) {
  try {
    await requirePrivateFile(path, "notifier_state_missing");
  } catch (error) {
    if (error instanceof ConfigError && error.message === "notifier_state_missing") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      throw new Error("invalid");
    }
    return Object.fromEntries(
      Object.entries(parsed.entries).filter(([key, expiry]) => {
        const expiryTime = Date.parse(expiry);
        return /^[a-f0-9]{64}$/.test(key) && Number.isFinite(expiryTime) && expiryTime > now.getTime();
      }),
    );
  } catch {
    throw new ConfigError("notifier_invalid_state");
  }
}

export async function sendNotice(config, notice, { now = new Date(), request, statePath }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new ValidationError("invalid_time");
  const key = noticeKey(notice);
  const entries = await readState(statePath, now);
  if (entries[key]) return "deduped";
  await request(config.token, "sendMessage", {
    chat_id: config.chatId,
    text: formatNotice(notice),
    disable_web_page_preview: true,
  });
  entries[key] = new Date(now.getTime() + DEDUPE_MS).toISOString();
  await writePrivateJson(statePath, { version: 1, entries });
  return "sent";
}

async function telegramRequest(token, method, payload) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new DeliveryError("telegram_delivery_failed");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new DeliveryError("telegram_delivery_failed");
  }
  if (!response.ok || body?.ok !== true) throw new DeliveryError("telegram_delivery_failed");
  return body;
}

function defaultPaths(home) {
  const codexHome = home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return {
    configPath: join(codexHome, "secrets", "approval-notifier.json"),
    statePath: join(codexHome, "state", "approval-notifier.json"),
  };
}

function parseNotice(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new ValidationError("invalid_arguments");
    values[flag.slice(2)] = value;
  }
  return {
    task: values.task,
    action: values.action,
    impact: values.impact,
    rollback: values.rollback,
    approvalPhrase: values["approval-phrase"],
  };
}

async function terminalQuestion(prompt, { hidden = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new PairingError("notifier_setup_requires_terminal");
  if (!hidden) {
    process.stdout.write(prompt);
    return new Promise((resolve) => {
      process.stdin.once("data", (data) => resolve(String(data).trim()));
      process.stdin.resume();
    });
  }
  process.stdout.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    process.stdin.once("data", (data) => {
      for (const character of data) {
        if (character === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          reject(new PairingError("notifier_setup_cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    });
  });
}

export async function run(argv, dependencies = {}) {
  const [command, ...rest] = argv;
  const { configPath, statePath } = defaultPaths(dependencies.home);
  const request = dependencies.request ?? telegramRequest;
  const print = dependencies.print ?? ((line) => console.log(line));
  const printError = dependencies.printError ?? ((line) => console.error(line));
  try {
    if (command === "status") {
      try {
        await loadConfig(configPath);
        print("configured=true");
      } catch (error) {
        if (error instanceof ConfigError && error.message === "notifier_not_configured") print("configured=false");
        else throw error;
      }
      return 0;
    }
    if (command === "setup") {
      await setupConfig({
        configPath,
        request,
        promptSecret: dependencies.promptSecret ?? ((prompt) => terminalQuestion(prompt, { hidden: true })),
        promptContinue: dependencies.promptContinue ?? terminalQuestion,
      });
      print("configured=true");
      return 0;
    }
    if (command === "dry-run") {
      print(formatNotice(parseNotice(rest)));
      return 0;
    }
    if (command === "send") {
      const result = await sendNotice(await loadConfig(configPath), parseNotice(rest), {
        request,
        statePath,
      });
      print(result);
      return 0;
    }
    throw new ValidationError("invalid_arguments");
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof PairingError ||
      error instanceof DeliveryError ||
      error instanceof ValidationError
    ) {
      printError(error.message);
      return 1;
    }
    printError("notifier_failed");
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("notifier.mjs")) {
  process.exitCode = await run(process.argv.slice(2));
}
