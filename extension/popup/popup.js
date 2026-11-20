"use strict";

const $ = (id) => document.getElementById(id);
let state = null;
let currentHost = null;

const STATUS = {
  off: ["Выключен", ""],
  connecting: ["Подключение…", "connecting"],
  on: ["Подключено", "on"],
  error: ["Ошибка", "error"],
};

function render() {
  const { settings, runtime } = state;
  $("toggle").checked = settings.enabled;
  const key = settings.enabled ? runtime.status : "off";
  const [label, cls] = STATUS[key] || STATUS.off;
  $("statusText").textContent = label;
  $("dot").className = "dot " + cls;
  let sub = "";
  if (key === "error") sub = runtime.error || "";
  else if (key === "on") sub = "Только трафик Firefox · SOCKS5 127.0.0.1:" + settings.port;
  else if (!settings.profileId) sub = "Добавьте сервер в настройках";
  $("statusSub").textContent = sub;

  $("profile").value = settings.profileId || "";
  $("mode").value = settings.mode;

  const m = runtime.metrics;
  $("stats").hidden = !(key === "on" && m);
  if (m) {
    $("hs").textContent = fmtAgo(m.handshake);
    $("rx").textContent = fmtBytes(m.rx);
    $("tx").textContent = fmtBytes(m.tx);
  }
  renderSite();
}

function renderSite() {
  if (!currentHost || !state) return;
  const { settings } = state;
  const local = AWGRules.isLocal(currentHost);
  const tunneled = AWGRules.shouldTunnel(currentHost, settings);
  $("siteBox").hidden = false;
  $("siteHost").textContent = currentHost;
  $("siteHost").title = currentHost;
  const route = $("siteRoute");
  route.textContent = !settings.enabled ? "VPN выключен" : tunneled ? "через VPN" : "напрямую";
  route.className = "pill" + (settings.enabled && tunneled ? " vpn" : "");

  const btn = $("siteBtn");
  const site = AWGRules.siteOf(currentHost);
  btn.disabled = local;
  if (local) {
    btn.textContent = "Локальный адрес — всегда напрямую";
    btn.dataset.action = "";
  } else if (settings.mode === "include") {
    const inList = AWGRules.matchesList(currentHost, settings.includeList);
    btn.textContent = inList ? "Убрать " + site + " из списка VPN" : "Пускать " + site + " через VPN";
    btn.dataset.action = inList ? "include:remove" : "include:add";
  } else {
    const inList = AWGRules.matchesList(currentHost, settings.excludeList);
    btn.textContent = inList ? "Вернуть " + site + " в VPN" : "Открывать " + site + " напрямую";
    btn.dataset.action = inList ? "exclude:remove" : "exclude:add";
  }
}

async function loadProfiles() {
  const sel = $("profile");
  sel.textContent = "";
  try {
    const { profiles } = await api("listProfiles");
    if (!profiles.length) {
      sel.append(new Option("— нет серверов —", ""));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    if (!state.settings.profileId) sel.append(new Option("— выберите —", ""));
    for (const p of profiles) sel.append(new Option(p.name + (p.endpoint ? " · " + p.endpoint : ""), p.id));
    sel.value = state.settings.profileId || "";
  } catch (e) {
    sel.append(new Option("— помощник недоступен —", ""));
    sel.disabled = true;
    Toast.error(e.message);
  }
}

async function refresh() {
  state = await api("getState");
  render();
}

$("toggle").addEventListener("change", async (e) => {
  const value = e.target.checked;
  try {
    state = await api("setEnabled", { value });
    render();
    if (value && state.runtime.status === "on") Toast.ok("VPN включён");
    else if (value && state.runtime.status === "error") Toast.error(state.runtime.error);
    else if (!value) Toast.ok("VPN выключен");
  } catch (err) {
    Toast.error(err.message);
    refresh();
  }
});

$("profile").addEventListener("change", async (e) => {
  try {
    state = await api("setSettings", { patch: { profileId: e.target.value || null } });
    render();
    if (state.settings.enabled && state.runtime.status === "error") Toast.error(state.runtime.error);
    else Toast.ok("Сервер выбран");
  } catch (err) {
    Toast.error(err.message);
  }
});

$("mode").addEventListener("change", async (e) => {
  try {
    state = await api("setSettings", { patch: { mode: e.target.value } });
    render();
    Toast.ok("Режим сохранён");
  } catch (err) {
    Toast.error(err.message);
  }
});

$("siteBtn").addEventListener("click", async (e) => {
  const [list, op] = (e.target.dataset.action || "").split(":");
  if (!list) return;
  try {
    await api("editList", { list, host: AWGRules.siteOf(currentHost), add: op === "add" });
    await refresh();
    Toast.ok("Список обновлён. Перезагрузите вкладку, чтобы применить.");
  } catch (err) {
    Toast.error(err.message);
  }
});

$("ipBtn").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    const { ip, viaVpn } = await api("checkIp");
    Toast.ok("Внешний IP: " + ip + (viaVpn ? " (через VPN)" : " (напрямую)"));
  } catch (err) {
    Toast.error("Не удалось проверить IP: " + err.message);
  } finally {
    e.target.disabled = false;
  }
});

$("optBtn").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "stateChanged") refresh();
});

(async () => {
  try {
    await refresh();
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^(https?|wss?):/.test(tab.url)) {
      currentHost = new URL(tab.url).hostname;
      renderSite();
    }
    await loadProfiles();
    if (state.settings.enabled) {
      state = await api("refresh");
      render();
    }
  } catch (e) {
    Toast.error(e.message);
  }
})();
