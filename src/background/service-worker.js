import { getConfig, setConfig } from "../shared/storage.js";
import { getPromptSkillIds, withPrmV5ImplementationContext, withSkillInstructions } from "../shared/skill-instructions.js";

const CHATGPT_URL_PATTERNS = ["https://chatgpt.com/*"];
const CHATGPT_BRIDGE_FILE = "src/content/chatgpt.js";

async function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("[LovaRPM] Não foi possível configurar o painel lateral:", error);
  }
}

async function cleanChatGptOnlyState() {
  const config = await getConfig();
  const migration = await chrome.storage.local.get(["repositoryDetectionMigrationV0400", "projectChatBindings", "chatgptOnlyCleanupV261", "providerConversationMigrationV1"]);
  const legacyProviderKey = ["ai", "Provider"].join("");
  const removedAssistantName = String.fromCharCode(103, 101, 109, 105, 110, 105);
  const legacySecondaryEnabledKey = removedAssistantName + "Enabled";
  const cleanConfig = { ...config };
  delete cleanConfig[legacyProviderKey];
  delete cleanConfig[legacySecondaryEnabledKey];
  const patch = { config: cleanConfig };

  if (!migration.repositoryDetectionMigrationV0400) {
    patch.workspaceBindings = {};
    patch.repositoryDetectionMigrationV0400 = true;
  }

  if (!migration.chatgptOnlyCleanupV261) {
    const bindings = patch.projectChatBindings || migration.projectChatBindings || {};
    const cleaned = {};
    for (const [projectId, record] of Object.entries(bindings)) {
      const conversations = (Array.isArray(record?.conversations) ? record.conversations : [])
        .filter((item) => String(item?.url || item?.lockedUrl || "").startsWith("https://chatgpt.com/") && !`${item?.title || ""} ${item?.lockedTitle || ""}`.toLowerCase().includes(removedAssistantName));
      const activeStillExists = conversations.some((item) => item.id === record?.activeConversationId);
      const cleanRecord = { ...record, conversations: conversations.map(({ provider, ...item }) => item), activeConversationId: activeStillExists ? record.activeConversationId : (conversations[conversations.length - 1]?.id || "") };
      delete cleanRecord[legacyProviderKey];
      cleaned[projectId] = cleanRecord;
    }
    patch.projectChatBindings = cleaned;
    patch.projectRunStatuses = {};
    patch.chatgptOnlyCleanupV261 = true;
    await chrome.storage.local.remove(["aiLink", "pendingPrompt", removedAssistantName + "LovableRelays"]);
  }

  if (!migration.providerConversationMigrationV1) {
    const bindings = patch.projectChatBindings || migration.projectChatBindings || {};
    const migrated = {};
    for (const [projectId, record] of Object.entries(bindings)) {
      const conversations = (Array.isArray(record?.conversations) ? record.conversations : []).map((item) => {
        if (item.aiProvider) return item;
        const isUnresolvedNewChat = !item.lockedUrl && String(item.url || "") === "https://chatgpt.com/";
        return { ...item, aiProvider: "chatgpt", ...(isUnresolvedNewChat ? { pendingNavigation: true } : {}) };
      });
      const activeConversationIds = { ...(record?.activeConversationIds || {}) };
      if (record?.activeConversationId) activeConversationIds.chatgpt = record.activeConversationId;
      migrated[projectId] = { ...record, activeConversationIds, conversations };
    }
    patch.projectChatBindings = migrated;
    patch.providerConversationMigrationV1 = true;
  }

  await chrome.storage.local.set(patch);
}

chrome.runtime.onInstalled.addListener(async () => {
  await cleanChatGptOnlyState();
  await configureSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  void cleanChatGptOnlyState();
  configureSidePanel();
});

void cleanChatGptOnlyState();
configureSidePanel();


