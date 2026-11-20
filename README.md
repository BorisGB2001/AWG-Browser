# AmneziaWG для Firefox

Расширение Firefox, которое пускает **только трафик браузера** через VPN-сервер AmneziaWG.
Остальные программы на Mac ходят в сеть напрямую. Root не нужен.

## Как это устроено

```
Firefox ──proxy.onRequest──▶ SOCKS5 127.0.0.1:40800 ──▶ wireproxy-awg ══AmneziaWG/UDP══▶ VPN-сервер
   │                               (логин/пароль генерируются при каждом запуске)
   └─ nativeMessaging ──▶ native-host/awg_host.py (запуск/остановка wireproxy, профили, статистика)
```

Расширение не может само открыть UDP-туннель, поэтому туннель поднимает
[wireproxy-awg](https://github.com/artem-russkikh/wireproxy-awg) — userspace-клиент AmneziaWG
(поддерживает AWG 1.0 / 1.5 / 2.0 / 3.0 / 3.1) с SOCKS5-прокси. Помощник на Python запускает его
по команде расширения.

## Возможности

- Вкл/выкл одной кнопкой, значок на панели: ON / … / ! (ошибка).
- Несколько серверов: импорт `.conf` (файлом или вставкой) и ключей `vpn://…` из приложения Amnezia.
  Конфиги с ключами хранятся в `~/Library/Application Support/AWG-Firefox/profiles` (права 600),
  а не в профиле Firefox.
- Раздельное туннелирование:
  - «Всё через VPN, кроме списка» — исключения идут напрямую;
  - «Только сайты из списка через VPN».
  Домен включает поддомены; поддерживаются IPv4 и CIDR. Кнопка «текущий сайт» в popup.
- Локальные адреса (localhost, 192.168.*, 10.*, *.local) — всегда напрямую (отключаемо).
- DNS сайтов, идущих через VPN, резолвится внутри туннеля (`proxyDNS`).
- Kill switch: если туннель упал, трафик не уходит в обход VPN.
- Защита WebRTC (`disable_non_proxied_udp`), пока VPN включён.
- Автопереподключение (проверка раз в 30 с), статистика: последний handshake, принято/отправлено.
- Проверка внешнего IP (запрос к api.ipify.org только по кнопке).

## Установка (macOS)

1. Нужны Go (`brew install go`) и Python 3 (есть в Homebrew или Xcode CLT).
2. Установить помощник и собрать wireproxy-awg:
   ```bash
   ./scripts/install-macos.sh
   ```
   Уже есть собранный wireproxy-awg — можно без Go:
   `WIREPROXY_BIN=/путь/к/wireproxy ./scripts/install-macos.sh`.
3. Установить расширение в Firefox:
   - **для проверки**: `about:debugging#/runtime/this-firefox` → «Загрузить временное дополнение…» →
     `extension/manifest.json` (сбрасывается при перезапуске Firefox);
   - **постоянно**: обычный Firefox принимает только подписанные расширения. Варианты:
     подписать как unlisted на addons.mozilla.org (`npx web-ext sign --channel=unlisted`, нужен
     API-ключ AMO) либо использовать Firefox Developer Edition / Nightly с
     `xpinstall.signatures.required = false` и поставить `dist/*.xpi` (`./scripts/build-xpi.sh`).
4. Откроется страница настроек → «Добавить сервер» → вставьте конфиг AmneziaWG → выберите сервер →
   включите тумблер в popup.

Где взять конфиг: в приложении AmneziaVPN «Поделиться» → формат **AmneziaWG** (файл `.conf`),
либо экспорт туннеля из AmneziaWG.app, либо ключ `vpn://`.

## Удаление

```bash
./scripts/uninstall-macos.sh
```

С флагом `--purge` удаляются и профили с ключами.

## Файлы

| Путь | Что это |
| --- | --- |
| `extension/` | само расширение (Manifest V3, Firefox 128+) |
| `extension/background.js` | маршрутизация `proxy.onRequest`, запуск туннеля, kill switch, WebRTC |
| `extension/lib/rules.js` | правила «через VPN / напрямую» |
| `extension/popup/`, `extension/options/` | интерфейс |
| `native-host/awg_host.py` | помощник native messaging |
| `scripts/install-macos.sh` | сборка wireproxy-awg и регистрация помощника |
| `scripts/build-xpi.sh` | упаковка `dist/awg-firefox-<версия>.xpi` |

Данные помощника: `~/Library/Application Support/AWG-Firefox/` (`profiles/`, `run/state.json`,
`logs/wireproxy.log`). Манифест native host:
`~/Library/Application Support/Mozilla/NativeMessagingHosts/awg_firefox.json`.

## Ограничения

- UDP через SOCKS5 в wireproxy не поддерживается: QUIC/HTTP3 Firefox сам откатывает на TCP,
  WebRTC-звонки через VPN не пойдут (при включённой защите WebRTC использует только прокси).
- Пока что только macOS (скрипт установки). Помощник переносим на Linux — поменять пути в
  `install-macos.sh`.

## Лицензия

MIT, см. [LICENSE](LICENSE). wireproxy-awg — отдельный проект под лицензией ISC, в репозиторий не входит: скрипт установки собирает его из исходников.
