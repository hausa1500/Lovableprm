(() => {
  if (globalThis.LovaRPMProviders) return;

  globalThis.LovaRPMProviders = Object.freeze({
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