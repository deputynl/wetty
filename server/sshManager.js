const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns');

const execFileAsync = promisify(execFile);

const TMUX_CONF = '/etc/tmux.conf';
const TMUX_SESSION = 'wetty';
const DEFAULT_ID = 'default';

// Off by default: with no remote sessions allowed, the only thing the "add
// session" UI can do is open more copies of the one configured target -
// this app doesn't become a general-purpose SSH jump box just because a
// browser can reach it, unless an operator opts into that explicitly.
const ALLOW_REMOTE_SESSIONS = process.env.ALLOW_REMOTE_SESSIONS === 'true';

// The reconnect loop runs as a shell script (not string-interpolated) so
// the target reaches it as positional args ($1/$2/$3) rather than needing
// to be spliced into a command string. Args, not env vars: tmux's *server*
// (already running after the first session) forks every later pane using
// the environment it captured at server-start time, not the environment of
// whatever client just asked for a new session - so a second session's own
// SSH_HOST/SSH_PORT/SSH_USER env vars are silently ignored in favor of the
// first session's, and it connects to the wrong host. Positional args don't
// have this problem: they're part of the `new-session ... sh -c script arg
// arg arg` command itself, which is per-invocation regardless of the
// server's cached environment.
// tmux keeps this pane alive across dropped *browser* connections; the loop
// itself keeps retrying so a dropped *ssh* connection (flaky wifi, laptop
// sleep) doesn't strand you at a dead shell either - it just prints a
// reconnect notice and tries again.
//
// The `tmux set-option default-command ...` line makes a mouse-driven split
// or new-window (the pane menu in tmux.conf, or Ctrl-b %/"/c) reconnect to
// this same target too, instead of dropping to a plain local shell - it's
// a *session*-scoped option, set from inside the very session it applies
// to (tmux always resolves `set-option` without `-t` to "the current
// session"), which sidesteps needing a separate server-side call timed
// against a session that may not exist yet (ttyd only actually creates it
// once a browser client connects).
//
// This line runs through two different shells, deliberately: $1/$2/$3 are
// expanded *now*, by the shell running this script, into a plain string
// with the target baked in literally - the single quotes around '$1@$2'
// are NOT parsed as quoting at this stage (they're just literal characters
// inside an already-double-quoted argument) and end up embedded verbatim
// in the stored default-command value. They start doing real quoting only
// the *second* time this text is parsed - as a shell command in its own
// right, by whatever shell tmux later runs default-command through for a
// new pane.
const RECONNECT_SCRIPT = `tmux set-option default-command "while true; do ssh -p $3 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3 '$1@$2'; echo; echo '[wetty] connection closed, reconnecting in 3s... (Ctrl-C to cancel this attempt)'; sleep 3; done"
while true; do
  ssh -p "$3" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3 "$1@$2"
  echo
  echo "[wetty] connection closed, reconnecting in 3s... (Ctrl-C to cancel this attempt)"
  sleep 3
done`;

// id -> { id, proc, ttydPort, tmuxSession, username, host, port }
const sessions = new Map();

// SSH_HOST is often an IP in homelab setups; PTR-resolve it to a real
// hostname for display (e.g. the browser tab) so the tab reads "nas" rather
// than "192.168.1.50". Falls back to the host itself - unchanged if it's
// already a hostname, or if there's no PTR record for the IP. Cached per
// host since it won't change for the life of the process and a missing PTR
// record would otherwise mean a fresh (slow) DNS timeout on every connect.
const machineNameCache = new Map();

function resolveMachineName(host) {
  if (!machineNameCache.has(host)) {
    machineNameCache.set(host, (async () => {
      if (!net.isIP(host)) return host;
      try {
        const names = await dns.promises.reverse(host);
        return names[0].replace(/\.$/, '');
      } catch {
        return host;
      }
    })());
  }
  return machineNameCache.get(host);
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
// Hostname or IPv4/IPv6 literal. Not exhaustive DNS-label validation - just
// enough to reject shell/command-injection-relevant characters, since these
// values ultimately reach `ssh` via env vars.
const HOST_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9.:-]{0,253}[a-zA-Z0-9])?$/;

// Values come from the browser now (not just trusted env vars), so they're
// validated before ever reaching a spawned process - and even then, only
// ever passed as argv elements to `ssh`/the reconnect script, never
// interpolated into a command string.
function validateTarget({ username, host, port }) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new Error('Invalid username');
  }
  if (typeof host !== 'string' || !HOST_RE.test(host)) {
    throw new Error('Invalid host');
  }
  const portNum = port === undefined || port === null || port === '' ? 22 : Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error('Invalid port');
  }
  return { username, host, port: portNum };
}

// Binds to port 0 to let the OS pick a free ephemeral port, then releases it
// immediately for ttyd to bind - each session gets its own dedicated ttyd
// process (and therefore its own port) rather than sharing one.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
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