async function listChatGptTabs() {
  const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  const removedAssistantName = String.fromCharCode(103, 101, 109, 105, 110, 105);
  return tabs
    .filter((tab) => tab.id && !String(tab.title || "").toLowerCase().includes(removedAssistantName))
    .map((tab) => ({
      tabId: tab.id,
      title: tab.title || "ChatGPT",
      url: tab.url || "https://chatgpt.com/",
      active: Boolean(tab.active),
      windowId: tab.windowId,
    }));
}

async function getStoredChatGptLink() {
  const stored = await chrome.storage.local.get("chatgptLink");
  return stored.chatgptLink || null;
}

async function clearChatGptLink() {
  await chrome.storage.local.remove("chatgptLink");
}

async function getLinkedChatGptTab() {
  const link = await getStoredChatGptLink();
  if (!link?.tabId) return null;

  try {
    const tab = await chrome.tabs.get(link.tabId);
    if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) {
      await clearChatGptLink();
      return null;
    }

    if (tab.url !== link.url || tab.title !== link.title) {
      await chrome.storage.local.set({
        chatgptLink: {
          ...link,
          url: tab.url || link.url,
          title: tab.title || link.title || "ChatGPT",
          updatedAt: new Date().toISOString(),
        },
      });
    }

    return tab;
  } catch {
    // A tab pode ter sido recriada pelo Chrome. Tentamos recuperar pela URL exata uma vez.
    const tabs = await listChatGptTabs();
    const recovered = tabs.find((tab) => link.url && tab.url === link.url);

    if (recovered?.tabId) {
      const nextLink = {
        tabId: recovered.tabId,
        url: recovered.url,
        title: recovered.title,
        linkedAt: link.linkedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({ chatgptLink: nextLink });
      return chrome.tabs.get(recovered.tabId);
    }

    await clearChatGptLink();
    return null;
  }
}

async function linkChatGptTab(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("Invalid ChatGPT tab.");
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) {
    throw new Error("The selected tab is not a ChatGPT conversation.");
  }

  const bridgeReady = await ensureChatGptBridge(tab.id);
  if (!bridgeReady) {
    throw new Error("The LovaRPM bridge did not respond in this ChatGPT tab.");
  }

  const link = {
    tabId: tab.id,
    url: tab.url || "https://chatgpt.com/",
    title: tab.title || "ChatGPT",
    linkedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ chatgptLink: link });
  return link;
}

async function getChatGptStatus() {
  const tabs = await listChatGptTabs();
  const linkedTab = await getLinkedChatGptTab();
  const link = linkedTab ? await getStoredChatGptLink() : null;

  return {
    connected: Boolean(linkedTab?.id),
    link,
    tabs,
  };
}

async function sendPromptMessage(tabId, prompt, provider = "chatgpt") {
  const config = globalThis.LovaRPMProviders?.[provider];
  if (!config) throw new Error("Unsupported AI provider.");
  return chrome.tabs.sendMessage(tabId, {
    type: config.submitMessage,
    prompt,
    implementationTask: true,
  });
}

async function ensureChatGptBridge(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
    if (ping?.ok && ping.source === "chatgpt") return true;
  } catch {}

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CHATGPT_BRIDGE_FILE],
  });

  const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
  return Boolean(ping?.ok && ping.source === "chatgpt");
}

async function ensureProviderBridge(tabId, provider) {
  if (provider === "chatgpt") return ensureChatGptBridge(tabId);
  const config = globalThis.LovaRPMProviders?.[provider];
  if (!config) return false;
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
    if (ping?.ok && ping.source === config.pingSource) return true;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: [config.bridgeFile] });
  const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
  return Boolean(ping?.ok && ping.source === config.pingSource);
}

async function linkClaudeTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Invalid Claude tab.");
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id || !tab.url?.startsWith("https://claude.ai/")) throw new Error("The selected tab is not a Claude conversation.");
  if (!(await ensureProviderBridge(tab.id, "claude"))) throw new Error("The LovaRPM bridge did not respond in this Claude tab.");
  return { tabId: tab.id, url: tab.url || "https://claude.ai/new", title: tab.title || "Claude", linkedAt: new Date().toISOString() };
}

