# AMO listing — Amnezia Browser Client

Copy these texts into the Developer Hub form (addons.mozilla.org → Developer Hub → the add-on →
Edit Product Page). Descriptions accept Markdown. The default locale is English (en-US); the Russian
texts go in as a translation ("Manage Translations" / «Локализовать на» → Русский).

## Basic info

| Field | Value |
|---|---|
| Name (en-US) | Amnezia Browser Client |
| Name (ru) | Amnezia Browser Client |
| Add-on URL slug | `amnezia-browser-client` |
| Categories | **Privacy & Security** |
| License | MIT |
| Homepage | https://github.com/BorisGB2001/AWG-Browser |
| Support site | https://github.com/BorisGB2001/AWG-Browser/issues |
| Privacy policy | paste `PRIVACY.md` |
| Experimental | no |
| Requires payment | no |

## Summary (en-US, ≤ 250 characters)

Unofficial AmneziaWG VPN client for Firefox only: a local wireproxy-awg tunnel, several servers, .conf and vpn:// import, per-site split tunneling, kill switch. Requires a small helper app. Open source.

## Summary (ru, ≤ 250 символов)

Неофициальный клиент AmneziaWG VPN только для Firefox: локальный туннель wireproxy-awg, несколько серверов, импорт .conf и vpn://, раздельное туннелирование по сайтам, kill switch. Нужен небольшой помощник. Открытый код.

## Description (en-US)

Amnezia Browser Client connects Firefox to your AmneziaWG VPN server. Only browser traffic goes through the tunnel; other apps on your computer keep using the normal connection. No administrator rights are needed.

**You need an AmneziaWG server** (self-hosted with Amnezia, or a configuration someone gave you). This add-on does not provide a VPN service.

**You also need the helper app.** Browser extensions cannot open UDP tunnels, so a small open-source helper starts [wireproxy-awg](https://github.com/artem-russkikh/wireproxy-awg) (a userspace AmneziaWG client) and Firefox uses it as a local SOCKS5 proxy. Download it from the [GitHub releases](https://github.com/BorisGB2001/AWG-Browser/releases):

- Windows: unzip and run `install.cmd`
- macOS, Linux: `./scripts/install.sh` (needs Go)

**Features**

- Import AmneziaWG `.conf` files or `vpn://` keys from the Amnezia app; AmneziaWG 1.0, 1.5, 2.0, 3.0, 3.1 and plain WireGuard
- Several servers, switchable from the toolbar popup
- Split tunneling: everything except a list, or only listed sites; domains, IPs and subnets; one click for the current site
- Local network addresses always go directly
- DNS for tunneled sites is resolved inside the tunnel
- Kill switch: if the tunnel is down, traffic does not bypass the VPN
- WebRTC IP leak protection while the VPN is on
- Automatic reconnect, handshake and traffic statistics, "Check IP" button

**Privacy**: no data collection. Server keys stay on your computer, in the helper's folder, not in the Firefox profile.

Open source (MIT): https://github.com/BorisGB2001/AWG-Browser
This is an unofficial project, not affiliated with Amnezia.

## Description (ru)

Amnezia Browser Client подключает Firefox к вашему VPN-серверу AmneziaWG. Через туннель идёт только трафик браузера, остальные программы на компьютере работают напрямую. Права администратора не нужны.

**Нужен сервер AmneziaWG** (свой, развёрнутый через Amnezia, или конфиг, который вам выдали). Расширение не предоставляет VPN-сервис.

**Нужна программа-помощник.** Расширения браузера не умеют открывать UDP-туннели, поэтому небольшой помощник с открытым кодом запускает [wireproxy-awg](https://github.com/artem-russkikh/wireproxy-awg) (клиент AmneziaWG), а Firefox работает через него как через локальный SOCKS5-прокси. Скачать: [релизы на GitHub](https://github.com/BorisGB2001/AWG-Browser/releases).

- Windows: распакуйте архив и запустите `install.cmd`
- macOS, Linux: `./scripts/install.sh` (нужен Go)

**Возможности**

- Импорт файлов `.conf` и ключей `vpn://` из приложения Amnezia; AmneziaWG 1.0, 1.5, 2.0, 3.0, 3.1 и обычный WireGuard
- Несколько серверов с переключением в окне расширения
- Раздельное туннелирование: всё, кроме списка, или только сайты из списка; домены, IP и подсети; текущий сайт одним нажатием
- Адреса локальной сети всегда напрямую
- DNS для сайтов через VPN определяется внутри туннеля
- Kill switch: если туннель упал, трафик не идёт в обход VPN
- Защита от утечки IP через WebRTC, пока VPN включён
- Автопереподключение, статистика рукопожатия и трафика, кнопка «Проверить IP»

**Конфиденциальность**: данные не собираются. Ключи серверов хранятся на вашем компьютере в папке помощника, а не в профиле Firefox.

Открытый код (MIT): https://github.com/BorisGB2001/AWG-Browser
Неофициальный проект, не связан с Amnezia.

## Notes for reviewers

The add-on needs a native messaging helper (`awg_host`, Go, open source in `native-host/` of the
repository) that starts wireproxy-awg, a userspace AmneziaWG client exposing a SOCKS5 proxy on
127.0.0.1. Permissions:

- `proxy` + `<all_urls>`: route requests to the local SOCKS5 proxy according to the user's site lists
  (`proxy.onRequest`); local network addresses always go direct.
- `nativeMessaging`: start/stop the tunnel, import/list server configurations, read tunnel statistics.
- `privacy`: set `webRTCIPHandlingPolicy` to `disable_non_proxied_udp` while the VPN is on, cleared when off.
- `alarms`: health check of the tunnel every 30 seconds while the VPN is on.
- `storage`: settings. `activeTab`: show the current site's route in the popup.

No remote code, no analytics. The only external request from the add-on is `https://api.ipify.org`,
made only when the user clicks "Check IP". To test without the helper, the options page shows
"helper not found" and the toggle reports an error; with the helper and any AmneziaWG/WireGuard
config the tunnel can be checked with "Check IP".
