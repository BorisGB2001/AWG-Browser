"use strict";

const $ = (id) => document.getElementById(id);
let state = null;

// ------------------------------------------------------------------ helper status

async function ping() {
  const box = $("hostInfo");
  try {
    const r = await api("ping");
    box.textContent = "";
    const ok = document.createElement("div");
    ok.innerHTML = '<b style="color:var(--ok)">✓ Помощник подключён</b>';
    const meta = document.createElement("div");
    meta.className = "muted small";
    meta.textContent =
      "host " + r.version + " · " + (r.wireproxy ? r.wireproxy : "wireproxy-awg НЕ найден") + " · данные: " + r.dataDir;
    box.append(ok, meta);
    return true;
  } catch (e) {
    box.textContent = "";
    const err = document.createElement("div");
    err.innerHTML = '<b style="color:var(--err)">✗ Помощник не найден</b>';
    const hint = document.createElement("div");
    hint.className = "muted small";
    hint.textContent = "Установите помощник (Windows: install.cmd из архива; macOS/Linux: scripts/install.sh) и перезапустите Firefox.";
    box.append(err, hint);
    return false;
  }
}

// ------------------------------------------------------------------ profiles

async function loadProfiles() {
  const root = $("profiles");
  root.textContent = "";
  let profiles = [];
  try {
    ({ profiles } = await api("listProfiles"));
  } catch (e) {
    root.innerHTML = '<div class="empty">Список недоступен: помощник не отвечает.</div>';
    return;
  }
  if (!profiles.length) {
    root.innerHTML = '<div class="empty">Серверов пока нет — добавьте конфиг ниже.</div>';
    $("importBox").open = true;
    return;
  }
  for (const p of profiles) {
    const row = document.createElement("div");
    row.className = "profile" + (p.id === state.settings.profileId ? " active" : "");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "profile";
    radio.checked = p.id === state.settings.profileId;
    radio.title = "Использовать этот сервер";
    radio.addEventListener("change", () => selectProfile(p.id));

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = p.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = p.error
      ? "Ошибка: " + p.error
      : [p.endpoint, p.protocol, "адрес " + p.address].filter(Boolean).join(" · ");
    info.append(name, meta);

    const btns = document.createElement("div");
    btns.className = "btns";
    const ren = document.createElement("button");
    ren.type = "button";
    ren.textContent = "Переименовать";
    ren.addEventListener("click", () => renameProfile(p));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Удалить";
    del.addEventListener("click", () => deleteProfile(p));
    btns.append(ren, del);

    row.append(radio, info, btns);
    root.append(row);
  }
}

async function selectProfile(id) {
  try {
    state = await api("setSettings", { patch: { profileId: id } });
    await loadProfiles();
    if (state.settings.enabled && state.runtime.status === "error") Toast.error(state.runtime.error);
    else Toast.ok(state.settings.enabled ? "Сервер выбран, туннель переподключён" : "Сервер выбран");
  } catch (e) {
    Toast.error(e.message);
  }
}

async function renameProfile(p) {
  const name = prompt("Новое название сервера", p.name);
  if (!name || name.trim() === p.name) return;
  try {
    await api("renameProfile", { id: p.id, name: name.trim() });
    await loadProfiles();
    Toast.ok("Переименовано");
  } catch (e) {
    Toast.error(e.message);
  }
}

async function deleteProfile(p) {
  if (!confirm("Удалить сервер «" + p.name + "»? Конфиг с ключами будет удалён с диска.")) return;
  try {
    await api("deleteProfile", { id: p.id });
    state = await api("getState");
    await loadProfiles();
    Toast.ok("Сервер удалён");
  } catch (e) {
    Toast.error(e.message);
  }
}

$("impFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 256 * 1024) {
    Toast.error("Файл слишком большой для конфига.");
    return;
  }
  $("impText").value = await file.text();
  if (!$("impName").value) $("impName").value = file.name.replace(/\.(conf|txt)$/i, "");
  e.target.value = "";
});

$("impBtn").addEventListener("click", async () => {
  const text = $("impText").value.trim();
  if (!text) {
    Toast.error("Вставьте конфиг или выберите файл.");
    return;
  }
  $("impBtn").disabled = true;
  try {
    const { profile } = await api("importProfile", { name: $("impName").value.trim(), text });
    $("impText").value = "";
    $("impName").value = "";
    state = await api("getState");
    await loadProfiles();
    Toast.ok("Сервер «" + profile.name + "» добавлен (" + profile.protocol + ")");
  } catch (e) {
    Toast.error(e.message);
  } finally {
    $("impBtn").disabled = false;
  }
});

// ------------------------------------------------------------------ settings form

function fillForm() {
  const s = state.settings;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === s.mode;
  $("excludeList").value = s.excludeList.join("\n");
  $("includeList").value = s.includeList.join("\n");
  for (const k of ["bypassLocal", "killSwitch", "webrtcProtect", "autoReconnect"]) $(k).checked = !!s[k];
  $("port").value = s.port;
  $("infoPort").value = s.infoPort;
}

$("saveBtn").addEventListener("click", async () => {
  const patch = {
    mode: document.querySelector('input[name="mode"]:checked')?.value || "exclude",
    excludeList: AWGRules.parseList($("excludeList").value),
    includeList: AWGRules.parseList($("includeList").value),
    port: Number($("port").value),
    infoPort: Number($("infoPort").value),
  };
  for (const k of ["bypassLocal", "killSwitch", "webrtcProtect", "autoReconnect"]) patch[k] = $(k).checked;
  if (patch.port === patch.infoPort) {
    Toast.error("Порты SOCKS5 и статистики должны различаться.");
    return;
  }
  try {
    state = await api("setSettings", { patch });
    fillForm();
    if (state.settings.enabled && state.runtime.status === "error") Toast.error(state.runtime.error);
    else Toast.ok("Сохранено");
  } catch (e) {
    Toast.error(e.message);
  }
});

$("pingBtn").addEventListener("click", async () => {
  if (await ping()) Toast.ok("Помощник отвечает");
  else Toast.error("Помощник не отвечает");
});

$("logBtn").addEventListener("click", async () => {
  try {
    const { log } = await api("logs");
    const pre = $("log");
    pre.hidden = false;
    pre.textContent = log || "(журнал пуст)";
    pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    Toast.error(e.message);
  }
});

(async () => {
  try {
    state = await api("getState");
    fillForm();
    await ping();
    await loadProfiles();
  } catch (e) {
    Toast.error(e.message);
  }
})();
