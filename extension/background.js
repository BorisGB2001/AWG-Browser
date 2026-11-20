/* AmneziaWG для Firefox — background (event page). */
"use strict";

const NATIVE = "awg_firefox";
const HEALTH_ALARM = "awg-health";

const DEFAULTS = {
  enabled: false,
  profileId: null,
  port: 40800, // local SOCKS5 of wireproxy-awg
  infoPort: 40801, // wireproxy health/metrics endpoint
  mode: "exclude", // "exclude": all except list; "include": only list
  excludeList: [],
  includeList: [],
  bypassLocal: true,
  killSwitch: true, // VPN on but tunnel down -> block instead of going direct
  webrtcProtect: true,
  autoReconnect: true,
};

let settings = { ...DEFAULTS };
// Runtime state of the tunnel. Credentials live only in memory / storage.session.
let rt = { status: "off", error: null, username: null, password: null, metrics: null, since: null };

const ready = (async () => {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  settings = { ...DEFAULTS, ...stored };
  try {
    const s = await browser.storage.session.get("rt");
    if (s.rt) rt = { ...rt, ...s.rt };
  } catch (_) {
    /* storage.session unavailable — fine */
  }
  updateBadge();
})();

// ------------------------------------------------------------------ native host

async function native(cmd, args = {}) {
  let res;
  try {
    res = await browser.runtime.sendNativeMessage(NATIVE, { cmd, ...args });
  } catch (e) {
    throw new Error(
      "Нет связи с помощником AmneziaWG (native host). Запустите scripts/install-macos.sh и перезапустите Firefox. (" +
        (e && e.message ? e.message : e) +
        ")"
    );
  }
  if (!res || !res.ok) throw new Error((res && res.error) || "Неизвестная ошибка помощника");
  return res;
}

// ------------------------------------------------------------------ state helpers

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await browser.storage.local.set(patch);
}

async function setRuntime(patch) {
  rt = { ...rt, ...patch };
  try {
    await browser.storage.session.set({ rt });
  } catch (_) {}
  updateBadge();
  browser.runtime.sendMessage({ type: "stateChanged" }).catch(() => {});
}

function updateBadge() {
  let text = "";
  let color = "#9e9e9e";
  let title = "Amnezia Browser Client — выключен";
  let icon = "icons/icon-off.svg";
  if (settings.enabled) {
    if (rt.status === "on") {
      text = "ON";
      color = "#2e7d32";
      title = "Amnezia Browser Client — подключено";
      icon = "icons/icon-on.svg";
    } else if (rt.status === "connecting") {
      text = "…";
      color = "#ef6c00";
      title = "Amnezia Browser Client — подключение";
    } else if (rt.status === "error") {
      text = "!";
      color = "#c62828";
      title = "Amnezia Browser Client — ошибка: " + (rt.error || "");
      icon = "icons/icon-err.svg";
    }
  }
  browser.action.setBadgeText({ text });
  browser.action.setBadgeBackgroundColor({ color });
  browser.action.setTitle({ title });
  browser.action.setIcon({ path: icon });
}

async function applyWebRtc(on) {
  try {
    const setting = browser.privacy.network.webRTCIPHandlingPolicy;
    if (on && settings.webrtcProtect) await setting.set({ value: "disable_non_proxied_udp" });
    else await setting.clear({});
  } catch (e) {
    console.warn("WebRTC policy:", e);
  }
}

// ------------------------------------------------------------------ connect / disconnect

let connecting = null;

async function connect() {
  if (connecting) return connecting;
  connecting = (async () => {
    if (!settings.profileId) {
      await setRuntime({ status: "error", error: "Не выбран профиль сервера. Импортируйте конфиг в настройках." });
      return;
    }
    await setRuntime({ status: "connecting", error: null });
    try {
      const { state } = await native("start", {
        id: settings.profileId,
        port: settings.port,
        infoPort: settings.infoPort,
      });
      await setRuntime({
        status: "on",
        error: null,
        username: state.username,
        password: state.password,
        metrics: state.metrics || null,
        since: state.startedAt || Math.floor(Date.now() / 1000),
      });
      await applyWebRtc(true);
    } catch (e) {
      await setRuntime({ status: "error", error: e.message, username: null, password: null });
    }
  })();
  try {
    await connecting;
  } finally {
    connecting = null;
  }
}

async function disconnect() {
  await applyWebRtc(false);
  try {
    await native("stop");
  } catch (e) {
    console.warn(e);
  }
  await setRuntime({ status: "off", error: null, username: null, password: null, metrics: null, since: null });
}

async function setEnabled(value) {
  await saveSettings({ enabled: !!value });
  if (value) {
    browser.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
    await connect();
  } else {
    browser.alarms.clear(HEALTH_ALARM);
    await disconnect();
  }
}

