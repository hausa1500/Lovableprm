const API_URL = "https://happy-little101.lovable.app/api/public/v1/licenses";
const PRODUCT_IDENTIFIER = "browser-extension-core";
const LICENSE_KEY = "happyLittleLicenseKey";
const DEVICE_ID_KEY = "happyLittleDeviceId";
const STATUS_KEY = "happyLittleLicenseStatus";
const LEGACY_KEYS = [
  "lovarpmLicenseSnapshot",
  "lovarpmLicenseSerial",
  "lovarpmLicenseLastSuccessAt",
  "lovarpmInstallationId",
  "lovaburstInstallationId",
  "lovarpmLicenseCustomerName",
];

const STATUS_MESSAGES = {
  unlicensed: "Enter a Happy Little license key to activate LovaRPM.",
  invalid: "This license key is invalid for LovaRPM.",
  expired: "This license has expired.",
  revoked: "This license has been revoked.",
  device_mismatch: "This license is not active on this device. Reactivate it or ask the issuer to reset its device.",
  device_limit_reached: "This license has reached its device limit. Ask the issuer to reset a device.",
  deactivated: "This device has been deactivated.",
  rate_limited: "The license service is temporarily rate-limiting checks. Try again shortly.",
  unavailable: "The license service is unavailable. Protected features remain locked.",
  provider_error: "Could not verify the license with Happy Little. Protected features remain locked.",
  unknown_status: "The license service returned an unrecognized result. Protected features remain locked.",
};

function statusRecord(code, details = {}) {
  return {
    valid: false,
    code,
    message: STATUS_MESSAGES[code] || STATUS_MESSAGES.unknown_status,
    checkedAt: Date.now(),
    ...details,
  };
}

async function saveStatus(status) {
  await chrome.storage.local.set({ [STATUS_KEY]: status });
  return status;
}

function statusFromResult(result) {
  return result.status.valid ? { ...result.status, remainingMs: result.remainingMs } : result.status;
}

async function deviceIdentifier() {
  const stored = await chrome.storage.local.get(DEVICE_ID_KEY);
  if (typeof stored[DEVICE_ID_KEY] === "string" && stored[DEVICE_ID_KEY].length >= 8) {
    return stored[DEVICE_ID_KEY];
  }
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
  return id;
}

async function providerOperation(operation, licenseKey) {
  const deviceId = await deviceIdentifier();
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation,
        licenseKey,
        productIdentifier: PRODUCT_IDENTIFIER,
        deviceIdentifier: deviceId,
      }),
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    let body;
    try {
      body = await response.json();
    } catch {
      return { status: statusRecord("provider_error") };
    }

    const code = typeof body?.status === "string" ? body.status : "unknown_status";
    if (body?.valid === true && code === "active" && response.ok) {
      const expiresAt = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
      const serverDate = Date.parse(response.headers.get("Date") || "");
      const elapsed = performance.now() - startedAt;
      const remainingMs = expiresAt - serverDate - elapsed - 1000;
      if (!Number.isFinite(expiresAt) || !Number.isFinite(serverDate)) {
        return { status: statusRecord("provider_error") };
      }
      if (remainingMs <= 0) {
        return { status: statusRecord("expired", { expiresAt: body.expiresAt || null }) };
      }
      return {
        status: {
          valid: true,
          code: "active",
          message: "License active.",
          expiresAt: body.expiresAt,
          checkedAt: Date.now(),
        },
        remainingMs,
      };
    }

    if (["invalid", "expired", "revoked", "device_mismatch", "device_limit_reached", "deactivated", "rate_limited", "unavailable"].includes(code)) {
      return { status: statusRecord(code, { expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null }) };
    }
    return { status: statusRecord("unknown_status") };
  } catch {
    return { status: statusRecord("unavailable") };
  } finally {
    clearTimeout(timeout);
  }
}

async function getLicenseStatus() {
  const stored = await chrome.storage.local.get(LICENSE_KEY);
  const key = typeof stored[LICENSE_KEY] === "string" ? stored[LICENSE_KEY] : "";
  if (!key) return saveStatus(statusRecord("unlicensed"));
  const result = await providerOperation("check", key);
  return saveStatus(statusFromResult(result));
}

async function activateLicense(rawKey) {
  const licenseKey = String(rawKey || "").trim().toUpperCase();
  if (!licenseKey || licenseKey.length < 16 || licenseKey.length > 100) {
    return saveStatus(statusRecord("invalid"));
  }

  await chrome.storage.local.remove(LICENSE_KEY);
  const result = await providerOperation("activate", licenseKey);
  if (result.status.valid) await chrome.storage.local.set({ [LICENSE_KEY]: licenseKey });
  return saveStatus(statusFromResult(result));
}

async function deactivateLicense() {
  const stored = await chrome.storage.local.get(LICENSE_KEY);
  const key = typeof stored[LICENSE_KEY] === "string" ? stored[LICENSE_KEY] : "";
  if (!key) return saveStatus(statusRecord("unlicensed"));
  const result = await providerOperation("deactivate", key);
  return saveStatus(result.status.code === "deactivated" ? statusRecord("deactivated") : result.status);
}

async function authorizeOperation() {
  const stored = await chrome.storage.local.get(LICENSE_KEY);
  const key = typeof stored[LICENSE_KEY] === "string" ? stored[LICENSE_KEY] : "";
  if (!key) {
    const status = await saveStatus(statusRecord("unlicensed"));
    return { ok: false, status };
  }
  const result = await providerOperation("check", key);
  const status = await saveStatus(statusFromResult(result));
  return status.valid ? { ok: true, status, remainingMs: result.remainingMs } : { ok: false, status };
}

async function preparePrompt(_operation, payload = {}) {
  if (typeof payload === "string") return payload;
  const text = payload.text || payload.prompt || payload.message || payload.content || payload.objective || payload.preparedPrompt || payload.finalPrompt || "";
  return text ? String(text) : "";
}

globalThis.LovaRPMLicense = {
  getLicenseStatus,
  activateLicense,
  deactivateLicense,
  authorizeOperation,
  preparePrompt,
};

chrome.storage.local.remove(LEGACY_KEYS).catch(() => {});
chrome.runtime.onInstalled.addListener(() => { getLicenseStatus().catch(() => {}); });
chrome.runtime.onStartup?.addListener?.(() => { getLicenseStatus().catch(() => {}); });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  const type = message.type;
  const reply = (promise) => promise
    .then((status) => sendResponse({ ok: true, status }))
    .catch(async () => {
      const status = statusRecord("provider_error");
      await saveStatus(status).catch(() => {});
      sendResponse({ ok: false, status });
    });

  if (type === "LOVARPM_LICENSE_STATUS" || type === "LOVABURST_LICENSE_STATUS") {
    reply(getLicenseStatus());
    return true;
  }
  if (type === "LOVARPM_LICENSE_ACTIVATE" || type === "LOVABURST_LICENSE_ACTIVATE") {
    reply(activateLicense(message.key));
    return true;
  }
  if (type === "LOVARPM_LICENSE_DEACTIVATE") {
    reply(deactivateLicense());
    return true;
  }
  if (type === "LOVARPM_LICENSE_AUTHORIZE") {
    authorizeOperation().then(sendResponse).catch(async () => {
      const status = statusRecord("provider_error");
      await saveStatus(status).catch(() => {});
      sendResponse({ ok: false, status });
    });
    return true;
  }
  return false;
});
