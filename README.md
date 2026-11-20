# Amnezia Browser Client — AmneziaWG VPN для Firefox

Неофициальный клиент AmneziaWG: расширение Firefox, которое пускает **только трафик браузера**
через VPN-сервер AmneziaWG. Остальные программы на компьютере ходят в сеть напрямую.
Права администратора не нужны. Работает на **Windows, macOS и Linux**.

## Как это устроено

```
Firefox ──proxy.onRequest──▶ SOCKS5 127.0.0.1:40800 ──▶ wireproxy-awg ══AmneziaWG/UDP══▶ VPN-сервер
   │                               (логин/пароль генерируются при каждом запуске)
   └─ nativeMessaging ──▶ awg_host (запуск/остановка wireproxy, профили, статистика)
```

Расширение не может само открыть UDP-туннель, поэтому туннель поднимает
[wireproxy-awg](https://github.com/artem-russkikh/wireproxy-awg) — userspace-клиент AmneziaWG
(поддерживает AWG 1.0 / 1.5 / 2.0 / 3.0 / 3.1) с SOCKS5-прокси. Помощник `awg_host` написан на Go
(один исполняемый файл без зависимостей) и запускает wireproxy по команде расширения.

## Возможности

- Вкл/выкл одной кнопкой, значок на панели: ON / … / ! (ошибка).
- Несколько серверов: импорт `.conf` (файлом или вставкой) и ключей `vpn://…` из приложения Amnezia.
  Конфиги с ключами хранятся в папке помощника (см. ниже) с доступом только для вашего
  пользователя, а не в профиле Firefox.
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

## Установка

Нужны две части: **помощник** на компьютере и **расширение** в Firefox (140+).

### Windows

1. Скачайте архив `amnezia-browser-client-<версия>-windows.zip` (раздел Releases) и распакуйте.
2. Запустите `install.cmd`. Скрипт поставит `awg_host.exe`, скачает официальный wireproxy-awg
   v1.0.18 с GitHub со сверкой SHA-256 и зарегистрирует помощника в Firefox
   (`HKCU\Software\Mozilla\NativeMessagingHosts\awg_firefox`).
   Без интернета: положите `wireproxy.exe` рядом с `install.cmd`.
3. Перезапустите Firefox и откройте `.xpi` из архива.

Собрать архив самому (на любой системе с Go): `./scripts/build-windows.sh`
(`INCLUDE_WIREPROXY=1` — положить в архив wireproxy.exe для установки без интернета).

### macOS и Linux

1. Нужен Go 1.22+ (`brew install go`, в Linux — пакет `golang`).
2. Собрать и установить помощника и wireproxy-awg:
   ```bash
   ./scripts/install.sh
   ```
   Готовые бинарники вместо сборки: `HOST_BIN=… WIREPROXY_BIN=… ./scripts/install.sh`.
3. Перезапустите Firefox и установите расширение (см. ниже).

### Расширение

- **Подписанный `.xpi`** — перетащите в окно Firefox, останется после перезапуска.
  Подписать самому для своего распространения: `./scripts/sign.sh` (спросит API-ключ AMO,
  https://addons.mozilla.org/developers/addon/api/key/), файл появится в `web-ext-artifacts/`.
- **Для разработки**: `about:debugging#/runtime/this-firefox` → «Загрузить временное дополнение…» →
  `extension/manifest.json` (сбрасывается при перезапуске Firefox).

Дальше: откроется страница настроек → «Добавить сервер» → вставьте конфиг AmneziaWG → выберите
сервер → включите тумблер в popup.

Где взять конфиг: в приложении AmneziaVPN «Поделиться» → формат **AmneziaWG** (файл `.conf`),
либо экспорт туннеля из AmneziaWG, либо ключ `vpn://`.

## Где лежат данные

| Система | Папка помощника | Регистрация в Firefox |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\AWG-Browser` | реестр `HKCU\Software\Mozilla\NativeMessagingHosts\awg_firefox` |
| macOS | `~/Library/Application Support/AWG-Firefox` | `~/Library/Application Support/Mozilla/NativeMessagingHosts/awg_firefox.json` |
| Linux | `~/.config/awg-browser` | `~/.mozilla/native-messaging-hosts/awg_firefox.json` |

Внутри: `profiles/` (конфиги с ключами), `run/state.json` (запущенный туннель), `logs/wireproxy.log`.

## Удаление

- Windows: `uninstall.cmd` (полностью, с профилями: `uninstall.ps1 -Purge`).
- macOS, Linux: `./scripts/uninstall.sh` (с профилями: `--purge`).

## Файлы

| Путь | Что это |
| --- | --- |
| `extension/` | само расширение (Manifest V3, Firefox 140+) |
| `extension/background.js` | маршрутизация `proxy.onRequest`, запуск туннеля, kill switch, WebRTC |
| `extension/lib/rules.js` | правила «через VPN / напрямую» |
| `extension/popup/`, `extension/options/` | интерфейс |
| `native-host/` | помощник native messaging на Go (`go test ./...` — тесты, в т.ч. с поддельным wireproxy) |
| `scripts/install.sh`, `uninstall.sh` | установка/удаление на macOS и Linux |
| `scripts/windows/` | установка/удаление на Windows (`install.cmd`, `install.ps1`) |
| `scripts/build-windows.sh` | архив для Windows `dist/amnezia-browser-client-<версия>-windows.zip` |
| `scripts/build-xpi.sh` | упаковка неподписанного `.xpi` |
| `scripts/sign.sh` | подпись на AMO: `unlisted` (по умолчанию) или `listed` |

## Ограничения

- UDP через SOCKS5 в wireproxy не поддерживается: QUIC/HTTP3 Firefox сам откатывает на TCP,
  WebRTC-звонки через VPN не пойдут (при включённой защите WebRTC использует только прокси).
- Официальный wireproxy-awg для Windows есть только для x64; на Windows ARM он работает через
  эмуляцию.
- `awg_host.exe` не подписан сертификатом Microsoft: SmartScreen может показать предупреждение.

## Лицензия

MIT, см. [LICENSE](LICENSE). wireproxy-awg — отдельный проект под лицензией ISC, в репозиторий не
входит: установщики собирают его из исходников (macOS, Linux) или скачивают официальный релиз
(Windows).
