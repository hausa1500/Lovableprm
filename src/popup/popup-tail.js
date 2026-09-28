"use strict";

function activeBuilderName() { return workspace.platform === "base44" ? "Base44" : "Lovable"; }
function activeBuilderPattern() { return workspace.platform === "base44" ? "https://app.base44.com/apps/*" : "https://lovable.dev/*"; }
function activeBuilderPrefix() { return workspace.platform === "base44" ? "https://app.base44.com/apps/" : "https://lovable.dev/"; }

function formatStatusTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

async function refreshRunStatus() {
  const projectId = workspace.lovableProjectId;
  if (!projectId) {
    ui.runStatusMain.dataset.status = "idle";
    ui.runStatusIcon.textContent = "◌";
    ui.runStatusTitle.textContent = "Nenhum projeto selecionado";
    ui.runStatusText.textContent = `Abra um projeto do ${activeBuilderName()} para acompanhar as solicitações.`;
    ui.runStatusTime.textContent = "";
    ui.runStatusLoader.hidden = true;
    ui.runObjective.hidden = true;
    if (ui.runResponseMirror) ui.runResponseMirror.hidden = true;
    return;
  }

  const stored = await chrome.storage.local.get("projectRunStatuses");
  const status = stored.projectRunStatuses?.[projectId] || null;

  if (!status) {
    ui.runStatusMain.dataset.status = "idle";
    ui.runStatusIcon.textContent = "◌";
    ui.runStatusTitle.textContent = "Nenhuma solicitação enviada ainda";
    ui.runStatusText.textContent = "Quando você enviar um comando, o andamento aparecerá aqui.";
    ui.runStatusTime.textContent = "";
    ui.runStatusLoader.hidden = true;
    ui.runObjective.hidden = true;
    if (ui.runResponseMirror) ui.runResponseMirror.hidden = true;
    return;
  }

  const states = {
    sending: { icon: "↗", title: "Enviando para o ChatGPT…", text: "Preparando o projeto, repositório e contexto da solicitação.", loading: true },
    working: { icon: "✦", title: "ChatGPT trabalhando…", text: "Acompanhe abaixo a resposta visível conforme ela aparece no ChatGPT.", loading: true },
    done: { icon: "✓", title: "Concluído", text: "O ChatGPT terminou esta solicitação com sucesso.", loading: false },
    blocked: { icon: "!", title: "Ação necessária", text: "O ChatGPT encontrou um bloqueio e precisa da sua atenção.", loading: false },
    error: { icon: "×", title: "Erro na execução", text: status.error || "Não foi possível concluir esta solicitação.", loading: false },
  };

  const state = states[status.status] || { icon: "◌", title: "Aguardando", text: "A solicitação está sendo preparada.", loading: false };
  ui.runStatusMain.dataset.status = status.status || "idle";
  ui.runStatusIcon.textContent = state.icon;
  ui.runStatusTitle.textContent = state.title;
  ui.runStatusText.textContent = state.text;
  ui.runStatusLoader.hidden = !state.loading;
  ui.runStatusTime.textContent = formatStatusTime(status.completedAt || status.detectedAt || status.dispatchedAt || status.startedAt || status.updatedAt);
  if (ui.runResponseMirror && ui.runResponseBody && ui.runResponseState) {
    const liveResponse = String(status.liveResponse || "").trim();
    const terminal = ["done", "blocked", "error"].includes(status.status);
    const showMirror = Boolean(liveResponse) && (status.status === "working" || terminal);
    ui.runResponseMirror.hidden = !showMirror;
    ui.runResponseMirror.dataset.state = terminal ? "done" : "live";
    ui.runResponseState.textContent = terminal ? "Resposta concluída" : "Atualizando em tempo real";
    if (showMirror && ui.runResponseBody.textContent !== liveResponse) {
      ui.runResponseBody.textContent = liveResponse;
      ui.runResponseBody.scrollTop = ui.runResponseBody.scrollHeight;
    }
  }
  if (ui.runObjective) {
    ui.runObjective.hidden = true;
    ui.runObjective.textContent = "";
  }
}

