// ttyd serves its own document into this iframe, but same-origin (proxied
// through /term/) means we can reach into it and inject our own styling:
// scrollbars to match the rest of the app, and a @font-face for the
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

const termFrame = document.getElementById('term-frame');
styleTerminalFrame(termFrame);

// --- Terminal font size ---
// ttyd reads `fontSize` (and other ITerminalOptions keys) from the iframe
// URL's query string as a per-client override - see parseOptsFromUrlQuery in
// ttyd's bundled frontend. That's the officially supported way to set it;
// there's no other reach-in point since ttyd's Terminal instance isn't
// exposed on the iframe's window.
const FONT_SIZE_KEY = 'wetty.terminalFontSize';
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;
const FONT_SIZE_DEFAULT = 12;
const FONT_SIZE_STEP = 2;

function getFontSize() {
  const stored = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
  if (Number.isNaN(stored)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, stored));
}

function terminalUrl() {
  return `/term/?fontSize=${getFontSize()}`;
}

function updateFontSizeDisplay() {
  const size = getFontSize();
  document.getElementById('font-size-value').textContent = size;
  document.getElementById('font-size-dec').disabled = size <= FONT_SIZE_MIN;
  document.getElementById('font-size-inc').disabled = size >= FONT_SIZE_MAX;
}

function setFontSize(size) {
  localStorage.setItem(FONT_SIZE_KEY, String(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size))));
  updateFontSizeDisplay();

  // Reload the terminal iframe so the new size takes effect immediately -
  // ttyd's backing tmux session is persistent, so this just reconnects the
  // websocket and redraws, no session/scrollback loss.
  if (termFrame.src) termFrame.src = terminalUrl();
}

document.getElementById('font-size-dec').addEventListener('click', () => setFontSize(getFontSize() - FONT_SIZE_STEP));
document.getElementById('font-size-inc').addEventListener('click', () => setFontSize(getFontSize() + FONT_SIZE_STEP));
updateFontSizeDisplay();

// Kick off (or reattach to) the tmux/ssh session, then point the iframe at it.
(async function start() {
  const res = await fetch('/api/session/start', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (data.machineName) document.title = `${data.machineName} — wetty`;
  termFrame.src = terminalUrl();
})();
