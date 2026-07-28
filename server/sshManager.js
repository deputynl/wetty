const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const dns = require('dns');

const execFileAsync = promisify(execFile);

const TTYD_PORT = parseInt(process.env.TTYD_PORT || '7681', 10);
const TMUX_CONF = '/etc/tmux.conf';
const TMUX_SESSION = 'wetty';

// The reconnect loop runs as a shell script (not string-interpolated) so
// SSH_HOST/SSH_PORT/SSH_USER reach it as inherited env vars rather than
// needing to be spliced into a command string. tmux keeps this pane alive
// across dropped *browser* connections; the loop itself keeps retrying so a
// dropped *ssh* connection (flaky wifi, laptop sleep) doesn't strand you at
// a dead shell either - it just prints a reconnect notice and tries again.
const RECONNECT_SCRIPT = `while true; do
  ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3 "$SSH_USER@$SSH_HOST"
  echo
  echo "[wetty] connection closed, reconnecting in 3s... (Ctrl-C to cancel this attempt)"
  sleep 3
done`;

let session = null; // { proc }

// SSH_HOST is often an IP in homelab setups; PTR-resolve it to a real
// hostname for display (e.g. the browser tab) so the tab reads "nas" rather
// than "192.168.1.50". Falls back to SSH_HOST itself - unchanged if it's
// already a hostname, or if there's no PTR record for the IP. Cached since
// it won't change for the life of the process and a missing PTR record
// would otherwise mean a fresh (slow) DNS timeout on every session start.
let machineNamePromise = null;

function resolveMachineName() {
  if (!machineNamePromise) {
    machineNamePromise = (async () => {
      const host = process.env.SSH_HOST;
      if (!net.isIP(host)) return host;
      try {
        const names = await dns.promises.reverse(host);
        return names[0].replace(/\.$/, '');
      } catch {
        return host;
      }
    })();
  }
  return machineNamePromise;
}

function waitForPort(port, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('ttyd did not start in time'));
        setTimeout(tryConnect, 150);
      });
    };
    tryConnect();
  });
}

// Returns the local port the ttyd instance is listening on, starting it (and
// the tmux session wrapping the ssh reconnect loop) if it isn't running yet.
async function getOrStartSession() {
  if (session) return session.port;

  if (!process.env.SSH_HOST || !process.env.SSH_USER) {
    throw new Error('SSH_HOST and SSH_USER environment variables must be set');
  }

  const proc = spawn('ttyd', [
    '-p', String(TTYD_PORT),
    '-W',
    '-t', 'disableLeaveAlert=true',
    '-t', 'fontSize=16',
    // Vendored so terminal text renders identically regardless of what's
    // installed client-side, matched by the @font-face injected into the
    // iframe in app.js. Plain DejaVu Sans Mono, not a Nerd Font build.
    // ttyd drops everything after the first comma in a -t value, so no
    // ", monospace" fallback here - it would be a no-op.
    '-t', "fontFamily='DejaVu Sans Mono'",
    'tmux', '-f', TMUX_CONF, 'new-session', '-A', '-s', TMUX_SESSION,
    'sh', '-c', RECONNECT_SCRIPT,
  ], {
    stdio: 'inherit',
    // Without a UTF-8 locale, curses apps (htop, vim, tmux itself, ...) can't
    // confirm the terminal supports Unicode and fall back to a degraded
    // ASCII/VT100 line-drawing rendering for box borders - literal
    // underscores and disconnected line segments instead of real "╭─╮" etc.
    // node:20-slim has no locale configured at all (`locale -a` only lists
    // C/C.utf8/POSIX) and doesn't need one installed - C.utf8 is already
    // there, just unused by default.
    //
    // COLORTERM=truecolor is what tmux checks (alongside the outer TERM's
    // terminfo) to decide whether to advertise 24-bit "Tc"/"RGB" color to
    // apps running inside it - without it, tmux falls back to 256-color
    // even though xterm.js and the escape codes flowing through it both
    // support full RGB.
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' },
  });

  proc.on('exit', (code) => {
    console.log(`ttyd exited (code ${code})`);
    session = null;
  });

  session = { port: TTYD_PORT, proc };
  await waitForPort(TTYD_PORT);
  return session.port;
}

// Kills the tmux session outright (not just the client attached to it via
// ttyd), which is what actually ends the reconnect loop and the ssh
// connection it's driving - detaching, or just killing ttyd's pty, would
// leave the `while true` loop in sshManager's RECONNECT_SCRIPT running
// server-side, so `tmux new-session -A` on the next login would just
// re-attach to the same still-open connection instead of starting fresh.
// ttyd itself is left running: it's a long-lived process that spawns a new
// tmux client per websocket connection, so there's nothing to restart there
// - the next `/term/` connection will have tmux create a brand new session
// since the old one is gone.
async function closeSession() {
  try {
    await execFileAsync('tmux', ['-f', TMUX_CONF, 'kill-session', '-t', TMUX_SESSION]);
  } catch {
    // No session running - already effectively closed.
  }
}

module.exports = { getOrStartSession, resolveMachineName, closeSession };
