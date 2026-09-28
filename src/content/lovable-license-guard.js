(() => {
  if (globalThis.__LOVABURST_LICENSE_GUARD_0318__) return;
  globalThis.__LOVABURST_LICENSE_GUARD_0318__ = true;
  const HOST_ID = "lovaburst-composer-ui";
  const STATUS_KEY = "happyLittleLicenseStatus";
  let currentStatus = null;
  let expiryTimer = null;

  const apply = () => {
    const host = document.getElementById(HOST_ID);
    if (!host) return false;
    const valid = currentStatus?.valid === true && currentStatus?.code === "active";
    host.style.display = valid ? "" : "none";
    host.dataset.lovaburstLicense = valid ? "valid" : "locked";
    return true;
  };

  const setStatus = (status) => {
    currentStatus = status || null;
    clearTimeout(expiryTimer);
    apply();
    const checkedAt = Number(currentStatus?.checkedAt);
    const remainingMs = Number(currentStatus?.remainingMs);
    if (currentStatus?.valid === true && Number.isFinite(checkedAt) && Number.isFinite(remainingMs)) {
      const age = Math.max(0, Date.now() - checkedAt);
      expiryTimer = setTimeout(() => {
        currentStatus = { valid:false, code:"expired" };
        apply();
        refreshStatus();
      }, Math.max(0, remainingMs - age));
    }
  };

  async function refreshStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ type:"LOVARPM_LICENSE_STATUS" });
      setStatus(response?.status);
    } catch {
      setStatus(null);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STATUS_KEY]) setStatus(changes[STATUS_KEY].newValue);
  });
  const observer = new MutationObserver(() => {
    if (document.getElementById(HOST_ID)) apply();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  apply();
  refreshStatus();
})();
