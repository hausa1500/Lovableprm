
const PROJECT_SKILLS_KEY = "projectSkillSelections";
const PROJECT_CHATS_KEY = "projectChatBindings";
const CHATGPT_ENHANCE_BRIDGE = "src/content/chatgpt-enhance.js";
const CHATGPT_SUBMIT_BRIDGE = "src/content/chatgpt.js";
const ENHANCE_TIMEOUT_MS = 95000;

const SKILL_IDS = new Set([
  "interface-premium",
  "git-safe",
  "tests-regression",
  "responsive",
  "performance",
  "security-review",
  "responsivo-completo",
  "corrigir-projeto",
  "seguranca-e-banco",
  "melhorar-ui-ux",
  "refatorar-projeto",
  "otimizar-projeto",
  "accessibility-wcag",
  "agent-ui-design",
  "ai-design-workflow",
  "audit-code-quality",
  "audit-cost-explosion",
  "audit-legal-risks",
  "audit-monitoring-recovery",
  "audit-secrets-data-leaks",
  "audit-unauthorized-access",
  "branding-identity",
  "cloud-migration",
  "color-theory",
  "component-patterns",
  "customer-journey",
  "design-process",
  "design-system-pro",
  "ux-design",
  "vibe-security-check",
  "visual-direction",
  "web-typography",
  "webdesign-review",
  "website-audit-relaunch",
  "design-trends-2026",
  "images-media",
  "landing-pages",
  "navigation-design",
  "responsive-design",
  "ui-design",
  "ui-patterns",
  "usability",
]);

async function selectedSkills(projectId) {
  if (!projectId) return [];
  const stored = await chrome.storage.local.get(PROJECT_SKILLS_KEY);
  const ids = Array.isArray(stored[PROJECT_SKILLS_KEY]?.[projectId]) ? stored[PROJECT_SKILLS_KEY][projectId] : [];
  return ids.filter((id) => SKILL_IDS.has(id)).slice(0, 42);
}

async function activeProjectConversation(projectId) {
  if (!projectId) return null;
  const stored = await chrome.storage.local.get(PROJECT_CHATS_KEY);
  const record = stored[PROJECT_CHATS_KEY]?.[projectId];
  return record?.conversations?.find((item) => item.id === record.activeConversationId) || null;
}

async function resolveChatTab(conversation) {
  if (!conversation) return null;
  if (conversation.tabId) {
    try {
      const tab = await chrome.tabs.get(conversation.tabId);
      const lockedUrl = String(conversation.lockedUrl || conversation.url || "").trim();
      if (tab?.url?.startsWith("https://chatgpt.com/") && (!lockedUrl || tab.url === lockedUrl)) return tab;
    } catch {}
  }
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
  const lockedUrl = String(conversation.lockedUrl || conversation.url || "").trim();
  if (lockedUrl && lockedUrl !== "https://chatgpt.com/") {
    const exact = tabs.find((tab) => tab.url === lockedUrl);
    if (exact?.id) return exact;
  }
  return null;
}

async function ensureEnhanceBridge(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_ENHANCE_PING" });
    if (ping?.ok && ping.version === "0.31.1") return true;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: [CHATGPT_ENHANCE_BRIDGE] });
  const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_ENHANCE_PING" });
  return Boolean(ping?.ok && ping.version === "0.31.1");
}

async function ensureSubmitBridge(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
    if (ping?.ok && ping.source === "chatgpt") return true;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: [CHATGPT_SUBMIT_BRIDGE] });
  const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
  return Boolean(ping?.ok && ping.source === "chatgpt");
}

async function refreshChatGptResult(projectId) {
  const id = String(projectId || "").trim();
  if (!id) throw new Error("Projeto não informado.");

  const conversation = await activeProjectConversation(id);
  const tab = await resolveChatTab(conversation);
  if (!tab?.id) throw new Error("A conversa vinculada do ChatGPT não está disponível.");

  try {
    const ping = await chrome.tabs.sendMessage(tab.id, {
      type: "LOVABURST_SCAN_RESULT_MARKERS",
      projectId: id,
    });
    return ping || { ok: true };
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content/chatgpt-result-refresh.js"],
    });
    return chrome.tabs.sendMessage(tab.id, {
      type: "LOVABURST_SCAN_RESULT_MARKERS",
      projectId: id,
    });
  }
}

