Amnezia Browser Client для Windows
==================================

Неофициальный клиент AmneziaWG VPN для Firefox: через VPN идёт только трафик браузера.

Что в архиве
  awg_host.exe      помощник: запускает и останавливает туннель wireproxy-awg
  install.cmd       установка помощника (двойной щелчок)
  uninstall.cmd     удаление помощника
  install.ps1, uninstall.ps1   сами сценарии установки и удаления
  *.xpi             подписанное расширение Firefox (если есть в архиве)

Установка
  1. Распакуйте архив в любую папку.
  2. Запустите install.cmd. Права администратора не нужны.
     Сценарий скачает wireproxy-awg v1.0.18 с GitHub (artem-russkikh/wireproxy-awg)
     и сверит контрольную сумму SHA-256. Если интернета нет — положите wireproxy.exe
     рядом с install.cmd.
     Если Windows SmartScreen предупредит о неизвестном издателе — «Подробнее» →
     «Выполнить в любом случае» (файлы не подписаны сертификатом Microsoft).
  3. Перезапустите Firefox и откройте файл .xpi (перетащите его в окно Firefox).
  4. На странице настроек расширения: «Добавить сервер» → вставьте конфиг AmneziaWG
     (.conf или ключ vpn://) → выберите сервер → включите VPN в окне расширения.

Где лежат данные
  %LOCALAPPDATA%\AWG-Browser\profiles   конфиги серверов с ключами
  %LOCALAPPDATA%\AWG-Browser\logs       журнал wireproxy
  Реестр: HKCU\Software\Mozilla\NativeMessagingHosts\awg_firefox

Удаление
  uninstall.cmd — удаляет помощник, профили остаются.
  Полностью: powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge

Исходный код: https://github.com/BorisGB2001/AWG-Browser