async function refreshChat() {
  if (refreshingChat) return;
  refreshingChat = true;
  try {
    let rec = await record(workspace.lovableProjectId);
    rec = await restoreActiveConversation(rec);
    const conversation = active(rec);
    const tab = conversation ? await resolveTab(conversation) : null;
    const hasProject = Boolean(workspace.lovableProjectId);
    const connected = Boolean(conversation);
    const available = Boolean(tab);
    ui.setupCard.hidden = !hasProject || connected;
    ui.connectedCard.hidden = !hasProject || !connected;
    if (!hasProject) return;
    if (connected) {
      ui.chatState.textContent = available ? "Conversa travada" : "Conversa travada · abra a conversa correta";
      ui.memoryState.textContent = conversation.lockedTitle || conversation.title || "Conversa exclusiva deste projeto";
    } else {
      const tabs = await chatTabs();
      ui.help.textContent = tabs.length ? "Encontramos uma conversa aberta. Você pode usá-la ou criar uma nova." : "Abra o ChatGPT em uma aba ou crie uma nova conversa por aqui.";
    }
  } finally { refreshingChat = false; }
}

async function refreshRepository() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !workspace.lovableProjectId || !tab.url?.startsWith(activeBuilderPrefix())) return;
  renderWorkspace({ ...workspace, detecting: true });
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "LOVABURST_FORCE_REPOSITORY_REFRESH" });
    renderWorkspace({ repository: response?.repository || "", lovableProjectId: response?.lovableProjectId || workspace.lovableProjectId, sourceTitle: tab.title || "", sourceUrl: tab.url || "", platform: workspace.platform });
  } catch { await refreshWorkspace(); }
}

function waitForTabComplete(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    timeout = setTimeout(finish, timeoutMs);
  });
}

async function reloadLovableAndExtensionUi() {
  if (!ui.refreshRepo || ui.refreshRepo.disabled) return;
  ui.refreshRepo.disabled = true;
  ui.refreshRepo.dataset.loading = "true";
  ui.refreshRepo.title = `Recarregando ${activeBuilderName()} e LovaRPM…`;

  try {
    const tabs = await chrome.tabs.query({ url: [activeBuilderPattern()] });
    const tab = tabs.find((item) => workspace.lovableProjectId && item.url?.includes(workspace.lovableProjectId)) || tabs.find((item) => item.active) || tabs[0];
    if (!tab?.id) throw new Error(`Não encontrei uma aba do ${activeBuilderName()} para recarregar.`);

    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id);
    window.location.reload();
  } catch (error) {
    ui.refreshRepo.disabled = false;
    delete ui.refreshRepo.dataset.loading;
    ui.refreshRepo.title = "Atualizar workspace e integrações";
    showFeedback(error?.message || `Não foi possível recarregar o ${activeBuilderName()} e a LovaRPM.`);
  }
}

function showFeedback(message, tone = "") {
  const text = String(message || "");
  if (!tone) {
    if (/erro|falha|não foi possível|não encontrei|inválid|indisponível|permissão|conecte este projeto/i.test(text)) tone = "error";
    else if (/enviado|iniciad|aprimorado|atualizados|removida|sucesso|concluíd/i.test(text)) tone = "success";
    else tone = "info";
  }
  ui.feedback.hidden = false; ui.feedback.textContent = text; ui.feedback.dataset.tone = tone;
}
async function chooseChatTab() {
  const tabs = await chatTabs();
  if (!tabs.length) throw new Error("Nenhuma conversa do ChatGPT está aberta. Abra uma aba do ChatGPT ou crie uma nova conversa.");

  const projectId = workspace.lovableProjectId;
  const all = await bindings();
  const ownership = new Map();
  for (const [ownerProjectId, rec] of Object.entries(all)) {
    for (const item of rec?.conversations || []) {
      const lockedUrl = String(item.lockedUrl || item.url || "").trim();
      if (lockedUrl && lockedUrl !== "https://chatgpt.com/") ownership.set(lockedUrl, ownerProjectId);
    }
  }

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "lb-chat-picker";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = '<section class="lb-chat-picker-panel"><header><div><span>// CHATGPT</span><strong>Trocar conversa</strong><p>Escolha qual conversa ficará exclusiva deste projeto.</p></div><button type="button" data-close aria-label="Fechar">×</button></header><div class="lb-chat-picker-list"></div><button type="button" class="lb-chat-picker-cancel" data-close>Cancelar</button></section>';

    const list = overlay.querySelector(".lb-chat-picker-list");
    for (const tab of tabs) {
      const ownerProjectId = ownership.get(tab.url) || "";
      const unavailable = Boolean(ownerProjectId && ownerProjectId !== projectId);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lb-chat-picker-option";
      button.disabled = unavailable;

      const title = document.createElement("strong");
      title.textContent = tab.title || "ChatGPT";
      const url = document.createElement("span");
      url.textContent = tab.url === "https://chatgpt.com/" ? "Nova conversa ainda sem URL própria" : tab.url;
      const state = document.createElement("small");
      state.textContent = unavailable ? "Exclusiva de outro projeto" : (tab.active ? "Aba ativa" : "Disponível");
      button.append(title, url, state);
      if (!unavailable) button.addEventListener("click", () => { overlay.remove(); resolve(tab); });
      list.append(button);
    }

    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(null);
    };
    overlay.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", cancel));
    overlay.addEventListener("click", (event) => { if (event.target === overlay) cancel(); });
    document.body.append(overlay);
  });
}

