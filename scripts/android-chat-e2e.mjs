import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const devtoolsUrl = process.env.NKG_DEVTOOLS_URL ?? "http://127.0.0.1:9222";
const vaultPassword = process.env.NKG_TEST_VAULT_PASSWORD ?? "nkgtestpass";
const providerUrl = process.env.NKG_TEST_PROVIDER_URL ?? "http://127.0.0.1:18080/v1";
const prompt = process.env.NKG_TEST_PROMPT ?? "请验证 Android 流式执行";
const recoveryPrompt = process.env.NKG_TEST_RECOVERY_PROMPT ?? "请验证 Android 后台恢复后的流式执行";
const expected = process.env.NKG_TEST_EXPECTED ?? "Android 原生 HTTP 与 Flow 流式执行成功。";
const mode = process.argv.includes("--lifecycle")
  ? "lifecycle"
  : (process.env.NKG_E2E_MODE ?? "chat");
const providerName = "NKG E2E";
const providerModel = "test-model";
const providerKey = "local-test-key";
const ownsTunnels = !process.env.NKG_DEVTOOLS_URL;
const provider = new URL(providerUrl);
const reversedPort = ownsTunnels && isLoopback(provider.hostname) ? provider.port : "";

if (mode !== "chat" && mode !== "lifecycle") {
  throw new Error(`Unsupported NKG_E2E_MODE: ${mode}`);
}

if (ownsTunnels) {
  setupAndroidForwarding();
  process.once("exit", cleanupAndroidForwarding);
}
const pages = await waitForPages();
const page = pages.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
if (!page) throw new Error("Android WebView DevTools page was not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let requestId = 0;
const pending = new Map();
socket.addEventListener("message", (message) => {
  const payload = JSON.parse(message.data);
  if (typeof payload.id !== "number") return;
  const handlers = pending.get(payload.id);
  if (!handlers) return;
  pending.delete(payload.id);
  if (payload.error) handlers.reject(new Error(payload.error.message));
  else handlers.resolve(payload.result);
});

function cdp(method, params = {}) {
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? "WebView evaluation failed",
    );
  }
  return result.result.value;
}

try {
  await cdp("Runtime.enable");
  const setup = await evaluate(providerSetupExpression());
  if (mode === "chat") {
    const chat = await evaluate(chatExpression(prompt, expected));
    process.stdout.write(`${JSON.stringify({ mode, setup, chat }, null, 2)}\n`);
  } else {
    runAdb("logcat", "-c");
    const started = await evaluate(startSlowStreamExpression(prompt));

    runAdb("shell", "input", "keyevent", "KEYCODE_HOME");
    const suspendedLog = await waitForLifecycleLog(["suspending", "suspended"]);

    runAdb("shell", "am", "start", "-n", "com.nkg.ai.bot/.MainActivity");
    const resumedLog = await waitForLifecycleLog(["resuming", "active"]);
    const suspended = await evaluate(suspensionResultExpression(started));
    const recovered = await evaluate(chatExpression(recoveryPrompt, expected));

    process.stdout.write(`${JSON.stringify({
      mode,
      setup,
      started,
      suspended,
      recovered,
      lifecycleLog: [...suspendedLog, ...resumedLog],
    }, null, 2)}\n`);
  }
} finally {
  socket.close();
  if (ownsTunnels) {
    cleanupAndroidForwarding();
    process.removeListener("exit", cleanupAndroidForwarding);
  }
}

function providerSetupExpression() {
  return `
(async () => {
  ${browserHelpers()}
  (await waitFor(() => button('模型服务'), 'navigation')).click();
  await waitFor(() => document.querySelector('.vault-card, .provider-layout'), 'Provider settings');
  if (document.body.innerText.includes('密钥库已锁定')) {
    const password = await waitFor(() => document.querySelector('input[type=password]'), 'vault password');
    setValue(password, ${JSON.stringify(vaultPassword)});
    password.closest('form').requestSubmit();
    await waitFor(() => document.body.innerText.includes('密钥库已解锁'), 'vault unlock');
  }

  const providerItem = [...document.querySelectorAll('.provider-item')]
    .find((item) => item.textContent.includes(${JSON.stringify(providerName)}));
  if (providerItem) {
    providerItem.querySelector('.provider-actions button').click();
    await waitFor(() => document.body.innerText.includes('EDIT PROFILE'), 'Provider edit mode');
  }
  const setProviderField = async (index, value) => {
    const input = await waitFor(() => document.querySelectorAll('.provider-form input')[index], 'Provider field ' + index);
    setValue(input, value);
    await sleep(50);
  };
  await setProviderField(0, ${JSON.stringify(providerName)});
  await setProviderField(1, ${JSON.stringify(providerUrl)});
  await setProviderField(2, ${JSON.stringify(providerModel)});
  await setProviderField(3, ${JSON.stringify(providerKey)});
  const form = document.querySelector('.provider-form');
  const insecureConfirmation = form.querySelector('input[name="allow-insecure-http"]');
  if (insecureConfirmation && !insecureConfirmation.checked) insecureConfirmation.click();
  form.requestSubmit();
  await waitFor(() => document.body.innerText.includes(providerItem ? 'Provider 已更新' : 'Provider 已保存'), 'Provider save');
  const savedProvider = await waitFor(() => [...document.querySelectorAll('.provider-item')]
    .find((item) => item.textContent.includes(${JSON.stringify(providerName)})), 'saved E2E Provider');
  savedProvider.querySelector('.provider-select').click();
  await waitFor(() => [...document.querySelectorAll('.provider-item')]
    .find((item) => item.textContent.includes(${JSON.stringify(providerName)}) && item.textContent.includes('当前')), 'selected E2E Provider');
  (await waitFor(() => button('对话'), 'chat navigation')).click();
  await waitFor(() => enabledComposer(), 'enabled chat composer');
  return {
    providerUrl: ${JSON.stringify(providerUrl)},
    insecureHttpConfirmed: Boolean(insecureConfirmation?.checked),
    assistantCount: persistedAssistants().length,
  };
})()
`;
}

