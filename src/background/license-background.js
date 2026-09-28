const INSTALLATION_ID_KEY = "lovarpmInstallationId";
const SERIAL_KEY = "lovarpmLicenseSerial";
const CUSTOMER_KEY = "lovarpmLicenseCustomerName";
const SNAPSHOT_KEY = "lovarpmLicenseSnapshot";
const LAST_SUCCESS_KEY = "lovarpmLicenseLastSuccessAt";

function unlockedSnapshot() {
  return {
    valid: true,
    code: "active",
    message: "License active.",
    customer: "Unlocked",
    serial: "LVBRPM-UNLOCK-UNLOCK-UNLOCK",
    expiresAt: null,
    lifetime: true,
    deviceId: null,
    skills: ["*"],
    resetsRemaining: 99,
    retryAt: null,
    grace: false,
    checkedAt: Date.now(),
  };
}

async function getInstallationId() {
  const stored = await chrome.storage.local.get([INSTALLATION_ID_KEY, "lovaburstInstallationId"]);
  if (stored[INSTALLATION_ID_KEY]) return stored[INSTALLATION_ID_KEY];
  if (stored.lovaburstInstallationId) {
    await chrome.storage.local.set({ [INSTALLATION_ID_KEY]: stored.lovaburstInstallationId });
    return stored.lovaburstInstallationId;
  }
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALLATION_ID_KEY]: id });
  return id;
}

async function ensureUnlocked() {
  const status = unlockedSnapshot();
  await chrome.storage.local.set({
    [SNAPSHOT_KEY]: status,
    [SERIAL_KEY]: status.serial,
    [CUSTOMER_KEY]: status.customer,
    [LAST_SUCCESS_KEY]: Date.now(),
  });
  return status;
}

async function getLicenseStatus() {
  return ensureUnlocked();
}

async function activateLicense() {
  return ensureUnlocked();
}

async function transferLicense() {
  return ensureUnlocked();
}

async function authorizeOperation() {
  return { ok: true, status: await ensureUnlocked() };
}

async function preparePrompt(operation, payload = {}) {
  if (typeof payload === "string") return payload;
  const text =
    payload.text ||
    payload.prompt ||
    payload.message ||
    payload.content ||
    payload.objective ||
    payload.preparedPrompt ||
    payload.finalPrompt ||
    "";
  return text ? String(text) : "";
}

async function requireUntamperedRuntime() { return true; }

globalThis.LovaRPMLicense = {
  getLicenseStatus,
  activateLicense,
  transferLicense,
  authorizeOperation,
  ensureUnlocked,
  preparePrompt,
  requireUntamperedRuntime,
};

chrome.runtime.onInstalled.addListener(() => { ensureUnlocked().catch(() => {}); });
chrome.runtime.onStartup?.addListener?.(() => { ensureUnlocked().catch(() => {}); });
ensureUnlocked().catch(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;
  const t = message.type;
  if (t === "LOVABURST_LICENSE_STATUS" || t === "LOVARPM_LICENSE_STATUS") {
    getLicenseStatus().then((status) => sendResponse({ ok: true, status })).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }
  if (t === "LOVABURST_LICENSE_ACTIVATE" || t === "LOVARPM_LICENSE_ACTIVATE") {
    activateLicense().then((status) => sendResponse({ ok: true, status })).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }
  if (
    t === "LOVARPM_LICENSE_TRANSFER" ||
    t === "LOVARPM_LICENSE_RESET" ||
    t === "LOVABURST_LICENSE_TRANSFER" ||
    t === "LOVABURST_LICENSE_RESET"
  ) {
    transferLicense().then((status) => sendResponse({ ok: true, status })).catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }
  return false;
});