async function useOpenConversation() {
  if (!workspace.lovableProjectId) throw new Error(`Abra um projeto do ${activeBuilderName()} primeiro.`);
  const selected = await chooseChatTab();
  if (!selected?.tabId) return false;
  await linkTab(selected.tabId);
  return true;
}
async function openActiveConversation() {
  const rec = await record(workspace.lovableProjectId); const conversation = active(rec); if (!conversation) return;
  let tab = await resolveTab(conversation);
  if (!tab && conversation.url?.startsWith("https://chatgpt.com/")) {
    tab = await chrome.tabs.create({ url: conversation.url, active: true });
    await update(workspace.lovableProjectId, (current) => ({ ...current, conversations: current.conversations.map((item) => item.id === conversation.id ? { ...item, tabId: tab.id, url: tab.url || item.url, closedAt: "" } : item) }));
  }
  if (tab?.id) { await activateRelay(tab.id); await chrome.tabs.update(tab.id, { active: true }); }
}

function renderSendButton(sending = false) {
  ui.sendCommand.innerHTML = sending
    ? '<span class="send-mark" aria-hidden="true">◌</span><b>Enviando…</b><span class="send-arrow" aria-hidden="true">→</span>'
    : '<span class="send-mark" aria-hidden="true">✦</span><b>Enviar</b><span class="send-arrow" aria-hidden="true">➜</span>';
}

async function sendCommand() {
  if (globalThis.__LOVABURST_POPUP_ATTACHMENTS__?.hasFiles?.()) return;
  const objective = ui.commandInput.value.trim();
  if (!objective) { ui.commandInput.focus(); showFeedback("Digite o que você quer alterar."); return; }
  if (!workspace.lovableProjectId) { showFeedback(`Abra o projeto do ${activeBuilderName()} que você quer alterar.`); return; }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(workspace.repository || "").trim())) {
    showFeedback("Conecte este projeto ao GitHub para enviar solicitações pela LovaRPM.", "error");
    return;
  }
  let rec = await record(workspace.lovableProjectId);
  if (!active(rec)) { showFeedback("Conecte uma conversa do ChatGPT antes de enviar."); ui.setupCard.hidden = false; return; }
  ui.sendCommand.disabled = true;
  renderSendButton(true);
  try {
    const tabs = await chrome.tabs.query({ url: [activeBuilderPattern()] });
    const source = tabs.find((tab) => tab.url?.includes(workspace.lovableProjectId)) || tabs[0];
    if (!source?.id) throw new Error(`Não encontrei a aba deste projeto no ${activeBuilderName()}.`);
    const skills = await selectedSkills();
    const response = await chrome.tabs.sendMessage(source.id, { type: "LOVABURST_SUBMIT_OBJECTIVE", objective, skills });
    if (!response?.ok) throw new Error(response?.error || "Não foi possível enviar.");
    await update(workspace.lovableProjectId, (current) => {
      const previous = current.recentObjectives?.[current.recentObjectives.length - 1];
      const repeated = previous && String(previous.text || "") === objective && Date.now() - new Date(previous.createdAt || 0).getTime() < 30000;
      return repeated ? current : { ...current, recentObjectives: [...(current.recentObjectives || []), { text: objective, createdAt: now() }].slice(-50) };
    });
    ui.commandInput.value = ""; updateCounter(); ui.commandInput.dispatchEvent(new Event("input", { bubbles: true })); showFeedback("Enviado ao ChatGPT."); await refreshRunStatus();
  } catch (error) {
    const message = error?.message || String(error);
    showFeedback(/github|repositório|repository|sem github|não conectado/i.test(message)
      ? "Conecte este projeto ao GitHub para enviar solicitações pela LovaRPM."
      : message, /github|repositório|repository|sem github|não conectado/i.test(message) ? "error" : "");
  }
  finally { ui.sendCommand.disabled = false; renderSendButton(false); await refreshChat(); }
}

