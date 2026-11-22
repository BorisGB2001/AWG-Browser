# Privacy Policy — Amnezia Browser Client

Last updated: 2026-11-22

Amnezia Browser Client ("the add-on") is an unofficial, open-source Firefox extension that routes browser traffic through an AmneziaWG VPN server chosen by the user. It works together with a small helper program ("awg_host") that the user installs on their computer.

## Data the add-on collects

None. The add-on and the helper have no analytics, telemetry, crash reporting or advertising, and the developer receives no data from them.

## Data stored on your device

- **Server configurations you import** (AmneziaWG `.conf` files or `vpn://` keys, including private keys): stored by the helper on your computer only, readable only by your user account:
  - Windows: `%LOCALAPPDATA%\AWG-Browser\profiles`
  - macOS: `~/Library/Application Support/AWG-Firefox/profiles`
  - Linux: `~/.config/awg-browser/profiles`
  They are not stored in the Firefox profile and are deleted when you remove the server or run the uninstaller with the purge option.
- **Settings** (selected server, routing mode, site lists, ports, kill switch and WebRTC options): in the add-on's local storage inside your Firefox profile (`storage.local`). Not synced.
- **Tunnel state and log**: the helper keeps the running tunnel's process id, local ports and a random one-time SOCKS5 password in `run/state.json`, and the output of wireproxy-awg in `logs/wireproxy.log`, in the same folder.

## Data sent over the network

- **To your AmneziaWG server** (the one in your configuration): the encrypted AmneziaWG tunnel carrying the browser traffic you choose to route through the VPN. This server is operated by you or by whoever gave you the configuration, not by the add-on developer.
- **Local only**: the add-on talks to the helper through Firefox native messaging and to the tunnel through a SOCKS5 proxy on `127.0.0.1`. Nothing leaves your computer this way.
- **"Check IP" button**: only when you click it, a request to `https://api.ipify.org` to show your current external IP address.
- **Windows installer**: once, during installation, downloads wireproxy-awg from its official GitHub release (`github.com/artem-russkikh/wireproxy-awg`) and verifies its SHA-256 checksum.

No other requests are made by the add-on or the helper.

## Contact

Questions and issues: https://github.com/BorisGB2001/AWG-Browser/issues