function chatExpression(message, expectedText) {
  return `
(async () => {
  ${browserHelpers()}
  const textarea = await waitFor(() => enabledComposer(), 'enabled chat composer');
  const assistantCountBefore = persistedAssistants().length;
  setValue(textarea, ${JSON.stringify(message)});
  textarea.closest('form').requestSubmit();
  const assistant = await waitFor(() => {
    const assistants = persistedAssistants();
    return assistants.length > assistantCountBefore
      && assistants.at(-1).textContent.includes(${JSON.stringify(expectedText)})
      ? assistants.at(-1)
      : undefined;
  }, 'new persisted assistant response', 30000);
  await waitFor(() => !document.querySelector('.message-bubble.streaming') && button('发送'), 'completed stream cleanup', 30000);
  return {
    assistantCountBefore,
    assistantCountAfter: persistedAssistants().length,
    newAssistant: assistant.innerText,
  };
})()
`;
}

function startSlowStreamExpression(message) {
  return `
(async () => {
  ${browserHelpers()}
  const textarea = await waitFor(() => enabledComposer(), 'enabled chat composer');
  const assistantCountBefore = persistedAssistants().length;
  setValue(textarea, ${JSON.stringify(message)});
  textarea.closest('form').requestSubmit();
  const streaming = await waitFor(() => {
    const item = document.querySelector('.message-bubble.assistant.streaming');
    return item?.textContent.includes('Android') ? item : undefined;
  }, 'first streamed delta', 30000);
  await waitFor(() => button('停止'), 'active stop control');
  return {
    assistantCountBefore,
    partialText: streaming.querySelector('p')?.textContent ?? streaming.textContent,
  };
})()
`;
}

function suspensionResultExpression(started) {
  return `
(async () => {
  ${browserHelpers()}
  await waitFor(() => button('发送') && !document.querySelector('.message-bubble.streaming'), 'suspended stream cleanup', 30000);
  const error = await waitFor(() => {
    const item = document.querySelector('.chat-error');
    return item?.textContent.includes('已停止生成') ? item : undefined;
  }, 'friendly suspension message', 30000);
  const assistants = persistedAssistants();
  if (assistants.length !== ${started.assistantCountBefore}) {
    throw new Error('Suspended stream persisted an unexpected assistant message');
  }
  if (assistants.slice(${started.assistantCountBefore}).some((item) => item.textContent.includes(${JSON.stringify(started.partialText)}))) {
    throw new Error('Suspended partial response leaked into persisted history');
  }
  return {
    assistantCount: assistants.length,
    error: error.textContent,
    partialReplyDiscarded: true,
  };
})()
`;
}

function browserHelpers() {
  return `
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (test, label, timeout = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = test();
      if (value) return value;
      await sleep(100);
    }
    throw new Error('Timed out waiting for ' + label + ': ' + document.body.innerText.slice(0, 1200));
  };
  const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.includes(text));
  const setValue = (element, value) => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const enabledComposer = () => {
    const item = document.querySelector('.chat-composer textarea');
    return item && !item.disabled ? item : undefined;
  };
  const persistedAssistants = () => [...document.querySelectorAll('.message-bubble.assistant:not(.streaming)')];
  `;
}

function setupAndroidForwarding() {
  runAdb("shell", "am", "start", "-n", "com.nkg.ai.bot/.MainActivity");
  const pid = runAdb("shell", "pidof", "com.nkg.ai.bot");
  if (!/^\d+$/.test(pid)) throw new Error(`NKG AI Bot process was not found: ${pid}`);
  runAdb("forward", "tcp:9222", `localabstract:webview_devtools_remote_${pid}`);
  if (reversedPort) runAdb("reverse", `tcp:${reversedPort}`, `tcp:${reversedPort}`);
}

function cleanupAndroidForwarding() {
  runAdbAllowFailure("forward", "--remove", "tcp:9222");
  if (reversedPort) runAdbAllowFailure("reverse", "--remove", `tcp:${reversedPort}`);
}

function runAdb(...args) {
  const result = spawnSync(resolveAdb(), deviceArguments(args), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function runAdbAllowFailure(...args) {
  spawnSync(resolveAdb(), deviceArguments(args), { encoding: "utf8", windowsHide: true });
}

function deviceArguments(args) {
  return process.env.NKG_ANDROID_DEVICE
    ? ["-s", process.env.NKG_ANDROID_DEVICE, ...args]
    : args;
}

function resolveAdb() {
  const candidates = [
    process.env.NKG_ADB,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? "adb";
}

async function waitForPages() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${devtoolsUrl}/json/list`);
      if (response.ok) return await response.json();
      lastError = new Error(`DevTools returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw lastError ?? new Error("Android WebView DevTools page was not found");
}

async function waitForLifecycleLog(phases) {
  let lastLog = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    lastLog = runAdb("logcat", "-d", "-t", "800");
    let cursor = 0;
    let matched = true;
    for (const phase of phases) {
      const index = lastLog.indexOf(`[runtime:lifecycle] ${phase}`, cursor);
      if (index < 0) {
        matched = false;
        break;
      }
      cursor = index + phase.length;
    }
    if (matched) {
      return lastLog.split(/\r?\n/).filter((line) => line.includes("[runtime:lifecycle]"));
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for lifecycle phases ${phases.join(" -> ")}: ${lastLog.slice(-2000)}`);
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
