// ttyd serves its own document into each iframe, but same-origin (proxied
// through /term/<id>/) means we can reach into it and inject our own
// styling: scrollbars to match the rest of the app, and a @font-face for the
// terminal font. The latter matters because ttyd is started with
// fontFamily='DejaVu Sans Mono' (see server/sshManager.js) but that name is
// only meaningful if the same font is actually loaded in this document -
// otherwise each client falls back to whatever "DejaVu Sans Mono"/monospace
// resolves to locally. This keeps regular terminal text consistent across
// clients; it's not what makes box-drawing characters (tmux panes, htop,
// vim splits on the remote host) render correctly - that depends on the
// container having a UTF-8 locale (see the LANG/LC_ALL comment in
// sshManager.js) - once real Unicode box characters are sent, xterm's own
// vector renderer draws them regardless of font.
function styleTerminalFrame(iframe) {
  iframe.addEventListener('load', () => {
    let doc;
    try {
      doc = iframe.contentDocument;
    } catch (e) {
      return; // not same-origin (e.g. about:blank in some browsers) - skip
    }
    if (!doc || !doc.head) return;
    const style = doc.createElement('style');
    style.textContent = `
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono.woff2') format('woff2');
        font-weight: normal;
        font-style: normal;
      }
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono-Bold.woff2') format('woff2');
        font-weight: bold;
        font-style: normal;
      }
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono-Oblique.woff2') format('woff2');
        font-weight: normal;
        font-style: italic;
      }
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono-BoldOblique.woff2') format('woff2');
        font-weight: bold;
        font-style: italic;
      }

      * { scrollbar-width: thin; scrollbar-color: #3e3d38 transparent; }
      *::-webkit-scrollbar { width: 10px; height: 10px; }
      *::-webkit-scrollbar-track { background: transparent; }
      *::-webkit-scrollbar-thumb {
        background-color: #3e3d38;
        border-radius: 6px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      *::-webkit-scrollbar-thumb:hover { background-color: #7a7870; background-clip: padding-box; }
      *::-webkit-scrollbar-corner { background: transparent; }
    `;
    doc.head.appendChild(style);

    // xterm.js (inside ttyd's iframe) measures its own cell/column metrics
    // against whatever font is actually loaded at that moment, which can
    // race ahead of the @font-face fetch above - especially over a real
    // (non-local) network, where the woff2 fetch can take long enough that
    // tmux's very first attach-redraw lands before the font arrives. That
    // first paint bakes in fallback-font cell metrics into xterm's renderer
    // that persist even after the real font loads - a later same-size
    // resize doesn't fix it, because xterm only remeasures glyph width when
    // the *container* actually changes size or when a font-related terminal
    // option changes; it has no way to know a @font-face it isn't watching
    // just became available. `document.fonts.load(...)` only loads the one
    // weight/style you ask for, so all four (regular/bold/italic/
    // bold-italic) must be listed explicitly or `document.fonts.ready` can
    // resolve without ever having touched the bold/italic faces.
    if (doc.fonts) {
      const variants = [
        "16px 'DejaVu Sans Mono'",
        "bold 16px 'DejaVu Sans Mono'",
        "italic 16px 'DejaVu Sans Mono'",
        "italic bold 16px 'DejaVu Sans Mono'",
      ];
      Promise.all(variants.map((v) => doc.fonts.load(v).catch(() => {})))
        .then(() => doc.fonts.ready)
        .then(() => {
          try {
            // ttyd exposes its live xterm.js Terminal instance as
            // `window.term` inside its own iframe document. Verified (via a
            // raw CDP network throttle + `document.fonts.check()` poll) that
            // once the real font finishes loading late, xterm's cached cell
            // width/height do NOT get remeasured on their own. Re-assigning
            // `fontFamily` to its *own current value* does nothing either:
            // xterm's OptionsService no-ops same-value writes, so the change
            // handler that would trigger CharSizeService never fires.
            // Toggling to a throwaway value first forces a real change,
            // which does trigger it.
            const term = iframe.contentWindow.term;
            if (term && term.options) {
              const family = term.options.fontFamily;
              term.options.fontFamily = 'monospace';
              term.options.fontFamily = family;
              if (term._core && term._core._charSizeService) {
                term._core._charSizeService.measure();
              }
            }
            // Let ttyd's own window-resize listener turn the now-correct
            // cell size into new rows/cols and propagate that to the server
            // - reaching in to call fitAddon.fit() directly bypasses that
            // propagation and desyncs the pty's idea of the terminal size
            // from what's on screen.
            iframe.contentWindow.dispatchEvent(new Event('resize'));
          } catch (e) {
            // iframe navigated away already - nothing to fix up
          }
        });
    }
  });
}

