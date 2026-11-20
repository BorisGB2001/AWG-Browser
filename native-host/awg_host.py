#!/usr/bin/env python3
"""
Native messaging host for the "AmneziaWG для Firefox" extension.

Firefox talks to this script over stdin/stdout (native messaging protocol:
4-byte native-endian length + UTF-8 JSON). The script is stateless: every
request is a separate process. The tunnel itself is a detached wireproxy-awg
process (userspace AmneziaWG -> local SOCKS5), tracked through a pid file.

Data directory: ~/Library/Application Support/AWG-Firefox
  host.json            host settings written by the installer (wireproxy path)
  profiles/<id>.conf   imported AmneziaWG configs (mode 0600)
  run/wireproxy.conf   generated wrapper config (WGConfig + [Socks5])
  run/state.json       running tunnel: pid, profile, ports, SOCKS credentials
  logs/wireproxy.log   wireproxy output
"""

import base64
import json
import os
import re
import secrets
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.request
import zlib

HOST_VERSION = "1.0.0"
BASE = os.path.expanduser("~/Library/Application Support/AWG-Firefox")
PROFILES = os.path.join(BASE, "profiles")
RUN = os.path.join(BASE, "run")
LOGS = os.path.join(BASE, "logs")
HOST_JSON = os.path.join(BASE, "host.json")
STATE = os.path.join(RUN, "state.json")
RUN_CONF = os.path.join(RUN, "wireproxy.conf")
LOG_FILE = os.path.join(LOGS, "wireproxy.log")

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


# ---------------------------------------------------------------- protocol

def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("@I", raw_len)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


class HostError(Exception):
    pass


# ---------------------------------------------------------------- helpers

def ensure_dirs():
    for d in (BASE, PROFILES, RUN, LOGS):
        os.makedirs(d, mode=0o700, exist_ok=True)


def write_private(path, text):
    """Write a file readable only by the current user."""
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def host_settings():
    return load_json(HOST_JSON, {})


def wireproxy_path():
    path = host_settings().get("wireproxy") or os.path.join(BASE, "bin", "wireproxy")
    if not (os.path.isfile(path) and os.access(path, os.X_OK)):
        raise HostError(
            "Не найден wireproxy-awg (%s). Запустите scripts/install-macos.sh." % path
        )
    return path


def slugify(name):
    s = re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-")[:40]
    return s or "profile"


# ---------------------------------------------------------------- config parsing

def parse_conf(text):
    """Very small INI reader for wg-quick style configs (keeps duplicate sections)."""
    sections = []
    cur = None
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        m = re.match(r"^\[(\w+)\]$", line)
        if m:
            cur = {"_name": m.group(1).lower()}
            sections.append(cur)
            continue
        if "=" in line and cur is not None:
            k, v = line.split("=", 1)
            cur[k.strip().lower()] = v.strip()
    return sections


def describe_conf(text):
    sections = parse_conf(text)
    iface = next((s for s in sections if s["_name"] == "interface"), None)
    peers = [s for s in sections if s["_name"] == "peer"]
    if not iface or "privatekey" not in iface:
        raise HostError("В конфиге нет секции [Interface] с PrivateKey.")
    if "address" not in iface:
        raise HostError("В секции [Interface] нет Address.")
    if not peers:
        raise HostError("В конфиге нет секции [Peer].")
    for p in peers:
        if "publickey" not in p or "endpoint" not in p:
            raise HostError("В секции [Peer] нужны PublicKey и Endpoint.")
    awg = "WireGuard"
    if any(k in iface for k in ("jc", "jmin", "jmax", "s1", "s2", "h1")):
        awg = "AWG 1.0"
    if any(k in iface for k in ("s3", "s4", "i1")):
        awg = "AWG 2.0"
    if any(k in iface for k in ("headerprotectionkey", "contentpaddingaddition")):
        awg = "AWG 3.0"
    if any(k in iface for k in ("randomtrailers", "disablecookies")):
        awg = "AWG 3.1"
    return {
        "endpoint": peers[0]["endpoint"],
        "address": iface["address"],
        "dns": iface.get("dns", ""),
        "protocol": awg,
    }