function updateCounter() { ui.commandCounter.textContent = ""; }

async function checkForBrowserManagedUpdate({ announce = false } = {}) {
  const version = chrome.runtime.getManifest().version; ui.version.classList.add("checking");
  try {
    if (typeof chrome.runtime.requestUpdateCheck !== "function") { if (announce) showFeedback(`Você está na LovaRPM v${version}. Atualizações automáticas ficarão disponíveis quando a extensão estiver no canal oficial.`); return; }
    const result = await chrome.runtime.requestUpdateCheck(); const status = typeof result === "string" ? result : result?.status; const versionAvailable = typeof result === "object" ? result?.version : "";
    if (status === "update_available") { ui.version.classList.add("update"); ui.updateBanner.hidden = false; ui.updateTitle.textContent = versionAvailable ? `LovaRPM v${versionAvailable} disponível` : "Nova versão disponível"; ui.updateText.textContent = "O Chrome encontrou uma atualização oficial. Ela será aplicada pelo próprio navegador."; return; }
    ui.version.classList.remove("update"); ui.updateBanner.hidden = true;
    if (announce) showFeedback(status === "throttled" ? `LovaRPM v${version}. O Chrome limitou uma nova verificação agora.` : `LovaRPM v${version}. Nenhuma atualização gerenciada pelo Chrome foi encontrada.`);
  } catch { if (announce) showFeedback(`LovaRPM v${version}. Nesta instalação beta por pasta/ZIP, a atualização continua sendo manual.`); }
  finally { ui.version.classList.remove("checking"); }
}

async function findCurrentLovableTab() {
  const tabs = await chrome.tabs.query({ url: [activeBuilderPattern()] });
  return tabs.find((tab) => workspace.lovableProjectId && tab.url?.includes(workspace.lovableProjectId))
    || tabs.find((tab) => tab.active)
    || tabs[0]
    || null;
}

const HIDE_LOVABLE_BADGE_OBJECTIVE = `Adicione a seguinte regra ao arquivo src/index.css para ocultar o badge do Lovable em toda a aplicação:

/* Hide Lovable badge */
#lovable-badge {
  display: none !important;
}`;

async function hideLovableBadge() {
  if (workspace.platform === "base44") throw new Error("A remoção da marca da plataforma continua disponível somente para projetos Lovable.");
  if (!workspace.lovableProjectId) throw new Error("Abra um projeto do Lovable antes de remover a marca d’água.");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(workspace.repository || "").trim())) {
    throw new Error("Conecte este projeto ao GitHub antes de remover a marca d’água.");
  }
  const rec = await record(workspace.lovableProjectId);
  if (!active(rec)) throw new Error("Conecte uma conversa do ChatGPT antes de remover a marca d’água.");
  const tab = await findCurrentLovableTab();
  if (!tab?.id) throw new Error("Abra um projeto do Lovable antes de remover a marca d’água.");
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "LOVABURST_SUBMIT_OBJECTIVE",
    objective: HIDE_LOVABLE_BADGE_OBJECTIVE,
    skills: [],
  });
  if (!response?.ok) throw new Error(response?.error || "Não foi possível enviar a remoção da marca d’água.");
  showFeedback("Comando para remover a marca d’água enviado ao ChatGPT.");
}