// --- Terminal font size ---
// ttyd reads `fontSize` (and other ITerminalOptions keys) from the iframe
// URL's query string as a per-client override - see parseOptsFromUrlQuery in
// ttyd's bundled frontend. That's the officially supported way to set it;
// there's no other reach-in point since ttyd's Terminal instance isn't
// exposed on the iframe's window.
const FONT_SIZE_DEFAULT = 12;

// Cache-busted so a re-used id (shouldn't normally happen, but keeps this
// robust) actually navigates the iframe rather than being a no-op src set.
function terminalUrl(id) {
  return `/term/${id}/?fontSize=${FONT_SIZE_DEFAULT}&_=${Date.now()}`;
}

// --- Open-session state ---
// tabs: [{ id, username, host, port, machineName, iframe }]
const tabs = [];
let activeId = null;

const terminalsEl = document.getElementById('terminals');
const tabBarEl = document.getElementById('tab-bar');
const controlsEl = document.getElementById('controls');

function createIframeForTab(id) {
  const iframe = document.createElement('iframe');
  iframe.className = 'term-frame';
  iframe.title = 'Terminal';
  iframe.src = terminalUrl(id);
  styleTerminalFrame(iframe);
  terminalsEl.appendChild(iframe);
  return iframe;
}

function findTab(id) {
  return tabs.find((t) => t.id === id);
}

function addTab(info) {
  const iframe = createIframeForTab(info.id);
  tabs.push({ ...info, iframe });
  setActive(info.id);
}

function setActive(id) {
  activeId = id;
  tabs.forEach((t) => t.iframe.classList.toggle('active', t.id === id));
  const t = findTab(id);
  document.title = t && t.machineName ? `${t.machineName} — wetty` : 'wetty';
  render();
}

// Ends the given session server-side and drops its tab/iframe. If that was
// the last one left, a totally blank app would have nowhere for the user to
// go, so the default session is reopened automatically - the same "closing
// always leaves you with a working terminal" behavior this app has always
// had, just now scoped to the empty-tabs edge case instead of every close.
async function removeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [removed] = tabs.splice(idx, 1);
  removed.iframe.remove();
  fetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});

  if (tabs.length === 0) {
    await openDefaultSession();
  } else if (activeId === id) {
    setActive(tabs[Math.max(0, idx - 1)].id);
  } else {
    render();
  }
}

function render() {
  if (tabs.length < 2) {
    tabBarEl.hidden = true;
    tabBarEl.innerHTML = '';
    document.body.classList.remove('has-tabs');
    controlsEl.hidden = false;
    return;
  }

  document.body.classList.add('has-tabs');
  controlsEl.hidden = true;
  tabBarEl.hidden = false;
  tabBarEl.innerHTML = '';

  tabs.forEach((t, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'tab-sep';
      sep.textContent = '·';
      tabBarEl.appendChild(sep);
    }

    const tabEl = document.createElement('span');
    tabEl.className = 'tab' + (t.id === activeId ? ' active' : '');
    tabEl.textContent = `${t.username}@${t.host}`;
    tabEl.addEventListener('click', () => setActive(t.id));

    if (t.id === activeId) {
      const closeEl = document.createElement('span');
      closeEl.className = 'tab-close';
      closeEl.textContent = '×';
      closeEl.title = 'Close';
      closeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTab(t.id);
      });
      tabEl.appendChild(closeEl);
    }

    tabBarEl.appendChild(tabEl);
  });

  const addEl = document.createElement('span');
  addEl.className = 'tab-add';
  addEl.textContent = '+';
  addEl.title = 'New session';
  addEl.addEventListener('click', () => togglePopover());
  tabBarEl.appendChild(addEl);
}

// --- Session creation ---