async function spawnSession(sessionId, tmuxSession, target) {
  const ttydPort = await getFreePort();

  const proc = spawn('ttyd', [
    '-p', String(ttydPort),
    '-W',
    '-t', 'disableLeaveAlert=true',
    '-t', 'fontSize=16',
    // Vendored so terminal text renders identically regardless of what's
    // installed client-side, matched by the @font-face injected into the
    // iframe in app.js. Plain DejaVu Sans Mono, not a Nerd Font build.
    // ttyd drops everything after the first comma in a -t value, so no
    // ", monospace" fallback here - it would be a no-op.
    '-t', "fontFamily='DejaVu Sans Mono'",
    'tmux', '-f', TMUX_CONF, 'new-session', '-A', '-s', tmuxSession,
    'sh', '-c', RECONNECT_SCRIPT, 'wetty-ssh', target.username, target.host, String(target.port),
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
    env: {
      ...process.env,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      COLORTERM: 'truecolor',
    },
  });

  proc.on('exit', (code) => {
    console.log(`ttyd (session ${sessionId}) exited (code ${code})`);
    sessions.delete(sessionId);
  });

  const entry = { id: sessionId, proc, ttydPort, tmuxSession, ...target };
  sessions.set(sessionId, entry);
  await waitForPort(ttydPort);
  return entry;
}

function getDefaultTarget() {
  if (!process.env.SSH_HOST || !process.env.SSH_USER) {
    throw new Error('SSH_HOST and SSH_USER environment variables must be set');
  }
  return validateTarget({
    username: process.env.SSH_USER,
    host: process.env.SSH_HOST,
    port: process.env.SSH_PORT,
  });
}

function isDefaultTarget(target) {
  const def = getDefaultTarget();
  return target.username === def.username && target.host === def.host && target.port === def.port;
}

// The one session tied to the env-configured target (SSH_HOST/PORT/USER).
// Kept under a fixed id and a fixed tmux session name ("wetty", unchanged
// from before this file supported multiple sessions) so a browser reload
// reattaches to it via `tmux -A` instead of starting a fresh connection -
// the property this app has always had for its "main" session. Any other
// session - including one opened manually to this exact same target - gets
// its own random id/tmux name via createSession() below instead, so it's
// independent and won't be reattached-to by accident.
async function createDefaultSession() {
  const existing = sessions.get(DEFAULT_ID);
  if (existing) return { id: DEFAULT_ID, port: existing.ttydPort, machineName: await resolveMachineName(existing.host) };

  const target = getDefaultTarget();
  const entry = await spawnSession(DEFAULT_ID, TMUX_SESSION, target);
  return { id: DEFAULT_ID, port: entry.ttydPort, machineName: await resolveMachineName(target.host) };
}

// Always starts a brand new, independently-tracked session - even if one
// already exists for the same username/host/port - so opening the same
// target twice gives you two separate tmux sessions instead of reattaching
// to the first. With ALLOW_REMOTE_SESSIONS unset/false, this is restricted
// to the configured target itself (still lets you open more of those) -
// this is the actual enforcement point, not just a UI affordance, since the
// request reaching here came from the browser.
async function createSession(input) {
  const target = validateTarget(input || {});
  if (!ALLOW_REMOTE_SESSIONS && !isDefaultTarget(target)) {
    throw new Error('Remote sessions are disabled (set ALLOW_REMOTE_SESSIONS=true to allow connecting to other targets)');
  }
  const id = crypto.randomBytes(4).toString('hex');
  const entry = await spawnSession(id, `wetty-${id}`, target);
  return { id, port: entry.ttydPort, machineName: await resolveMachineName(target.host) };
}

function getSessionPort(id) {
  const entry = sessions.get(id);
  return entry ? entry.ttydPort : null;
}

// Kills the tmux session outright (not just the client attached to it via
// ttyd), which is what actually ends the reconnect loop and the ssh
// connection it's driving - detaching, or just killing ttyd's pty, would
// leave the `while true` loop in RECONNECT_SCRIPT running server-side. The
// ttyd process itself is also killed here: unlike the old single-shared-ttyd
// design, each session now has its own dedicated ttyd, so there's nothing
// else it could still be needed for.
async function closeSession(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  try {
    await execFileAsync('tmux', ['-f', TMUX_CONF, 'kill-session', '-t', entry.tmuxSession]);
  } catch {
    // No session running - already effectively closed.
  }
  try {
    entry.proc.kill();
  } catch {
    // Already exited.
  }
  sessions.delete(id);
}

module.exports = {
  createDefaultSession,
  createSession,
  getSessionPort,
  closeSession,
  resolveMachineName,
  ALLOW_REMOTE_SESSIONS,
};
