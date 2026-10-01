(() => {
  if (window.__LOVARPM_CLAUDE_BRIDGE_V1__) return;
  window.__LOVARPM_CLAUDE_BRIDGE_V1__ = true;

  const SOURCE = "claude";
  const RUN_STATUS_KEY = "projectRunStatuses";
  const LARGE_PROMPT_THRESHOLD = 12000;
  const REQUEST_MARKERS = ["[PRM_BUILD_REQUEST_V5]", "[LOVABURST_REQUEST_V3]", "[LOVABURST_REQUEST_V2]", "[LOVABURST_REQUEST_V1]"];
  const PROJECT_ID_PATTERN = /(?:LOVABLE_PROJECT|BASE44_APP):\s*([A-Za-z0-9-]+)/i;
  const RESULT_MARKERS = Object.freeze({
    "[LOVABURST_DONE]": "done",
    "[LOVABURST_BLOCKED]": "blocked",
    "[LOVABURST_ERROR]": "error",
    "[LOVARPM_DONE]": "done",
    "[LOVARPM_BLOCKED]": "blocked",
    "[LOVARPM_ERROR]": "error",
  });
  const COMPOSER_SELECTORS = [
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"][role="textbox"]',
    'div.ProseMirror[contenteditable="true"]',
    'textarea[placeholder*="Reply" i]',
    'textarea[placeholder*="Message" i]',
    'textarea[placeholder*="Send" i]',
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
  ];
  const SEND_BUTTON_SELECTORS = [
    'button[data-testid*="send" i]',
    'button[aria-label*="Send message" i]',
    'button[aria-label*="Send" i]',
    'button[title*="Send" i]',
    'button[type="submit"]',
  ];
  const USER_MESSAGE_SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid*="human-message" i]',
    '[data-message-author-role="user"]',
    '[data-author="human"]',
  ];
  const ASSISTANT_MESSAGE_SELECTORS = [
    '[data-testid="assistant-message"]',
    '[data-testid*="assistant-message" i]',
    '[data-message-author-role="assistant"]',
    '[data-author="assistant"]',
  ];
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const isRequest = (text) => REQUEST_MARKERS.some((marker) => String(text || "").includes(marker));
  let busy = false;
  let lastResponseSignature = "";
  let lastStatusWriteAt = 0;
  let idleTimer = null;
  let resultScanTimer = null;

  function visible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 40 && rect.height > 18 && style.display !== "none" && style.visibility !== "hidden";
  }

  function read(element) {
    if (!element) return "";
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value || "";
    return String(element.innerText || element.textContent || "").trim();
  }

  function findComposer() {
    const candidates = [];
    const seen = new Set();
    for (const selector of COMPOSER_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (!seen.has(element) && visible(element)) {
          seen.add(element);
          candidates.push(element);
        }
      }
    }
    candidates.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return Number(Boolean(right.closest("form"))) - Number(Boolean(left.closest("form"))) || rightRect.bottom - leftRect.bottom;
    });
    return candidates[0] || null;
  }

  async function waitForComposer(timeoutMs = 16000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const element = findComposer();
      if (element) return element;
      await sleep(150);
    }
    return null;
  }

  function setComposerText(element, text) {
    element.focus();
    const large = text.length >= LARGE_PROMPT_THRESHOLD;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, text);
      else element.value = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: large ? "insertFromPaste" : "insertText", data: large ? null : text }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return;
    }

    if (large) {
      element.replaceChildren(document.createTextNode(text));
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      try {
        document.execCommand("delete", false);
        if (!document.execCommand("insertText", false, text)) element.textContent = text;
      } catch {
        element.textContent = text;
      }
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: large ? "insertFromPaste" : "insertText", data: large ? null : text }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function sendButton(composer) {
    const roots = [composer?.closest("form"), composer?.parentElement, document].filter(Boolean);
    for (const root of roots) {
      for (const selector of SEND_BUTTON_SELECTORS) {
        const matches = Array.from(root.querySelectorAll(selector)).filter((button) => visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true");
        if (matches.length) return matches.at(-1);
      }
    }
    return null;
  }

  function userMessages() {
    const nodes = new Set(USER_MESSAGE_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector))));
    return [...nodes].filter(visible);
  }

  function assistantMessages() {
    const nodes = new Set(ASSISTANT_MESSAGE_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector))));
    return [...nodes].filter(visible);
  }

  function assistantSnapshot() {
    const messages = assistantMessages();
    const last = messages.at(-1) || null;
    return {
      count: messages.length,
      lastKey: last?.getAttribute("data-message-id") || last?.getAttribute("data-testid") || `assistant-${messages.length - 1}`,
      lastText: read(last),
    };
  }

  async function waitForEnhancedAnswer(baseline, timeoutMs = 95000) {
    const startedAt = Date.now();
    let lastText = "";
    let stableChecks = 0;
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(700);
      const messages = assistantMessages();
      const last = messages.at(-1) || null;
      if (!last) continue;
      const key = last.getAttribute("data-message-id") || last.getAttribute("data-testid") || `assistant-${messages.length - 1}`;
      const text = read(last);
      const isNew = messages.length > Number(baseline?.count || 0) || key !== String(baseline?.lastKey || "") || (text && text !== String(baseline?.lastText || ""));
      if (!isNew || !text) continue;
      if (text === lastText) stableChecks += 1;
      else { lastText = text; stableChecks = 1; }
      if (!generating() && stableChecks >= 2) return text;
    }
    throw new Error("Claude took too long to return the enhanced prompt.");
  }

  function generating() {
    return Boolean(document.querySelector('button[aria-label*="Stop" i],button[aria-label*="Cancel response" i],button[title*="Stop" i],[data-testid*="stop" i]'));
  }

  async function waitForDispatch(baseline, composer, button, timeoutMs = 14000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (userMessages().length > baseline) return { confirmed: true, signal: "user-message" };
      if (generating()) return { confirmed: true, signal: "generation" };
      if (button && (!button.isConnected || button.disabled || button.getAttribute("aria-disabled") === "true")) return { confirmed: true, signal: "send-state" };
      if (Date.now() - startedAt >= 700 && !read(composer).trim()) return { confirmed: true, signal: "composer-cleared" };
      await sleep(140);
    }
    return { confirmed: false, signal: "timeout" };
  }

  async function submitPrompt(prompt, options = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) return { ok: false, error: "Prompt is empty or invalid." };
    const composer = await waitForComposer();
    if (!composer) return { ok: false, error: "Claude message field not found." };
    const readyStartedAt = Date.now();
    while (generating() && Date.now() - readyStartedAt < 120000) await sleep(250);
    if (generating()) return { ok: false, error: "Claude is still processing the previous response." };

    let authorization;
    try {
      authorization = await chrome.runtime.sendMessage({ type: "LOVARPM_LICENSE_AUTHORIZE" });
    } catch {
      return { ok: false, error: "Could not verify the LovaRPM license. Protected features remain locked." };
    }
    const remainingMs = Number(authorization?.remainingMs);
    if (!authorization?.ok || !authorization.status?.valid || !Number.isFinite(remainingMs) || remainingMs <= 0) {
      return { ok: false, error: authorization?.status?.message || "A valid LovaRPM license is required." };
    }

    const authorizationDeadline = performance.now() + remainingMs;
    const originalPrompt = prompt.trim();
    const preparedPrompt = options.implementationTask === true && !originalPrompt.startsWith("[PRM_WRAPPER]")
      ? `[PRM_WRAPPER]\n\nExecute the user's request accurately and completely.\nInspect before changing. Preserve existing functionality and explicit requirements.\nMake the smallest safe changes necessary.\nVerify and repair task-caused errors before finishing.\nThe user's request is the source of truth; do not override it.\n\nFINAL RESPONSE:\nBriefly report what changed, key files, and validations actually performed.\n\nFinish with exactly one status:\n[PRM_DONE]\n[PRM_BLOCKED]\n[PRM_ERROR]\n\n${originalPrompt}`
      : originalPrompt;
    const baseline = userMessages().length;
    setComposerText(composer, preparedPrompt);
    await sleep(preparedPrompt.length >= 12000 ? 180 : 120);
    if (!read(composer).trim()) return { ok: false, error: "LovaRPM could not insert the prompt into Claude." };

    let button = sendButton(composer);
    if (!button) {
      const startedAt = Date.now();
      while (!button && Date.now() - startedAt < 18000) {
        await sleep(150);
        button = sendButton(composer);
      }
    }
    if (performance.now() + 250 >= authorizationDeadline) {
      if (read(composer).trim() === preparedPrompt) setComposerText(composer, "");
      return { ok: false, error: "The license expired before the request could be sent." };
    }

    if (button) button.click();
    else {
      const form = composer.closest("form");
      if (form?.requestSubmit) form.requestSubmit();
      else {
        composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true, cancelable: true }));
        composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, composed: true, cancelable: true }));
      }
    }
    const dispatch = await waitForDispatch(baseline, composer, button);
    return { ok: true, confirmation: dispatch.confirmed ? dispatch.signal : "pending" };
  }

  function findMessages(selectors) {
    const nodes = new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))));
    return [...nodes].filter(visible);
  }

  function markerFromText(text) {
    const value = String(text || "");
    for (const [marker, status] of Object.entries(RESULT_MARKERS)) if (value.includes(marker)) return { marker, status };
    return null;
  }

  function projectIdFromRequest(text) {
    if (!isRequest(text)) return "";
    return String(text.match(PROJECT_ID_PATTERN)?.[1] || "");
  }

  function compact(text, limit = 2200) {
    return String(text || "").replace(/\[LOVABURST_(?:DONE|BLOCKED|ERROR)\]|\[LOVARPM_(?:DONE|BLOCKED|ERROR)\]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(-limit);
  }

  async function persistStatus(projectId, status, marker, messageKey, text) {
    if (!projectId) return;
    const stored = await chrome.storage.local.get(RUN_STATUS_KEY);
    const all = stored[RUN_STATUS_KEY] || {};
    const previous = all[projectId] || {};
    if (previous.aiProvider && previous.aiProvider !== SOURCE) return;
    const now = new Date().toISOString();
    await chrome.storage.local.set({
      [RUN_STATUS_KEY]: {
        ...all,
        [projectId]: {
          ...previous,
          projectId,
          aiProvider: SOURCE,
          status,
          marker: marker || previous.marker || "",
          detectedAt: marker ? now : previous.detectedAt,
          completedAt: marker ? now : previous.completedAt,
          chatUrl: location.href,
          chatTitle: document.title || "Claude",
          assistantMessageKey: messageKey,
          excerpt: marker ? compact(text, 1200) : previous.excerpt,
          liveResponse: compact(text),
          liveResponseAt: now,
          liveResponseMessageKey: messageKey,
          error: status === "error" ? compact(text, 1200) : "",
        },
      },
    });
    if (marker) {
      chrome.runtime.sendMessage({ type: "LOVABURST_RESULT_MARKER_DETECTED", source: SOURCE, projectId, status, marker, chatUrl: location.href }).catch(() => {});
    }
  }

  async function scanResults() {
    const users = findMessages(USER_MESSAGE_SELECTORS);
    const assistants = findMessages(ASSISTANT_MESSAGE_SELECTORS);
    let latest = null;
    for (let index = 0; index < users.length; index += 1) {
      const userText = read(users[index]);
      const projectId = projectIdFromRequest(userText);
      if (projectId) latest = { projectId, userIndex: index, requestText: userText };
    }
    if (!latest) return;

    const following = users[latest.userIndex + 1];
    const assistant = assistants.filter((node) => {
      const userRect = users[latest.userIndex].getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      return rect.top > userRect.top && (!following || rect.top < following.getBoundingClientRect().top);
    }).at(-1);
    if (!assistant) return;
    const text = read(assistant);
    if (!text) return;
    const key = assistant.getAttribute("data-message-id") || assistant.getAttribute("data-testid") || `${latest.userIndex}:${text.length}`;
    const marker = markerFromText(text);
    const signature = `${latest.projectId}|${key}|${marker?.marker || text}`;
    const now = Date.now();
    if (!marker && signature === lastResponseSignature) return;
    if (!marker && now - lastStatusWriteAt < 450) return;
    lastResponseSignature = signature;
    lastStatusWriteAt = now;

    if (marker) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      await persistStatus(latest.projectId, marker.status, marker.marker, key, text);
      return;
    }
    if (generating()) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      await persistStatus(latest.projectId, "working", "", key, text);
      return;
    }
    await persistStatus(latest.projectId, "working", "", key, text);
    if (!idleTimer) {
      idleTimer = window.setTimeout(() => {
        idleTimer = null;
        if (!generating()) void persistStatus(latest.projectId, "done", "[LOVABURST_DONE]", key, text);
      }, 1600);
    }
  }

  async function prepareAttachments(attachments) {
    if (!attachments.length) return { ok: true, count: 0 };
    const composer = await waitForComposer();
    if (!composer) throw new Error("Claude message field not found.");
    let authorization;
    try { authorization = await chrome.runtime.sendMessage({ type: "LOVARPM_LICENSE_AUTHORIZE" }); }
    catch { throw new Error("Could not verify the LovaRPM license. Protected features remain locked."); }
    const remainingMs = Number(authorization?.remainingMs);
    if (!authorization?.ok || !authorization.status?.valid || !Number.isFinite(remainingMs) || remainingMs <= 250) {
      throw new Error(authorization?.status?.message || "A valid LovaRPM license is required.");
    }
    const authorizationDeadline = performance.now() + remainingMs;
    const root = composer.closest("form") || document;
    const input = Array.from(root.querySelectorAll('input[type="file"]')).find((item) => !item.disabled)
      || Array.from(document.querySelectorAll('input[type="file"]')).find((item) => !item.disabled);
    if (!input) throw new Error("The current Claude composer does not provide a file input.");
    const files = attachments.map((item) => {
      const binary = atob(item.base64 || "");
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new File([bytes], item.name, { type: item.type || "", lastModified: Date.now() });
    });
    if (performance.now() + 250 >= authorizationDeadline) throw new Error("The license expired before the attachments could be added.");
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
    if (setter) setter.call(input, transfer.files);
    else input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const names = files.map((file) => file.name.toLowerCase());
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30000) {
      await sleep(250);
      const current = String(root.innerText || root.textContent || "").toLowerCase();
      if (names.every((name) => current.includes(name))) return { ok: true, count: files.length };
      const alerts = Array.from(document.querySelectorAll('[role="alert"],[aria-live="assertive"]')).filter(visible);
      const error = alerts.map(read).find((text) => /upload|file|unsupported|failed|limit|size|type/i.test(text));
      if (error) throw new Error(`Claude rejected the attachment: ${error.slice(0, 400)}`);
    }
    throw new Error(`Could not attach ${files[0]?.name || "the file"} to Claude. The message was not sent.`);
  }

  function exportProjectContext(projectId) {
    const targetId = String(projectId || "");
    if (!targetId) return "";
    const nodes = [...findMessages(USER_MESSAGE_SELECTORS), ...findMessages(ASSISTANT_MESSAGE_SELECTORS)]
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
    const collected = [];
    let belongs = false;
    for (const node of nodes) {
      const text = read(node);
      const isUser = USER_MESSAGE_SELECTORS.some((selector) => node.matches(selector));
      if (isUser && projectIdFromRequest(text) === targetId) belongs = true;
      if (belongs && text) collected.push(`${isUser ? "USER" : "ASSISTANT"}:\n${text.slice(0, 1800)}`);
    }
    return collected.slice(-12).join("\n\n---\n\n").slice(-14000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LOVABURST_ENHANCE_PING") {
      sendResponse({ ok: true, version: "1.0.0" });
      return false;
    }
    if (message?.type === "LOVABURST_ENHANCE_SNAPSHOT") {
      sendResponse({ ok: true, baseline: assistantSnapshot() });
      return false;
    }
    if (message?.type === "LOVABURST_ENHANCE_WAIT_FOR_RESPONSE") {
      void waitForEnhancedAnswer(message.baseline, Number(message.timeoutMs) || 95000)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (message?.type === "LOVABURST_CONTENT_PING") {
      sendResponse({ ok: true, source: SOURCE, url: location.href, composerDetected: Boolean(findComposer()), busy: generating() });
      return false;
    }
    if (message?.type === "LOVABURST_EXPORT_PROJECT_CONTEXT") {
      sendResponse({ ok: true, source: SOURCE, projectId: String(message.projectId || ""), excerpt: exportProjectContext(message.projectId) });
      return false;
    }
    if (message?.type === "LOVABURST_SCAN_RESULT_MARKERS") {
      void scanResults().then(() => sendResponse({ ok: true, source: SOURCE })).catch(() => sendResponse({ ok: false, source: SOURCE }));
      return true;
    }
    if (message?.type === "LOVABURST_ATTACHMENTS_PING") {
      sendResponse({ ok: true, source: "claude-attachments", version: "1.0.0" });
      return false;
    }
    if (message?.type === "LOVABURST_PREPARE_ATTACHMENTS") {
      void prepareAttachments(Array.isArray(message.attachments) ? message.attachments.slice(0, 5) : [])
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (message?.type === "LOVABURST_SUBMIT_TO_CLAUDE") {
      if (busy) {
        sendResponse({ ok: false, error: "Claude is already processing a LovaRPM submission." });
        return false;
      }
      busy = true;
      void submitPrompt(message.prompt, { implementationTask: message.implementationTask === true })
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        .finally(() => { busy = false; });
      return true;
    }
    return false;
  });

  const observer = new MutationObserver(() => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (resultScanTimer) clearTimeout(resultScanTimer);
    resultScanTimer = window.setTimeout(() => {
      resultScanTimer = null;
      void scanResults().catch(() => {});
    }, 180);
  });
  const startObserving = () => {
    const root = document.body || document.documentElement;
    if (!root) return window.setTimeout(startObserving, 250);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    void scanResults().catch(() => {});
  };
  startObserving();
  chrome.runtime.sendMessage({ type: "LOVABURST_PING", source: SOURCE }).catch(() => {});
})();