async function linkProviderTab(tabId, provider) {
  if (provider === "chatgpt") return linkChatGptTab(tabId);
  if (provider === "claude") return linkClaudeTab(tabId);
  throw new Error("Unsupported AI provider.");
}

function isProviderNewUrl(provider, url) {
  const config = globalThis.LovaRPMProviders?.[provider];
  try {
    const parsed = new URL(url);
    return parsed.origin === config?.origin && (parsed.pathname === "/" || parsed.pathname === "/new");
  } catch {
    return false;
  }
}

async function resolveProjectProviderTab(projectId, provider) {
  if (!projectId || !globalThis.LovaRPMProviders?.[provider]) return null;
  const stored = await chrome.storage.local.get("projectChatBindings");
  const record = stored.projectChatBindings?.[projectId];
  const conversation = globalThis.LovaRPMProviders.resolveConversation(record, provider);
  if (!conversation || (conversation.aiProvider || "chatgpt") !== provider) return null;
  const config = globalThis.LovaRPMProviders[provider];
  const expectedUrl = String(conversation.lockedUrl || (!conversation.pendingNavigation ? conversation.url : "") || "").trim();
  if (conversation.tabId) {
    try {
      const tab = await chrome.tabs.get(conversation.tabId);
      const sameConversation = expectedUrl && globalThis.LovaRPMProviders.sameConversation(provider, expectedUrl, tab?.url);
      if (tab?.url?.startsWith(`${config.origin}/`) && (!expectedUrl || sameConversation || conversation.pendingNavigation)) {
        if (!conversation.pendingNavigation && sameConversation && tab.url !== expectedUrl) {
          const bindings = stored.projectChatBindings || {};
          const currentRecord = bindings[projectId];
          if (currentRecord) {
            bindings[projectId] = {
              ...currentRecord,
              conversations: currentRecord.conversations.map((item) => item.id === conversation.id
                ? { ...item, url: tab.url, lockedUrl: tab.url, title: tab.title || item.title, lockedTitle: tab.title || item.lockedTitle }
                : item),
            };
            await chrome.storage.local.set({ projectChatBindings: bindings });
          }
        }
        return tab;
      }
    } catch {}
  }
  if (expectedUrl && !isProviderNewUrl(provider, expectedUrl)) {
    const tabs = await chrome.tabs.query({ url: config.patterns });
    const tab = tabs.find((item) => globalThis.LovaRPMProviders.sameConversation(provider, expectedUrl, item.url));
    if (tab?.id) return tab;
  }
  return null;
}

async function refreshProviderResult(projectId, provider) {
  const tab = await resolveProjectProviderTab(projectId, provider);
  if (!tab?.id) throw new Error(`The linked ${globalThis.LovaRPMProviders?.[provider]?.name || "AI provider"} conversation is unavailable.`);
  await ensureProviderBridge(tab.id, provider);
  const result = await chrome.tabs.sendMessage(tab.id, { type: "LOVABURST_SCAN_RESULT_MARKERS", projectId });
  return result || { ok: true, projectId, aiProvider: provider };
}

