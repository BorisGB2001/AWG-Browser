#!/usr/bin/env node
/*
 * Tests for the extension logic without a browser: routing rules (lib/rules.js)
 * and the background state machine (background.js) with a mocked `browser` API
 * and a fake native host.   Run: node scripts/test-extension.js
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "extension");
const R = require(path.join(EXT, "lib", "rules.js"));
let passed = 0;
const ok = (name) => (passed++, console.log("ok  ", name));

// ------------------------------------------------------------------ rules

{
  assert.deepStrictEqual(
    R.parseList("https://www.Bank.ru/x\n*.gosuslugi.ru, ya.ru # yandex\n203.0.113.0/24\n# c\nпример.рф\nexample.com.\n[2001:db8::1]:443\nuser@host.example\n2001:db8::/32\n999.1.1.1/8"),
    ["www.bank.ru", "gosuslugi.ru", "ya.ru", "203.0.113.0/24", "xn--e1afmkfd.xn--p1ai", "example.com", "2001:db8::1", "host.example"]
  );
  const ex = { mode: "exclude", excludeList: R.parseList("gosuslugi.ru\n203.0.113.0/24\nпример.рф"), includeList: [], bypassLocal: true };
  assert(!R.shouldTunnel("lk.gosuslugi.ru", ex));
  assert(R.shouldTunnel("xgosuslugi.ru", ex));
  assert(!R.shouldTunnel("203.0.113.9", ex));
  assert(R.shouldTunnel("203.0.114.9", ex));
  assert(!R.shouldTunnel("xn--e1afmkfd.xn--p1ai", ex), "IDN entry must match the punycode host");
  assert(!R.shouldTunnel("EXAMPLE.local", ex) && !R.shouldTunnel("192.168.1.1", ex) && !R.shouldTunnel("[::1]", ex));
  const inc = { mode: "include", includeList: R.parseList("youtube.com\nпример.рф\n2001:db8::1"), excludeList: [], bypassLocal: true };
  assert(R.shouldTunnel("www.youtube.com.", inc), "trailing dot in the request host");
  assert(!R.shouldTunnel("myyoutube.com", inc) && !R.shouldTunnel("ya.ru", inc));
  assert(R.shouldTunnel("xn--e1afmkfd.xn--p1ai", inc) && R.shouldTunnel("[2001:db8::1]", inc));
  ok("rules: list normalisation and matching");
}

// ------------------------------------------------------------------ background with mocks

function makeWorld(stored = {}) {
  const calls = []; // native host commands, in order
  const host = { running: null, delay: 0, failStart: null, gate: null };
  const local = { ...stored };
  const session = {};
  const privacy = {};
  const alarms = new Set();
  const listeners = {};
  const ev = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const setting = (name) => ({
    set: async ({ value }) => void (privacy[name] = value),
    clear: async () => void delete privacy[name],
  });
  const browser = {
    storage: {
      local: { get: async () => ({ ...local }), set: async (p) => void Object.assign(local, p) },
      session: { get: async () => ({ ...session }), set: async (p) => void Object.assign(session, p) },
    },
    runtime: {
      id: "x",
      sendNativeMessage: async (_name, msg) => {
        calls.push(msg.cmd);
        if (host.gate && msg.cmd === host.gate.cmd) await host.gate.promise;
        if (msg.cmd === "start") {
          if (host.failStart) return { ok: false, error: host.failStart };
          host.running = { profile: msg.id, port: msg.port, infoPort: msg.infoPort };
          return { ok: true, state: { running: true, ...host.running, username: "awg", password: "pw", startedAt: 100, metrics: {} } };
        }
        if (msg.cmd === "stop") {
          host.running = null;
          return { ok: true };
        }
        if (msg.cmd === "status") {
          return { ok: true, state: host.running ? { running: true, ...host.running, username: "awg", password: "pw", startedAt: 100 } : { running: false } };
        }
        return { ok: true };
      },
      sendMessage: async () => {},
      getManifest: () => ({ version: "test" }),
      openOptionsPage() {},
      onStartup: ev("startup"),
      onInstalled: ev("installed"),
      onMessage: ev("message"),
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {}, setIcon() {} },
    privacy: { network: { webRTCIPHandlingPolicy: setting("webrtc"), networkPredictionEnabled: setting("predict") } },
    alarms: {
      create: (n) => void alarms.add(n),
      clear: (n) => void alarms.delete(n),
      get: async (n) => (alarms.has(n) ? { name: n } : undefined),
      onAlarm: ev("alarm"),
    },
    proxy: { onRequest: ev("proxy"), onError: ev("proxyError") },
  };
  const ctx = vm.createContext({ browser, console: { warn() {}, error() {}, log() {} }, URL, setTimeout, clearTimeout, AbortController, fetch: async () => ({ json: async () => ({ ip: "1.2.3.4" }) }) });
  for (const f of ["lib/rules.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
  const send = async (msg) => {
    const res = await listeners.message(msg, { id: "x" });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  };
  const proxy = (url) => listeners.proxy({ url });
  return { calls, host, local, privacy, alarms, listeners, send, proxy };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
const SOCKS = (r) => (Array.isArray(r) ? r[0] : r);

(async () => {
  // --- off: everything direct
  {
    const w = makeWorld({ profileId: "nl" });
    assert.strictEqual((await w.proxy("https://example.com/")).type, "direct");
    ok("vpn off -> direct");
  }

  // --- on: tunnel, lists, local addresses, privacy settings, alarm
  {
    const w = makeWorld({ profileId: "nl", excludeList: ["bank.ru"] });
    const st = await w.send({ type: "setEnabled", value: true });
    assert.strictEqual(st.runtime.status, "on");
    assert.strictEqual(st.runtime.password, undefined, "password must not reach the pages");
    const r = await w.proxy("https://example.com/");
    assert(!Array.isArray(r), "kill switch on: no direct fallback");
    assert.deepStrictEqual([r.type, r.host, r.port, r.password, r.proxyDNS], ["socks", "127.0.0.1", 40800, "pw", true]);
    assert(r.connectionIsolationKey);
    assert.strictEqual((await w.proxy("https://lk.bank.ru/")).type, "direct");
    assert.strictEqual((await w.proxy("http://192.168.1.1/")).type, "direct");
    assert.deepStrictEqual(w.privacy, { webrtc: "disable_non_proxied_udp", predict: false });
    assert(w.alarms.has("awg-health"));
    await w.send({ type: "setEnabled", value: false });
    assert.deepStrictEqual(w.privacy, {});
    assert(!w.alarms.has("awg-health") && w.host.running === null);
    assert.strictEqual((await w.proxy("https://example.com/")).type, "direct");
    ok("vpn on -> socks, lists honoured, privacy settings applied and cleared");
  }

  // --- kill switch: tunnel down -> blackhole; switch off -> direct, and [socks, direct] when up
  {
    const w = makeWorld({ profileId: "nl" });
    w.host.failStart = "нет связи";
    const st = await w.send({ type: "setEnabled", value: true });
    assert.strictEqual(st.runtime.status, "error");
    const r = await w.proxy("https://example.com/");
    assert.deepStrictEqual([r.type, r.port], ["http", 9], "tunnel down + kill switch -> blocked");
    assert.strictEqual(w.privacy.webrtc, "disable_non_proxied_udp", "WebRTC protected even when the connect failed");
    await w.send({ type: "setSettings", patch: { killSwitch: false } });
    assert.strictEqual((await w.proxy("https://example.com/")).type, "direct");
    w.host.failStart = null;
    await w.listeners.alarm({ name: "awg-health" });
    const up = await w.proxy("https://example.com/");
    assert(Array.isArray(up) && up[0].type === "socks" && up[1].type === "direct");
    ok("kill switch blocks when the tunnel is down; off -> direct fallback");
  }

  // --- no profile + kill switch
  {
    const w = makeWorld({});
    const st = await w.send({ type: "setEnabled", value: true });
    assert.strictEqual(st.runtime.status, "error");
    assert.strictEqual((await w.proxy("https://example.com/")).port, 9);
    ok("no server selected -> error, traffic blocked");
  }

  // --- race: VPN switched off while a start is in flight
  {
    const w = makeWorld({ profileId: "nl" });
    let release;
    w.host.gate = { cmd: "start", promise: new Promise((r) => (release = r)) };
    const on = w.send({ type: "setEnabled", value: true });
    await flush();
    const off = w.send({ type: "setEnabled", value: false });
    await flush();
    release();
    await Promise.all([on, off]);
    assert.strictEqual(w.host.running, null, "tunnel must be stopped after the late start");
    assert.strictEqual(w.calls[w.calls.length - 1], "stop");
    assert.strictEqual((await w.send({ type: "getState" })).runtime.status, "off");
    assert.deepStrictEqual(w.privacy, {});
    ok("switch off during start -> tunnel stopped");
  }

  // --- race: VPN switched off while the health check waits for the host
  {
    const w = makeWorld({ profileId: "nl" });
    await w.send({ type: "setEnabled", value: true });
    w.host.running = null; // tunnel died
    let release;
    w.host.gate = { cmd: "status", promise: new Promise((r) => (release = r)) };
    const health = w.listeners.alarm({ name: "awg-health" });
    await flush();
    const off = w.send({ type: "setEnabled", value: false });
    await flush();
    release();
    await Promise.all([health, off]);
    assert.strictEqual(w.host.running, null, "health check must not bring the tunnel back");
    assert.strictEqual((await w.send({ type: "getState" })).runtime.status, "off");
    ok("switch off during health check -> tunnel stays off");
  }

  // --- server changed while a start is in flight; info port change restarts
  {
    const w = makeWorld({ profileId: "nl" });
    let release;
    w.host.gate = { cmd: "start", promise: new Promise((r) => (release = r)) };
    const on = w.send({ type: "setEnabled", value: true });
    await flush();
    const change = w.send({ type: "setSettings", patch: { profileId: "de" } });
    await flush();
    w.host.gate = null;
    release();
    await Promise.all([on, change]);
    assert.strictEqual(w.host.running.profile, "de", "the newer server must win");
    await w.send({ type: "setSettings", patch: { infoPort: 40900 } });
    assert.strictEqual(w.host.running.infoPort, 40900);
    await assert.rejects(w.send({ type: "setSettings", patch: { infoPort: 40800 } }), /различаться/);
    ok("server changed during start is applied; info port change applied");
  }

  // --- tunnel died: auto reconnect on/off
  {
    const w = makeWorld({ profileId: "nl" });
    await w.send({ type: "setEnabled", value: true });
    w.host.running = null;
    await w.listeners.alarm({ name: "awg-health" });
    assert(w.host.running, "auto reconnect");
    await w.send({ type: "setSettings", patch: { autoReconnect: false } });
    w.host.running = null;
    await w.listeners.alarm({ name: "awg-health" });
    assert.strictEqual(w.host.running, null);
    assert.strictEqual((await w.send({ type: "getState" })).runtime.status, "error");
    assert.strictEqual((await w.proxy("https://example.com/")).port, 9);
    ok("tunnel died: reconnects, or reports an error and blocks");
  }

  // --- editList: removing drops every covering entry
  {
    const w = makeWorld({ profileId: "nl", excludeList: ["example.com", "www.example.com", "other.org"] });
    await w.send({ type: "editList", list: "exclude", host: "www.example.com", add: false });
    assert.deepStrictEqual((await w.send({ type: "getState" })).settings.excludeList, ["other.org"]);
    await w.send({ type: "editList", list: "exclude", host: "пример.рф", add: true });
    assert.deepStrictEqual((await w.send({ type: "getState" })).settings.excludeList, ["other.org", "xn--e1afmkfd.xn--p1ai"]);
    ok("editList removes covering entries, adds normalised ones");
  }

  console.log(`\n${passed} tests passed`);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