async function downloadCurrentProject() {
  const repository = String(workspace.repository || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Abra um projeto conectado ao GitHub antes de baixar.");
  }
  const [owner, name] = repository.split("/");
  await chrome.downloads.download({
    url: `https://github.com/${owner}/${name}/archive/refs/heads/main.zip`,
    filename: `${name}-main.zip`,
    saveAs: true,
    conflictAction: "uniquify",
  });
  showFeedback("Download do projeto iniciado.");
}

async function renderConfig(config) { ui.enabled.checked = Boolean(config.enabled); ui.sendCommand.disabled = !config.enabled; }
ui.enabled.addEventListener("change", async () => { const config = await getConfig(); await renderConfig(await setConfig({ ...config, enabled: ui.enabled.checked })); });
ui.refreshRepo.addEventListener("click", (event) => { event.preventDefault(); event.stopImmediatePropagation(); void reloadLovableAndExtensionUi(); }, true);
ui.useOpen.addEventListener("click", async () => { ui.useOpen.disabled = true; ui.help.textContent = "Escolha a conversa que será exclusiva deste projeto."; try { const changed = await useOpenConversation(); if (changed) await refreshChat(); } catch (error) { ui.help.textContent = error?.message || String(error); } finally { ui.useOpen.disabled = false; } });
ui.create.addEventListener("click", async () => { ui.create.disabled = true; ui.help.textContent = "Criando e preparando a conversa…"; try { await newConversation(); await refreshChat(); } catch (error) { ui.help.textContent = error?.message || String(error); } finally { ui.create.disabled = false; } });
ui.open.addEventListener("click", async () => { try { await openActiveConversation(); } catch (error) { showFeedback(error?.message || String(error)); } });
ui.compactNew.addEventListener("click", async () => { ui.compactNew.disabled = true; try { await newConversation(); await refreshChat(); } catch (error) { showFeedback(error?.message || String(error)); } finally { ui.compactNew.disabled = false; } });
ui.useAnother.addEventListener("click", async () => {
  ui.useAnother.disabled = true;
  try {
    const changed = await useOpenConversation();
    if (changed) {
      await refreshChat();
      showFeedback("Conversa selecionada e travada exclusivamente para este projeto.", "success");
    }
  } catch (error) { showFeedback(error?.message || String(error)); }
  finally { ui.useAnother.disabled = false; }
});
ui.commandInput.addEventListener("input", updateCounter);
ui.commandInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  ui.sendCommand.click();
});
ui.sendCommand.addEventListener("click", () => void sendCommand());
ui.version.addEventListener("click", () => void checkForBrowserManagedUpdate({ announce: true })); ui.footerVersion.addEventListener("click", () => void checkForBrowserManagedUpdate({ announce: true }));
const commandsTabButton = document.createElement("button");
commandsTabButton.className = "tab";
commandsTabButton.id = "commandsTabButton";
commandsTabButton.dataset.tab = "commands";
commandsTabButton.type = "button";
commandsTabButton.innerHTML = '<span class="tab-icon">⌘</span> Comandos';
ui.skillsTab?.before(commandsTabButton);