function mainWorldWorkspaceProbe() {
  const blocked = new Set([
    "settings", "marketplace", "features", "topics", "collections", "login", "signup",
    "projects", "project", "lovable", "api", "assets", "src", "public", "blob", "tree",
    "en", "docs",
  ]);
  const scored = new Map();
  const normalizePlainRepository = (value) => {
    const text = String(value || "").trim();
    const match = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
    if (!match) return "";

    const owner = match[1];
    const repo = match[2];
    if (blocked.has(owner.toLowerCase()) || blocked.has(repo.toLowerCase())) return "";
    if (owner.length < 2 || repo.length < 2) return "";
    return `${owner}/${repo}`;
  };

  const normalizeGithubUrl = (value) => {
    if (!value) return "";
    const raw = String(value).trim();

    const ssh = raw.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
    if (ssh) return normalizePlainRepository(`${ssh[1]}/${ssh[2]}`);

    let url;
    try {
      url = new URL(raw, location.href);
    } catch {
      return "";
    }

    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return "";

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    return normalizePlainRepository(`${parts[0]}/${parts[1]}`);
  };

  const add = (value, score) => {
    const repo = normalizeGithubUrl(value);
    if (!repo) return;
    scored.set(repo, Math.max(scored.get(repo) || 0, score));
  };

  const collectText = (value, score) => {
    if (value == null) return;
    let text;

    try {
      text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return;
    }

    if (!text) return;
    text = text.slice(0, 300000);

    const patterns = [
      /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi,
      /git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi,
    ];

    for (const pattern of patterns) {
      for (const match of text.match(pattern) || []) add(match, score);
    }
  };

  const projectId = location.pathname.match(/\/(?:projects|apps)\/([A-Za-z0-9-]+)/i)?.[1] || "";

  try {
    const root = document.documentElement;
    const boundProject = root?.dataset?.lovaburstRepositoryProject || "";

    if (boundProject && boundProject === projectId) {
      const trusted = normalizePlainRepository(root?.dataset?.lovaburstRepository || "");
      if (trusted) scored.set(trusted, 180);
    }
  } catch {}

  try {
    for (const anchor of document.querySelectorAll('a[href*="github.com"], a[href^="git@github.com:"]')) {
      add(anchor.href || anchor.getAttribute("href"), 140);
    }
  } catch {}

  try {
    collectText(document.documentElement?.innerHTML, 55);
  } catch {}

  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || "";
      collectText(`${key}:${localStorage.getItem(key) || ""}`, /github|repo|project|workspace/i.test(key) ? 120 : 80);
    }
  } catch {}

  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index) || "";
      collectText(`${key}:${sessionStorage.getItem(key) || ""}`, /github|repo|project|workspace/i.test(key) ? 115 : 75);
    }
  } catch {}

  const preferredGlobals = [
    "__NEXT_DATA__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__",
    "__REACT_QUERY_STATE__", "__remixContext", "__ROUTE_DATA__", "__lovable", "lovable",
  ];

  for (const key of preferredGlobals) {
    try {
      collectText(window[key], 125);
    } catch {}
  }

  const repository = [...scored.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
  return { repository, lovableProjectId: projectId };
}

async function detectLovableWorkspace(tabId, payload = {}) {
  const lovableProjectId = payload.lovableProjectId || "";
  const workspaceKey = lovableProjectId || payload.url || "";

  if (payload.domRepository) {
    return { repository: payload.domRepository, source: "isolated-dom", lovableProjectId };
  }

  if (workspaceKey) {
    const stored = await chrome.storage.local.get("workspaceBindings");
    const cached = stored.workspaceBindings?.[workspaceKey]?.repository;
    if (cached) return { repository: cached, source: "workspace-cache", lovableProjectId };
  }

  if (!tabId) return { repository: "", source: "none", lovableProjectId };

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: mainWorldWorkspaceProbe,
    });
    const result = results?.[0]?.result || {};
    const repository = result.repository || "";
    const projectId = result.lovableProjectId || lovableProjectId;

    if (repository && (projectId || workspaceKey)) {
      const key = projectId || workspaceKey;
      const stored = await chrome.storage.local.get("workspaceBindings");
      await chrome.storage.local.set({
        workspaceBindings: {
          ...(stored.workspaceBindings || {}),
          [key]: {
            repository,
            detectedAt: new Date().toISOString(),
            source: "main-world",
          },
        },
      });
    }

    return { repository, source: repository ? "main-world" : "none", lovableProjectId: projectId };
  } catch {
    return { repository: "", source: "none", lovableProjectId };
  }
}

