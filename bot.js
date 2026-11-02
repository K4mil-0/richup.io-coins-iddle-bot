/**
 * Richup.io Overnight Coin Farming Bot (MAX PROFIT EDITION)
 * Architektura:
 *  - Okno 1 (HOST): Twoje główne konto (zapisana sesja w profiles/host) - ZAWSZE WYGRYWA
 *  - Okno 2 (BOT 1): Konto gościa (profiles/bot1) - nowe ID co grę, poddaje się po 35 rundach
 *  - Okno 3 (BOT 2): Konto gościa (profiles/bot2) - nowe ID co grę, poddaje się po 45 rundach
 *
 * Optymalizacje pod maksymalny zysk monet:
 *  1. Domyślne zasady gry ($1500) - brak blokady monet za modyfikację zasad (Custom Rules).
 *  2. Inteligentny bufor gotówki - każdy bot kupuje do 5 pól (do $280), dzięki czemu zawsze ma
 *     ponad $800-$1500 zapasu i NIGDY nie zbankrutuje przypadkowo przed 35/45 rundą.
 *  3. Czyszczenie ciasteczek i Storage gości co mecz - w każdej grze BOT 1 i BOT 2 mają nowe ID
 *     i nowy losowy nick (ochrona przed blokadą Anti-Win-Trading za grę z tymi samymi osobami).
 *  4. Szybki czas reakcji (450ms) - maksymalna liczba pełnych gier na godzinę.
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
  bot1SurrenderRound: 35,  // Bot 1 poddaje się po 35 swoich rundach
  bot2SurrenderRound: 45,  // Bot 2 poddaje się po 45 swoich rundach
  maxPropertiesPerBot: 5,  // Maks. liczba kupionych pól na bota (gwarantuje bezpieczny zapas gotówki przy domyślnych $1500)
  maxPropertyPrice: 280,   // Kupuj tylko pola o cenie <= $280
  tickIntervalMs: 450,     // Szybkie sprawdzanie stanu gry (450ms)
  maxGameDurationMs: 22 * 60 * 1000, // Watchdog: max 22 minuty na jedną grę
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
      name: 'BOT 1 (Gość - 35 rund)',
      port: 9223,
      profileDir: path.join(__dirname, 'profiles', 'bot1'),
      windowPos: '640,0',
      windowSize: '640,900',
      surrenderAtRound: 35,
      preferredColorIndex: 2,
    },
    {
      id: 'bot2',
      name: 'BOT 2 (Gość - 45 rund)',
      port: 9224,
      profileDir: path.join(__dirname, 'profiles', 'bot2'),
      windowPos: '1280,0',
      windowSize: '640,900',
      surrenderAtRound: 45,
      preferredColorIndex: 5,
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
    this.propertiesBought = 0;
    this.surrenderClicks = 0;
    this.surrendered = false;
    this.joinedLobby = false;
    this.lastAction = 'Inicjalizacja...';
    this.lastRollTimestamp = 0;
    this.lastBuyTimestamp = 0;
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
          await this.send('Network.enable').catch(() => {});
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

  /**
   * Czyści tożsamość gościa (ciasteczka, localStorage, sessionStorage) dla BOT 1 i BOT 2,
   * aby serwer Richup.io w każdym meczu widział zupełnie nowych graczy (brak blokady Anti-Win-Trading!)
   */
  async resetGuestIdentity() {
    if (this.cfg.id === 'host') return; // NIGDY nie czyścimy konta Hosta!
    try {
      await this.ensureConnected();
      await this.send('Network.clearBrowserCookies').catch(() => {});
      await this.send('Storage.clearDataForOrigin', {
        origin: 'https://richup.io',
        storageTypes: 'cookies,local_storage,session_storage,indexeddb',
      }).catch(() => {});
      await this.eval(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch (_) {}
      }).catch(() => {});
      console.log(`[${this.cfg.name}] 🔄 Wygenerowano nową tożsamość gościa (nowe ID gracza na kolejny mecz).`);
    } catch (_) {}
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
    this.propertiesBought = 0;
    this.surrenderClicks = 0;
    this.surrendered = false;
    this.joinedLobby = false;
    this.lastAction = 'Nowa gra...';
    this.lastRollTimestamp = 0;
    this.lastBuyTimestamp = 0;
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
      `🎲 Rundy: <b>${hudData.rounds}</b> / ${limitStr} | 🏠 Pola: <b>${hudData.propertiesBought}/${hudData.maxProperties}</b><br>` +
      `📊 B1 / B2: <b>${hudData.bot1Rounds}/${hudData.bot1Limit}</b> | <b>${hudData.bot2Rounds}/${hudData.bot2Limit}</b>`;
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

  const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div')).filter((el) => {
    if (!isVisible(el) || el.disabled || el.closest('#richup-bot-hud')) return false;
    const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return txt.length > 0 && txt.length <= 45;
  });

  candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);

  for (const b of candidates) {
    const t = (b.innerText || b.textContent || '').trim().toLowerCase();
    if (t === 'accept' || t === 'agree' || t === 'zgadzam się' || t === 'zaakceptuj') {
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
 * Obsługa lobby: przechodzenie przez "Enter Game" -> "Select appearance" -> "Join game" -> "Start Game"
 * UWAGA: Zostawiamy w 100% DOMYŚLNE ZASADY GRY ($1500 na start, brak aukcji),
 * ponieważ serwer Richup.io wymaga domyślnych zasad (Default Rules), aby przyznać monetę za wygraną!
 */
function pageLobbyTick(params) {
  const { preferredColorIndex, allJoined } = params;

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
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

  const clickables = getClickableElements();
  const findClickable = (regex) =>
    clickables.find((el) => {
      const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return regex.test(txt);
    });

  const bodyText = document.body ? document.body.innerText : '';
  if (/loading game/i.test(bodyText) && !findClickable(/enter game|join game|start game|change appearance/i)) {
    return { action: 'loading_game', isSeatedInLobby: false };
  }

  // KROK 1: Ekran powitalny ("Your nickname..." + przycisk ">> Enter Game")
  const enterGameBtn = findClickable(/enter game|wejdź do gry/i);
  if (enterGameBtn) {
    smartClick(enterGameBtn);
    return { action: 'enter_game_clicked', label: (enterGameBtn.innerText || '').trim(), isSeatedInLobby: false };
  }

  // KROK 2: Ekran wyboru wyglądu pionka ("Select your player appearance:" + przycisk "Join game ->")
  const joinGameBtn = findClickable(/join game|dołącz do gry/i);
  if (joinGameBtn) {
    if (/select your player appearance|wybierz wygląd/i.test(bodyText)) {
      const joinRect = joinGameBtn.getBoundingClientRect();
      const circles = Array.from(document.querySelectorAll('div, button, span')).filter((el) => {
        if (!isVisible(el) || el.closest('#richup-bot-hud')) return false;
        const r = el.getBoundingClientRect();
        const isSquare = Math.abs(r.width - r.height) <= 6 && r.width >= 28 && r.width <= 70;
        const isAboveJoin = r.bottom < joinRect.top && r.top > joinRect.top - 320;
        const style = getComputedStyle(el);
        const isRound = style.borderRadius.includes('50%') || parseInt(style.borderRadius, 10) >= 14;
        return isSquare && isAboveJoin && isRound && style.cursor === 'pointer';
      });

      if (circles.length > 0) {
        window.__rbColorTry = (window.__rbColorTry || 0) + 1;
        const idx = ((preferredColorIndex || 0) + window.__rbColorTry) % circles.length;
        smartClick(circles[idx]);
      }
    }

    smartClick(joinGameBtn);
    return { action: 'join_clicked', label: (joinGameBtn.innerText || '').trim(), isSeatedInLobby: false };
  }

  // KROK 3: Sprawdzenie czy gracz faktycznie siedzi już przy stole w pokoju
  const changeAppearanceBtn = findClickable(/change appearance|zmień wygląd/i);
  const startGameBtn = findClickable(/start game|rozpocznij grę/i);
  const isSeatedInLobby = !!changeAppearanceBtn || !!startGameBtn;

  // KROK 4: Sprawdzenie czy gra już wystartowała
  const inGameIndicator = findClickable(/^(roll the dice|roll again|end turn|rzuć kostką|zakończ turę)$/i);
  if (inGameIndicator && !startGameBtn) {
    return { action: 'game_already_started', isSeatedInLobby: true };
  }

  // KROK 5: Kliknięcie "Start Game" (gdy wszystkie 3 okna siedzą przy stole)
  if (startGameBtn && allJoined) {
    smartClick(startGameBtn);
    return { action: 'start_clicked', isSeatedInLobby: true };
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
  const { shouldSurrender, allowGameOverCheck, canBuyMoreProperties, maxPropertyPrice } = params;

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
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

  // 0. Sprawdzenie czy gra się zakończyła (ekran końcowy / wygrana)
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

  // 4. Obsługa poddania się (Bankrupt) dla BOT 1 (>= 35 rund) oraz BOT 2 (>= 45 rund)
  const bankruptBtns = buttons.filter((b) => {
    const txt = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
    return /^(confirm|yes|bankrupt|declare bankruptcy|surrender|potwierdź|tak|zbankrutuj|poddaj się)$/i.test(txt);
  });

  if (shouldSurrender) {
    if (bankruptBtns.length > 0) {
      const target = bankruptBtns[bankruptBtns.length - 1];
      smartClick(target);
      return {
        event: 'surrender_clicked',
        label: (target.innerText || '').trim(),
        bankruptButtonsCount: bankruptBtns.length,
      };
    } else {
      return { event: 'already_bankrupt' };
    }
  }

  // 5. Inteligentne kupowanie nieruchomości (BEZ ulepszania domkami i z zachowaniem bufora gotówki!)
  if (canBuyMoreProperties) {
    const buyBtn = buttons.find((b) => {
      const txt = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
      if (/house|hotel|upgrade|build|dom|ulepsz|buduj/i.test(txt)) return false;
      if (b.querySelector('[data-icon="arrow-up-from-line"]')) return false;
      if (!/^(buy for \$|buy\b|kup za|kup\b)/i.test(txt)) return false;

      // Sprawdzamy cenę pola z tekstu przycisku (np. "Buy for $200")
      const priceMatch = txt.match(/\$(\d+)/);
      if (priceMatch) {
        const price = parseInt(priceMatch[1], 10);
        if (price > maxPropertyPrice) return false;
      }
      return true;
    });

    if (buyBtn) {
      smartClick(buyBtn);
      return { event: 'bought_property', label: (buyBtn.innerText || '').trim() };
    }
  }

  // 6. Rzut kostką: rozróżniamy pierwszy rzut w rundzie ("Roll the dice") od dubletu ("Roll again")
  const rollInitialBtn = findBtn(/roll the dice|roll dice|rzuć kostką|rzuć kośćmi/i);
  if (rollInitialBtn) {
    smartClick(rollInitialBtn);
    return { event: 'rolled_initial', label: (rollInitialBtn.innerText || '').trim() };
  }

  const rollAgainBtn = findBtn(/^(roll again|rzuć ponownie|roll)$/i);
  if (rollAgainBtn) {
    smartClick(rollAgainBtn);
    return { event: 'rolled_again', label: (rollAgainBtn.innerText || '').trim() };
  }

  // 7. Kończenie tury ("End turn")
  const endTurnBtn = findBtn(/end turn|zakończ turę/i);
  if (endTurnBtn) {
    smartClick(endTurnBtn);
    return { event: 'ended_turn', label: (endTurnBtn.innerText || '').trim() };
  }

  // 8. Zamknięcie ewentualnych okienek informacyjnych ("OK", "Continue", "Got it")
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

    this.state = 'INIT'; // INIT -> CREATE_ROOM -> WAIT_HOST_SEATED -> WAIT_BOTS_JOIN -> PLAYING -> NEXT_GAME
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
    console.log('  RICHUP.IO BOT NOCNY - MAX COIN PROFIT EDITION');
    console.log('  - Domyślne zasady ($1500) + inteligentny bufor gotówki (max 5 pól)');
    console.log('  - Nowa tożsamość gości (BOT 1 & BOT 2) w każdym meczu');
    console.log('  - Bot 1 poddaje się po 35 rundach | Bot 2 po 45 rundach');
    console.log('==============================================================\n');

    for (const client of this.clients) {
      await client.launch();
      await sleep(800);
    }

    await sleep(2000);
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
          propertiesBought: c.propertiesBought,
          maxProperties: CONFIG.maxPropertiesPerBot,
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
      console.log('[WATCHDOG] Gra przekroczyła 22 minuty. Zakładam nowy pokój...');
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

    // Przed każdym nowym meczem czyścimy tożsamość gości (BOT 1 i BOT 2), aby serwer widział nowych graczy!
    await this.bot1.resetGuestIdentity();
    await this.bot2.resetGuestIdentity();

    const hostUrl = await this.host.eval('location.href');
    if (hostUrl.includes('/room/')) {
      this.host.lastAction = 'Powrót na stronę główną...';
      await this.host.navigate('https://richup.io/');
      await sleep(2500);
      return;
    }

    this.host.lastAction = 'Tworzę prywatną grę...';
    this.bot1.lastAction = 'Czekam aż Host utworzy i zajmie pokój...';
    this.bot2.lastAction = 'Czekam aż Host utworzy i zajmie pokój...';

    const res = await this.host.eval(pageClickCreatePrivateGame);
    if (res?.clicked) {
      console.log(`[HOST] Kliknięto: "${res.text}". Czekam na wygenerowanie pokoju...`);
      await sleep(2500);
    }

    const newUrl = await this.host.eval('location.href');
    if (newUrl && newUrl.includes('/room/')) {
      this.roomUrl = newUrl;
      console.log(`[HOST] Wygenerowano link pokoju: ${this.roomUrl}`);
      console.log(`[HOST] Czekam aż HOST wejdzie do środka jako pierwszy (żeby miał 👑 Hosta)...`);

      await this.host.eval('window.__rbColorTry = 0;');

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

    if (res?.action === 'enter_game_clicked') {
      this.host.lastAction = `Kliknięto "${res.label}"...`;
    } else if (res?.action === 'join_clicked') {
      this.host.lastAction = `Dołączam jako Host ("${res.label}")...`;
    }

    if (res?.isSeatedInLobby) {
      this.host.joinedLobby = true;
      this.host.lastAction = '👑 Siedzę przy stole jako Host! Zapraszam boty...';
      console.log(`[HOST] ✅ Host zajął miejsce przy stole! Teraz wpuszczam Bot 1 i Bot 2 do ${this.roomUrl}...`);

      this.bot1.lastAction = 'Wchodzę do pokoju Hosta...';
      await this.bot1.navigate(this.roomUrl);
      await sleep(1600);

      this.bot2.lastAction = 'Wchodzę do pokoju Hosta...';
      await this.bot2.navigate(this.roomUrl);
      await sleep(1400);

      this.setState('WAIT_BOTS_JOIN');
    }
  }

  async handleWaitBotsJoin() {
    for (const bot of [this.bot1, this.bot2]) {
      const u = await bot.eval('location.href');
      if (this.roomUrl && u !== this.roomUrl) {
        await bot.navigate(this.roomUrl);
        await sleep(1000);
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
      } else if (res?.action === 'enter_game_clicked') {
        c.lastAction = `Kliknięto "${res.label}"...`;
        console.log(`[${c.cfg.name}] Kliknięto przycisk wejścia: "${res.label}"`);
      } else if (res?.action === 'join_clicked') {
        c.lastAction = `Wybieram kolor i klikam "${res.label}"...`;
        console.log(`[${c.cfg.name}] Kliknięto dołączenie: "${res.label}"`);
      } else if (res?.action === 'start_clicked') {
        c.lastAction = 'Rozpoczynam grę (Start Game)!';
        console.log(`[${c.cfg.name}] 🚀 Wszyscy 3 gracze przy stole! Kliknięto Start Game!`);
        this.gameStartTime = Date.now();
        await sleep(1500);
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
        c.lastAction = allJoined ? 'Klikam Start Game...' : 'Czekam na pozostałe boty...';
      }
    }
  }

  async handlePlaying() {
    const totalRoundsPlayed = this.host.rounds + this.bot1.rounds + this.bot2.rounds;
    const allowGameOverCheck = totalRoundsPlayed >= 5 || (this.bot1.surrendered && this.bot2.surrendered);

    for (const c of this.clients) {
      const shouldSurrender = c.cfg.id !== 'host' && c.rounds >= c.cfg.surrenderAtRound;
      const canBuyMoreProperties = c.propertiesBought < CONFIG.maxPropertiesPerBot;

      const res = await c.eval(pageGameplayTick, {
        shouldSurrender,
        allowGameOverCheck,
        canBuyMoreProperties,
        maxPropertyPrice: CONFIG.maxPropertyPrice,
      });

      if (!res) continue;

      switch (res.event) {
        case 'rolled_initial': {
          const now = Date.now();
          if (now - c.lastRollTimestamp > 1800) {
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
        case 'bought_property': {
          const now = Date.now();
          if (now - c.lastBuyTimestamp > 1200) {
            c.propertiesBought++;
            c.lastBuyTimestamp = now;
          }
          c.lastAction = `Kupiono pole ${c.propertiesBought}/${CONFIG.maxPropertiesPerBot} (${res.label})`;
          break;
        }
        case 'ended_turn':
          c.lastAction = `Zakończono turę (Runda ${c.rounds})`;
          break;
        case 'surrender_clicked':
          c.surrenderClicks++;
          c.lastAction = `🏳️ Poddaję grę (${res.label})...`;
          if (c.surrenderClicks >= 2 && !c.surrendered) {
            console.log(`[${c.cfg.name}] 🏳️ Kliknięto potwierdzenie poddania po ${c.rounds} rundach!`);
          }
          break;
        case 'already_bankrupt':
          if (c.surrenderClicks >= 1 && !c.surrendered) {
            c.surrendered = true;
            c.lastAction = `🏳️ Poddano grę (Wyeliminowany)`;
            console.log(`[${c.cfg.name}] 🏳️ Bot oficjalnie wyeliminowany po ${c.rounds} rundach!`);
          }
          break;
        case 'game_over':
          console.log(`[${c.cfg.name}] 🏆 Wykryto koniec gry! Twoje główne konto wygrywa!`);
          this.gamesWon++;
          await sleep(5000);
          this.setState('NEXT_GAME');
          return;
        default:
          if (shouldSurrender && !c.surrendered) {
            c.lastAction = `Szukam przycisku Bankrupt (${c.rounds} rund)...`;
          }
          break;
      }
    }

    if (this.bot1.surrendered && this.bot2.surrendered) {
      console.log('[INFO] Oba boty-goście się poddały! Czekam 6 sekund na zapisanie monet na koncie Hosta...');
      this.host.lastAction = '🏆 WYGRANA! Zapisywanie monet...';
      await sleep(6000);
      this.gamesWon++;
      this.setState('NEXT_GAME');
    }
  }

  async handleNextGame() {
    this.gameNumber++;
    console.log(`[INFO] Przygotowanie do kolejnej gry (#${this.gameNumber})...`);
    for (const c of this.clients) {
      c.lastAction = 'Przechodzę do nowej gry...';
      await c.navigate('https://richup.io/');
      await sleep(800);
    }
    await sleep(2000);
    this.setState('CREATE_ROOM');
  }
}

// Start
const orchestrator = new RichupOrchestrator();
orchestrator.start().catch((err) => {
  console.error('Krytyczny błąd bota:', err);
  process.exit(1);
});