const commandsPanel = document.createElement("div");
commandsPanel.className = "tab-panel";
commandsPanel.id = "commandsPanel";
commandsPanel.innerHTML = '<section class="commands-hero"><div class="commands-orb">⌘</div><div><span>// COMANDOS PRONTOS</span><h2>Escolha o que deseja fazer.</h2><p>Ao clicar, o comando completo será colocado no campo de prompt para você revisar e enviar.</p></div></section><section class="commands-grid" id="commandsGrid"><button class="command-preset-card" data-command-file="corrigir" data-command-title="CORRIGIR" type="button"><span>FIX</span><div><strong>CORRIGIR</strong><small>Auditoria completa e correção de bugs.</small></div><b>→</b></button><button class="command-preset-card" data-command-file="melhorar" data-command-title="MELHORAR" type="button"><span>UX</span><div><strong>MELHORAR</strong><small>Melhoria profunda da interface e experiência.</small></div><b>→</b></button><button class="command-preset-card" data-command-file="otimizar" data-command-title="OTIMIZAR" type="button"><span>OPT</span><div><strong>OTIMIZAR</strong><small>Otimização completa do projeto.</small></div><b>→</b></button><button class="command-preset-card" data-command-file="refatorar" data-command-title="REFATORAR" type="button"><span>REF</span><div><strong>REFATORAR</strong><small>Revisão e refatoração ampla do código.</small></div><b>→</b></button><button class="command-preset-card" data-command-file="responsivo" data-command-title="RESPONSIVO" type="button"><span>RWD</span><div><strong>RESPONSIVO</strong><small>Adaptação completa para todos os dispositivos.</small></div><b>→</b></button><button class="command-preset-card" data-command-file="seguranca" data-command-title="SEGURANÇA" type="button"><span>SEC</span><div><strong>SEGURANÇA</strong><small>Auditoria de segurança e banco de dados.</small></div><b>→</b></button></section><div class="commands-feedback" id="commandsFeedback" role="status" aria-live="polite">Selecione um comando para prepará-lo no prompt.</div>';
const extraCommands = [
  ["futurista-uma-cor", "FUTURISTA UMA COR", "3D", "FUTURISTA — UMA COR", "Sidebar futurista e 3D com uma identidade cromática predominante."],
  ["botoes-coloridos", "BOTÕES COLORIDOS", "RGB", "BOTÕES COM CORES DIFERENTES", "Sidebar futurista com uma cor vibrante e distinta em cada botão."],
];
const commandsGrid = commandsPanel.querySelector("#commandsGrid");
for (const [file, title, icon, name, description] of extraCommands) {
  const card = document.createElement("button");
  card.className = "command-preset-card";
  card.dataset.commandFile = file;
  card.dataset.commandTitle = title;
  card.type = "button";
  card.innerHTML = `<span>${icon}</span><div><strong>${name}</strong><small>${description}</small></div><b>→</b>`;
  commandsGrid.append(card);
}
ui.skillsPanel?.before(commandsPanel);

