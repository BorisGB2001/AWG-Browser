/* Amnezia Browser Client — background (event page). */
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
// "active" is the "profile|port|infoPort" the running tunnel was started with.
let rt = { status: "off", error: null, active: null, username: null, password: null, metrics: null, since: null };

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
  // An event page can be woken up without onStartup; keep the health alarm alive.
  if (settings.enabled && !(await browser.alarms.get(HEALTH_ALARM))) {
    browser.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
  }
})();

// ------------------------------------------------------------------ native host

async function native(cmd, args = {}) {
  let res;
  try {
    res = await browser.runtime.sendNativeMessage(NATIVE, { cmd, ...args });
  } catch (e) {
    throw new Error(
      "Нет связи с помощником AmneziaWG (native host). Установите помощник (Windows: install.cmd, macOS/Linux: scripts/install.sh) и перезапустите Firefox. (" +
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

// WebRTC and prefetch protection follow the VPN switch itself, not the tunnel
// status: while the VPN is meant to be on, nothing may bypass it even if the
// tunnel is still connecting or has failed.
async function applyPrivacy(on) {
  try {
    const setting = browser.privacy.network.webRTCIPHandlingPolicy;
    if (on && settings.webrtcProtect) await setting.set({ value: "disable_non_proxied_udp" });
    else await setting.clear({});
  } catch (e) {
    console.warn("WebRTC policy:", e);
  }
  // DNS prefetch and speculative connections would name the sites to the local
  // resolver and open connections past the tunnel.
  try {
    const predict = browser.privacy.network.networkPredictionEnabled;
    if (on) await predict.set({ value: false });
    else await predict.clear({});
  } catch (e) {
    console.warn("network prediction:", e);
  }
}

// ------------------------------------------------------------------ tunnel state machine
//
// Every change (switch, server, ports, health check) goes through one queue and
// calls reconcile(), which reads the settings at the moment it runs. So a switch
// flipped or a server changed while a start is in flight is never lost, and a
// health check cannot bring the tunnel back after the user turned the VPN off.

let queue = Promise.resolve();

function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch((e) => console.warn("tunnel op:", e));
  return run;
}

const wantKey = () => [settings.profileId, settings.port, settings.infoPort].join("|");
const stateKey = (st) => [st.profile, st.port, st.infoPort].join("|");

function tunnelUp(state) {
  return setRuntime({
    status: "on",
    error: null,
    active: stateKey(state),
    username: state.username,
    password: state.password,
    metrics: state.metrics || null,
    since: state.startedAt || Math.floor(Date.now() / 1000),
  });
}

const OFF = { status: "off", error: null, active: null, username: null, password: null, metrics: null, since: null };

async function reconcile() {
  if (!settings.enabled) {
    await applyPrivacy(false);
    try {
      await native("stop");
    } catch (e) {
      console.warn(e);
    }
    await setRuntime(OFF);
    return;
  }
  await applyPrivacy(true);
  if (!settings.profileId) {
    await setRuntime({ ...OFF, status: "error", error: "Не выбран профиль сервера. Импортируйте конфиг в настройках." });
    return;
  }
  if (rt.status !== "on" || rt.active !== wantKey()) {
    await setRuntime({ status: "connecting", error: null, active: null, username: null, password: null });
  }
  try {
    // "start" is idempotent: a tunnel already running with the same settings is reused.
    const { state } = await native("start", { id: settings.profileId, port: settings.port, infoPort: settings.infoPort });
    await tunnelUp(state);
  } catch (e) {
    await setRuntime({ ...OFF, status: "error", error: e.message });
  }
}

const sync = () => enqueue(reconcile);

function ensureAlarm() {
  if (settings.enabled) browser.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
  else browser.alarms.clear(HEALTH_ALARM);
}

async function setEnabled(value) {
  await saveSettings({ enabled: !!value });
  ensureAlarm();
  await sync();
}

function healthCheck() {
  return enqueue(async () => {
    if (!settings.enabled) return;
    let state;
    try {
      ({ state } = await native("status"));
    } catch (e) {
      await setRuntime({ ...OFF, status: "error", error: e.message });
      return;
    }
    if (!settings.enabled) return; // switched off while the host was answering
    if (state.running && stateKey(state) === wantKey()) await tunnelUp(state);
    else if (settings.autoReconnect) await reconcile();
    else await setRuntime({ ...OFF, status: "error", error: "Туннель остановлен. Автопереподключение выключено." });
  });
}

// ------------------------------------------------------------------ proxy routing

const DIRECT = { type: "direct" };
// Nothing listens on the discard port: a request sent here fails at once.
// Used by the kill switch when there is no working tunnel.
const BLACKHOLE = { type: "http", host: "127.0.0.1", port: 9 };

function route(details) {
  if (!settings.enabled) return DIRECT;
  let host;
  try {
    host = new URL(details.url).hostname;
  } catch (_) {
    return DIRECT;
  }
  if (!AWGRules.shouldTunnel(host, settings)) return DIRECT;
  if (rt.status !== "on" || !rt.password) return settings.killSwitch ? BLACKHOLE : DIRECT;
  const tunnel = {
    type: "socks",
    host: "127.0.0.1",
    port: settings.port,
    username: rt.username,
    password: rt.password,
    proxyDNS: true,
    failoverTimeout: 5,
    // Firefox reuses proxy connections; a new key per tunnel start makes a
    // changed server take effect at once.
    connectionIsolationKey: "awg:" + rt.active + ":" + rt.since,
  };
  // Kill switch on: only the tunnel, the request fails if it is down.
  // Kill switch off: Firefox falls back to a direct connection.
  return settings.killSwitch ? tunnel : [tunnel, DIRECT];
}

browser.proxy.onRequest.addListener(
  async (details) => {
    try {
      await ready;
      return route(details);
    } catch (e) {
      // Never fail open: an internal error must not send VPN traffic direct.
      console.error("proxy.onRequest:", e);
      return settings.enabled && settings.killSwitch ? BLACKHOLE : DIRECT;
    }
  },
  { urls: ["<all_urls>"] }
);

browser.proxy.onError.addListener((err) => console.warn("proxy error:", err && err.message));

// ------------------------------------------------------------------ lifecycle

browser.runtime.onStartup.addListener(async () => {
  await ready;
  ensureAlarm();
  if (settings.enabled) await sync();
});

browser.runtime.onInstalled.addListener(async (details) => {
  await ready;
  ensureAlarm();
  if (settings.enabled) await sync();
  if (details.reason === "install") browser.runtime.openOptionsPage();
});

browser.alarms.onAlarm.addListener(async (a) => {
  await ready;
  if (a.name === HEALTH_ALARM) await healthCheck();
});

// ------------------------------------------------------------------ messages from popup/options

async function getState() {
  return { settings, runtime: { ...rt, password: undefined, username: undefined }, version: browser.runtime.getManifest().version };
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
  // Removing drops every entry that covers the host (a parent domain, "www."),
  // otherwise the site would keep its route and the button would do nothing.
  const cur = settings[key].filter((e) => e !== entry && (add || !AWGRules.matches(entry, e)));
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
    const port = "port" in clean ? clean.port : settings.port;
    const infoPort = "infoPort" in clean ? clean.infoPort : settings.infoPort;
    if (port === infoPort) throw new Error("Порты SOCKS5 и статистики должны различаться.");
    const needSync =
      settings.enabled &&
      ["profileId", "port", "infoPort", "webrtcProtect"].some((k) => k in clean && clean[k] !== settings[k]);
    await saveSettings(clean);
    if (needSync) await sync();
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
