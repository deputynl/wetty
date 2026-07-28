# wetty

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A small self-hosted web UI for persistent SSH terminals in the browser.
Point it at a machine via environment variables, open the page, and you're
connected - reload the tab, close your laptop, get on a flaky connection,
whatever - the underlying session keeps running in `tmux` on the server and
you just reattach. From there you can open additional terminals, each with
its own independent `tmux` session - even a second one to the same target.
By default those additional terminals are still restricted to the
configured target; set `ALLOW_REMOTE_SESSIONS=true` to allow opening
sessions to any other `user@host:port` from the UI too.

## How it works

- **Server** (`server/index.js`): a tiny Express app that serves the page
  and reverse-proxies terminal traffic (HTTP + WebSocket), per session, to
  the `ttyd` instance backing it.
- **Sessions** (`server/sshManager.js`): each open terminal gets its own
  `ttyd tmux new-session -A -s <name> sh -c '<ssh reconnect loop>'`, on its
  own locally-allocated port.
  - The env-configured session (`SSH_HOST`/`SSH_PORT`/`SSH_USER`) always
    uses a fixed tmux session name, so a page reload reattaches to it via
    `tmux -A` instead of starting fresh - only the terminal view drops on a
    browser disconnect (flaky wifi, laptop sleep, closed tab), not the `ssh`
    process or its scrollback. Any other session - opened by hand from the
    UI - gets its own independent tmux session instead, even if it's to the
    same target, so it won't be reattached-to by accident.
  - The reconnect loop inside each session re-runs `ssh` if the connection
    itself drops (not just the browser), so a network blip on the *ssh*
    link also just gets retried instead of leaving you at a dead shell.
  - Right-click a pane (mouse mode is on, via `tmux.conf`) for a small
    curated menu - split, zoom, or close - restyled to roughly match the
    web UI instead of tmux's default. Splitting or opening a new window
    reconnects to that same session's target rather than dropping to a
    local shell in the container, since each session sets its own
    `default-command` to the same reconnect loop as its initial pane.
- **Frontend** (`public/`): one full-page iframe per open terminal, proxied
  to its `ttyd` instance. A small "+"/"×" control lets you add or close
  sessions; a minimal tab bar appears only once a second terminal is open,
  and disappears again once you're back down to one. Connection details you
  enter (`user@host[:port]`) are remembered in the browser's local storage
  for one-click reopening, with the env-configured target always pinned at
  the top of that list.

Only one port needs to leave the container - the `ttyd` processes it spawns
stay internal and are proxied through the server.

## Setup

1. Edit `docker-compose.yml` (or set these directly in your own
   orchestration) with the connection details:
   - `SSH_HOST` - hostname or IP to connect to
   - `SSH_PORT` - SSH port (defaults to `22`)
   - `SSH_USER` - remote username
2. Auth: by default `ssh` will prompt for a password right there in the
   browser terminal on connect. For passwordless login, mount a private key
   into the container instead, e.g.:
   ```yaml
   volumes:
     - ~/.ssh/id_ed25519:/root/.ssh/id_ed25519:ro
     - wetty-ssh:/root/.ssh
   ```
   The `wetty-ssh` named volume persists `known_hosts` across container
   restarts so you're not re-accepting the host key (or, without a mounted
   key, retyping your password) every single time.
3. Build and run:
   ```
   docker compose up -d --build
   ```
4. Open `http://<your-host>:8080`.
5. Put this behind whatever reverse proxy / auth you already use for other
   homelab services - the app only exposes one HTTP port and has no auth of
   its own.

### Using the published image

Skip the local build and pull the prebuilt image from GHCR instead:

```yaml
services:
  wetty:
    image: ghcr.io/deputynl/wetty:latest
    container_name: wetty
    ports:
      - "8080:8080"
    environment:
      SSH_HOST: your-host-or-ip
      SSH_PORT: "22"
      SSH_USER: your-user
    volumes:
      - wetty-ssh:/root/.ssh
    restart: unless-stopped

volumes:
  wetty-ssh:
```

```
docker compose up -d
```

## Environment variables

| Variable   | Default | Description                          |
|------------|---------|---------------------------------------|
| `SSH_HOST`              | -       | Required. Default host to connect to.  |
| `SSH_USER`              | -       | Required. Default remote username.     |
| `SSH_PORT`              | `22`    | Default remote SSH port.               |
| `PORT`                  | `8080`  | HTTP port the web UI listens on.       |
| `ALLOW_REMOTE_SESSIONS` | `false` | Allow opening sessions to targets other than the configured one - see below. |

`SSH_HOST`/`SSH_USER`/`SSH_PORT` are the *default* target: opened
automatically on load and pinned at the top of the connection list. By
default that's also the *only* target the UI can open - the "+" control
lets you start additional sessions to it (each an independent `tmux`
session, so you can have several terminals to the same box at once), but
the free-text `user@host[:port]` field and any other-host history entries
are hidden. Set `ALLOW_REMOTE_SESSIONS=true` to turn this into a general
jump box that can open a session to any host it can reach - see "Known
limitations" below before doing that on anything internet-facing.

## Files

```
Dockerfile           node + ttyd + tmux + openssh-client
docker-compose.yml   env vars for the target host, volume for known_hosts/keys
tmux.conf            mouse + scrollback settings for the persistent session
server/index.js      express app: static UI, http+ws proxy to ttyd
server/sshManager.js spawns/tracks the ttyd+tmux+ssh process
public/              vanilla JS/HTML/CSS frontend (no build step)
public/vendor/fonts/  vendored DejaVu Sans Mono (no CDN at runtime)
```

## Building and publishing an image

There's no CI workflow wired up - images are built and pushed by hand,
always for both `linux/amd64` and `linux/arm64` via buildx (so the same
tag works on a homelab x86 box or a Raspberry Pi / Apple Silicon host
without the puller needing to know or care). Every push tags the image
twice: `latest`, and a UTC build timestamp (`yyyymmddhhmmss`) so past
versions stay pullable and visible in the GHCR version list instead of
being silently overwritten:

```
docker buildx create --name wetty-builder --use   # one-time setup
TS=$(date -u +%Y%m%d%H%M%S)
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<you>/wetty:latest -t ghcr.io/<you>/wetty:$TS \
  --push .
```

(`buildx` cross-builds `arm64` under QEMU emulation, so this works from an
amd64 host - it's just slower than a native build, mainly on the `npm
install` and `apt-get` steps.)

The git side mirrors this: every release gets an immutable `yyyymmddhhmmss`
tag plus a `latest` tag that's force-moved to point at it (same idea as the
image's `latest`, so it needs `--force` since it's overwriting where the
tag used to point):

```
TS=$(date -u +%Y%m%d%H%M%S)
git tag -a "$TS" -m "$TS" HEAD
git push origin "$TS"
git tag -f latest HEAD
git push origin latest --force
gh release create "$TS" --title "$TS" --notes "..."
```

For a new GitHub repo from scratch:

```
git init
git add -A
git commit -m "Initial commit"
gh repo create <you>/wetty --public --source=. --push
```

(swap `--public` for `--private` as you prefer; `gh auth login` first if
you haven't authenticated the `gh` CLI yet.)

## Known limitations

- No auth of its own - anyone who can reach the HTTP port can open a
  terminal to the configured default target (and, with
  `ALLOW_REMOTE_SESSIONS=true`, anywhere else it can reach). Put it behind a
  reverse proxy / VPN / IDP.
- No idle-timeout/cleanup for `ttyd` processes - each stays running until
  its session is closed from the UI or the container restarts.

## License

[MIT](LICENSE)
