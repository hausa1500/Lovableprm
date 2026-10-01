(() => {
  if (globalThis.LovaRPMProviders) return;

  function conversationKey(provider, value) {
    try {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      const route = provider === "chatgpt" ? "c" : "chat";
      const routeIndex = parts.lastIndexOf(route);
      if (url.hostname !== (provider === "chatgpt" ? "chatgpt.com" : "claude.ai") || routeIndex < 0 || !parts[routeIndex + 1]) return "";
      return `${provider}:${parts[routeIndex + 1]}`;
    } catch {
      return "";
    }
  }

  function sameConversation(provider, left, right) {
    const leftKey = conversationKey(provider, left);
    const rightKey = conversationKey(provider, right);
    if (leftKey || rightKey) return Boolean(leftKey && leftKey === rightKey);
    try {
      const a = new URL(left);
      const b = new URL(right);
      return a.origin === b.origin &&
        a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "") &&
        a.search === b.search &&
        a.hash === b.hash;
    } catch {
      return false;
    }
  }

  function resolveConversation(record, provider) {
    if (!record || !["chatgpt", "claude"].includes(provider)) return null;
    const conversations = Array.isArray(record.conversations) ? record.conversations : [];
    const isProviderConversation = (conversation) => (conversation?.aiProvider || "chatgpt") === provider;
    const byId = (id) => conversations.find((conversation) => conversation.id === id && isProviderConversation(conversation)) || null;
    const providerActive = byId(record.activeConversationIds?.[provider]);
    if (providerActive) return providerActive;
    const legacyActive = byId(record.activeConversationId);
    if (legacyActive) return legacyActive;
    return conversations
      .filter(isProviderConversation)
      .sort((left, right) => {
        const leftDate = Date.parse(left.linkedAt || left.createdAt || "") || 0;
        const rightDate = Date.parse(right.linkedAt || right.createdAt || "") || 0;
        return rightDate - leftDate;
      })[0] || null;
  }

  globalThis.LovaRPMProviders = Object.freeze({
    conversationKey,
    sameConversation,
    resolveConversation,
    chatgpt: Object.freeze({
      id: "chatgpt",
      name: "ChatGPT",
      origin: "https://chatgpt.com",
      homeUrl: "https://chatgpt.com/",
      newUrl: "https://chatgpt.com/",
      patterns: ["https://chatgpt.com/*"],
      bridgeFile: "src/content/chatgpt.js",
      pingSource: "chatgpt",
      submitMessage: "LOVABURST_SUBMIT_TO_CHATGPT",
      linkMessage: "LOVABURST_LINK_CHATGPT",
      enabledConfigKey: "chatgptEnabled",
    }),
    claude: Object.freeze({
      id: "claude",
      name: "Claude",
      origin: "https://claude.ai",
      homeUrl: "https://claude.ai/",
      newUrl: "https://claude.ai/new",
      patterns: ["https://claude.ai/*"],
      bridgeFile: "src/content/claude.js",
      pingSource: "claude",
      submitMessage: "LOVABURST_SUBMIT_TO_CLAUDE",
      linkMessage: "LOVABURST_LINK_CLAUDE",
      enabledConfigKey: "claudeEnabled",
    }),
  });
})();