const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');

const { getOrStartSession, resolveMachineName, closeSession } = require('./sshManager');

const PORT = parseInt(process.env.PORT || '8080', 10);
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('error', (err, req, res) => {
  console.error('proxy error', err.message);
  if (res && res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Terminal session is not available yet, try again in a moment.');
  }
});

app.post('/api/session/start', async (req, res) => {
  try {
    const [port, machineName] = await Promise.all([getOrStartSession(), resolveMachineName()]);
    res.json({ ok: true, port, machineName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/session/close', async (req, res) => {
  await closeSession();
  res.json({ ok: true });
});

// /term/... -> the ttyd instance running the ssh session
app.use('/term', async (req, res) => {
  try {
    const port = await getOrStartSession();
    // Strip the /term prefix so ttyd sees paths as if it were root.
    req.url = req.originalUrl.replace(/^\/term/, '') || '/';
    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  } catch (err) {
    res.status(400).send(err.message);
  }
});

const server = http.createServer(app);

// WebSocket upgrades (ttyd's actual terminal stream) need handling separately.
server.on('upgrade', async (req, socket, head) => {
  if (!req.url.startsWith('/term')) { socket.destroy(); return; }
  try {
    const port = await getOrStartSession();
    req.url = req.url.replace(/^\/term/, '') || '/';
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
  } catch (err) {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`wetty listening on :${PORT} -> ${process.env.SSH_USER}@${process.env.SSH_HOST}:${process.env.SSH_PORT || 22}`);
});