const sleepBackground = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function relayPromptToProvider(payload, sourceTabId = null) {
  const provider = payload.aiProvider === "claude" ? "claude" : "chatgpt";
  const providerInfo = globalThis.LovaRPMProviders?.[provider];
  if (!providerInfo) throw new Error("Unsupported AI provider.");
  const config = await getConfig();
  if (config.enabled === false || config[providerInfo.enabledConfigKey] === false) {
    throw new Error(`The ${providerInfo.name} integration is disabled in LovaRPM.`);
  }

  const tab = await resolveProjectProviderTab(payload.lovableProjectId, provider);
  if (!tab?.id) {
    throw new Error(`${providerInfo.name} is not linked to this project. Open the LovaRPM panel and link a ${providerInfo.name} conversation.`);
  }

  const preparedPrompt = await globalThis.LovaRPMLicense?.preparePrompt?.("main", payload);
  if (!preparedPrompt) throw new Error("The server did not prepare the operation.");
  const implementationPrompt = await withPrmV5ImplementationContext(preparedPrompt, payload);
  const prompt = withSkillInstructions(implementationPrompt, payload.skills);
  let sourceTab = null;
  let activatedChatForDispatch = false;

  try {
    if (Number.isInteger(sourceTabId)) {
      sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
    }

    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      activatedChatForDispatch = true;
      await sleepBackground(180);
    }

    const bridgeReady = await ensureProviderBridge(tab.id, provider);
    if (!bridgeReady) throw new Error(`The ${providerInfo.name} bridge did not respond after injection.`);

    const response = await sendPromptMessage(tab.id, prompt, provider);
    if (!response?.ok) {
      throw new Error(response?.error || `${providerInfo.name} did not confirm that the prompt was sent.`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failure = /license|protected features remain locked/i.test(detail)
      ? "LovaRPM license authorization failed"
      : `Could not activate the LovaRPM bridge in ${providerInfo.name}`;
    throw new Error(`${failure}: ${detail}`);
  } finally {
    if (
      activatedChatForDispatch &&
      sourceTab?.id &&
      sourceTab.id !== tab.id &&
      (sourceTab.url?.startsWith("https://lovable.dev/") || sourceTab.url?.startsWith("https://app.base44.com/apps/"))
    ) {
      await chrome.tabs.update(sourceTab.id, { active: true }).catch(() => {});
    }
  }

  return { tabId: tab.id, aiProvider: provider };
}

const PROJECT_RUN_STATUS_KEY = "projectRunStatuses";
const ACCESS_BOOTSTRAP_KEY = "accessBootstrapConversationsV219";

async function accessBootstrapState(projectId, provider = "chatgpt") {
  const id = String(projectId || "").trim();
  if (!id) return { required: false, key: "" };
  const stored = await chrome.storage.local.get(["projectChatBindings", ACCESS_BOOTSTRAP_KEY]);
  const record = stored.projectChatBindings?.[id];
  const conversation = globalThis.LovaRPMProviders.resolveConversation(record, provider);
  if (conversation && (conversation.aiProvider || "chatgpt") !== provider) return { required: true, key: "" };
  const identity = String(conversation?.id || conversationId || conversation?.url || (conversation?.tabId ? `tab-${conversation.tabId}` : "")).trim();
  if (!identity) return { required: true, key: "" };
  const key = `${id}::${identity}`;
  return { required: !Boolean(stored[ACCESS_BOOTSTRAP_KEY]?.[key]), key };
}

async function markAccessBootstrapComplete(key) {
  const id = String(key || "").trim();
  if (!id) return;
  const stored = await chrome.storage.local.get(ACCESS_BOOTSTRAP_KEY);
  const entries = stored[ACCESS_BOOTSTRAP_KEY] || {};
  await chrome.storage.local.set({
    [ACCESS_BOOTSTRAP_KEY]: {
      ...entries,
      [id]: { completedAt: new Date().toISOString() },
    },
  });
}

async function setProjectRunStatus(projectId, patch) {
  if (!projectId) return null;
  const stored = await chrome.storage.local.get(PROJECT_RUN_STATUS_KEY);
  const statuses = stored[PROJECT_RUN_STATUS_KEY] || {};
  const previous = statuses[projectId] || {};
  const next = {
    ...previous,
    ...patch,
    projectId,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({
    [PROJECT_RUN_STATUS_KEY]: {
      ...statuses,
      [projectId]: next,
    },
  });
  return next;
}

async function handleCapturedPrompt(message, sender) {
  const payload = message.payload;

  if (!payload?.text || typeof payload.text !== "string" || !payload.text.trim()) {
    return { ok: false, error: "Prompt is empty or invalid." };
  }

  let repository = payload.repository || "";
  let repositoryDetectionSource = payload.repositoryDetectionSource || "";
  let lovableProjectId = payload.lovableProjectId || "";
  const storedProvider = await chrome.storage.local.get("selectedAiProvider");
  const aiProvider = payload.aiProvider === "claude" || payload.aiProvider === "chatgpt"
    ? payload.aiProvider
    : storedProvider.selectedAiProvider === "claude" ? "claude" : "chatgpt";
  const platform = payload.platform === "base44" || message.source === "base44" ? "base44" : "lovable";

  const bindingStore = await chrome.storage.local.get("projectChatBindings");
  const projectBinding = bindingStore.projectChatBindings?.[lovableProjectId];
  const activeConversation = globalThis.LovaRPMProviders.resolveConversation(projectBinding, aiProvider);
  if (!activeConversation || (activeConversation.aiProvider || "chatgpt") !== aiProvider) {
    const providerName = globalThis.LovaRPMProviders?.[aiProvider]?.name || "AI provider";
    return { ok: false, error: `Connect a ${providerName} conversation to this project before sending.` };
  }

  if (!repository) {
    const workspace = await detectLovableWorkspace(sender?.tab?.id, {
      lovableProjectId,
      url: payload.url,
      domRepository: "",
    });
    repository = workspace.repository || "";
    repositoryDetectionSource = workspace.source || "none";
    lovableProjectId = workspace.lovableProjectId || lovableProjectId;
  }

  let fallbackSkills;
  if (!Object.prototype.hasOwnProperty.call(payload, "skills") && lovableProjectId) {
    const stored = await chrome.storage.local.get("projectSkillSelections");
    fallbackSkills = stored.projectSkillSelections?.[lovableProjectId];
  }

  const bootstrap = await accessBootstrapState(lovableProjectId, aiProvider);

  const pendingPrompt = {
    text: payload.text.trim(),
    url: payload.url || "",
    title: payload.title || "",
    capturedAt: payload.capturedAt || new Date().toISOString(),
    source: message.source || "lovable",
    platform,
    aiProvider,
    repository,
    repositoryDetectionSource,
    lovableProjectId,
    apiDiagnostics: Array.isArray(payload.apiDiagnostics) ? payload.apiDiagnostics.slice(-24) : [],
    skills: getPromptSkillIds(payload, fallbackSkills),
    accessBootstrap: bootstrap.required ? "REQUIRED" : "",
    accessBootstrapKey: bootstrap.key || "",
    status: "captured",
  };

  const workspaceKey = pendingPrompt.lovableProjectId || pendingPrompt.url;
  const storagePatch = { pendingPrompt };

  await setProjectRunStatus(pendingPrompt.lovableProjectId, {
    status: "sending",
    marker: "",
    objective: pendingPrompt.text.slice(0, 700),
    startedAt: pendingPrompt.capturedAt,
    dispatchedAt: "",
    completedAt: "",
    error: "",
    excerpt: "",
    repository: pendingPrompt.repository || "",
    aiProvider,
  });

  if (workspaceKey && pendingPrompt.repository) {
    const stored = await chrome.storage.local.get("workspaceBindings");
    storagePatch.workspaceBindings = {
      ...(stored.workspaceBindings || {}),
      [workspaceKey]: {
        repository: pendingPrompt.repository,
        detectedAt: new Date().toISOString(),
        source: pendingPrompt.repositoryDetectionSource || "captured",
      },
    };
  }

  await chrome.storage.local.set(storagePatch);

  try {
    const relay = await relayPromptToProvider(pendingPrompt, sender?.tab?.id);
    const dispatchedPrompt = {
      ...pendingPrompt,
      status: "dispatched",
      providerTabId: relay.tabId,
      ...(aiProvider === "chatgpt" ? { chatgptTabId: relay.tabId } : {}),
      dispatchedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ pendingPrompt: dispatchedPrompt });
    await setProjectRunStatus(pendingPrompt.lovableProjectId, {
      status: "working",
      marker: "",
      dispatchedAt: dispatchedPrompt.dispatchedAt,
      providerTabId: relay.tabId,
      ...(aiProvider === "chatgpt" ? { chatgptTabId: relay.tabId } : {}),
      aiProvider,
      error: "",
    });
    return {
      ok: true,
      status: "dispatched",
      providerTabId: relay.tabId,
      aiProvider,
      repository: pendingPrompt.repository,
      repositoryDetectionSource: pendingPrompt.repositoryDetectionSource,
    };
  } catch (error) {
    const failedPrompt = {
      ...pendingPrompt,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ pendingPrompt: failedPrompt });
    await setProjectRunStatus(pendingPrompt.lovableProjectId, {
      status: "error",
      marker: "[LOVABURST_ERROR]",
      error: failedPrompt.error,
      completedAt: failedPrompt.failedAt,
    });
    return { ok: false, error: failedPrompt.error };
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const link = await getStoredChatGptLink();
  if (link?.tabId === tabId) {
    await clearChatGptLink();
  }
  const stored = await chrome.storage.local.get("projectChatBindings");
  const bindings = stored.projectChatBindings || {};
  let changed = false;
  for (const record of Object.values(bindings)) {
    record.conversations = (record.conversations || []).map((conversation) => {
      if (conversation.tabId !== tabId) return conversation;
      changed = true;
      return { ...conversation, tabId: null, closedAt: new Date().toISOString() };
    });
  }
  if (changed) await chrome.storage.local.set({ projectChatBindings: bindings });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const link = await getStoredChatGptLink();
  if (link?.tabId === tabId && changeInfo.url && !changeInfo.url.startsWith("https://chatgpt.com/")) {
    await clearChatGptLink();
  } else if (link?.tabId === tabId && tab?.url?.startsWith("https://chatgpt.com/") && (changeInfo.url || changeInfo.title)) {
    await chrome.storage.local.set({
      chatgptLink: {
        ...link,
        url: tab.url,
        title: tab.title || link.title || "ChatGPT",
        updatedAt: new Date().toISOString(),
      },
    });
  }

  if (!changeInfo.url || !tab?.url) return;
  const storedBindings = await chrome.storage.local.get("projectChatBindings");
  const bindings = storedBindings.projectChatBindings || {};
  let changed = false;
  for (const record of Object.values(bindings)) {
    record.conversations = (record.conversations || []).map((conversation) => {
      const provider = conversation.aiProvider || "chatgpt";
      const providerInfo = globalThis.LovaRPMProviders?.[provider];
      if (conversation.tabId !== tabId || !providerInfo) return conversation;
      if (!tab.url.startsWith(`${providerInfo.origin}/`)) {
        changed = true;
        return { ...conversation, tabId: null, pendingNavigation: false, closedAt: new Date().toISOString() };
      }
      const isNew = isProviderNewUrl(provider, tab.url);
      if (!conversation.pendingNavigation) {
        const expectedUrl = conversation.lockedUrl || conversation.url || "";
        if (globalThis.LovaRPMProviders.sameConversation(provider, expectedUrl, tab.url)) {
          if (expectedUrl === tab.url && conversation.title === tab.title) return conversation;
          changed = true;
          return { ...conversation, url: tab.url, title: tab.title || conversation.title, lockedUrl: tab.url, lockedTitle: tab.title || conversation.lockedTitle };
        }
        return conversation;
      }
      if (isNew) return conversation;
      changed = true;
      return { ...conversation, url: tab.url, title: tab.title || conversation.title, lockedUrl: tab.url, lockedTitle: tab.title || conversation.lockedTitle, pendingNavigation: false };
    });
  }
  if (changed) await chrome.storage.local.set({ projectChatBindings: bindings });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "LOVABURST_RESULT_MARKER_DETECTED") {
    // Provider bridges persist project-scoped results; complete bootstrap only for its sender.
    const marker = String(message.marker || "");
    const projectId = String(message.projectId || "");
    const provider = message.source === "claude" ? "claude" : "chatgpt";
    if (marker === "[LOVABURST_DONE]" || marker === "[LOVARPM_DONE]") {
      chrome.storage.local.get("pendingPrompt")
        .then((stored) => {
          const prompt = stored.pendingPrompt;
          if (
            prompt?.accessBootstrapKey &&
            String(prompt?.lovableProjectId || "") === projectId &&
            (prompt?.aiProvider || "chatgpt") === provider
          ) {
            return markAccessBootstrapComplete(prompt.accessBootstrapKey);
          }
        })
        .catch(() => {});
    }
    sendResponse({
      ok: true,
      projectId,
      status: String(message.status || ""),
      marker,
    });
    return false;
  }


  if (!message || typeof message !== "object") return false;
  if (message.type === "LOVABURST_PREPARE_SPECIAL_OPERATION") {
    const operation = String(message.operation || "").trim();
    if (!["create-project", "analyze-project"].includes(operation)) { sendResponse({ ok: false, error: "Invalid operation." }); return false; }
    globalThis.LovaRPMLicense?.preparePrompt?.(operation, message.payload || {})
      .then((prompt) => sendResponse({ ok: true, prompt }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_GET_CONFIG") {
    getConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_SET_CONFIG") {
    setConfig(message.config ?? {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_LIST_CHATGPT_TABS") {
    listChatGptTabs()
      .then((tabs) => sendResponse({ ok: true, tabs }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_GET_CHATGPT_STATUS") {
    getChatGptStatus()
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_LINK_PROVIDER") {
    linkProviderTab(Number(message.tabId), message.provider === "claude" ? "claude" : "chatgpt")
      .then((link) => sendResponse({ ok: true, link }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_LINK_CHATGPT") {
    linkChatGptTab(Number(message.tabId))
      .then((link) => sendResponse({ ok: true, link }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_UNLINK_CHATGPT") {
    clearChatGptLink()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_OPEN_LINKED_CHATGPT") {
    getLinkedChatGptTab()
      .then(async (tab) => {
        if (!tab?.id) {
          sendResponse({ ok: false, error: "No ChatGPT conversation is linked." });
          return;
        }
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_DETECT_WORKSPACE") {
    detectLovableWorkspace(sender?.tab?.id, message.payload || {})
      .then((workspace) => sendResponse({ ok: true, ...workspace }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_PROMPT_CAPTURED") {
    handleCapturedPrompt(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_REFRESH_PROVIDER_RESULT") {
    const provider = message.provider === "claude" ? "claude" : "chatgpt";
    refreshProviderResult(String(message.projectId || ""), provider)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message.type === "LOVABURST_PING") {
    sendResponse({ ok: true, source: "background" });
  }

  return false;
});