async function healthCheck() {
  if (!settings.enabled) return;
  try {
    const { state } = await native("status");
    const sameTunnel = state.running && state.profile === settings.profileId && state.port === settings.port;
    if (sameTunnel) {
      await setRuntime({
        status: "on",
        error: null,
        username: state.username,
        password: state.password,
        metrics: state.metrics || null,
        since: state.startedAt,
      });
    } else if (settings.autoReconnect || rt.status === "on") {
      await connect();
    }
  } catch (e) {
    await setRuntime({ status: "error", error: e.message });
  }
}

// ------------------------------------------------------------------ proxy routing

const DIRECT = { type: "direct" };

browser.proxy.onRequest.addListener(
  async (details) => {
    await ready;
    if (!settings.enabled) return DIRECT;
    let host;
    try {
      host = new URL(details.url).hostname;
    } catch (_) {
      return DIRECT;
    }
    if (!AWGRules.shouldTunnel(host, settings)) return DIRECT;
    if (rt.status !== "on" && !settings.killSwitch) return DIRECT;
    // With the kill switch on and the tunnel down this proxy is unreachable,
    // so the request fails instead of leaking around the VPN.
    return {
      type: "socks",
      host: "127.0.0.1",
      port: settings.port,
      username: rt.username || "awg",
      password: rt.password || "-",
      proxyDNS: true,
      failoverTimeout: 5,
    };
  },
  { urls: ["<all_urls>"] }
);

browser.proxy.onError.addListener((err) => console.warn("proxy error:", err && err.message));

// ------------------------------------------------------------------ lifecycle

browser.runtime.onStartup.addListener(async () => {
  await ready;
  if (settings.enabled) {
    browser.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
    await connect();
  }
});

browser.runtime.onInstalled.addListener(async (details) => {
  await ready;
  if (settings.enabled) {
    browser.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
    await connect();
  }
  if (details.reason === "install") browser.runtime.openOptionsPage();
});

browser.alarms.onAlarm.addListener(async (a) => {
  await ready;
  if (a.name === HEALTH_ALARM) await healthCheck();
});

// ------------------------------------------------------------------ messages from popup/options

async function getState() {
  return { settings, runtime: { ...rt, password: undefined, username: undefined } };
}

async function checkIp() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store", signal: ctrl.signal });
    const j = await r.json();
    return { ip: j.ip, viaVpn: settings.enabled && AWGRules.shouldTunnel("api.ipify.org", settings) };
  } finally {
    clearTimeout(timer);
  }
}

async function editList(list, host, add) {
  const key = list === "include" ? "includeList" : "excludeList";
  const entry = AWGRules.normalizeEntry(host);
  if (!entry) throw new Error("Пустой домен.");
  const cur = settings[key].filter((e) => e !== entry);
  if (add) cur.push(entry);
  await saveSettings({ [key]: cur });
  return { [key]: cur };
}

const handlers = {
  getState,
  async setEnabled({ value }) {
    await setEnabled(value);
    return getState();
  },
  async setSettings({ patch }) {
    const allowed = Object.keys(DEFAULTS).filter((k) => k !== "enabled");
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    if ("excludeList" in clean) clean.excludeList = AWGRules.parseList(clean.excludeList.join("\n"));
    if ("includeList" in clean) clean.includeList = AWGRules.parseList(clean.includeList.join("\n"));
    for (const p of ["port", "infoPort"]) {
      if (p in clean) {
        const n = Number(clean[p]);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error("Порт должен быть числом 1024–65535.");
        clean[p] = n;
      }
    }
    const needReconnect =
      settings.enabled &&
      ["profileId", "port", "infoPort"].some((k) => k in clean && clean[k] !== settings[k]);
    await saveSettings(clean);
    if ("webrtcProtect" in clean && rt.status === "on") await applyWebRtc(true);
    if (needReconnect) await connect();
    return getState();
  },
  async listProfiles() {
    return native("list");
  },
  async importProfile({ name, text }) {
    const res = await native("import", { name, text });
    if (!settings.profileId) await saveSettings({ profileId: res.profile.id });
    return res;
  },
  async deleteProfile({ id }) {
    await native("delete", { id });
    if (settings.profileId === id) {
      await saveSettings({ profileId: null });
      if (settings.enabled) await setEnabled(false);
    }
    return {};
  },
  async renameProfile({ id, name }) {
    return native("rename", { id, name });
  },
  async editList({ list, host, add }) {
    return editList(list, host, add);
  },
  async ping() {
    return native("ping");
  },
  async logs() {
    return native("logs", { lines: 120 });
  },
  async refresh() {
    await healthCheck();
    return getState();
  },
  checkIp,
};

browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id || !msg || !handlers[msg.type]) return undefined;
  return ready
    .then(() => handlers[msg.type](msg))
    .then(
      (data) => ({ ok: true, data }),
      (e) => ({ ok: false, error: e && e.message ? e.message : String(e) })
    );
});
