/**
 * Richup.io Overnight Coin Farming Bot (Szybka & Pewna Konfiguracja)
 * Architektura:
 *  - Okno 1 (HOST): Twoje główne konto (zapisana sesja w profiles/host) - ZAWSZE WYGRYWA
 *  - Okno 2 (BOT 1): Konto gościa (profiles/bot1) - poddaje się po 50 rundach (lub wcześniej przy długu < $0)
 *  - Okno 3 (BOT 2): Konto gościa (profiles/bot2) - poddaje się po 60 rundach (lub wcześniej przy długu < $0)
 *
 * Zasady maksymalizujące szybkość zdobywania monet i statystyk profilu:
 *  1. Host tworzy prywatny pokój, ustawia "Maximum players = 3", "Starting cash = $3000" oraz wyłącza boty AI.
 *  2. Gdy wszystkie 3 okna (Host + Bot 1 + Bot 2) zajmą miejsca przy stole (3/3), Host przełącza pokój na
 *     PUBLICZNY ("Private room" -> OFF -> "Make public") i od razu klika "Start Game".
 *     Dzięki temu nikt obcy nie wejdzie (3/3 zajęte), a gra liczy się zarówno do monet, jak i statystyk profilu!
 *  3. Jeśli HOST posiada cały zestaw kolorystyczny (monopol) i ma minimum $1500 gotówki, automatycznie
 *     kupuje domki/hotele na swoich polach, aby szybciej wykończyć boty i przyspieszyć grę.
 *  4. Przyspieszony cykl akcji (350ms) oraz zmniejszony limit rund do poddania (50 i 60 rund).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ==================== BLOKADA PODWÓJNEGO URUCHOMIENIA (PID LOCK) ====================
const PID_FILE = path.join(__dirname, 'bot.pid');
try {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 'SIGTERM');
        console.log(`[INIT] Zamknięto poprzednią instancję bota (PID ${oldPid}).`);
      } catch (_) {}
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
} catch (_) {}

// ==================== KONFIGURACJA ====================
const CONFIG = {
  bot1SurrenderRound: 50,  // Bot 1 poddaje się po 50 swoich rundach (lub gdy zbankrutuje na czynszu)
  bot2SurrenderRound: 60,  // Bot 2 poddaje się po 60 swoich rundach (lub gdy zbankrutuje na czynszu)
  hostMinCashForHouses: 1500, // Host buduje domki/hotele na zestawach tylko gdy ma >= $1500
  tickIntervalMs: 350,     // Przyspieszona pętla sprawdzania stanu gry (350ms)
  maxGameDurationMs: 35 * 60 * 1000, // Watchdog: max 35 minut na jedną grę
  chromePath: findChromePath(),
  instances: [
    {
      id: 'host',
      name: 'HOST (Główne Konto)',
      port: 9222,
      profileDir: path.join(__dirname, 'profiles', 'host'),
      windowPos: '0,0',
      windowSize: '640,900',
      surrenderAtRound: Infinity, // Host NIGDY się nie poddaje
      preferredColorIndex: 0,
    },
    {
      id: 'bot1',
      name: 'BOT 1 (Gość - 50 rund)',
      port: 9223,
      profileDir: path.join(__dirname, 'profiles', 'bot1'),
      windowPos: '640,0',
      windowSize: '640,900',
      surrenderAtRound: 50,
      preferredColorIndex: 3,
    },
    {
      id: 'bot2',
      name: 'BOT 2 (Gość - 60 rund)',
      port: 9224,
      profileDir: path.join(__dirname, 'profiles', 'bot2'),
      windowPos: '1280,0',
      windowSize: '640,900',
      surrenderAtRound: 60,
      preferredColorIndex: 7,
    },
  ],
};

function findChromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Nie znaleziono przeglądarki Google Chrome ani Microsoft Edge!');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================== KLIENT CDP (Chrome DevTools Protocol) ====================
class BrowserClient {
  constructor(instanceConfig) {
    this.cfg = instanceConfig;
    this.proc = null;
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
    this.rounds = 0;
    this.surrendered = false;
    this.joinedLobby = false;
    this.lastAction = 'Inicjalizacja...';
    this.lastRollTimestamp = 0;
    this.lastTurnstileClick = 0;
  }

  async launch() {
    fs.mkdirSync(this.cfg.profileDir, { recursive: true });

    try {
      const res = await fetch(`http://127.0.0.1:${this.cfg.port}/json`);
      if (res.ok) {
        console.log(`[${this.cfg.name}] Wykryto otwarte okno na porcie ${this.cfg.port} – podłączam się!`);
        await this.connectCDP();
        return;
      }
    } catch (_) {}

    const args = [
      `--remote-debugging-port=${this.cfg.port}`,
      `--user-data-dir=${this.cfg.profileDir}`,
      `--window-position=${this.cfg.windowPos}`,
      `--window-size=${this.cfg.windowSize}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      '--mute-audio',
      'https://richup.io/',
    ];

    console.log(`[${this.cfg.name}] Uruchamianie przeglądarki (port ${this.cfg.port})...`);
    this.proc = spawn(CONFIG.chromePath, args, { detached: false, stdio: 'ignore' });
    await this.connectCDP();
  }

  async connectCDP() {
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.cfg.port}/json`);
        const targets = await res.json();
        const pageTarget = targets.find(
          (t) => t.type === 'page' && (t.url.includes('richup.io') || t.url.startsWith('http') || t.url === 'about:blank')
        );
        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          await this.openWebSocket(pageTarget.webSocketDebuggerUrl);
          return;
        }
      } catch (_) {}
      await sleep(500);
    }
    throw new Error(`[${this.cfg.name}] Nie udało się połączyć z portem debugowania ${this.cfg.port}`);
  }

  openWebSocket(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = async () => {
        try {
          await this.send('Page.enable');
          await this.send('Runtime.enable');
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.id && this.pending.has(data.id)) {
            const { resolve: res, reject: rej } = this.pending.get(data.id);
            this.pending.delete(data.id);
            if (data.error) rej(new Error(data.error.message));
            else res(data.result);
          }
        } catch (_) {}
      };

      ws.onerror = (err) => reject(err);
      ws.onclose = () => {
        this.ws = null;
      };
    });
  }

  async ensureConnected() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connectCDP();
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket nie jest połączony'));
      }
      const id = this.msgId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout CDP dla ${method}`));
        }
      }, 8000);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(fnOrExpr, arg = undefined) {
    await this.ensureConnected();
    const expression =
      typeof fnOrExpr === 'function'
        ? `(${fnOrExpr.toString()})(${JSON.stringify(arg)})`
        : fnOrExpr;
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res && res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || 'Błąd wykonania JS w przeglądarce');
    }
    return res?.result?.value;
  }

  async navigate(url) {
    await this.ensureConnected();
    await this.send('Page.navigate', { url });
  }

  async nativeMouseClick(x, y) {
    await this.ensureConnected();
    const rx = Math.round(x + (Math.random() * 4 - 2));
    const ry = Math.round(y + (Math.random() * 4 - 2));
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.max(1, rx - 15),
      y: Math.max(1, ry - 10),
    });
    await sleep(50);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rx,
      y: ry,
    });
    await sleep(35);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rx,
      y: ry,
      button: 'left',
      clickCount: 1,
    });
    await sleep(65);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rx,
      y: ry,
      button: 'left',
      clickCount: 1,
    });
  }

  async checkAndSolveTurnstile() {
    if (Date.now() - this.lastTurnstileClick < 4000) return false;

    const box = await this.eval(() => {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const ifr of iframes) {
        const src = (ifr.src || '').toLowerCase();
        const r = ifr.getBoundingClientRect();
        if (
          r.width >= 200 &&
          r.height >= 45 &&
          r.height <= 120 &&
          (src.includes('cloudflare') || src.includes('turnstile') || src.includes('challenge') || r.width <= 360)
        ) {
          return { x: r.left + 28, y: r.top + r.height / 2, found: 'iframe' };
        }
      }

      const bodyText = document.body ? document.body.innerText : '';
      if (/loading game/i.test(bodyText)) {
        const divs = Array.from(document.querySelectorAll('div'));
        for (const d of divs) {
          if (d.closest('#richup-bot-hud')) continue;
          const r = d.getBoundingClientRect();
          if (r.width >= 280 && r.width <= 325 && r.height >= 55 && r.height <= 78 && r.top > 200) {
            return { x: r.left + 28, y: r.top + r.height / 2, found: 'shadow-container' };
          }
        }
      }
      return null;
    });

    if (box && box.x > 0 && box.y > 0) {
      this.lastTurnstileClick = Date.now();
      this.lastAction = '🛡️ Klikam weryfikację Cloudflare...';
      console.log(`[${this.cfg.name}] 🛡️ Wykryto Cloudflare Turnstile (${box.found}) – klikam checkbox (${Math.round(box.x)}, ${Math.round(box.y)})...`);
      await this.nativeMouseClick(box.x, box.y);
      return true;
    }
    return false;
  }

  resetForNewGame() {
    this.rounds = 0;
    this.surrendered = false;
    this.joinedLobby = false;
    this.lastAction = 'Nowa gra...';
    this.lastRollTimestamp = 0;
  }
}

// ==================== SKRYPTY WSTRZYKIWANE DO STRONY (DOM HELPERS) ====================

function pageUpdateHUD(hudData) {
  let box = document.getElementById('richup-bot-hud');
  if (!box) {
    box = document.createElement('div');
    box.id = 'richup-bot-hud';
    box.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'z-index:2147483647',
      'background:rgba(15, 23, 42, 0.92)',
      'color:#f8fafc',
      'padding:10px 14px',
      'border-radius:10px',
      'font-family:Segoe UI, Arial, sans-serif',
      'font-size:12px',
      'line-height:1.45',
      'border:2px solid #6366f1',
      'box-shadow:0 8px 20px rgba(0,0,0,0.5)',
      'min-width:240px',
      'user-select:none',
    ].join(';');

    box.innerHTML = `
      <div style="font-weight:700;font-size:13px;color:#818cf8;margin-bottom:4px;" id="rb-title"></div>
      <div id="rb-stats"></div>
      <div id="rb-action" style="color:#38bdf8;font-weight:600;margin-top:4px;"></div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;" id="rb-controls"></div>
    `;
    document.body.appendChild(box);

    window.__rbState = window.__rbState || {
      paused: false,
      forceNewRoom: false,
      forceSurrender: false,
    };

    const controls = box.querySelector('#rb-controls');

    const btnPause = document.createElement('button');
    btnPause.id = 'rb-btn-pause';
    btnPause.style.cssText = 'padding:3px 8px;border-radius:5px;border:none;cursor:pointer;font-weight:600;font-size:11px;background:#22c55e;color:#fff;';
    btnPause.onclick = () => {
      window.__rbState.paused = !window.__rbState.paused;
    };
    controls.appendChild(btnPause);

    if (hudData.roleId === 'host') {
      const btnNew = document.createElement('button');
      btnNew.textContent = '🔄 Nowy pokój';
      btnNew.style.cssText = 'padding:3px 8px;border-radius:5px;border:none;cursor:pointer;font-weight:600;font-size:11px;background:#3b82f6;color:#fff;';
      btnNew.onclick = () => {
        window.__rbState.forceNewRoom = true;
      };
      controls.appendChild(btnNew);
    } else {
      const btnSurr = document.createElement('button');
      btnSurr.textContent = '🏳️ Poddaj teraz';
      btnSurr.style.cssText = 'padding:3px 8px;border-radius:5px;border:none;cursor:pointer;font-weight:600;font-size:11px;background:#ef4444;color:#fff;';
      btnSurr.onclick = () => {
        window.__rbState.forceSurrender = true;
      };
      controls.appendChild(btnSurr);
    }
  }

  window.__rbState = window.__rbState || { paused: false, forceNewRoom: false, forceSurrender: false };

  let newlyEarnedCoins = 0;
  if (hudData.roleId === 'host' && document.body) {
    const txt = document.body.innerText || '';
    const m = txt.match(/You just earned\s+(\d+)\s+Coin/i);
    if (m) {
      if (!window.__rbCoinToastSeen) {
        window.__rbCoinToastSeen = true;
        newlyEarnedCoins = parseInt(m[1], 10) || 1;
      }
    } else if (/You earned a coin for this win/i.test(txt)) {
      if (!window.__rbCoinToastSeen) {
        window.__rbCoinToastSeen = true;
        newlyEarnedCoins = 1;
      }
    } else {
      window.__rbCoinToastSeen = false;
    }
  }

  const titleEl = box.querySelector('#rb-title');
  const statsEl = box.querySelector('#rb-stats');
  const actionEl = box.querySelector('#rb-action');
  const btnPause = box.querySelector('#rb-btn-pause');

  if (titleEl) titleEl.textContent = `🤖 ${hudData.name}`;
  if (statsEl) {
    const limitStr = hudData.surrenderAtRound > 9999 ? 'NIGDY (Wygrywa)' : `${hudData.surrenderAtRound}`;
    statsEl.innerHTML =
      `🏆 Wygrane: <b>${hudData.gamesWon}</b> (Gra #${hudData.gameNumber}) | 🪙 Monety: <b style="color:#facc15;">${hudData.coinsEarned}</b><br>` +
      `🎲 Rundy tego bota: <b>${hudData.rounds}</b> / ${limitStr}<br>` +
      `📊 Rundy B1 / B2: <b>${hudData.bot1Rounds}/${hudData.bot1Limit}</b> | <b>${hudData.bot2Rounds}/${hudData.bot2Limit}</b>`;
  }
  if (actionEl) {
    actionEl.textContent = window.__rbState.paused ? '⏸️ WSTRZYMANO (Kliknij Wznów)' : `▶ ${hudData.lastAction}`;
  }
  if (btnPause) {
    btnPause.textContent = window.__rbState.paused ? '▶️ Wznów bota' : '⏸️ Pauza';
    btnPause.style.background = window.__rbState.paused ? '#f59e0b' : '#22c55e';
  }

  const out = {
    url: location.href,
    paused: !!window.__rbState.paused,
    forceNewRoom: !!window.__rbState.forceNewRoom,
    forceSurrender: !!window.__rbState.forceSurrender,
    newlyEarnedCoins,
  };
  window.__rbState.forceNewRoom = false;
  window.__rbState.forceSurrender = false;
  return out;
}

function pageClickCreatePrivateGame() {
  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0';
  };

  const smartClick = (el) => {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  };

  // 1. Zamykanie okienka RODO ("Consent")
  const gdprBtn = document.querySelector('.fc-cta-consent, button.fc-primary-button');
  if (gdprBtn && isVisible(gdprBtn)) {
    smartClick(gdprBtn);
    return { clicked: false, gdprClicked: true };
  }

  const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div')).filter((el) => {
    if (!isVisible(el) || el.disabled || el.closest('#richup-bot-hud')) return false;
    const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return txt.length > 0 && txt.length <= 45;
  });

  candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);

  for (const b of candidates) {
    const t = (b.innerText || b.textContent || '').trim().toLowerCase();
    if (t === 'consent' || t === 'accept' || t === 'agree' || t === 'zgadzam się' || t === 'zaakceptuj') {
      smartClick(b);
    }
  }

  const patterns = [
    /create a private game/i,
    /create private game/i,
    /private game/i,
    /play with friends/i,
    /prywatn/i,
    /graj ze znajomymi/i,
    /create room/i,
  ];

  for (const pat of patterns) {
    const match = candidates.find((b) => {
      const txt = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
      return pat.test(txt);
    });
    if (match) {
      smartClick(match);
      return { clicked: true, text: (match.innerText || '').trim() };
    }
  }
  return { clicked: false };
}

/**
 * Obsługa lobby:
 *  1. Zamyka okienko RODO ("Consent").
 *  2. Klika ">> Enter Game".
 *  3. Wybiera wolny wygląd pionka (button[aria-label^="Select appearance"]:not(:disabled)) i klika "Join game".
 *  4. U Hosta ustawia po kolei (czekając aż zniknie "Updating settings..."):
 *     - "Maximum players" = 3
 *     - "Starting cash" = $3000
 *     - "Allow bots to join" = OFF
 *  5. Gdy wszystkie 3 okna siedzą przy stole (allJoined === true, 3/3 miejsc zajętych):
 *     - Host wyłącza "Private room" i klika "Make public" w okienku modalnym
 *     - Gdy pokój jest już publiczny, Host klika "Start Game".
 */
