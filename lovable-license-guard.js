(() => {
  if (globalThis.__LOVABURST_LICENSE_GUARD_0318__) return;
  globalThis.__LOVABURST_LICENSE_GUARD_0318__ = true;
  const HOST_ID = "lovaburst-composer-ui";
  const apply = (valid) => {
    const host = document.getElementById(HOST_ID);
    if (!host) return false;
    host.style.display = valid ? "" : "none";
    host.dataset.lovaburstLicense = valid ? "valid" : "locked";
    return true;
  };
  const sync = async () => {
    if (!apply(true)) setTimeout(() => apply(true), 800);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.lovarpmLicenseSnapshot || changes.lovarpmLicenseSerial)) sync();
  });
  const observer = new MutationObserver(() => {
    if (document.getElementById(HOST_ID)) sync();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  sync();
})();