ui.chatTab?.addEventListener("click", () => setTab("chat")); commandsTabButton.addEventListener("click", () => setTab("commands")); ui.skillsTab?.addEventListener("click", () => setTab("skills")); ui.historyTab?.addEventListener("click", () => setTab("history"));
document.querySelectorAll("[data-command-file]").forEach((card) => {
  card.addEventListener("click", async () => {
    const feedback = document.getElementById("commandsFeedback");
    const cards = [...document.querySelectorAll("[data-command-file]")];
    cards.forEach((item) => { item.disabled = true; });
    feedback.textContent = "Carregando comando…";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "LOVARPM_COMMAND_GET",
        commandId: card.dataset.commandFile,
      });
      if (!response?.ok) throw new Error(response?.error || "Comando não autorizado.");
      const prompt = String(response.command?.prompt || "").trim();
      if (!prompt) throw new Error("O comando selecionado está vazio.");
      ui.commandInput.value = prompt;
      ui.commandInput.dispatchEvent(new Event("input", { bubbles: true }));
      setTab("chat");
      ui.commandInput.focus();
      ui.commandInput.setSelectionRange(0, 0);
      ui.commandInput.scrollTop = 0;
      showFeedback(`Comando ${card.dataset.commandTitle} pronto para revisar e enviar.`, "success");
    } catch (error) {
      feedback.textContent = error?.message || "Não foi possível carregar o comando.";
    } finally {
      cards.forEach((item) => { item.disabled = false; });
    }
  });
});
document.getElementById("chatConnectedCard")?.querySelector(".connected-main")?.addEventListener("click", () => { const card = document.getElementById("chatConnectedCard"); if (card) card.dataset.actionsOpen = card.dataset.actionsOpen === "true" ? "false" : "true"; });
const additionalSkills = [
  ["accessibility-wcag", "A11Y", "Accessibility (WCAG)", "WCAG 2.1 AA, semântica, teclado, contraste e ARIA."],
  ["agent-ui-design", "AGENT", "Agent UI Design", "Interfaces completas para agentes, chat e ferramentas."],
  ["ai-design-workflow", "AI", "AI Design Workflow", "IA no processo de design com validação humana."],
  ["audit-code-quality", "CODE", "Audit Code Quality", "Qualidade estrutural, duplicação e manutenção do código."],
  ["audit-cost-explosion", "COST", "Audit Cost Explosion", "Riscos de custos em APIs, banco, uploads e funções."],
  ["audit-legal-risks", "LAW", "Audit Legal Risks", "Privacidade, termos, LGPD/GDPR e propriedade intelectual."],
  ["audit-monitoring-recovery", "OPS", "Audit Monitoring & Recovery", "Observabilidade, erros, uptime, backups e recuperação."],
  ["audit-secrets-data-leaks", "LEAK", "Audit Secrets & Data Leaks", "Segredos expostos, RLS, Storage e dados sensíveis."],
  ["audit-unauthorized-access", "AUTH", "Audit Unauthorized Access", "Autenticação, autorização, IDOR e validação de acesso."],
  ["branding-identity", "BRAND", "Branding & Identity", "Marca, identidade visual e consistência corporativa."],
  ["cloud-migration", "CLOUD", "Cloud Migration", "Migração completa do Supabase Cloud e seus serviços."],
  ["color-theory", "COLOR", "Color Theory", "Cores, contraste, tokens, harmonias e dark mode."],
  ["component-patterns", "COMP", "Component Patterns", "Arquitetura moderna, composição, tokens e variantes."],
  ["customer-journey", "CX", "Customer Journey", "Jornada, touchpoints, emoções, personas e retenção."],
  ["design-process", "FLOW", "Design Process", "Processo completo do briefing ao handoff."],
  ["design-system-pro", "DS", "Design System Pro", "Design system completo e justificado para o projeto."],
  ["ux-design", "UX", "UX Design", "Estratégia, pesquisa, personas, fluxos e leis essenciais de UX."],
  ["vibe-security-check", "VSEC", "Vibe Security Check", "Auditoria OWASP, correção de vulnerabilidades e relatório."],
  ["visual-direction", "ART", "Visual Direction", "Direção visual, paletas, tipografia, layouts e imagens."],
  ["web-typography", "TYPE", "Web Typography", "Escala, hierarquia, legibilidade e carregamento de fontes."],
  ["webdesign-review", "REVIEW", "Webdesign Review", "Revisão completa e coordenada das áreas de web design."],
  ["website-audit-relaunch", "RELAUNCH", "Website Audit & Relaunch", "Auditoria técnica, UX, conteúdo, SEO e conversão."],
  ["design-trends-2026", "2026", "Design Trends 2026", "Motion, tipografia expressiva, dark mode e storytelling."],
  ["images-media", "MEDIA", "Images & Media", "Seleção, otimização, acessibilidade e performance de mídia."],
  ["landing-pages", "LAND", "Landing Pages", "Estrutura, copy, CTA e testes orientados à conversão."],
  ["navigation-design", "NAV", "Navigation Design", "Menus, breadcrumbs, busca e navegação mobile e desktop."],
  ["responsive-design", "RWD", "Responsive Design", "Layout mobile-first, grids fluidos e interação por toque."],
  ["ui-design", "UI", "UI Design", "Grid, espaçamento, hierarquia, tokens e consistência visual."],
  ["ui-patterns", "PAT", "UI Patterns", "Padrões prontos para heróis, cards, formulários, preços e CTAs."],
  ["usability", "USE", "Usability", "Heurísticas de Nielsen, ISO 9241 e redução de fricção."],
];
const skillsGrid = document.getElementById("skillsGrid");
if (skillsGrid) {
  const divider = document.createElement("div");
  divider.className = "skill-library-divider";
  divider.innerHTML = "<span>NOVAS SKILLS</span><small>Especialistas adicionais para o workflow</small>";
  skillsGrid.append(divider);
  for (const [id, icon, name, description] of additionalSkills) {
    const card = document.createElement("button");
    card.className = "skill-card";
    card.dataset.skill = id;
    card.type = "button";
    card.innerHTML = `<span>${icon}</span><div><strong>${name}</strong><small>${description}</small></div><i></i>`;
    skillsGrid.append(card);
  }
}
document.querySelectorAll("[data-skill]").forEach((card) => { card.addEventListener("click", async () => { if (!workspace.lovableProjectId) { showFeedback(`Abra um projeto do ${activeBuilderName()} antes de selecionar Skills.`); return; } const ids = await selectedSkills(); const id = card.dataset.skill; const next = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]; await saveSelectedSkills(next); await renderSkills(); }); });
ui.platformButtons.forEach((button) => button.addEventListener("click", async () => {
  await selectPlatform(button.dataset.platform);
  await refreshWorkspace();
  await refreshChat();
  await refreshRunStatus();
}));
ui.clearSkills?.addEventListener("click", async () => { await saveSelectedSkills([]); await renderSkills(); });
ui.refreshData?.addEventListener("click", async () => { await refreshRepository(); await refreshChat(); await refreshRunStatus(); await renderSkills(); showFeedback("Dados atualizados."); });
ui.settings?.addEventListener("click", () => showFeedback("Ajustes avançados entram na camada comercial da LovaRPM."));
ui.hideBadge?.addEventListener("click", async () => {
  ui.hideBadge.disabled = true;
  try { await hideLovableBadge(); } catch (error) { showFeedback(error?.message || String(error)); }
  finally { ui.hideBadge.disabled = false; }
});
ui.downloadProject?.addEventListener("click", async () => {
  ui.downloadProject.disabled = true;
  try { await downloadCurrentProject(); } catch (error) { showFeedback(error?.message || String(error)); }
  finally { ui.downloadProject.disabled = false; }
});
const footerIcons = { refreshDataButton: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4"/></svg>', hideLovableBadgeButton: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.6 5.4L20 11l-5.4 2.6L12 19l-2.6-5.4L4 11l5.4-2.6L12 3Z"/></svg>', downloadProjectButton: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>', settingsButton: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="m19.4 15 .1.1-1.7 2.9-.2-.1-2.1-1.2a7.4 7.4 0 0 1-1.6.9L13.6 20H10.4l-.3-2.4a7.4 7.4 0 0 1-1.6-.9l-2.1 1.2-.2.1-1.7-2.9.1-.1 2-1.4a7.2 7.2 0 0 1 0-1.8l-2-1.4-.1-.1 1.7-2.9.2.1 2.1 1.2a7.4 7.4 0 0 1 1.6-.9l.3-2.4h3.2l.3 2.4a7.4 7.4 0 0 1 1.6.9l2.1-1.2.2.1 1.7 2.9-.1.1-2 1.4a7.2 7.2 0 0 1 0 1.8l2 1.4Z"/></svg>' };
for (const [id, icon] of Object.entries(footerIcons)) { const button = document.getElementById(id); if (button) { const label = button.textContent.replace(/^[^\p{L}\p{N}]+/u, "").trim(); button.innerHTML = `${icon}<span>${label}</span>`; button.classList.add("lb-footer-control"); } }
chrome.tabs.onRemoved.addListener(async (tabId) => { const all = await bindings(); let changed = false; for (const rec of Object.values(all)) for (const item of rec?.conversations || []) if (item.tabId === tabId) { item.tabId = null; item.closedAt = now(); changed = true; } if (changed) await save(all); await refreshChat(); });
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
  // A conversa vinculada é uma identidade imutável. Navegar para outro chat na
  // mesma aba física nunca pode reescrever URL/título do vínculo salvo.
  if (changeInfo.url || changeInfo.status === "complete" || changeInfo.title) {
    await refreshWorkspace();
    await refreshChat();
  }
});
chrome.tabs.onActivated.addListener(async () => { await refreshWorkspace(); await refreshChat(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area !== "local") return; if (changes.config?.newValue) void renderConfig(changes.config.newValue); if (changes.workspaceBindings || changes.pendingPrompt) void refreshWorkspace(); if (changes.projectChatBindings) void refreshChat(); if (changes.projectRunStatuses) void refreshRunStatus(); if (changes.projectSkillSelections) void renderSkills(); });
window.setInterval(() => void refreshWorkspace(), 900); window.setInterval(() => void refreshChat(), 1800);
(async () => { const version = chrome.runtime.getManifest().version; ui.versionText.textContent = `v${version}`; ui.footerVersion.textContent = `LovaRPM v${version}`; updateCounter(); renderSendButton(false); await selectPlatform(await selectedPlatform()); await renderConfig(await getConfig()); await refreshWorkspace(); await refreshChat(); await refreshRunStatus(); await checkForBrowserManagedUpdate(); })();