function pageLobbyTick(params) {
  const { isHost, preferredColorIndex, allJoined } = params;

  const isVisible = (el) => {
    if (!el) return false;
    // Ignoruj ukryty overlay dołączania (.KdB0kL15 bez klasy .ExumLxlw)
    if (el.closest('.KdB0kL15:not(.ExumLxlw)')) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  };

  const smartClick = (el) => {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  };

  const setReactSelectValue = (sel, newVal) => {
    // 1. Wywołaj bezpośrednio props.onChange komponentu oI przez React Fiber
    const fk = Object.keys(sel).find((k) => k.startsWith('__reactFiber$'));
    let fib = fk ? sel[fk] : null;
    for (let i = 0; i < 6 && fib; i++, fib = fib.return) {
      if (Array.isArray(fib.memoizedProps?.options) && typeof fib.memoizedProps?.onChange === 'function') {
        fib.memoizedProps.onChange(String(newVal));
        return true;
      }
    }
    // 2. Fallback przez __reactProps$ na elemencie <select>
    const propKey = Object.keys(sel).find((k) => k.startsWith('__reactProps$'));
    if (propKey && typeof sel[propKey]?.onChange === 'function') {
      sel[propKey].onChange({ target: { value: String(newVal) } });
      return true;
    }
    sel.value = String(newVal);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const getToggleFiberProps = (btn) => {
    if (!btn) return null;
    const fk = Object.keys(btn).find((k) => k.startsWith('__reactFiber$'));
    let fib = fk ? btn[fk] : null;
    for (let i = 0; i < 6 && fib; i++, fib = fib.return) {
      if (typeof fib.memoizedProps?.isOn === 'boolean') {
        return fib.memoizedProps;
      }
    }
    return null;
  };

  // KROK 0: Natychmiastowe zamykanie okienka RODO ("Consent")
  const gdprBtn =
    document.querySelector('.fc-cta-consent, button.fc-primary-button') ||
    Array.from(document.querySelectorAll('button, [role="button"]')).find((el) => {
      if (!isVisible(el) || el.closest('#richup-bot-hud')) return false;
      const t = (el.innerText || el.textContent || '').trim();
      return /^(consent|accept all|zgadzam się)$/i.test(t);
    });
  if (gdprBtn && isVisible(gdprBtn)) {
    smartClick(gdprBtn);
    return { action: 'gdpr_consent_clicked', isSeatedInLobby: false };
  }

  const getClickableElements = (includeDisabled = false) => {
    const all = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
    const filtered = all.filter((el) => {
      if (!isVisible(el) || (!includeDisabled && el.disabled) || el.closest('#richup-bot-hud')) return false;
      const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 40) return false;
      const tag = el.tagName.toLowerCase();
      const cursor = getComputedStyle(el).cursor;
      return tag === 'button' || el.getAttribute('role') === 'button' || cursor === 'pointer';
    });
    filtered.sort((a, b) => {
      const aIsBtn = a.tagName === 'BUTTON' ? 0 : 1;
      const bIsBtn = b.tagName === 'BUTTON' ? 0 : 1;
      if (aIsBtn !== bIsBtn) return aIsBtn - bIsBtn;
      return (a.innerText || '').length - (b.innerText || '').length;
    });
    return filtered;
  };

  const clickables = getClickableElements(false);
  const findClickable = (regex) =>
    clickables.find((el) => {
      const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return regex.test(txt);
    });

  // Sprawdzenie czy gracz już siedzi przy stole (ma swój wiersz [data-is-me="true"] na liście graczy)
  const isAlreadyInPlayerList = !!document.querySelector('[data-is-me="true"]');
  const changeAppearanceBtn = findClickable(/change appearance|zmień wygląd/i);
  const startGameBtn = findClickable(/start game|rozpocznij grę/i);
  const isSeatedInLobby = isAlreadyInPlayerList || !!changeAppearanceBtn || !!startGameBtn;

  const bodyText = document.body ? document.body.innerText : '';
  if (!isSeatedInLobby && /loading game/i.test(bodyText) && !findClickable(/enter game|join game/i)) {
    return { action: 'loading_game', isSeatedInLobby: false };
  }

  // KROK 1 i KROK 2 wykonujemy TYLKO wtedy, gdy gracz NIE siedzi jeszcze przy stole!
  if (!isSeatedInLobby) {
    // KROK 1: Ekran powitalny ("Your nickname..." + przycisk ">> Enter Game")
    const enterGameBtn = findClickable(/enter game|wejdź do gry/i);
    if (enterGameBtn) {
      smartClick(enterGameBtn);
      return { action: 'enter_game_clicked', label: (enterGameBtn.innerText || '').trim(), isSeatedInLobby: false };
    }

    // KROK 2: Ekran wyboru wyglądu pionka ("Select your player appearance:" + kółka button[aria-label^="Select appearance"])
    const appearanceBtns = Array.from(document.querySelectorAll('button[aria-label^="Select appearance"]')).filter(
      (b) => isVisible(b) && !b.disabled
    );
    const anyJoinBtn = getClickableElements(true).find((el) =>
      /^(join game|dołącz do gry)$/i.test((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
    );

    if (appearanceBtns.length > 0 || anyJoinBtn) {
      const enabledJoinBtn = findClickable(/^(join game|dołącz do gry)$/i);
      if (!enabledJoinBtn && appearanceBtns.length > 0) {
        window.__rbColorTry = (window.__rbColorTry || 0) + 1;
        const idx = ((preferredColorIndex || 0) + window.__rbColorTry) % appearanceBtns.length;
        const chosenCircle = appearanceBtns[idx];
        smartClick(chosenCircle);
        return {
          action: 'appearance_selected',
          label: chosenCircle.getAttribute('aria-label') || 'kolor',
          isSeatedInLobby: false,
        };
      }

      if (enabledJoinBtn) {
        smartClick(enabledJoinBtn);
        return { action: 'join_clicked', label: (enabledJoinBtn.innerText || '').trim(), isSeatedInLobby: false };
      }
    }
  }

  // KROK 4: Sprawdzenie czy gra już wystartowała
  const inGameIndicator = findClickable(/^(roll the dice|roll again|end turn|rzuć kostką|zakończ turę)$/i);
  if (inGameIndicator && !startGameBtn) {
    return { action: 'game_already_started', isSeatedInLobby: true };
  }

  // KROK 5 (HOST): Konfiguracja ustawień pokoju (z limitem prób, aby nigdy nie zablokować Start Game)
  if (isHost && isSeatedInLobby) {
    // 5A. Jeśli otwarte jest okienko potwierdzenia "Make public", kliknij je od razu!
    const makePublicModalBtn = findClickable(/^make public$/i);
    if (makePublicModalBtn) {
      smartClick(makePublicModalBtn);
      return { action: 'make_public_confirmed', isSeatedInLobby: true };
    }

    const selects = Array.from(document.querySelectorAll('select')).filter((s) => !s.disabled);

    // 5B. Ustaw "Maximum players" = 3 (maksymalnie 2 próby na pokój)
    if ((window.__rbTriesMaxPlayers || 0) < 2) {
      for (const sel of selects) {
        const optValues = Array.from(sel.options).map((o) => o.value);
        if (optValues.includes('2') && optValues.includes('3') && optValues.includes('4') && sel.value !== '3') {
          window.__rbTriesMaxPlayers = (window.__rbTriesMaxPlayers || 0) + 1;
          setReactSelectValue(sel, '3');
          return { action: 'max_players_set_3', isSeatedInLobby: true };
        }
      }
    }

    // 5C. Ustaw "Starting cash" = $3000 (maksymalnie 2 próby na pokój)
    if ((window.__rbTriesCash || 0) < 2) {
      for (const sel of selects) {
        const optValues = Array.from(sel.options).map((o) => o.value);
        if (optValues.includes('1500') && optValues.includes('3000') && sel.value !== '3000') {
          window.__rbTriesCash = (window.__rbTriesCash || 0) + 1;
          setReactSelectValue(sel, '3000');
          return { action: 'starting_cash_set_3000', isSeatedInLobby: true };
        }
      }
    }

    // 5D. Upewnij się, że "Allow bots to join" jest wyłączone (OFF)
    if ((window.__rbTriesBots || 0) < 2) {
      const botsToggleBtn = document.querySelector('button[aria-label="Allow bots to join"]');
      const botsProps = getToggleFiberProps(botsToggleBtn);
      if (botsToggleBtn && !botsToggleBtn.disabled && botsProps?.isOn === true) {
        window.__rbTriesBots = (window.__rbTriesBots || 0) + 1;
        smartClick(botsToggleBtn);
        return { action: 'bots_disabled', isSeatedInLobby: true };
      }
    }

    // 5E. Gdy wszystkie 3 okna siedzą przy stole (3/3), przełącz "Private room" -> OFF ("Make public") i kliknij "Start Game"
    if (allJoined) {
      if ((window.__rbMakePublicTries || 0) < 2) {
        let privateToggleBtn = null;
        for (const btn of Array.from(document.querySelectorAll('button'))) {
          if (!getToggleFiberProps(btn)) continue;
          let cur = btn.parentElement;
          for (let i = 0; i < 5 && cur; i++, cur = cur.parentElement) {
            const txt = (cur.innerText || '').trim();
            if (/^Private room\b/i.test(txt)) {
              privateToggleBtn = btn;
              break;
            }
          }
          if (privateToggleBtn) break;
        }

        const privProps = getToggleFiberProps(privateToggleBtn);
        if (privateToggleBtn && !privateToggleBtn.disabled && privProps?.isOn === true) {
          window.__rbMakePublicTries = (window.__rbMakePublicTries || 0) + 1;
          if (typeof privProps.onClick === 'function') privProps.onClick();
          else smartClick(privateToggleBtn);
          return { action: 'toggled_private_off', isSeatedInLobby: true };
        }
      }

      if (startGameBtn) {
        smartClick(startGameBtn);
        return { action: 'start_clicked', isSeatedInLobby: true };
      }
    }
  }

  return {
    action: isSeatedInLobby ? 'seated_in_lobby' : 'waiting_in_lobby',
    isSeatedInLobby,
    hasStartGameBtn: !!startGameBtn,
  };
}

/**
 * Główny krok rozgrywki wykonywany w każdym z 3 okien podczas trwania meczu
 */
function pageGameplayTick(params) {
  const { isHost, minCashForHouses, shouldSurrender, allowGameOverCheck } = params;

  const isVisible = (el) => {
    if (!el) return false;
    if (el.closest('.KdB0kL15:not(.ExumLxlw)')) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  };

  const smartClick = (el) => {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  };

  const getClickableElements = () => {
    const all = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
    const filtered = all.filter((el) => {
      if (!isVisible(el) || el.disabled || el.closest('#richup-bot-hud')) return false;
      const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 45) return false;
      const tag = el.tagName.toLowerCase();
      const cursor = getComputedStyle(el).cursor;
      return tag === 'button' || el.getAttribute('role') === 'button' || cursor === 'pointer';
    });
    filtered.sort((a, b) => {
      const aIsBtn = a.tagName === 'BUTTON' ? 0 : 1;
      const bIsBtn = b.tagName === 'BUTTON' ? 0 : 1;
      if (aIsBtn !== bIsBtn) return aIsBtn - bIsBtn;
      return (a.innerText || '').length - (b.innerText || '').length;
    });
    return filtered;
  };

  const buttons = getClickableElements();

  const findBtn = (regex) =>
    buttons.find((b) => {
      const txt = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
      return regex.test(txt);
    });

  // Odczyt aktualnej gotówki gracza z DOM ([data-is-me="true"] [data-testid="player-money"])
  const moneyEl = document.querySelector('[data-is-me="true"] [data-testid="player-money"]');
  const selfMoney = moneyEl
    ? parseInt((moneyEl.innerText || moneyEl.textContent || '').replace(/[^0-9-]/g, ''), 10)
    : null;

  // 0. Sprawdzenie czy gra oficjalnie zakończyła się ekranem "Game over!" / "Another game"
  if (allowGameOverCheck) {
    const playAgainBtn = findBtn(/^(play again|another game|zagraj ponownie|kolejna gra)$/i);
    if (playAgainBtn) {
      return { event: 'game_over' };
    }
  }

  // 1. Gdyby okno wciąż miało niezamknięty "Start Game", kliknij go
  const startGameBtn = findBtn(/^start game$/i);
  if (startGameBtn) {
    smartClick(startGameBtn);
    return { event: 'clicked_start_game' };
  }

  // 2. Odrzucanie ofert wymiany (Trade)
  const declineBtn = findBtn(/^(decline|reject|cancel trade|odrzuć)$/i);
  if (declineBtn) {
    smartClick(declineBtn);
    return { event: 'declined_trade' };
  }

  // 3. Jeśli przypadkiem włączyła się aukcja, kliknij "Pass" / "Pas"
  const passAuctionBtn = findBtn(/^(pass|pas|skip)$/i);
  if (passAuctionBtn) {
    smartClick(passAuctionBtn);
    return { event: 'passed_auction' };
  }

  // 4. PODDAWANIE SIĘ (Bankrupt) dla BOT 1 / BOT 2:
  //    - po osiągnięciu limitu rund (50 / 60 rund)
  //    - LUB natychmiast, gdy bot wpadnie na hotele Hosta i jego kasa spadnie poniżej $0 (selfMoney < 0)!
  const brokeOnRent = !isHost && selfMoney !== null && !Number.isNaN(selfMoney) && selfMoney < 0;
  if (shouldSurrender || brokeOnRent) {
    const cancelBtn = findBtn(/^cancel$/i);
    if (cancelBtn && cancelBtn.parentElement) {
      const modalBankruptBtn = Array.from(cancelBtn.parentElement.querySelectorAll('button')).find((b) =>
        /^bankrupt|yes|confirm$/i.test((b.innerText || b.textContent || '').trim())
      );
      if (modalBankruptBtn && !modalBankruptBtn.disabled) {
        smartClick(modalBankruptBtn);
        return { event: 'surrender_confirmed_in_modal', label: 'Bankrupt (Modal)' };
      }
    }

    const mainBankruptBtn = buttons.find((b) => /^bankrupt$/i.test((b.innerText || b.textContent || '').trim()));
    if (mainBankruptBtn) {
      mainBankruptBtn.scrollIntoView({ block: 'center' });
      smartClick(mainBankruptBtn);
      return { event: 'surrender_opened_modal', label: 'Bankrupt (Panel)' };
    }

    return { event: 'already_bankrupt' };
  }

  // 5. Kupowanie wszystkich nieruchomości, na których stanie gracz (pola miast/lotnisk/elektrowni)
  const buyBtn = buttons.find((b) => {
    const txt = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
    if (/house|hotel|upgrade|build|dom|ulepsz|buduj/i.test(txt)) return false;
    if (b.querySelector('[data-icon="arrow-up-from-line"]')) return false;
    return /^(buy for \$|buy\b|kup za|kup\b)/i.test(txt);
  });
  if (buyBtn) {
    smartClick(buyBtn);
    return { event: 'bought_property', label: (buyBtn.innerText || '').trim() };
  }

  // 6. Rzut kostką: rozróżniamy pierwszy rzut w rundzie ("Roll the dice") od dubletu ("Roll again")
  const rollInitialBtn = findBtn(/roll the dice|roll dice|rzuć kostką|rzuć kośćmi/i);
  if (rollInitialBtn) {
    window.__rbUpgradeTries = 0;
    window.__rbLastOpenedPropIndex = -1;
    smartClick(rollInitialBtn);
    return { event: 'rolled_initial', label: (rollInitialBtn.innerText || '').trim() };
  }

  const rollAgainBtn = findBtn(/^(roll again|rzuć ponownie|roll)$/i);
  if (rollAgainBtn) {
    smartClick(rollAgainBtn);
    return { event: 'rolled_again', label: (rollAgainBtn.innerText || '').trim() };
  }

  // 7. BUDOWANIE DOMKÓW / HOTELI PRZEZ HOSTA (gdy Host ma pełny zestaw kolorystyczny i gotówkę >= $1500)
  const endTurnBtn = findBtn(/end turn|zakończ turę/i);
  if (
    isHost &&
    endTurnBtn &&
    selfMoney !== null &&
    !Number.isNaN(selfMoney) &&
    selfMoney >= (minCashForHouses || 1500) &&
    (window.__rbUpgradeTries || 0) < 10
  ) {
    // Jeśli przed chwilą kliknięto ulepszenie, daj serwerowi chwilę (600ms) na aktualizację poziomu domku
    if (Date.now() - (window.__rbLastUpgradeClickAt || 0) < 600) {
      return { event: 'waiting_upgrade_sync' };
    }

    // 7A. Jeśli na ekranie jest już otwarta karta właściwości z aktywnym przyciskiem Upgrade (pierwszy przycisk w ._9bzEapiJ)
    const enabledUpgradeBtn = Array.from(document.querySelectorAll('._9bzEapiJ button:first-child')).find(
      (b) => !b.disabled && isVisible(b)
    );
    if (enabledUpgradeBtn) {
      window.__rbUpgradeTries = (window.__rbUpgradeTries || 0) + 1;
      window.__rbLastUpgradeClickAt = Date.now();
      smartClick(enabledUpgradeBtn);
      return { event: 'upgraded_property', label: `Kasa: $${selfMoney}` };
    }

    // 7B. Przeszukaj posiadane właściwości w panelu "My properties" (.YTmH8X8Z) przez React Fiber
    const propEls = Array.from(document.querySelectorAll('.YTmH8X8Z'));
    const ownedCities = [];
    for (const el of propEls) {
      const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      let fib = fk ? el[fk] : null;
      for (let i = 0; i < 10 && fib; i++, fib = fib.return) {
        const p = fib.memoizedProps;
        if (p && p.property && typeof p.index === 'number') {
          if (p.property.type === 'city') {
            ownedCities.push({ el, property: p.property, index: p.index });
          }
          break;
        }
      }
    }

    // Grupuj miasta według kraju (zestawu kolorystycznego)
    const byCountry = {};
    for (const item of ownedCities) {
      const cid = item.property.countryId || 'unknown';
      if (!byCountry[cid]) byCountry[cid] = [];
      byCountry[cid].push(item);
    }

    // Sprawdź, czy któryś kraj jest pełnym zestawem (2 miasta dla skrajnych zestawów na polach 1-3 oraz 37-39, 3 dla pozostałych)
    for (const cid of Object.keys(byCountry)) {
      const group = byCountry[cid];
      const requiredCount = group.some((g) => g.index <= 3 || g.index >= 37) ? 2 : 3;
      const anyMortgaged = group.some((g) => g.property.isMortgaged);
      if (group.length >= requiredCount && !anyMortgaged) {
        const minLevel = Math.min(...group.map((g) => g.property.level || 0));
        if (minLevel < 5) {
          const candidate = group.find(
            (g) => (g.property.level || 0) === minLevel && g.index !== window.__rbLastOpenedPropIndex
          );
          if (candidate && candidate.el) {
            const upgradeCost = minLevel + 1 === 5 ? candidate.property.hotelPrice : candidate.property.housePrice;
            if (!upgradeCost || selfMoney >= Math.max(minCashForHouses || 1500, upgradeCost)) {
              window.__rbUpgradeTries = (window.__rbUpgradeTries || 0) + 1;
              window.__rbLastOpenedPropIndex = candidate.index;
              candidate.el.scrollIntoView({ block: 'nearest' });
              smartClick(candidate.el);
              return { event: 'opened_property_for_upgrade', label: candidate.property.name };
            }
          }
        }
      }
    }
  }

  // 8. Kończenie tury ("End turn")
  if (endTurnBtn) {
    window.__rbUpgradeTries = 0;
    window.__rbLastOpenedPropIndex = -1;
    smartClick(endTurnBtn);
    return { event: 'ended_turn', label: (endTurnBtn.innerText || '').trim() };
  }

  // 9. Zamknięcie ewentualnych okienek informacyjnych ("OK", "Continue", "Got it")
  const okBtn = findBtn(/^(ok|continue|got it|rozumiem|dalej)$/i);
  if (okBtn) {
    smartClick(okBtn);
    return { event: 'clicked_ok' };
  }

  return { event: 'idle' };
}

// ==================== GŁÓWNY ORKIESTRATOR BOTA ====================
class RichupOrchestrator {
  constructor() {
    this.clients = CONFIG.instances.map((cfg) => new BrowserClient(cfg));
    this.host = this.clients[0];
    this.bot1 = this.clients[1];
    this.bot2 = this.clients[2];

    this.state = 'INIT';
    this.roomUrl = null;
    this.gamesWon = 0;
    this.coinsEarned = 0;
    this.gameNumber = 1;
    this.gameStartTime = Date.now();
    this.stateEnteredAt = Date.now();
  }

  setState(newState) {
    console.log(`\n=== [STAN BOTA] ${this.state} -> ${newState} (Gra #${this.gameNumber}, Wygrane: ${this.gamesWon}, Monety: ${this.coinsEarned}) ===`);
    this.state = newState;
    this.stateEnteredAt = Date.now();
  }

  async start() {
    console.log('==============================================================');
    console.log('  RICHUP.IO BOT NOCNY (TURBO FARMING + STATYSTYKI PROFILU)');
    console.log('  - Pokój 3/3 zamieniany na PUBLICZNY przed startem ($3000 na start)');
    console.log('  - Host buduje domki/hotele na zestawach, gdy ma >= $1500');
    console.log('  - Bot 1 poddaje się po 50 rundach | Bot 2 po 60 rundach');
    console.log('  - Szybki cykl akcji (350ms)');
    console.log('==============================================================\n');

    for (const client of this.clients) {
      await client.launch();
      await sleep(700);
    }

    await sleep(1500);
    this.setState('CREATE_ROOM');

    while (true) {
      try {
        await this.tick();
      } catch (err) {
        console.error('[BŁĄD PĘTLI]:', err.message);
      }
      await sleep(CONFIG.tickIntervalMs);
    }
  }

  async tick() {
    let anyPaused = false;
    let forceNewRoom = false;

    for (const c of this.clients) {
      try {
        const hudRes = await c.eval(pageUpdateHUD, {
          roleId: c.cfg.id,
          name: c.cfg.name,
          gamesWon: this.gamesWon,
          coinsEarned: this.coinsEarned,
          gameNumber: this.gameNumber,
          rounds: c.rounds,
          surrenderAtRound: c.cfg.surrenderAtRound === Infinity ? 999999 : c.cfg.surrenderAtRound,
          bot1Rounds: this.bot1.rounds,
          bot1Limit: CONFIG.bot1SurrenderRound,
          bot2Rounds: this.bot2.rounds,
          bot2Limit: CONFIG.bot2SurrenderRound,
          lastAction: c.lastAction,
        });

        if (hudRes?.paused) anyPaused = true;
        if (hudRes?.forceNewRoom) forceNewRoom = true;
        if (hudRes?.newlyEarnedCoins > 0) {
          this.coinsEarned += hudRes.newlyEarnedCoins;
          console.log(`[HOST] 🪙 +${hudRes.newlyEarnedCoins} Coin! Łącznie zdobyte monety w tej sesji: ${this.coinsEarned}`);
        }
        if (hudRes?.forceSurrender && c.cfg.id !== 'host') {
          c.rounds = c.cfg.surrenderAtRound;
          c.lastAction = 'Wymuszono poddanie!';
        }

        await c.checkAndSolveTurnstile();
      } catch (_) {}
    }

    if (forceNewRoom) {
      console.log('[INFO] Ręcznie wymuszono utworzenie nowego pokoju!');
      this.setState('CREATE_ROOM');
      return;
    }

    if (anyPaused) {
      return;
    }

    const timeInState = Date.now() - this.stateEnteredAt;
    if (
      (this.state === 'CREATE_ROOM' || this.state === 'WAIT_HOST_SEATED' || this.state === 'WAIT_BOTS_JOIN') &&
      timeInState > 3 * 60 * 1000
    ) {
      console.log('[WATCHDOG] Lobby trwało ponad 3 minuty. Zakładam świeży pokój...');
      this.setState('CREATE_ROOM');
      return;
    }
    if (this.state === 'PLAYING' && Date.now() - this.gameStartTime > CONFIG.maxGameDurationMs) {
      console.log('[WATCHDOG] Gra przekroczyła 35 minut. Zakładam nowy pokój...');
      this.setState('CREATE_ROOM');
      return;
    }

    // ==================== MASZYNA STANÓW ====================
    if (this.state === 'CREATE_ROOM') {
      await this.handleCreateRoom();
    } else if (this.state === 'WAIT_HOST_SEATED') {
      await this.handleWaitHostSeated();
    } else if (this.state === 'WAIT_BOTS_JOIN') {
      await this.handleWaitBotsJoin();
    } else if (this.state === 'PLAYING') {
      await this.handlePlaying();
    } else if (this.state === 'NEXT_GAME') {
      await this.handleNextGame();
    }
  }

  async handleCreateRoom() {
    for (const c of this.clients) c.resetForNewGame();
    this.roomUrl = null;

    const hostUrl = await this.host.eval('location.href');
    if (hostUrl.includes('/room/')) {
      this.host.lastAction = 'Powrót na stronę główną...';
      await this.host.navigate('https://richup.io/');
      await sleep(2000);
      return;
    }

    this.host.lastAction = 'Tworzę prywatną grę...';
    this.bot1.lastAction = 'Czekam aż Host utworzy i zajmie pokój...';
    this.bot2.lastAction = 'Czekam aż Host utworzy i zajmie pokój...';

    const res = await this.host.eval(pageClickCreatePrivateGame);
    if (res?.clicked) {
      console.log(`[HOST] Kliknięto: "${res.text}". Czekam na wygenerowanie pokoju...`);
      await sleep(2000);
    }

    const newUrl = await this.host.eval('location.href');
    if (newUrl && newUrl.includes('/room/')) {
      this.roomUrl = newUrl;
      console.log(`[HOST] Wygenerowano link pokoju: ${this.roomUrl}`);
      console.log(`[HOST] Czekam aż HOST wejdzie do środka jako pierwszy (żeby miał 👑 Hosta)...`);

      await this.host.eval(
        'window.__rbColorTry = 0; window.__rbTriesMaxPlayers = 0; window.__rbTriesCash = 0; window.__rbTriesBots = 0; window.__rbMakePublicTries = 0;'
      );

      this.setState('WAIT_HOST_SEATED');
    }
  }

  async handleWaitHostSeated() {
    const res = await this.host.eval(pageLobbyTick, {
      isHost: true,
      preferredColorIndex: this.host.cfg.preferredColorIndex,
      allJoined: false,
    });

    if (res?.action === 'loading_game') {
      this.host.lastAction = 'Ładowanie pokoju (Loading game)...';
      return;
    }

    if (res?.action === 'gdpr_consent_clicked') {
      this.host.lastAction = 'Zaakceptowano RODO (Consent)...';
    } else if (res?.action === 'enter_game_clicked') {
      this.host.lastAction = `Kliknięto "${res.label}"...`;
    } else if (res?.action === 'appearance_selected') {
      this.host.lastAction = `Wybrano wolny kolor (${res.label})...`;
    } else if (res?.action === 'join_clicked') {
      this.host.lastAction = `Dołączam jako Host ("${res.label}")...`;
    }

    if (res?.isSeatedInLobby) {
      this.host.joinedLobby = true;
      this.host.lastAction = '👑 Siedzę przy stole jako Host! Zapraszam boty...';
      console.log(`[HOST] ✅ Host zajął miejsce przy stole! Teraz wpuszczam Bot 1 i Bot 2 do ${this.roomUrl}...`);

      this.bot1.lastAction = 'Wchodzę do pokoju Hosta...';
      await this.bot1.navigate(this.roomUrl);
      await sleep(1200);

      this.bot2.lastAction = 'Wchodzę do pokoju Hosta...';
      await this.bot2.navigate(this.roomUrl);
      await sleep(1000);

      this.setState('WAIT_BOTS_JOIN');
    }
  }

  async handleWaitBotsJoin() {
    for (const bot of [this.bot1, this.bot2]) {
      const u = await bot.eval('location.href');
      if (this.roomUrl && u !== this.roomUrl) {
        await bot.navigate(this.roomUrl);
        await sleep(800);
      }
    }

    const allJoined = this.host.joinedLobby && this.bot1.joinedLobby && this.bot2.joinedLobby;

    for (const c of this.clients) {
      const res = await c.eval(pageLobbyTick, {
        isHost: c.cfg.id === 'host',
        preferredColorIndex: c.cfg.preferredColorIndex,
        allJoined,
      });

      if (res?.isSeatedInLobby && !c.joinedLobby) {
        c.joinedLobby = true;
        c.lastAction = 'Siedzi przy stole w lobby!';
        console.log(`[${c.cfg.name}] ✅ Siedzi już przy stole w lobby!`);
      }

      if (res?.action === 'loading_game') {
        c.lastAction = 'Ładowanie gry (Loading game)...';
      } else if (res?.action === 'gdpr_consent_clicked') {
        c.lastAction = 'Zaakceptowano okienko RODO (Consent)!';
        console.log(`[${c.cfg.name}] Kliknięto przycisk RODO (Consent)`);
      } else if (res?.action === 'enter_game_clicked') {
        c.lastAction = `Kliknięto "${res.label}"...`;
        console.log(`[${c.cfg.name}] Kliknięto przycisk wejścia: "${res.label}"`);
      } else if (res?.action === 'appearance_selected') {
        c.lastAction = `Wybrano wolny kolor (${res.label})...`;
        console.log(`[${c.cfg.name}] 🎨 Wybrano wolny kolor pionka: ${res.label}`);
      } else if (res?.action === 'join_clicked') {
        c.lastAction = `Kliknięto "${res.label}"...`;
        console.log(`[${c.cfg.name}] Kliknięto dołączenie: "${res.label}"`);
      } else if (res?.action === 'max_players_set_3') {
        c.lastAction = 'Ustawiono Maximum players = 3!';
        console.log('[HOST] 👥 Ustawiono Maximum players = 3!');
      } else if (res?.action === 'starting_cash_set_3000') {
        c.lastAction = 'Ustawiono Starting cash = $3000!';
        console.log('[HOST] 💰 Ustawiono Starting cash = $3000!');
      } else if (res?.action === 'bots_disabled') {
        c.lastAction = 'Wyłączono Allow bots to join!';
        console.log('[HOST] 🤖 Wyłączono Allow bots to join!');
      } else if (res?.action === 'toggled_private_off') {
        c.lastAction = 'Przełączam pokój na publiczny (3/3)...';
        console.log('[HOST] 🌐 Przełączono Private room -> OFF (otwieranie Make public)...');
      } else if (res?.action === 'make_public_confirmed') {
        c.lastAction = 'Pokój ustawiony jako PUBLICZNY!';
        console.log('[HOST] 🌐 Potwierdzono Make public (pokój 3/3 jest teraz publiczny)!');
      } else if (res?.action === 'start_clicked') {
        c.lastAction = 'Rozpoczynam grę (Start Game)!';
        console.log(`[${c.cfg.name}] 🚀 Wszyscy 3 gracze przy stole (pokój publiczny, $3000)! Kliknięto Start Game!`);
        this.gameStartTime = Date.now();
        await sleep(1200);
        this.setState('PLAYING');
        return;
      } else if (res?.action === 'game_already_started' && allJoined) {
        console.log(`[${c.cfg.name}] Rozgrywka już wystartowała!`);
        this.gameStartTime = Date.now();
        this.setState('PLAYING');
        return;
      } else if (!c.joinedLobby) {
        c.lastAction = 'Wchodzę do gry (Enter / Join)...';
      } else {
        c.lastAction = allJoined ? 'Konfiguruję i klikam Start Game...' : 'Czekam na pozostałe boty...';
      }
    }
  }

  async handlePlaying() {
    const totalRoundsPlayed = this.host.rounds + this.bot1.rounds + this.bot2.rounds;
    const allowGameOverCheck = totalRoundsPlayed >= 5 || (this.bot1.surrendered && this.bot2.surrendered);

    for (const c of this.clients) {
      const shouldSurrender = c.cfg.id !== 'host' && c.rounds >= c.cfg.surrenderAtRound;

      const res = await c.eval(pageGameplayTick, {
        isHost: c.cfg.id === 'host',
        minCashForHouses: CONFIG.hostMinCashForHouses,
        shouldSurrender,
        allowGameOverCheck,
      });

      if (!res) continue;

      switch (res.event) {
        case 'rolled_initial': {
          const now = Date.now();
          if (now - c.lastRollTimestamp > 1400) {
            c.rounds++;
            c.lastRollTimestamp = now;
            console.log(
              `[${c.cfg.name}] 🎲 Rzut kostką! Runda: ${c.rounds}` +
                (c.cfg.surrenderAtRound < Infinity ? ` / ${c.cfg.surrenderAtRound}` : '')
            );
          }
          c.lastAction = `Rzut kostką (Runda ${c.rounds})`;
          break;
        }
        case 'rolled_again':
          c.lastAction = `Dublet - rzucam ponownie (Runda ${c.rounds})`;
          break;
        case 'bought_property':
          c.lastAction = `Kupiono pole (${res.label})`;
          break;
        case 'opened_property_for_upgrade':
          c.lastAction = `🏠 Otwieram ulepszanie: ${res.label}...`;
          break;
        case 'upgraded_property':
          c.lastAction = `🏠 Zbudowano domek/hotel (${res.label})!`;
          console.log(`[${c.cfg.name}] 🏠 Zbudowano domek/hotel na posiadanym zestawie (${res.label})!`);
          break;
        case 'ended_turn':
          c.lastAction = `Zakończono turę (Runda ${c.rounds})`;
          break;
        case 'surrender_opened_modal':
          c.lastAction = `🏳️ Otwieram okienko Bankrupt (Runda ${c.rounds})...`;
          console.log(`[${c.cfg.name}] 🏳️ Kliknięto przycisk Bankrupt w panelu (otwieranie modala)...`);
          break;
        case 'surrender_confirmed_in_modal':
          c.lastAction = `🏳️ Potwierdzono Bankrupt w modalu!`;
          console.log(`[${c.cfg.name}] 🏳️ Potwierdzono bankructwo w okienku modalnym po ${c.rounds} rundach!`);
          break;
        case 'already_bankrupt':
          if (!c.surrendered) {
            c.surrendered = true;
            c.lastAction = `🏳️ Wyeliminowany (Bankrut)`;
            console.log(`[${c.cfg.name}] ✅ Bot jest już oficjalnie wyeliminowany z gry!`);
          }
          break;
        case 'game_over':
          console.log(`[${c.cfg.name}] 🏆 Ekran "Game over!" widoczny! Czekam 4.5s na zapis wygranej i monety w profilu...`);
          this.host.lastAction = '🏆 WYGRANA (Game over)! Zapisywanie w profilu...';
          this.gamesWon++;
          await sleep(4500);
          this.setState('NEXT_GAME');
          return;
        default:
          break;
      }
    }
  }

  async handleNextGame() {
    this.gameNumber++;
    console.log(`[INFO] Przygotowanie do kolejnej gry (#${this.gameNumber})...`);
    for (const c of this.clients) {
      c.lastAction = 'Przechodzę do nowej gry...';
      await c.navigate('https://richup.io/');
      await sleep(600);
    }
    await sleep(1500);
    this.setState('CREATE_ROOM');
  }
}

// Start
const orchestrator = new RichupOrchestrator();
orchestrator.start().catch((err) => {
  console.error('Krytyczny błąd bota:', err);
  process.exit(1);
});