def decode_vpn_link(link):
    """Decode an Amnezia 'vpn://...' share string into (wg config text, suggested name)."""
    payload = link.strip()[len("vpn://"):]
    payload = re.sub(r"\s+", "", payload)
    payload += "=" * (-len(payload) % 4)
    try:
        raw = base64.urlsafe_b64decode(payload)
    except ValueError:
        raise HostError("Не удалось декодировать vpn:// (base64).")
    data = None
    # Qt qCompress: 4-byte big-endian length + zlib stream
    for candidate in (raw[4:], raw):
        try:
            data = zlib.decompress(candidate)
            break
        except zlib.error:
            continue
    if data is None:
        data = raw
    try:
        obj = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise HostError("vpn:// не содержит JSON-конфигурации Amnezia.")

    name = obj.get("description") or obj.get("name") or obj.get("hostName") or "Amnezia"
    for container in obj.get("containers", []):
        for key, value in container.items():
            if not isinstance(value, dict) or "last_config" not in value:
                continue
            last = value["last_config"]
            if isinstance(last, str):
                try:
                    last = json.loads(last)
                except ValueError:
                    continue
            conf = last.get("config") if isinstance(last, dict) else None
            if conf and "[Interface]" in conf:
                if "$" in conf:
                    raise HostError(
                        "Конфиг в vpn:// содержит незаполненные шаблоны ($...). "
                        "Экспортируйте конфиг клиента AmneziaWG (.conf)."
                    )
                return conf, name
    raise HostError(
        "В vpn:// нет конфигурации AmneziaWG/WireGuard. "
        "В приложении Amnezia выберите «Поделиться» → формат AmneziaWG."
    )


# ---------------------------------------------------------------- profiles

def profile_path(pid):
    if not ID_RE.match(pid or ""):
        raise HostError("Некорректный идентификатор профиля.")
    return os.path.join(PROFILES, pid + ".conf")


def meta_path(pid):
    return os.path.join(PROFILES, pid + ".json")


def list_profiles():
    ensure_dirs()
    result = []
    for fn in sorted(os.listdir(PROFILES)):
        if not fn.endswith(".conf"):
            continue
        pid = fn[:-5]
        if not ID_RE.match(pid):
            continue
        meta = load_json(meta_path(pid), {})
        item = {"id": pid, "name": meta.get("name", pid)}
        try:
            with open(os.path.join(PROFILES, fn), "r", encoding="utf-8") as f:
                item.update(describe_conf(f.read()))
        except (OSError, HostError) as e:
            item["error"] = str(e)
        result.append(item)
    return result


def import_profile(name, text):
    ensure_dirs()
    text = (text or "").strip()
    if not text:
        raise HostError("Пустой конфиг.")
    if text.startswith("vpn://"):
        text, suggested = decode_vpn_link(text)
        name = name or suggested
    text = text.replace("\r\n", "\n").strip() + "\n"
    info = describe_conf(text)
    name = (name or info["endpoint"].rsplit(":", 1)[0]).strip()[:80]
    base_id = slugify(name)
    pid, n = base_id, 2
    while os.path.exists(profile_path(pid)):
        pid = "%s-%d" % (base_id, n)
        n += 1
    write_private(profile_path(pid), text)
    write_private(meta_path(pid), json.dumps({"name": name}, ensure_ascii=False))
    # Validate with wireproxy itself when it is installed.
    try:
        configtest(profile_path(pid))
    except HostError:
        os.remove(profile_path(pid))
        os.remove(meta_path(pid))
        raise
    item = {"id": pid, "name": name}
    item.update(info)
    return item


def delete_profile(pid):
    state = load_json(STATE, {})
    if state.get("profile") == pid and pid_alive(state.get("pid")):
        stop_tunnel()
    for p in (profile_path(pid), meta_path(pid)):
        if os.path.exists(p):
            os.remove(p)


def rename_profile(pid, name):
    if not os.path.exists(profile_path(pid)):
        raise HostError("Профиль не найден.")
    write_private(meta_path(pid), json.dumps({"name": name.strip()[:80]}, ensure_ascii=False))


# ---------------------------------------------------------------- tunnel

