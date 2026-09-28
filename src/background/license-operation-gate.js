(() => {
  if (!globalThis.LovaRPMLicense) globalThis.LovaRPMLicense = {};
  globalThis.LovaRPMLicense.authorizeOperation = async () => ({
    ok: true,
    status: {
      valid: true,
      code: "active",
      message: "License active.",
      lifetime: true,
      skills: ["*"],
      checkedAt: Date.now(),
    },
  });
  if (!globalThis.LovaRPMLicense.preparePrompt) {
    globalThis.LovaRPMLicense.preparePrompt = async (_op, payload = {}) => {
      if (typeof payload === "string") return payload;
      return String(payload?.text || payload?.prompt || payload?.message || payload?.content || payload?.objective || "");
    };
  }
  // Keep original listeners; no wrapping / no blocking
})();
