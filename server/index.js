const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');

const {
  createDefaultSession,
  createSession,
  getSessionPort,
  closeSession,
  ALLOW_REMOTE_SESSIONS,
} = require('./sshManager');

const PORT = parseInt(process.env.PORT || '8080', 10);
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('error', (err, req, res) => {
  console.error('proxy error', err.message);
  if (res && res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Terminal session is not available yet, try again in a moment.');
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    username: process.env.SSH_USER,
    host: process.env.SSH_HOST,
    port: parseInt(process.env.SSH_PORT || '22', 10),
    allowRemoteSessions: ALLOW_REMOTE_SESSIONS,
  });
});

// The single env-configured session - reused across reloads (see
// createDefaultSession's comment in sshManager.js).
app.post('/api/sessions/default', async (req, res) => {
  try {
    const result = await createDefaultSession();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Any other session - always a fresh one, even for a target that already
// has a session open (see createSession's comment in sshManager.js).
app.post('/api/sessions', async (req, res) => {
  try {
    const result = await createSession(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  await closeSession(req.params.id);
  res.json({ ok: true });
});

// /term/<id>/... -> the ttyd instance backing that particular session.
// Splits query string off before matching so it can be re-appended to the
// stripped path, rather than getting swallowed by the path regex.
function parseTermPath(url) {
  const [pathPart, query] = url.split('?');
  const match = pathPart.match(/^\/term\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  if (!match) return null;
  const [, id, rest] = match;
  return { id, url: (rest || '/') + (query ? `?${query}` : '') };
}

app.use('/term', (req, res) => {
  const parsed = parseTermPath(req.originalUrl);
  if (!parsed) { res.status(404).end(); return; }
  const port = getSessionPort(parsed.id);
  if (!port) { res.status(404).send('Session not found - it may have been closed.'); return; }
  req.url = parsed.url;
  proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
});

const server = http.createServer(app);

// WebSocket upgrades (ttyd's actual terminal stream) need handling separately.
server.on('upgrade', (req, socket, head) => {
  const parsed = parseTermPath(req.url);
  if (!parsed) { socket.destroy(); return; }
  const port = getSessionPort(parsed.id);
  if (!port) { socket.destroy(); return; }
  req.url = parsed.url;
  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
});

server.listen(PORT, () => {
  console.log(`wetty listening on :${PORT} -> ${process.env.SSH_USER}@${process.env.SSH_HOST}:${process.env.SSH_PORT || 22}`);
});