def pid_alive(pid):
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    # Make sure the pid still belongs to wireproxy (pids get reused).
    try:
        comm = subprocess.run(
            ["ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True, timeout=3
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return False
    return os.path.basename(comm) == "wireproxy"


def port_open(port, timeout=0.3):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def configtest(profile_file):
    try:
        binary = wireproxy_path()
    except HostError:
        return  # not installed yet: skip validation
    tmp = os.path.join(RUN, "configtest.conf")
    write_private(tmp, "WGConfig = %s\n" % profile_file)
    try:
        r = subprocess.run(
            [binary, "-n", "-c", tmp], capture_output=True, text=True, timeout=10
        )
    finally:
        os.remove(tmp)
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).strip().splitlines()
        raise HostError("wireproxy отклонил конфиг: " + (msg[-1] if msg else "ошибка"))


def stop_tunnel():
    state = load_json(STATE, {})
    pid = state.get("pid")
    if pid_alive(pid):
        os.kill(pid, signal.SIGTERM)
        for _ in range(30):
            if not pid_alive(pid):
                break
            time.sleep(0.1)
        if pid_alive(pid):
            os.kill(pid, signal.SIGKILL)
    if os.path.exists(STATE):
        os.remove(STATE)


def start_tunnel(pid, port, info_port):
    ensure_dirs()
    binary = wireproxy_path()
    path = profile_path(pid)
    if not os.path.exists(path):
        raise HostError("Профиль не найден.")
    port, info_port = int(port), int(info_port)
    if not (1024 <= port <= 65535 and 1024 <= info_port <= 65535) or port == info_port:
        raise HostError("Некорректные порты.")

    state = load_json(STATE, {})
    if (
        pid_alive(state.get("pid"))
        and state.get("profile") == pid
        and state.get("port") == port
        and port_open(port)
    ):
        return public_state(state)  # already running with the same settings

    stop_tunnel()
    for p in (port, info_port):
        if port_open(p):
            raise HostError("Порт 127.0.0.1:%d уже занят другой программой." % p)

    username = "awg"
    password = secrets.token_urlsafe(18)
    write_private(
        RUN_CONF,
        "WGConfig = %s\n\n[Socks5]\nBindAddress = 127.0.0.1:%d\nUsername = %s\nPassword = %s\n"
        % (path, port, username, password),
    )
    log = open(LOG_FILE, "ab")
    log.write(("\n==== %s start profile=%s port=%d\n" % (time.strftime("%F %T"), pid, port)).encode())
    log.flush()
    proc = subprocess.Popen(
        [binary, "-c", RUN_CONF, "-i", "127.0.0.1:%d" % info_port],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,  # survive the host process and Firefox's cleanup
        close_fds=True,
    )
    log.close()

    deadline = time.time() + 8
    while time.time() < deadline:
        if proc.poll() is not None:
            raise HostError("wireproxy завершился при запуске: " + tail_log(5))
        if port_open(port):
            break
        time.sleep(0.15)
    else:
        proc.kill()
        raise HostError("wireproxy не открыл SOCKS-порт за 8 секунд.")

    state = {
        "pid": proc.pid,
        "profile": pid,
        "port": port,
        "infoPort": info_port,
        "username": username,
        "password": password,
        "startedAt": int(time.time()),
    }
    write_private(STATE, json.dumps(state))
    return public_state(state)


def metrics(info_port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/metrics" % info_port, timeout=2) as r:
            body = r.read().decode("utf-8", "replace")
    except OSError:
        return {}
    out = {"rx": 0, "tx": 0, "handshake": 0}
    for line in body.splitlines():
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k == "rx_bytes":
            out["rx"] += int(v)
        elif k == "tx_bytes":
            out["tx"] += int(v)
        elif k == "last_handshake_time_sec":
            out["handshake"] = max(out["handshake"], int(v))
        elif k == "endpoint":
            out["endpoint"] = v
    return out


def public_state(state):
    running = pid_alive(state.get("pid"))
    res = {"running": running}
    if running:
        res.update({k: state.get(k) for k in ("profile", "port", "username", "password", "startedAt", "pid")})
        res["metrics"] = metrics(state.get("infoPort", 0))
    return res


def tail_log(lines=40):
    try:
        with open(LOG_FILE, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 64 * 1024))
            data = f.read().decode("utf-8", "replace")
    except OSError:
        return ""
    return "\n".join(data.splitlines()[-lines:])


def wireproxy_version():
    try:
        r = subprocess.run([wireproxy_path(), "-v"], capture_output=True, text=True, timeout=5)
        return (r.stdout or r.stderr).strip()
    except (HostError, OSError, subprocess.SubprocessError):
        return None


# ---------------------------------------------------------------- dispatch

def handle(msg):
    cmd = msg.get("cmd")
    if cmd == "ping":
        return {"version": HOST_VERSION, "wireproxy": wireproxy_version(), "dataDir": BASE}
    if cmd == "list":
        return {"profiles": list_profiles()}
    if cmd == "import":
        return {"profile": import_profile(msg.get("name"), msg.get("text"))}
    if cmd == "delete":
        delete_profile(msg.get("id"))
        return {}
    if cmd == "rename":
        rename_profile(msg.get("id"), msg.get("name") or "")
        return {}
    if cmd == "start":
        return {"state": start_tunnel(msg.get("id"), msg.get("port", 40800), msg.get("infoPort", 40801))}
    if cmd == "stop":
        stop_tunnel()
        return {}
    if cmd == "status":
        return {"state": public_state(load_json(STATE, {}))}
    if cmd == "logs":
        return {"log": tail_log(int(msg.get("lines", 80)))}
    raise HostError("Неизвестная команда: %r" % cmd)


def main():
    ensure_dirs()
    while True:
        try:
            msg = read_message()
        except ValueError:
            send_message({"ok": False, "error": "Некорректное сообщение."})
            continue
        if msg is None:
            break
        try:
            res = handle(msg)
            res["ok"] = True
        except HostError as e:
            res = {"ok": False, "error": str(e)}
        except Exception as e:  # never crash silently in front of Firefox
            res = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
        send_message(res)


if __name__ == "__main__":
    main()
