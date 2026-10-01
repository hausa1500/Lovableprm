"use strict";

(() => {
  const BUTTON_ID = "useAnotherChatButton";
  const BINDINGS_KEY = "projectChatBindings";

  const now = () => new Date().toISOString();
  const makeId = () => crypto.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const selectedProvider = async () => (await chrome.storage.local.get("selectedAiProvider")).selectedAiProvider === "claude" ? "claude" : "chatgpt";
  const isNewProviderUrl = (provider, url) => {
    const config = globalThis.LovaRPMProviders?.[provider] || globalThis.LovaRPMProviders?.chatgpt;
    try {
      const parsed = new URL(url);
      return parsed.origin === config.origin && (parsed.pathname === "/" || parsed.pathname === "/new");
    } catch {
      return false;
    }
  };

  function currentProjectId() {
    const value = String(document.getElementById("projectValue")?.textContent || "").trim();
    return value && value !== "—" ? value : "";
  }

  async function chatTabs(provider) {
    provider = provider || await selectedProvider();
    const config = globalThis.LovaRPMProviders?.[provider];
    const tabs = await chrome.tabs.query({ url: config.patterns });
    return tabs
      .filter((tab) => Number.isInteger(tab.id))
      .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
  }

  async function bindings() {
    return (await chrome.storage.local.get(BINDINGS_KEY))[BINDINGS_KEY] || {};
  }

  async function saveBindings(value) {
    await chrome.storage.local.set({ [BINDINGS_KEY]: value });
  }

  async function ensureBridge(tabId, provider) {
    provider = provider || await selectedProvider();
    const config = globalThis.LovaRPMProviders?.[provider];
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
      if (ping?.ok && ping.source === config.pingSource) return true;
    } catch {}
    await chrome.scripting.executeScript({ target: { tabId }, files: [config.bridgeFile] });
    const ping = await chrome.tabs.sendMessage(tabId, { type: "LOVABURST_CONTENT_PING" });
    return Boolean(ping?.ok && ping.source === config.pingSource);
  }

  async function activateRelay(tabId, provider) {
    provider = provider || await selectedProvider();
    const response = await chrome.runtime.sendMessage({ type: "LOVABURST_LINK_PROVIDER", provider, tabId });
    if (!response?.ok) throw new Error(response?.error || "Could not activate this conversation.");
  }

  function closePicker(result, resolve, overlay) {
    overlay.remove();
    resolve(result);
  }

  async function chooseChatTab(projectId, provider) {
    provider = provider || await selectedProvider();
    const config = globalThis.LovaRPMProviders?.[provider];
    const tabs = await chatTabs(provider);
    if (!tabs.length) throw new Error(`No ${config.name} conversations are open.`);

    const all = await bindings();
    const ownership = new Map();
    for (const [ownerProjectId, rec] of Object.entries(all)) {
      for (const item of rec?.conversations || []) {
        const lockedUrl = String(item.lockedUrl || item.url || "").trim();
        if ((item.aiProvider || "chatgpt") === provider && lockedUrl && !isNewProviderUrl(provider, lockedUrl)) ownership.set(lockedUrl, ownerProjectId);
      }
    }

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "lb-chat-picker";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.innerHTML = `<section class="lb-chat-picker-panel"><header><div><span>// ${config.name.toUpperCase()}</span><strong>Switch conversation</strong><p>Choose the conversation to reserve for this project.</p></div><button type="button" data-close aria-label="Close">×</button></header><div class="lb-chat-picker-list"></div><button type="button" class="lb-chat-picker-cancel" data-close>Cancel</button></section>`;

      const list = overlay.querySelector(".lb-chat-picker-list");
      for (const tab of tabs) {
        const ownerProjectId = ownership.get(tab.url || "") || "";
        const unavailable = Boolean(ownerProjectId && ownerProjectId !== projectId);
        const option = document.createElement("button");
        option.type = "button";
        option.className = "lb-chat-picker-option";
        option.disabled = unavailable;

        const title = document.createElement("strong");
        title.textContent = tab.title || config.name;
        const url = document.createElement("span");
        url.textContent = isNewProviderUrl(provider, tab.url) ? "New conversation without its own URL yet" : String(tab.url || "");
        const state = document.createElement("small");
        state.textContent = unavailable ? "Reserved for another project" : (tab.active ? "Active tab" : "Available");
        option.append(title, url, state);

        if (!unavailable) option.addEventListener("click", () => closePicker(tab, resolve, overlay));
        list.append(option);
      }

      overlay.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closePicker(null, resolve, overlay)));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closePicker(null, resolve, overlay);
      });
      document.body.append(overlay);
    });
  }

  async function bindSelectedConversation(projectId, tab, provider) {
    provider = provider || await selectedProvider();
    const config = globalThis.LovaRPMProviders?.[provider];
    if (!tab?.id || !tab.url?.startsWith(`${config.origin}/`)) throw new Error("Invalid conversation.");

    const all = await bindings();
    for (const [ownerProjectId, rec] of Object.entries(all)) {
      if (ownerProjectId === projectId) continue;
      const used = (rec?.conversations || []).some((item) => {
        if ((item.aiProvider || "chatgpt") !== provider) return false;
        if (item.tabId === tab.id) return true;
        const lockedUrl = String(item.lockedUrl || item.url || "");
        return !isNewProviderUrl(provider, lockedUrl) && lockedUrl === tab.url;
      });
      if (used) throw new Error("This conversation is already reserved for another project.");
    }

    if (!(await ensureBridge(tab.id, provider))) throw new Error(`The LovaRPM bridge did not respond in this ${config.name} conversation.`);

    const rec = all[projectId] || {
      projectId,
      repository: "",
      sourceTitle: "",
      sourceUrl: "",
      activeConversationId: "",
      activeConversationIds: {},
      conversations: [],
      recentObjectives: [],
    };

    const conversations = Array.isArray(rec.conversations) ? [...rec.conversations] : [];
    let linked = conversations.find((item) => {
      if ((item.aiProvider || "chatgpt") !== provider) return false;
      if (item.tabId === tab.id) return true;
      const lockedUrl = String(item.lockedUrl || item.url || "");
      return !isNewProviderUrl(provider, tab.url) && lockedUrl === tab.url;
    });

    if (!linked) {
      linked = {
        id: makeId(),
        aiProvider: provider,
        tabId: tab.id,
        url: tab.url,
        title: tab.title || config.name,
        lockedUrl: isNewProviderUrl(provider, tab.url) ? "" : tab.url,
        lockedTitle: tab.title || config.name,
        pendingNavigation: isNewProviderUrl(provider, tab.url),
        createdAt: now(),
        linkedAt: now(),
        contextSentAt: "",
      };
      conversations.push(linked);
    } else {
      linked = {
        ...linked,
        aiProvider: provider,
        tabId: tab.id,
        url: tab.url,
        title: tab.title || linked.title || config.name,
        lockedUrl: isNewProviderUrl(provider, tab.url) ? "" : tab.url,
        lockedTitle: tab.title || linked.lockedTitle || linked.title || config.name,
        pendingNavigation: isNewProviderUrl(provider, tab.url),
        linkedAt: now(),
        closedAt: "",
      };
      conversations[conversations.findIndex((item) => item.id === linked.id)] = linked;
    }

    all[projectId] = {
      ...rec,
      activeConversationId: linked.id,
      activeConversationIds: { ...(rec.activeConversationIds || {}), [provider]: linked.id },
      conversations: conversations.slice(-12),
      updatedAt: now(),
    };
    await saveBindings(all);
    await activateRelay(tab.id, provider);
  }

  async function handleSwitch(button) {
    const projectId = currentProjectId();
    if (!projectId) throw new Error(`Open a ${globalThis.workspace?.platform === "base44" ? "Base44" : "Lovable"} project first.`);
    const provider = await selectedProvider();
    button.disabled = true;
    try {
      const selected = await chooseChatTab(projectId, provider);
      if (!selected) return;
      await bindSelectedConversation(projectId, selected, provider);
      if (typeof refreshChat === "function") await refreshChat();
      if (typeof showFeedback === "function") showFeedback("Conversation selected and locked exclusively to this project.", "success");
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.(`#${BUTTON_ID}`);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void handleSwitch(button).catch((error) => {
      if (typeof showFeedback === "function") showFeedback(error instanceof Error ? error.message : String(error), "error");
    });
  }, true);
})();
