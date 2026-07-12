#!/usr/bin/env node

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setupPage({ sessionPath, state, pairingCode, error }) {
  const body = state === "enter-token"
    ? `
      <h1>Connect Telegram</h1>
      <p>Paste the BotFather token for the bot that will send approval notices.</p>
      <form method="post" action="${sessionPath}">
        <label>BotFather token <input name="token" type="password" autocomplete="off" autofocus required></label>
        <button type="submit">Continue</button>
      </form>`
    : state === "waiting"
      ? `
        <meta http-equiv="refresh" content="2">
        <h1>Pair your Telegram chat</h1>
        <p>Send this exact message to the bot in a private Telegram chat:</p>
        <pre>${escapeHtml(pairingCode)}</pre>
        <p>Waiting for that private message.</p>`
      : state === "complete"
        ? `<h1>Telegram connected</h1><p>You can close this page.</p>`
        : `
          <h1>Setup did not complete</h1>
          <p>${escapeHtml(error ?? "Try again.")}</p>
          <p><a href="${sessionPath}?retry=1">Start again</a></p>`;
  return `<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Notifier setup</title><style>
  body{font:16px system-ui,sans-serif;line-height:1.5;max-width:40rem;margin:10vh auto;padding:0 1.25rem;color:#151515}
  input{display:block;width:100%;box-sizing:border-box;margin:.5rem 0 1rem;padding:.7rem;font:inherit}
  button{padding:.7rem 1rem;font:inherit}pre{padding:.8rem;background:#f3f3f3;overflow:auto}
  </style></head><body>${body}</body></html>`;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) reject(new PairingError("notifier_setup_request_too_large"));
    });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });
}

function openLocalBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function startBrowserSetup({
  configPath,
  request,
  randomBytes = nodeRandomBytes,
  openBrowser = openLocalBrowser,
  pollIntervalMs = 2000,
  timeoutMs = 5 * 60 * 1000,
}) {
  try {
    await stat(configPath);
    throw new ConfigError("notifier_already_configured");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
  }
  const sessionPath = `/setup/${randomBytes(16).toString("hex")}`;
  let state = "enter-token";
  let pairingCode = "";
  let error;
  let baseline = 0;
  let polling = false;
  let pollTimer;
  let timeoutTimer;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const close = () => {
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    server.close();
    server.closeAllConnections?.();
  };
  const complete = async (chatId, token) => {
    await writePrivateJson(configPath, { version: 1, token, chatId });
    state = "complete";
    close();
    resolveDone(configPath);
  };
  const poll = async (token) => {
    if (polling || state !== "waiting") return;
    polling = true;
    try {
      const response = await request(token, "getUpdates", {
        offset: baseline + 1,
        timeout: 0,
        limit: 10,
      });
      if (!Array.isArray(response?.result)) throw new PairingError("notifier_pairing_failed");
      const chatId = matchedPrivateStart(response.result, pairingCode.slice(7), baseline);
      if (chatId !== undefined) {
        await complete(chatId, token);
        return;
      }
      baseline = Math.max(baseline, maxUpdateId(response.result));
    } catch (caught) {
      state = "failed";
      error = "Telegram could not confirm pairing. Start setup again.";
      clearInterval(pollTimer);
    } finally {
      polling = false;
    }
  };
  const beginPairing = async (token) => {
    if (!token || /\s/.test(token)) throw new PairingError("notifier_token_invalid");
    await request(token, "getMe", {});
    const initial = await request(token, "getUpdates", { timeout: 0, limit: 100 });
    if (!Array.isArray(initial?.result)) throw new PairingError("notifier_pairing_failed");
    baseline = maxUpdateId(initial.result);
    pairingCode = `/start ${randomBytes(16).toString("hex")}`;
    state = "waiting";
    pollTimer = setInterval(() => void poll(token), pollIntervalMs);
  };
  const server = createServer(async (requestObject, response) => {
    const requestUrl = new URL(requestObject.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== sessionPath) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    if (requestObject.method === "GET" && requestUrl.searchParams.get("retry") === "1") {
      clearInterval(pollTimer);
      state = "enter-token";
      pairingCode = "";
      error = undefined;
    }
    if (requestObject.method === "POST") {
      try {
        const body = await readRequestBody(requestObject);
        const token = new URLSearchParams(body).get("token")?.trim() ?? "";
        await beginPairing(token);
      } catch (caught) {
        state = "failed";
        error = caught instanceof DeliveryError && caught.message === "telegram_token_rejected"
          ? "Telegram rejected this BotFather token. Generate a new token in BotFather and try again."
          : "Telegram could not verify the token. Check your connection and try again.";
      }
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      "cache-control": "no-store",
    });
    response.end(setupPage({ sessionPath, state, pairingCode, error }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    close();
    throw new PairingError("notifier_setup_server_failed");
  }
  const url = `http://127.0.0.1:${address.port}${sessionPath}`;
  timeoutTimer = setTimeout(() => {
    if (state !== "complete") {
      state = "failed";
      error = "The setup window expired. Start setup again.";
      close();
      rejectDone(new PairingError("notifier_setup_expired"));
    }
  }, timeoutMs);
  try {
    await openBrowser(url);
  } catch {
    close();
    throw new PairingError("notifier_browser_open_failed");
  }
  return { url, done, close };
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
  if (response.status === 401 || body?.error_code === 401) {
    throw new DeliveryError("telegram_token_rejected");
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
      const session = await startBrowserSetup({
        configPath,
        request,
        randomBytes: dependencies.randomBytes,
        openBrowser: dependencies.openBrowser,
        pollIntervalMs: dependencies.pollIntervalMs,
        timeoutMs: dependencies.timeoutMs,
      });
      print("local_setup_opened");
      await session.done;
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
