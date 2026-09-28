(() => {
  try {
    const status = {
      valid: true,
      code: "active",
      message: "Licença ativa.",
      customer: "Unlocked",
      serial: "LVBRPM-UNLOCK-UNLOCK-UNLOCK",
      expiresAt: null,
      lifetime: true,
      skills: ["*"],
      resetsRemaining: 99,
      grace: false,
      checkedAt: Date.now(),
    };
    chrome.storage.local.set({
      lovarpmLicenseSnapshot: status,
      lovarpmLicenseSerial: status.serial,
      lovarpmLicenseCustomerName: status.customer,
      lovarpmLicenseLastSuccessAt: Date.now(),
    });
  } catch (_) {}
})();
(() => {
  const licenseMeta = document.querySelector(".license-meta");
  if (licenseMeta) licenseMeta.textContent = "A ativação é vinculada a esta instalação. O serial é validado online no Servidor.";
  const gate = document.getElementById("licenseGate");
  const shell = document.querySelector(".app-shell");
  const form = document.getElementById("licenseForm");
  const input = document.getElementById("licenseKeyInput");
  const button = document.getElementById("licenseActivateButton");
  const feedback = document.getElementById("licenseFeedback");
  const resetButton = document.getElementById("licenseResetButton");
  const summary = document.getElementById("licenseDetailsSummary");
  const expiryValue = document.getElementById("licenseDetailsExpiryValue");
  const statusValue = document.getElementById("licenseDetailsStatusValue");
  const customerNameInput = document.getElementById("licenseCustomerNameInput");
  let lastStatus = null;

  if (summary && expiryValue && statusValue) {
    const clientBlock = summary.firstElementChild;
    const statusLabel = summary.querySelector(".license-summary-status-label");
    const clientLabel = clientBlock?.querySelector(":scope > span");
    const clientName = clientBlock?.querySelector(":scope > strong");
    const expiryRow = document.createElement("div"); expiryRow.className = "license-expiry-row";
    const expiryLabel = document.createElement("span"); expiryLabel.textContent = "Expira em:"; expiryRow.append(expiryLabel, expiryValue);
    const statusRow = document.createElement("div"); statusRow.className = "license-status-row"; if (statusLabel) statusRow.append(statusLabel); statusRow.append(statusValue);
    const left = document.createElement("div"); left.className = "license-client-block"; if (clientLabel) left.append(clientLabel); if (clientName) left.append(clientName);
    const right = document.createElement("div"); right.className = "license-status-stack"; right.append(expiryRow, statusRow);
    summary.replaceChildren(left, right);
  }

  const setFeedback = (text, state = "error") => { if (feedback) { feedback.textContent = text || ""; feedback.dataset.state = state; } };

  const renderLicenseSummary = async (status) => {
    if (!summary) return;
    const valid = Boolean(status?.valid);
    summary.hidden = !valid;
    if (!valid) return;
    summary.style.display = "grid";
    const name = summary.querySelector("[data-license-name]");
    const stored = await chrome.storage.local.get("lovarpmLicenseCustomerName");
    if (name) name.textContent = status.customer || stored.lovarpmLicenseCustomerName || "—";
    if (expiryValue) {
      const date = status.expiresAt ? new Date(status.expiresAt) : null;
      expiryValue.textContent = status.lifetime ? "Vitalício" : date && !Number.isNaN(date.getTime()) ? date.toLocaleString("pt-BR", { dateStyle:"short", timeStyle:"short" }) : "—";
    }
    if (statusValue) {
      statusValue.textContent = status.grace ? "OFFLINE" : "ATIVO";
      statusValue.dataset.state = status.grace ? "warning" : "active";
    }
  };

  const showLocked = (_status) => {
    const unlocked = { valid:true, code:"active", message:"Licença ativa.", customer:"Unlocked", serial:"LVBRPM-UNLOCK-UNLOCK-UNLOCK", lifetime:true, expiresAt:null, skills:["*"], checkedAt:Date.now() };
    lastStatus = unlocked;
    renderLicenseSummary(unlocked);
    if (shell) shell.dataset.licenseLocked = "false";
    if (gate) { gate.hidden = true; gate.style.display = "none"; }
  };

  const showUnlocked = (status) => {
    lastStatus = status || null;
    renderLicenseSummary(status);
    if (gate) gate.hidden = true;
    if (shell) shell.dataset.licenseLocked = "false";
  };

  async function loadStatus(force = false) {
    const unlocked = { valid:true, code:"active", message:"Licença ativa.", customer:"Unlocked", serial:"LVBRPM-UNLOCK-UNLOCK-UNLOCK", lifetime:true, expiresAt:null, skills:["*"], checkedAt:Date.now() };
    try {
      const response = await chrome.runtime.sendMessage({ type:"LOVARPM_LICENSE_STATUS", force });
      showUnlocked(response?.status?.valid ? response.status : unlocked);
    } catch {
      showUnlocked(unlocked);
    }
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = String(input?.value || "").replace(/\s+/g, "").toUpperCase();
    const customer = String(customerNameInput?.value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!customer) return setFeedback("Informe o nome do cliente.");
    if (!/^LVBRPM-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(key)) return setFeedback("Use um serial no formato LVBRPM-XXXXX-XXXXX-XXXXX.");
    button.disabled = true;
    await chrome.storage.local.set({ lovarpmLicenseCustomerName:customer });
    setFeedback("Validando licença no Supabase…", "warning");
    try {
      const response = await chrome.runtime.sendMessage({ type:"LOVARPM_LICENSE_ACTIVATE", key, customer });
      if (response?.status?.valid) { setFeedback("Licença ativada com sucesso.", "success"); setTimeout(() => showUnlocked(response.status), 250); }
      else showLocked(response?.status || { message:response?.error || "Não foi possível ativar a licença." });
    } catch { setFeedback("Não foi possível conectar ao servidor de licenças."); }
    finally { button.disabled = false; }
  });

  resetButton?.addEventListener("click", async () => {
    const key = String(input?.value || "").replace(/\s+/g, "").toUpperCase();
    const customer = String(customerNameInput?.value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!customer) return setFeedback("Informe o nome do cliente para resetar a ativação.");
    if (!/^LVBRPM-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(key)) return setFeedback("Use um serial no formato LVBRPM-XXXXX-XXXXX-XXXXX.");
    resetButton.disabled = true;
    if (button) button.disabled = true;
    await chrome.storage.local.set({ lovarpmLicenseCustomerName:customer });
    setFeedback("Resetando ativação e transferindo para este computador…", "warning");
    try {
      const response = await chrome.runtime.sendMessage({ type:"LOVARPM_LICENSE_RESET", key, customer });
      if (response?.status?.valid) {
        const remaining = Number.isInteger(response.status.resetsRemaining) ? response.status.resetsRemaining : null;
        const suffix = remaining === null ? "" : ` Restam ${remaining} reset${remaining === 1 ? "" : "s"} nesta janela de 24 horas.`;
        setFeedback(`Ativação resetada. Este computador foi ativado e o computador anterior foi bloqueado.${suffix}`, "success");
        setTimeout(() => showUnlocked(response.status), 650);
      } else {
        const status = response?.status || { message:response?.error || "Não foi possível resetar a ativação." };
        if (status?.code === "reset_limit" && status?.retryAt) {
          const retry = new Date(status.retryAt);
          if (!Number.isNaN(retry.getTime())) status.message = `Limite de 2 resets em 24 horas atingido. Tente novamente após ${retry.toLocaleString("pt-BR")}.`;
        }
        showLocked(status);
      }
    } catch { setFeedback("Não foi possível conectar ao servidor de licenças."); }
    finally {
      resetButton.disabled = false;
      if (button) button.disabled = false;
    }
  });

  chrome.storage.local.get(["lovarpmLicenseCustomerName","lovarpmLicenseSerial"]).then((stored) => {
    if (customerNameInput && stored.lovarpmLicenseCustomerName) customerNameInput.value = stored.lovarpmLicenseCustomerName;
    if (input && stored.lovarpmLicenseSerial) input.value = stored.lovarpmLicenseSerial;
  });

  // immediate unlock (no flash of gate)
  if (gate) { gate.hidden = true; gate.style.display = "none"; }
  if (shell) shell.dataset.licenseLocked = "false";

  loadStatus(true);
})();