async function openDefaultSession() {
  const [res, config] = await Promise.all([
    fetch('/api/sessions/default', { method: 'POST' }),
    getDefaultConfig(),
  ]);
  const data = await res.json().catch(() => ({}));
  if (!data.ok) return;
  addTab({ id: 'default', ...config, machineName: data.machineName });
}

async function openNewSession(target) {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) return;
  upsertHistory(target);
  addTab({ id: data.id, ...target, machineName: data.machineName });
}

let defaultConfigPromise = null;
function getDefaultConfig() {
  if (!defaultConfigPromise) {
    defaultConfigPromise = fetch('/api/config').then((r) => r.json());
  }
  return defaultConfigPromise;
}

// --- History (localStorage) ---

const HISTORY_KEY = 'wetty:connections';
const HISTORY_LIMIT = 20;

function targetKey(t) {
  return `${t.username}@${t.host}:${t.port}`;
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}

function upsertHistory(target) {
  const list = loadHistory().filter((e) => targetKey(e) !== targetKey(target));
  list.unshift({ ...target, lastUsedAt: Date.now() });
  saveHistory(list.slice(0, HISTORY_LIMIT));
}

// --- Add-session popover ---

const popoverEl = document.getElementById('add-popover');
const inputEl = document.getElementById('add-input');
const errorEl = document.getElementById('add-error');
const historyListEl = document.getElementById('history-list');

// user@host[:port] - port optional, defaults to 22.
const TARGET_RE = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+)(?::(\d{1,5}))?$/;

function parseTargetString(str) {
  const match = str.trim().match(TARGET_RE);
  if (!match) return null;
  const port = match[3] ? parseInt(match[3], 10) : 22;
  if (port < 1 || port > 65535) return null;
  return { username: match[1], host: match[2], port };
}

function togglePopover() {
  if (popoverEl.hidden) openPopover(); else closePopover();
}

async function openPopover() {
  popoverEl.hidden = false;
  errorEl.textContent = '';
  inputEl.value = '';

  const config = await getDefaultConfig();
  inputEl.hidden = !config.allowRemoteSessions;
  errorEl.hidden = !config.allowRemoteSessions;

  await renderHistoryList();
  if (config.allowRemoteSessions) inputEl.focus();
}

function closePopover() {
  popoverEl.hidden = true;
}

async function renderHistoryList() {
  historyListEl.innerHTML = '';
  const config = await getDefaultConfig();
  const pinnedKey = targetKey(config);

  const pinnedEl = document.createElement('div');
  pinnedEl.className = 'history-item pinned';
  pinnedEl.textContent = pinnedKey;
  pinnedEl.addEventListener('click', async () => {
    closePopover();
    await openNewSession(config);
  });
  historyListEl.appendChild(pinnedEl);

  // With remote sessions disabled, the pinned row above (repeatable) is the
  // only thing on offer - no other target, including ones from history, is
  // reachable through this UI.
  if (!config.allowRemoteSessions) return;

  // Entries matching the pinned default are skipped here - that target is
  // already covered by the pinned row above (which itself can be clicked
  // any number of times to open more sessions to it).
  loadHistory()
    .filter((entry) => targetKey(entry) !== pinnedKey)
    .forEach((entry) => {
      const el = document.createElement('div');
      el.className = 'history-item';
      el.textContent = targetKey(entry);
      el.addEventListener('click', async () => {
        closePopover();
        await openNewSession(entry);
      });
      historyListEl.appendChild(el);
    });
}

inputEl.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const target = parseTargetString(inputEl.value);
  if (!target) {
    errorEl.textContent = 'Expected format: user@host[:port]';
    return;
  }
  closePopover();
  await openNewSession(target);
});

document.addEventListener('click', (e) => {
  if (popoverEl.hidden) return;
  if (popoverEl.contains(e.target)) return;
  if (e.target.closest('#add-btn') || e.target.closest('.tab-add')) return;
  closePopover();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !popoverEl.hidden) closePopover();
});

document.getElementById('add-btn').addEventListener('click', () => togglePopover());

// Kills the actual tmux session for the active tab (see closeSession in
// server/sshManager.js) so the ssh reconnect loop backing it stops instead
// of just detaching.
document.getElementById('close-btn').addEventListener('click', async () => {
  if (!activeId) return;
  if (!confirm('Close the connection? This ends the current session.')) return;
  await removeTab(activeId);
});

openDefaultSession();