async function forwardComposerObjective(message, sender) {
  const objective = String(message.objective || "").trim();
  const projectId = String(message.projectId || "").trim();
  if (!objective) throw new Error("Digite o que você quer alterar.");
  if (!projectId) throw new Error("Não foi possível identificar o projeto da plataforma.");
  if (!sender?.tab?.id) throw new Error("A aba da plataforma não está disponível.");

  const skills = await selectedSkills(projectId);
  const response = await chrome.tabs.sendMessage(sender.tab.id, {
    type: "LOVABURST_SUBMIT_OBJECTIVE",
    objective,
    skills,
  });
  if (!response?.ok) throw new Error(response?.error || "Não foi possível enviar o pedido pela LovaRPM.");
  return response;
}

function isBuilderUrl(url) {
  return String(url || "").startsWith("https://lovable.dev/") || String(url || "").startsWith("https://app.base44.com/apps/");
}

async function resolveLovableSourceTab(projectId, senderTab) {
  if (senderTab?.id && isBuilderUrl(senderTab.url)) return senderTab;
  const tabs = await chrome.tabs.query({ url: ["https://lovable.dev/*", "https://app.base44.com/apps/*"] });
  return tabs.find((item) => item.url?.includes(projectId)) || tabs.find((item) => item.active) || tabs[0] || null;
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function enhanceComposerPrompt(message, sender) {
  const text = String(message.text || "").trim();
  const projectId = String(message.projectId || "").trim();
  if (!text) throw new Error("Digite um pedido antes de usar o Boost.");
  if (!projectId) throw new Error("Não foi possível identificar o projeto da plataforma.");
  const config = (await chrome.storage.local.get("config")).config || {};
  if (config.enabled === false || config.chatgptEnabled === false) throw new Error("ChatGPT integration is disabled in LovaRPM.");

  const conversation = await activeProjectConversation(projectId);
  const tab = await resolveChatTab(conversation);
  if (!tab?.id) throw new Error("Conecte uma conversa do ChatGPT a este projeto antes de usar o Boost.");

  const skills = await selectedSkills(projectId);
  const platform = sender?.tab?.url?.startsWith("https://app.base44.com/") ? "base44" : "lovable";
  const prompt = await globalThis.LovaRPMLicense?.preparePrompt?.("enhance", { text, lovableProjectId: projectId, platform, repository: String(message.repository || ""), title: String(message.title || sender?.tab?.title || ""), skills });
  if (!prompt) throw new Error("O servidor não preparou o aprimoramento.");
  const sourceTab = await resolveLovableSourceTab(projectId, sender?.tab || null);
  const chatWasActive = Boolean(tab.active);

  try {
    if (!chatWasActive) {
      await chrome.tabs.update(tab.id, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
    if (!(await ensureSubmitBridge(tab.id))) throw new Error("A ponte de envio do ChatGPT não respondeu.");
    if (!(await ensureEnhanceBridge(tab.id))) throw new Error("A ponte de aprimoramento do ChatGPT não respondeu.");

    const snapshot = await chrome.tabs.sendMessage(tab.id, { type: "LOVABURST_ENHANCE_SNAPSHOT" });
    if (!snapshot?.ok || !snapshot.baseline) throw new Error("Não foi possível iniciar a verificação do prompt aprimorado.");

    const dispatched = await chrome.tabs.sendMessage(tab.id, { type: "LOVABURST_SUBMIT_TO_CHATGPT", prompt });
    if (!dispatched?.ok) throw new Error(dispatched?.error || "O ChatGPT não confirmou o envio do pedido de aprimoramento.");

    const response = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: "LOVABURST_ENHANCE_WAIT_FOR_RESPONSE", baseline: snapshot.baseline, timeoutMs: ENHANCE_TIMEOUT_MS }),
      ENHANCE_TIMEOUT_MS + 5000,
      "O ChatGPT demorou demais para devolver o prompt aprimorado.",
    );
    const enhanced = String(response?.text || "").trim();
    if (!response?.ok || !enhanced) throw new Error(response?.error || "O ChatGPT não devolveu um prompt aprimorado.");
    if (enhanced === text) throw new Error("O ChatGPT devolveu o mesmo texto sem aprimoramento. Tente novamente.");
    return { ok: true, text: enhanced };
  } finally {
    if (!chatWasActive && sourceTab?.id && isBuilderUrl(sourceTab.url)) {
      await chrome.tabs.update(sourceTab.id, { active: true }).catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "LOVABURST_COMPOSER_SUBMIT") {
    forwardComposerObjective(message, sender)
      .then((response) => sendResponse({ ok: true, ...response }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_ENHANCE_PROMPT") {
    enhanceComposerPrompt(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_REFRESH_CHATGPT_RESULT") {
    refreshChatGptResult(message.projectId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  return false;
});
