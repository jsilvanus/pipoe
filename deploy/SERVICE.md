# systemd user unit

`pipoe.service` runs pipoe as a systemd user service.

Expected layout (relative to the service user's home, `%h`):

- app checkout (built, with `dist/`): `~/apps/pipoe`
- environment file: `~/apps/pipoe.env` (all settings and secrets live here, never in git; see `deploy/pipoe.env.template` if present)
- Node.js: `~/.local/bin/node`

Install:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/pipoe.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pipoe
loginctl enable-linger "$USER"   # once, so it runs without a login session
```

Status and logs: `systemctl --user status pipoe`, `journalctl --user -u pipoe -f`.
