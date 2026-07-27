# wetty

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A small self-hosted web UI that gives you one thing: a browser tab with a
persistent SSH terminal to a host you configure via environment variables.
Point it at a machine, open the page, and you're connected - reload the tab,
close your laptop, get on a flaky connection, whatever - the underlying
session keeps running in `tmux` on the server and you just reattach.

## How it works

- **Server** (`server/index.js`): a tiny Express app that serves the page
  and reverse-proxies terminal traffic (HTTP + WebSocket) to a `ttyd`
  instance it spawns on demand.
- **Session** (`server/sshManager.js`): on first load, the server runs
  `ttyd tmux new-session -A -s wetty sh -c '<ssh reconnect loop>'`.
  - `tmux -A` attaches to the existing session if one's already running, or
    creates it. That's what makes browser reconnects (flaky wifi, laptop
    sleep, closed tab) safe - only the terminal view drops, the `ssh`
    process and its scrollback keep running in `tmux` until you come back.
  - The reconnect loop re-runs `ssh` if the connection itself drops (not
    just the browser), so a network blip on the *ssh* link also just gets
    retried instead of leaving you at a dead shell.
- **Frontend** (`public/`): a single full-page iframe pointed at the proxied
  `ttyd` instance, plus a small font-size control. No sidebar, no tabs, no
  file browser - just the terminal.

Only one port needs to leave the container - the `ttyd` process it spawns
stays internal and is proxied through the server.

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
| `SSH_HOST` | -       | Required. Host to connect to.         |
| `SSH_USER` | -       | Required. Remote username.            |
| `SSH_PORT` | `22`    | Remote SSH port.                      |
| `PORT`     | `8080`  | HTTP port the web UI listens on.      |
| `TTYD_PORT`| `7681`  | Internal port `ttyd` binds to.        |

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

There's no CI workflow wired up - images are built and pushed by hand:

```
docker build -t ghcr.io/<you>/wetty:latest .
docker push ghcr.io/<you>/wetty:latest
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

- No auth of its own - anyone who can reach the HTTP port can open the
  terminal. Put it behind a reverse proxy / VPN / IDP.
- Single target per deployment - run another container (different `PORT`,
  different env vars) if you want to reach a second host.
- No idle-timeout/cleanup for the `ttyd` process - it stays running until
  the container restarts.

## License

[MIT](LICENSE)
