/**
 * =================================================================
 *  Unfollowers-X  v2.0
 *  Dashboard Bidireccional: Unfollower + Auto-Follow
 *  Vanilla JavaScript — Sin dependencias externas
 * =================================================================
 *
 *  Modulo Unfollower : x.com/TU_USUARIO/following
 *  Modulo Auto-Follow: x.com/@USUARIO/followers
 *
 *  USO:
 *  1. Navegar a la pagina correcta segun el modulo deseado
 *  2. Abrir DevTools (F12) → Console
 *  3. Pegar este script completo y presionar Enter
 *
 *  ADVERTENCIA: El uso de automatizaciones puede infringir los
 *  Terminos de Servicio de X. Usar bajo responsabilidad propia.
 * =================================================================
 */

(function () {
  'use strict';

  // =================================================================
  // CONFIGURACION
  // =================================================================
  const CFG = {
    // Unfollower — delays entre acciones (ms, con decimales precisos)
    UF_DELAY_MIN:  10_230,          // 10.23 segundos
    UF_DELAY_MAX:  64_320,          // 64.32 segundos
    UF_CD_EVERY:   10,              // cooldown cada N unfollows
    UF_CD_MIN:     4  * 60 * 1_000, // 4 minutos
    UF_CD_MAX:     10 * 60 * 1_000, // 10 minutos

    // Auto-Follow — delays entre acciones
    AF_DELAY_MIN:      45_000,
    AF_DELAY_MAX:      95_000,
    AF_CD_EVERY:       10,
    AF_CD_MIN:         4  * 60 * 1_000,
    AF_CD_MAX:         10 * 60 * 1_000,
    AF_MAX_PER_BATCH:  20,
    AF_BATCH_WAIT:     2 * 60 * 60 * 1_000, // 2 horas entre lotes
    AF_CHUNK_SIZE:     250,

    // Scroll
    SC_MIN:       500,
    SC_MAX:       2_000,
    SC_STEP:      700,
    SC_MAX_STUCK: 6,

    // Timeout global de sesion
    TIMEOUT: 2 * 60 * 60 * 1_000,
  };

  // =================================================================
  // ESTADO GLOBAL
  // =================================================================
  const S = {
    sessionStart: null,
    activeModule: null,  // 'unfollow' | 'autofollow' | null
    running:      false,
    stop:         false,

    uf: {
      nonMutuals: [],
      selected:   new Set(),
      count:      0,
      phase:      'idle', // idle|scanning|results|running|done
    },

    af: {
      candidates:  [],
      selected:    new Set(),
      seen:        new Set(),  // usernames vistos en todos los chunks
      count:       0,
      phase:       'idle',     // idle|loading|results|running|done
      scanDone:    false,      // true si se llego al final de la lista
      stuckCount:  0,
      lastHeight:  0,
      lastBatchEnd: null,      // timestamp del ultimo lote completado
    },
  };

  // =================================================================
  // UTILIDADES
  // =================================================================

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** Decimal aleatorio entre a y b */
  const rnd = (a, b) => Math.random() * (b - a) + a;

  /** Entero aleatorio entre a y b inclusive */
  const rndInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

  /** Escapa HTML para prevenir XSS al inyectar datos externos en la UI */
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Extrae username puro de un href de perfil de X */
  function uname(href) {
    return href ? (href.split('/')[1] ?? '').split('?')[0].toLowerCase() || null : null;
  }

  /** Formatea milisegundos como "4m 32s" */
  function fmtMs(ms) {
    const s = Math.ceil(ms / 1_000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  }

  /** Formatea milisegundos como "37.45s" con dos decimales */
  function fmtSec(ms) {
    return (ms / 1_000).toFixed(2) + 's';
  }

  /** Color de fondo para avatar de inicial, deterministico por letra */
  function icolor(ch) {
    const p = ['#1e3a5f','#1e4d3a','#3d2260','#5c2020',
               '#1a4a4a','#3a3a1e','#2d1f4f','#1f3d2d'];
    return p[((ch || 'a').toLowerCase().charCodeAt(0) - 97 + 26) % 8];
  }

  /** True si se supero el timeout de sesion */
  function expired() {
    return S.sessionStart && (Date.now() - S.sessionStart) > CFG.TIMEOUT;
  }

  // =================================================================
  // DETECCION DE PAGINA
  // Determina en que pagina esta el usuario para habilitar el modulo
  // correcto del dashboard.
  // =================================================================
  function detectPage() {
    const path = window.location.pathname;
    if (/\/following\b/.test(path))  return 'following';
    if (/\/followers\b/.test(path))  return 'followers';
    return 'other';
  }

  // =================================================================
  // MODULO: DETECT
  // Responsabilidad: analizar celdas del DOM para extraer datos de
  // usuario y localizar botones de accion.
  // =================================================================
  const DETECT = {
    _sys: new Set(['search','explore','notifications','messages',
                   'settings','home','i','following','followers']),

    /**
     * True si el UserCell pertenece a un mutuo.
     * X inyecta "Te sigue" / "Follows you" en el texto de la celda.
     */
    followsBack(cell) {
      const t = cell.innerText || cell.textContent || '';
      return /te sigue\b/i.test(t) || /follows you\b/i.test(t);
    },

    /** Extrae username y displayName de un [data-testid="UserCell"] */
    userInfo(cell) {
      let username = null;
      for (const a of cell.querySelectorAll('a[href^="/"]')) {
        const u = uname(a.getAttribute('href'));
        if (u && !u.includes('#') && !this._sys.has(u)) { username = u; break; }
      }
      const ne = cell.querySelector('[data-testid="User-Name"] span span')
              || cell.querySelector('[data-testid="UserName"] span span');
      return { username, displayName: ne?.textContent?.trim() || username || '?' };
    },

    /**
     * Localiza el boton de UNFOLLOW dentro de un UserCell.
     * Multiples fallbacks por si X cambia los selectores.
     */
    unfollowBtn(cell) {
      return (
        cell.querySelector('[data-testid$="-follow"]')                      ||
        cell.querySelector('button[aria-label*="Unfollow" i]')              ||
        cell.querySelector('button[aria-label*="Dejar de seguir" i]')       ||
        [...cell.querySelectorAll('button')].find(b =>
          /siguiendo|following/i.test(b.textContent)
        )                                                                    ||
        null
      );
    },

    /**
     * Localiza el boton de FOLLOW (no Following, no Unfollow).
     * Usado por el modulo Auto-Follow en paginas /followers.
     */
    followBtn(cell) {
      // data-testid=[username]-follow, excluyendo unfollow
      const byTestId = cell.querySelector('[data-testid$="-follow"]');
      if (byTestId) {
        const lbl = byTestId.getAttribute('aria-label') || '';
        if (!/unfollow/i.test(lbl)) return byTestId;
      }
      return (
        cell.querySelector('button[aria-label^="Follow @" i]')              ||
        [...cell.querySelectorAll('button')].find(b => {
          const t = b.textContent?.trim() || '';
          const l = b.getAttribute('aria-label') || '';
          return /^follow$/i.test(t) && !/following|unfollow/i.test(t + l);
        })                                                                   ||
        null
      );
    },
  };

  // =================================================================
  // MODULO: SCRAPER
  // Responsabilidad: desplazar la pagina en background (el overlay
  // cubre el scroll) y capturar UserCells del DOM.
  // =================================================================
  const SCRAPER = {
    /**
     * Escaneo completo de la pagina /following.
     * Reinicia desde el top y lee todos los UserCells que no sean mutuos.
     */
    async scanUnfollowers(onProgress) {
      window.scrollTo(0, 0);
      await sleep(1_200);
      const seen = new Set();
      let stuck = 0, lastH = 0;

      while (stuck < CFG.SC_MAX_STUCK && !S.stop) {
        if (expired()) break;
        document.querySelectorAll('[data-testid="UserCell"]').forEach(cell => {
          const { username, displayName } = DETECT.userInfo(cell);
          if (!username || seen.has(username)) return;
          seen.add(username);
          if (!DETECT.followsBack(cell)) {
            S.uf.nonMutuals.push({ username, displayName });
          }
        });
        onProgress(seen.size, S.uf.nonMutuals.length);
        window.scrollBy(0, CFG.SC_STEP);
        await sleep(rndInt(CFG.SC_MIN, CFG.SC_MAX));
        const nh = document.body.scrollHeight;
        stuck = nh === lastH ? stuck + 1 : 0;
        lastH = nh;
      }
    },

    /**
     * Carga un chunk de seguidores desde la pagina actual de /followers.
     * Continua desde la posicion de scroll actual (no reinicia).
     * Usado por el modulo Auto-Follow con carga incremental por chunks.
     */
    async scanFollowers(onProgress) {
      let added = 0;
      S.af.stuckCount = 0;

      while (S.af.stuckCount < CFG.SC_MAX_STUCK && !S.stop) {
        if (expired()) break;
        document.querySelectorAll('[data-testid="UserCell"]').forEach(cell => {
          const { username, displayName } = DETECT.userInfo(cell);
          if (!username || S.af.seen.has(username)) return;
          // Solo incluir usuarios que podemos seguir (boton Follow presente)
          if (!DETECT.followBtn(cell)) return;
          S.af.seen.add(username);
          S.af.candidates.push({ username, displayName });
          added++;
        });
        onProgress(S.af.candidates.length);
        if (added >= CFG.AF_CHUNK_SIZE) break; // chunk completo
        window.scrollBy(0, CFG.SC_STEP);
        await sleep(rndInt(CFG.SC_MIN, CFG.SC_MAX));
        const nh = document.body.scrollHeight;
        S.af.stuckCount = nh === S.af.lastHeight ? S.af.stuckCount + 1 : 0;
        S.af.lastHeight = nh;
      }

      S.af.scanDone = S.af.stuckCount >= CFG.SC_MAX_STUCK;
      return added;
    },
  };

  // =================================================================
  // MODULO: UF (Unfollower)
  // Responsabilidad: ejecutar unfollows con delays precisos,
  // cooldowns cada 10 acciones y confirmacion del modal de X.
  // =================================================================
  const UF = {
    async waitConfirm(t = 4_000) {
      const d = Date.now() + t;
      return new Promise(r => {
        const ck = () => {
          const b = document.querySelector('[data-testid="confirmationSheetConfirm"]');
          if (b) { b.click(); return r(true); }
          Date.now() < d ? setTimeout(ck, 150) : r(true);
        };
        ck();
      });
    },

    /**
     * Cuenta regresiva con callbacks cada 500ms.
     * Permite mostrar tiempos precisos (decimales) en la UI.
     */
    async countdown(ms, onTick) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !S.stop) {
        onTick(deadline - Date.now());
        await sleep(500);
      }
    },

    /**
     * Ejecuta la cola de unfollows con scroll progresivo.
     * No almacena referencias al DOM (la lista de X esta virtualizada).
     *
     * Logica de cooldown:
     * - Cada CFG.UF_CD_EVERY unfollows → pausa aleatoria de 4-10 min
     * - Entre unfollows normales → delay preciso de 10.23-64.32s
     */
    async run(queue, onProgress, onCooldown) {
      S.uf.count = 0;
      window.scrollTo(0, 0);
      await sleep(1_500);

      const pending = new Set(queue.map(u => u.username));
      let done = 0, lastH = 0, stuck = 0;

      while (pending.size > 0 && !S.stop && stuck < 7) {
        if (expired()) break;
        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        let found = false;

        for (const cell of cells) {
          const { username } = DETECT.userInfo(cell);
          if (!username || !pending.has(username)) continue;

          found = true;
          pending.delete(username);

          cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(500 + Math.random() * 400);

          const btn = DETECT.unfollowBtn(cell);
          if (!btn) { console.warn('[XUF] btn no encontrado @' + username); continue; }

          const delayMs = rnd(CFG.UF_DELAY_MIN, CFG.UF_DELAY_MAX);
          onProgress(done + 1, queue.length, username, delayMs);

          try {
            btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
            await sleep(250 + Math.random() * 150);
            btn.click();
            await sleep(800 + Math.random() * 300);
            await this.waitConfirm();
            await sleep(400);
            S.uf.count++;
            done++;
          } catch (e) {
            console.error('[XUF] error @' + username, e);
          }

          // Cooldown obligatorio cada N unfollows
          if (done > 0 && done % CFG.UF_CD_EVERY === 0 && pending.size > 0 && !S.stop) {
            const cdMs = rndInt(CFG.UF_CD_MIN, CFG.UF_CD_MAX);
            await this.countdown(cdMs, rem => onCooldown(rem, done, queue.length));
          } else if (pending.size > 0 && !S.stop) {
            await this.countdown(delayMs, rem => onProgress(done, queue.length, username, rem));
          }
        }

        if (!found) {
          window.scrollBy(0, CFG.SC_STEP);
          await sleep(rndInt(CFG.SC_MIN, CFG.SC_MAX));
          const nh = document.body.scrollHeight;
          stuck = nh === lastH ? stuck + 1 : 0;
          lastH = nh;
        } else {
          stuck = 0;
        }
      }

      return { done, stopped: S.stop };
    },
  };

  // =================================================================
  // MODULO: AF (Auto-Follow)
  // Responsabilidad: seguir usuarios con delays, cooldowns y el
  // limite estricto de 20 follows por lote.
  // =================================================================
  const AF = {
    async waitConfirm(t = 4_000) {
      const d = Date.now() + t;
      return new Promise(r => {
        const ck = () => {
          const b = document.querySelector('[data-testid="confirmationSheetConfirm"]');
          if (b) { b.click(); return r(true); }
          Date.now() < d ? setTimeout(ck, 150) : r(true);
        };
        ck();
      });
    },

    async countdown(ms, onTick) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !S.stop) {
        onTick(deadline - Date.now());
        await sleep(500);
      }
    },

    /**
     * Verifica si el cooldown de 2 horas entre lotes esta activo.
     * Solo aplica dentro de la misma sesion (sin persistencia en localStorage).
     */
    batchCooldownActive() {
      if (!S.af.lastBatchEnd) return false;
      return (Date.now() - S.af.lastBatchEnd) < CFG.AF_BATCH_WAIT;
    },

    batchCooldownRemaining() {
      if (!S.af.lastBatchEnd) return 0;
      return Math.max(0, CFG.AF_BATCH_WAIT - (Date.now() - S.af.lastBatchEnd));
    },

    /**
     * Ejecuta la cola de follows con scroll progresivo.
     * Se detiene al alcanzar CFG.AF_MAX_PER_BATCH follows.
     */
    async run(queue, onProgress, onCooldown) {
      S.af.count = 0;
      window.scrollTo(0, 0);
      await sleep(1_500);

      const pending = new Set(queue.map(u => u.username));
      let done = 0, lastH = 0, stuck = 0;

      while (pending.size > 0 && !S.stop && stuck < 7 && done < CFG.AF_MAX_PER_BATCH) {
        if (expired()) break;
        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        let found = false;

        for (const cell of cells) {
          if (done >= CFG.AF_MAX_PER_BATCH) break;
          const { username } = DETECT.userInfo(cell);
          if (!username || !pending.has(username)) continue;

          found = true;
          pending.delete(username);

          cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(500 + Math.random() * 400);

          const btn = DETECT.followBtn(cell);
          if (!btn) { console.warn('[XUF] follow btn no encontrado @' + username); continue; }

          const delayMs = rndInt(CFG.AF_DELAY_MIN, CFG.AF_DELAY_MAX);
          onProgress(done + 1, queue.length, username, delayMs);

          try {
            btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
            await sleep(250 + Math.random() * 150);
            btn.click();
            await sleep(800 + Math.random() * 300);
            await this.waitConfirm();
            await sleep(400);
            S.af.count++;
            done++;
          } catch (e) {
            console.error('[XUF] error follow @' + username, e);
          }

          if (done >= CFG.AF_MAX_PER_BATCH) break;

          // Cooldown obligatorio cada N follows
          if (done > 0 && done % CFG.AF_CD_EVERY === 0 && pending.size > 0 && !S.stop) {
            const cdMs = rndInt(CFG.AF_CD_MIN, CFG.AF_CD_MAX);
            await this.countdown(cdMs, rem => onCooldown(rem, done, queue.length));
          } else if (pending.size > 0 && !S.stop) {
            await this.countdown(delayMs, rem => onProgress(done, queue.length, username, rem));
          }
        }

        if (!found) {
          window.scrollBy(0, CFG.SC_STEP);
          await sleep(rndInt(CFG.SC_MIN, CFG.SC_MAX));
          const nh = document.body.scrollHeight;
          stuck = nh === lastH ? stuck + 1 : 0;
          lastH = nh;
        } else {
          stuck = 0;
        }
      }

      S.af.lastBatchEnd = Date.now();
      return { done, stopped: S.stop };
    },
  };

  // =================================================================
  // MODULO: UI
  // Responsabilidad: CSS inyectado, estructura del overlay,
  // renderizado de todas las fases de ambos modulos.
  // =================================================================
  const UI = {
    _el: null,

    // -----------------------------------------------------------------
    // CSS — inyectado una sola vez en <head>
    // -----------------------------------------------------------------
    _CSS: `
      /* ── Overlay base ───────────────────────────────────── */
      #xuf-ov {
        position: fixed;
        inset: 0;
        z-index: 9999999;
        background: #111111;
        color: #d8d8d8;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                     'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.55;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      /* ── Animacion de entrada ────────────────────────────── */
      @keyframes xuf-in {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .xuf-anim { animation: xuf-in 0.2s ease; }

      /* ── Barra de navegacion superior ────────────────────── */
      .xuf-nav {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 24px;
        height: 52px;
        border-bottom: 1px solid #1e1e1e;
        background: #0d0d0d;
        flex-shrink: 0;
        gap: 16px;
      }
      .xuf-brand {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 2px;
        text-transform: uppercase;
        color: #2a2a2a;
        white-space: nowrap;
      }
      .xuf-ver { color: #222; }

      /* ── Tabs ────────────────────────────────────────────── */
      .xuf-tabs {
        display: flex;
        gap: 4px;
        flex: 1;
        justify-content: center;
      }
      .xuf-tab {
        background: transparent;
        border: 1px solid transparent;
        border-radius: 5px;
        padding: 6px 16px;
        font-size: 12px;
        font-weight: 600;
        color: #383838;
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        white-space: nowrap;
      }
      .xuf-tab:hover:not(.xuf-tab-disabled):not(.xuf-tab-active) {
        border-color: #222;
        color: #686868;
      }
      .xuf-tab.xuf-tab-active {
        background: #1a1a1a;
        border-color: #282828;
        color: #c8c8c8;
      }
      .xuf-tab.xuf-tab-disabled {
        opacity: 0.28;
        cursor: not-allowed;
      }
      .xuf-tab-hint {
        font-size: 11px;
        color: #2a2a2a;
        text-align: center;
        flex: 1;
      }

      /* ── Boton cerrar ────────────────────────────────────── */
      .xuf-close {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 11px;
        font-weight: 700;
        color: #282828;
        padding: 6px 8px;
        border-radius: 4px;
        transition: color 0.1s, background 0.1s;
        font-family: inherit;
        white-space: nowrap;
      }
      .xuf-close:hover { color: #c8c8c8; background: #1a1a1a; }

      /* ── Cuerpo principal ────────────────────────────────── */
      .xuf-body {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      /* Modo centrado: para fases de scan, progreso, done */
      .xuf-body-center {
        align-items: center;
        justify-content: center;
        overflow-y: auto;
      }
      /* Modo panel: para fases de resultados (tabla full-height) */
      .xuf-body-panel {
        align-items: stretch;
        justify-content: flex-start;
        overflow: hidden;
      }

      /* ── Card centrada ───────────────────────────────────── */
      .xuf-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 24px;
        width: 100%;
        max-width: 440px;
        padding: 52px 32px;
        text-align: center;
      }

      /* ── Spinner ─────────────────────────────────────────── */
      @keyframes xuf-spin { to { transform: rotate(360deg); } }
      .xuf-spinner {
        width: 28px;
        height: 28px;
        border: 2px solid #1a1a1a;
        border-top-color: #555;
        border-radius: 50%;
        animation: xuf-spin 0.85s linear infinite;
        flex-shrink: 0;
      }

      /* ── Tipografia ──────────────────────────────────────── */
      .xuf-heading {
        font-size: 19px;
        font-weight: 600;
        color: #d8d8d8;
        margin: 0;
        letter-spacing: -0.3px;
      }
      .xuf-sub {
        font-size: 13px;
        color: #404040;
        margin: 0;
        max-width: 340px;
        line-height: 1.65;
      }
      .xuf-big-num {
        font-size: 76px;
        font-weight: 700;
        color: #d8d8d8;
        line-height: 1;
        margin: 0;
        letter-spacing: -4px;
      }
      .xuf-target {
        font-size: 16px;
        font-weight: 600;
        color: #585858;
        margin: 0;
        min-height: 22px;
      }
      .xuf-page-note {
        font-size: 12px;
        color: #2e2e2e;
        margin: 0;
        text-align: center;
      }

      /* ── Indicador de pagina (dashboard) ─────────────────── */
      .xuf-page-ind {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 20px 28px;
        background: #0d0d0d;
        border: 1px solid #181818;
        border-radius: 8px;
        width: 100%;
        max-width: 400px;
      }
      .xuf-page-ind-url {
        font-size: 11px;
        font-family: 'SF Mono', Consolas, monospace;
        color: #303030;
      }
      .xuf-page-ind-status {
        font-size: 13px;
        color: #585858;
      }
      .xuf-page-ind-status.ok { color: #406840; }

      /* ── Aviso de modulo en uso ───────────────────────────── */
      .xuf-module-warn {
        background: #0f0e00;
        border: 1px solid #1c1a00;
        border-radius: 6px;
        padding: 10px 16px;
        font-size: 12px;
        color: #504a00;
        width: 100%;
        max-width: 400px;
        text-align: center;
      }
      .xuf-module-warn strong { color: #807030; }

      /* ── Fila de estadisticas (fase escaneo) ─────────────── */
      .xuf-stats {
        display: flex;
        gap: 48px;
        align-items: flex-end;
      }
      .xuf-stat {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }
      .xuf-stat-n {
        font-size: 40px;
        font-weight: 700;
        color: #d8d8d8;
        line-height: 1;
        letter-spacing: -1.5px;
        min-width: 56px;
        text-align: center;
      }
      .xuf-stat-l {
        font-size: 9px;
        color: #282828;
        text-transform: uppercase;
        letter-spacing: 1.2px;
      }

      /* ── Barra de progreso ───────────────────────────────── */
      .xuf-prog-wrap {
        width: 100%;
        max-width: 360px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
      }
      .xuf-prog-track {
        width: 100%;
        height: 2px;
        background: #1a1a1a;
        border-radius: 1px;
        overflow: hidden;
      }
      .xuf-prog-fill {
        height: 100%;
        background: #d8d8d8;
        border-radius: 1px;
        transition: width 0.4s ease;
      }
      .xuf-prog-lbl { font-size: 11px; color: #303030; }

      /* ── Banner de cooldown ──────────────────────────────── */
      .xuf-cd-banner {
        background: #0d0f16;
        border: 1px solid #141820;
        border-radius: 6px;
        padding: 12px 20px;
        font-size: 13px;
        color: #383c50;
        width: 100%;
        max-width: 360px;
        text-align: center;
        line-height: 1.6;
      }
      .xuf-cd-banner strong { color: #5060a0; }

      /* ── Panel de resultados ─────────────────────────────── */
      .xuf-panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        max-width: 900px;
        width: 100%;
        margin: 0 auto;
      }

      .xuf-panel-hd {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 28px;
        border-bottom: 1px solid #181818;
        flex-shrink: 0;
        gap: 16px;
      }
      .xuf-panel-hd-r {
        display: flex;
        align-items: center;
        gap: 18px;
      }
      .xuf-sel-lbl {
        font-size: 12px;
        color: #383838;
        white-space: nowrap;
      }
      .xuf-sel-lbl strong { color: #b8b8b8; font-weight: 600; }

      /* Aviso limite (cuando hay mas de MAX_PER_BATCH) */
      .xuf-limit-bar {
        background: #120f00;
        border-bottom: 1px solid #1e1900;
        padding: 7px 28px;
        font-size: 12px;
        color: #504800;
        flex-shrink: 0;
      }
      .xuf-limit-bar strong { color: #807030; }

      .xuf-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 28px;
        border-bottom: 1px solid #181818;
        flex-shrink: 0;
      }
      .xuf-table-scroll {
        flex: 1;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: #1a1a1a transparent;
      }
      .xuf-table-scroll::-webkit-scrollbar { width: 3px; }
      .xuf-table-scroll::-webkit-scrollbar-thumb { background: #1a1a1a; }

      .xuf-table {
        width: 100%;
        border-collapse: collapse;
      }
      .xuf-tr {
        border-bottom: 1px solid #131313;
        transition: background 0.1s;
      }
      .xuf-tr:hover { background: #0f0f0f; }
      .xuf-td {
        padding: 9px 12px;
        vertical-align: middle;
      }
      .xuf-td-cb { width: 44px; text-align: center; }
      .xuf-td-av { width: 48px; }

      .xuf-avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 700;
        color: rgba(255,255,255,0.6);
        flex-shrink: 0;
      }
      .xuf-u-name {
        display: block;
        font-weight: 600;
        font-size: 13px;
        color: #c8c8c8;
      }
      .xuf-u-handle {
        display: block;
        font-size: 11px;
        color: #383838;
        margin-top: 2px;
      }

      .xuf-panel-ft {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 28px;
        border-top: 1px solid #181818;
        flex-shrink: 0;
        gap: 12px;
        flex-wrap: wrap;
      }
      .xuf-ft-note { font-size: 11px; color: #282828; margin: 0; }

      /* ── Botones ─────────────────────────────────────────── */
      .xuf-btn {
        padding: 7px 18px;
        border-radius: 4px;
        border: none;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        transition: background 0.15s, color 0.15s, opacity 0.15s;
        white-space: nowrap;
        font-family: inherit;
        line-height: 1.4;
      }
      .xuf-btn:disabled { opacity: 0.3; cursor: not-allowed; pointer-events: none; }
      .xuf-btn:focus-visible { outline: 2px solid #484848; outline-offset: 2px; }

      .xuf-btn-primary { background: #d8d8d8; color: #0d0d0d; }
      .xuf-btn-primary:hover:not(:disabled) { background: #f0f0f0; }

      .xuf-btn-ghost {
        background: transparent;
        color: #484848;
        border: 1px solid #1e1e1e;
      }
      .xuf-btn-ghost:hover:not(:disabled) {
        background: #181818;
        color: #b8b8b8;
        border-color: #2a2a2a;
      }

      .xuf-btn-danger { background: #3a0f0f; color: #c87070; border: 1px solid #4a1515; }
      .xuf-btn-danger:hover:not(:disabled) { background: #4a1515; color: #e08080; }

      /* ── Checkbox ────────────────────────────────────────── */
      .xuf-cb {
        width: 13px;
        height: 13px;
        cursor: pointer;
        accent-color: #b8b8b8;
      }
      .xuf-cb:disabled { opacity: 0.3; cursor: not-allowed; }
    `,

    // -----------------------------------------------------------------
    // Ciclo de vida del overlay
    // -----------------------------------------------------------------

    injectCSS() {
      if (document.getElementById('xuf-css')) return;
      const s = document.createElement('style');
      s.id   = 'xuf-css';
      s.textContent = this._CSS;
      document.head.appendChild(s);
    },

    mount() {
      document.getElementById('xuf-ov')?.remove();
      this.injectCSS();
      this._el = document.createElement('div');
      this._el.id = 'xuf-ov';
      document.body.appendChild(this._el);
      return this._el;
    },

    unmount() {
      this._el?.remove();
      this._el = null;
    },

    /** Pinta la estructura persistente: nav + tabs + cuerpo vacio */
    buildShell(pageType) {
      if (!this._el) return;
      const ufDisabled  = pageType !== 'following';
      const afDisabled  = pageType !== 'followers';
      this._el.innerHTML = `
        <div class="xuf-nav">
          <span class="xuf-brand">Unfollowers-X <span class="xuf-ver">v2.0</span></span>
          <div class="xuf-tabs">
            <button
              class="xuf-tab ${ufDisabled ? 'xuf-tab-disabled' : 'xuf-tab-active'}"
              id="xuf-tab-uf"
              ${ufDisabled ? 'disabled' : ''}
            >Modulo Unfollower</button>
            <button
              class="xuf-tab ${afDisabled ? 'xuf-tab-disabled' : ''} ${!afDisabled ? 'xuf-tab-active' : ''}"
              id="xuf-tab-af"
              ${afDisabled ? 'disabled' : ''}
            >Modulo Auto-Follow</button>
          </div>
          <button class="xuf-close" id="xuf-close-btn">Cerrar</button>
        </div>
        <div class="xuf-body xuf-body-center" id="xuf-body"></div>
      `;
      document.getElementById('xuf-close-btn').onclick = () => {
        if (S.running) {
          S.stop = true;
        }
        this.unmount();
      };
      document.getElementById('xuf-tab-uf').onclick = () => {
        if (ufDisabled) return;
        if (S.running) { this._showModuleWarn(); return; }
        CTRL.startUnfollower();
      };
      document.getElementById('xuf-tab-af').onclick = () => {
        if (afDisabled) return;
        if (S.running) { this._showModuleWarn(); return; }
        CTRL.startAutoFollow();
      };
    },

    _showModuleWarn() {
      const body = this._body();
      if (!body) return;
      const mod = S.activeModule === 'unfollow' ? 'Unfollower' : 'Auto-Follow';
      const existing = body.querySelector('.xuf-module-warn');
      if (existing) { existing.remove(); return; }
      const w = document.createElement('div');
      w.className = 'xuf-module-warn xuf-anim';
      w.innerHTML = `El modulo <strong>${mod}</strong> esta en ejecucion. Completa o detiene el proceso antes de cambiar de modulo.`;
      body.appendChild(w);
      setTimeout(() => w.remove(), 3500);
    },

    _body() {
      return document.getElementById('xuf-body');
    },

    _setBodyMode(mode) {
      const b = this._body();
      if (!b) return;
      b.className = 'xuf-body ' + (mode === 'panel' ? 'xuf-body-panel' : 'xuf-body-center');
    },

    // -----------------------------------------------------------------
    // Dashboard — pantalla inicial segun pagina detectada
    // -----------------------------------------------------------------
    showDashboard(pageType) {
      this._setBodyMode('center');
      const body = this._body();
      if (!body) return;

      let content;
      if (pageType === 'following') {
        content = `
          <div class="xuf-page-ind xuf-anim">
            <span class="xuf-page-ind-url">${esc(window.location.pathname)}</span>
            <span class="xuf-page-ind-status ok">Pagina /following detectada</span>
          </div>
          <p class="xuf-heading">Modulo Unfollower disponible</p>
          <p class="xuf-sub">Detectara todas las cuentas que no te siguen de vuelta y te permitira dejar de seguirlas con delays precisos.</p>
          <button class="xuf-btn xuf-btn-primary" id="xuf-start-uf">Iniciar Modulo Unfollower</button>
        `;
      } else if (pageType === 'followers') {
        const cooldownActive = AF.batchCooldownActive();
        const cooldownNote   = cooldownActive
          ? `<div class="xuf-module-warn" style="max-width:400px">Cooldown activo. Proximo lote disponible en <strong>${fmtMs(AF.batchCooldownRemaining())}</strong></div>`
          : '';
        content = `
          <div class="xuf-page-ind xuf-anim">
            <span class="xuf-page-ind-url">${esc(window.location.pathname)}</span>
            <span class="xuf-page-ind-status ok">Pagina /followers detectada</span>
          </div>
          <p class="xuf-heading">Modulo Auto-Follow disponible</p>
          <p class="xuf-sub">Cargara los seguidores de este perfil en bloques de ${CFG.AF_CHUNK_SIZE} y te permitira seguir hasta ${CFG.AF_MAX_PER_BATCH} por lote.</p>
          ${cooldownNote}
          <button class="xuf-btn xuf-btn-primary" id="xuf-start-af" ${cooldownActive ? 'disabled' : ''}>
            Iniciar Modulo Auto-Follow
          </button>
        `;
      } else {
        content = `
          <div class="xuf-page-ind xuf-anim">
            <span class="xuf-page-ind-url">${esc(window.location.pathname)}</span>
            <span class="xuf-page-ind-status">Pagina no reconocida</span>
          </div>
          <p class="xuf-heading">Navega a la pagina correcta</p>
          <div class="xuf-sub" style="text-align:left;max-width:380px">
            <p style="margin-bottom:8px"><strong style="color:#888">Modulo Unfollower:</strong><br>x.com/TU_USUARIO/following</p>
            <p><strong style="color:#888">Modulo Auto-Follow:</strong><br>x.com/@USUARIO/followers</p>
          </div>
          <button class="xuf-btn xuf-btn-ghost" id="xuf-redetect">Re-detectar pagina</button>
        `;
      }

      body.innerHTML = `<div class="xuf-card xuf-anim">${content}</div>`;

      document.getElementById('xuf-start-uf')?.addEventListener('click', () => CTRL.startUnfollower());
      document.getElementById('xuf-start-af')?.addEventListener('click', () => CTRL.startAutoFollow());
      document.getElementById('xuf-redetect')?.addEventListener('click', () => CTRL.init());
    },

    // -----------------------------------------------------------------
    // Unfollower — fases de UI
    // -----------------------------------------------------------------
    uf: {
      showScan() {
        UI._setBodyMode('center');
        const b = UI._body();
        if (!b) return;
        b.innerHTML = `
          <div class="xuf-card xuf-anim">
            <div class="xuf-spinner"></div>
            <p class="xuf-heading">Escaneando lista de seguidos</p>
            <p class="xuf-sub" id="xuf-scan-sub">Iniciando escaneo...</p>
            <div class="xuf-stats">
              <div class="xuf-stat">
                <span class="xuf-stat-n" id="xuf-sc-n">0</span>
                <span class="xuf-stat-l">Revisados</span>
              </div>
              <div class="xuf-stat">
                <span class="xuf-stat-n" id="xuf-sc-f">0</span>
                <span class="xuf-stat-l">No-mutuos</span>
              </div>
            </div>
            <button class="xuf-btn xuf-btn-ghost" id="xuf-uf-cancel">Cancelar</button>
          </div>
        `;
        document.getElementById('xuf-uf-cancel').onclick = () => {
          S.stop = true;
        };
      },

      updateScan(n, found) {
        const sub = document.getElementById('xuf-scan-sub');
        const nn  = document.getElementById('xuf-sc-n');
        const nf  = document.getElementById('xuf-sc-f');
        if (sub) sub.textContent = 'Escaneando usuario ' + n + '...';
        if (nn)  nn.textContent  = n;
        if (nf)  nf.textContent  = found;
      },

      showResults(nonMutuals) {
        UI._setBodyMode('panel');
        const b = UI._body();
        if (!b) return;

        const rows = nonMutuals.map(({ username, displayName }) => {
          const ini   = (displayName[0] || username[0] || '?').toUpperCase();
          const color = icolor(ini);
          const chk   = S.uf.selected.has(username) ? 'checked' : '';
          return `
            <tr class="xuf-tr">
              <td class="xuf-td xuf-td-cb">
                <input type="checkbox" class="xuf-cb" data-u="${esc(username)}" ${chk}/>
              </td>
              <td class="xuf-td xuf-td-av">
                <div class="xuf-avatar" style="background:${color}">${esc(ini)}</div>
              </td>
              <td class="xuf-td">
                <span class="xuf-u-name">${esc(displayName)}</span>
                <span class="xuf-u-handle">@${esc(username)}</span>
              </td>
            </tr>
          `;
        }).join('');

        b.innerHTML = `
          <div class="xuf-panel xuf-anim">
            <div class="xuf-panel-hd">
              <span class="xuf-sub">No-mutuos detectados</span>
              <div class="xuf-panel-hd-r">
                <span class="xuf-sel-lbl">
                  <strong id="xuf-uf-sel-n">${nonMutuals.length}</strong> de ${nonMutuals.length} seleccionados
                </span>
              </div>
            </div>
            <div class="xuf-toolbar">
              <button class="xuf-btn xuf-btn-ghost" id="xuf-uf-sel-all">Seleccionar todo</button>
              <button class="xuf-btn xuf-btn-ghost" id="xuf-uf-desel">Deseleccionar todo</button>
            </div>
            <div class="xuf-table-scroll">
              <table class="xuf-table"><tbody>${rows}</tbody></table>
            </div>
            <div class="xuf-panel-ft">
              <p class="xuf-ft-note">Sin limite de unfollows por sesion — cooldown cada ${CFG.UF_CD_EVERY} acciones</p>
              <button class="xuf-btn xuf-btn-danger" id="xuf-uf-run">
                Dejar de seguir seleccionados
              </button>
            </div>
          </div>
        `;

        // Sync checkboxes con state
        S.uf.selected.clear();
        nonMutuals.forEach(u => S.uf.selected.add(u.username));

        const refreshCnt = (total) => {
          const el = document.getElementById('xuf-uf-sel-n');
          if (el) el.textContent = S.uf.selected.size;
          const btn = document.getElementById('xuf-uf-run');
          if (btn) btn.disabled = S.uf.selected.size === 0;
        };

        b.querySelectorAll('.xuf-cb').forEach(cb => {
          cb.addEventListener('change', () => {
            cb.checked ? S.uf.selected.add(cb.dataset.u) : S.uf.selected.delete(cb.dataset.u);
            refreshCnt(nonMutuals.length);
          });
        });

        document.getElementById('xuf-uf-sel-all').onclick = () => {
          b.querySelectorAll('.xuf-cb').forEach(cb => { cb.checked = true; S.uf.selected.add(cb.dataset.u); });
          refreshCnt(nonMutuals.length);
        };
        document.getElementById('xuf-uf-desel').onclick = () => {
          b.querySelectorAll('.xuf-cb').forEach(cb => { cb.checked = false; S.uf.selected.delete(cb.dataset.u); });
          refreshCnt(nonMutuals.length);
        };
        document.getElementById('xuf-uf-run').onclick = () => {
          if (S.uf.selected.size > 0) CTRL.runUnfollow();
        };
      },

      showRunning(total) {
        UI._setBodyMode('center');
        const b = UI._body();
        if (!b) return;
        b.innerHTML = `
          <div class="xuf-card xuf-anim">
            <p class="xuf-heading" id="xuf-uf-h">Preparando...</p>
            <p class="xuf-target" id="xuf-uf-u"></p>
            <div class="xuf-prog-wrap">
              <div class="xuf-prog-track">
                <div class="xuf-prog-fill" id="xuf-uf-prog" style="width:0%"></div>
              </div>
              <span class="xuf-prog-lbl" id="xuf-uf-lbl">0 / ${total}</span>
            </div>
            <div class="xuf-cd-banner" id="xuf-uf-cd" style="display:none"></div>
            <button class="xuf-btn xuf-btn-ghost" id="xuf-uf-stop">Detener</button>
          </div>
        `;
        document.getElementById('xuf-uf-stop').onclick = () => {
          S.stop = true;
          const b2 = document.getElementById('xuf-uf-stop');
          if (b2) { b2.textContent = 'Deteniendo...'; b2.disabled = true; }
        };
      },

      updateProgress(cur, total, username, remMs) {
        const pct = Math.round((cur / total) * 100);
        const h   = document.getElementById('xuf-uf-h');
        const u   = document.getElementById('xuf-uf-u');
        const p   = document.getElementById('xuf-uf-prog');
        const l   = document.getElementById('xuf-uf-lbl');
        const cd  = document.getElementById('xuf-uf-cd');
        if (h)  h.textContent = 'Dejando de seguir...';
        if (u)  u.textContent = '@' + username;
        if (p)  p.style.width = pct + '%';
        if (l)  l.textContent = cur + ' / ' + total + '  —  Espera ' + fmtSec(remMs);
        if (cd) cd.style.display = 'none';
      },

      updateCooldown(remMs, cur, total) {
        const h  = document.getElementById('xuf-uf-h');
        const u  = document.getElementById('xuf-uf-u');
        const cd = document.getElementById('xuf-uf-cd');
        if (h)  h.textContent = 'Cooldown activo';
        if (u)  u.textContent = cur + ' de ' + total + ' completados';
        if (cd) {
          cd.style.display = 'block';
          cd.innerHTML = `Reanudando en <strong>${fmtMs(remMs)}</strong>`;
        }
      },

      showDone(count, stopped) {
        UI._setBodyMode('center');
        const b = UI._body();
        if (!b) return;
        const msg = stopped
          ? 'Proceso detenido manualmente.'
          : `Unfollowados ${count} usuario${count !== 1 ? 's' : ''} con exito.`;
        b.innerHTML = `
          <div class="xuf-card xuf-anim">
            ${count > 0 ? `<p class="xuf-big-num">${count}</p>` : ''}
            <p class="xuf-heading">Completado</p>
            <p class="xuf-sub">${esc(msg)}</p>
            <div style="display:flex;gap:8px">
              <button class="xuf-btn xuf-btn-ghost" id="xuf-uf-again">Ejecutar nuevamente</button>
              <button class="xuf-btn xuf-btn-primary" id="xuf-uf-dash">Volver al Dashboard</button>
            </div>
          </div>
        `;
        document.getElementById('xuf-uf-again').onclick = () => CTRL.startUnfollower();
        document.getElementById('xuf-uf-dash').onclick  = () => CTRL.backToDashboard();
      },
    },

    // -----------------------------------------------------------------
    // Auto-Follow — fases de UI
    // -----------------------------------------------------------------
    af: {
      showLoading(count) {
        UI._setBodyMode('center');
        const b = UI._body();
        if (!b) return;
        b.innerHTML = `
          <div class="xuf-card xuf-anim">
            <div class="xuf-spinner"></div>
            <p class="xuf-heading">Cargando seguidores</p>
            <p class="xuf-sub" id="xuf-af-sub">Iniciando...</p>
            <div class="xuf-stats">
              <div class="xuf-stat">
                <span class="xuf-stat-n" id="xuf-af-n">${count}</span>
                <span class="xuf-stat-l">Cargados</span>
              </div>
            </div>
            <button class="xuf-btn xuf-btn-ghost" id="xuf-af-cancel">Cancelar</button>
          </div>
        `;
        document.getElementById('xuf-af-cancel').onclick = () => { S.stop = true; };
      },

      updateLoading(count) {
        const sub = document.getElementById('xuf-af-sub');
        const n   = document.getElementById('xuf-af-n');
        if (sub) sub.textContent = 'Cargando usuarios ' + count + '...';
        if (n)   n.textContent   = count;
      },

      showResults(candidates) {
        UI._setBodyMode('panel');
        const b = UI._body();
        if (!b) return;

        const isAFLimit = candidates.length > CFG.AF_MAX_PER_BATCH;

        const rows = candidates.map(({ username, displayName }) => {
          const ini   = (displayName[0] || username[0] || '?').toUpperCase();
          const color = icolor(ini);
          const chk   = S.af.selected.has(username) ? 'checked' : '';
          return `
            <tr class="xuf-tr">
              <td class="xuf-td xuf-td-cb">
                <input type="checkbox" class="xuf-cb" data-u="${esc(username)}" ${chk}/>
              </td>
              <td class="xuf-td xuf-td-av">
                <div class="xuf-avatar" style="background:${color}">${esc(ini)}</div>
              </td>
              <td class="xuf-td">
                <span class="xuf-u-name">${esc(displayName)}</span>
                <span class="xuf-u-handle">@${esc(username)}</span>
              </td>
            </tr>
          `;
        }).join('');

        const limitBar = isAFLimit ? `
          <div class="xuf-limit-bar">
            <strong>Atencion:</strong> Solo se procesaran los primeros <strong>${CFG.AF_MAX_PER_BATCH}</strong> seleccionados por lote.
          </div>` : '';

        const loadMoreBtn = !S.af.scanDone ? `
          <button class="xuf-btn xuf-btn-ghost" id="xuf-af-more">
            Cargar mas seguidores (+${CFG.AF_CHUNK_SIZE})
          </button>` : `<span class="xuf-ft-note">Lista completa cargada</span>`;

        b.innerHTML = `
          <div class="xuf-panel xuf-anim">
            <div class="xuf-panel-hd">
              <span class="xuf-sub">Seguidores disponibles para seguir</span>
              <div class="xuf-panel-hd-r">
                <span class="xuf-sel-lbl">
                  <strong id="xuf-af-sel-n">${candidates.length}</strong> de ${candidates.length} seleccionados
                </span>
              </div>
            </div>
            ${limitBar}
            <div class="xuf-toolbar">
              <button class="xuf-btn xuf-btn-ghost" id="xuf-af-sel-all">Seleccionar todo</button>
              <button class="xuf-btn xuf-btn-ghost" id="xuf-af-desel">Deseleccionar todo</button>
            </div>
            <div class="xuf-table-scroll">
              <table class="xuf-table"><tbody>${rows}</tbody></table>
            </div>
            <div class="xuf-panel-ft">
              ${loadMoreBtn}
              <button class="xuf-btn xuf-btn-primary" id="xuf-af-run">
                Seguir seleccionados
              </button>
            </div>
          </div>
        `;

        // Sync con state
        S.af.selected.clear();
        candidates.forEach(u => S.af.selected.add(u.username));

        const refreshCnt = () => {
          const el = document.getElementById('xuf-af-sel-n');
          if (el) el.textContent = S.af.selected.size;
          const btn = document.getElementById('xuf-af-run');
          if (btn) btn.disabled = S.af.selected.size === 0;
        };

        b.querySelectorAll('.xuf-cb').forEach(cb => {
          cb.addEventListener('change', () => {
            cb.checked ? S.af.selected.add(cb.dataset.u) : S.af.selected.delete(cb.dataset.u);
            refreshCnt();
          });
        });

        document.getElementById('xuf-af-sel-all').onclick = () => {
          b.querySelectorAll('.xuf-cb').forEach(cb => { cb.checked = true; S.af.selected.add(cb.dataset.u); });
          refreshCnt();
        };
        document.getElementById('xuf-af-desel').onclick = () => {
          b.querySelectorAll('.xuf-cb').forEach(cb => { cb.checked = false; S.af.selected.delete(cb.dataset.u); });
          refreshCnt();
        };
        document.getElementById('xuf-af-more')?.addEventListener('click', () => CTRL.loadMoreFollowers());
        document.getElementById('xuf-af-run').onclick = () => {
          if (S.af.selected.size > 0) CTRL.runAutoFollow();
        };
      },

      showRunning(total) {
        UI._setBodyMode('center');
        const b = UI._body();
        if (!b) return;
        b.innerHTML = `
          <div class="xuf-card xuf-anim">
            <p class="xuf-heading" id="xuf-af-h">Preparando...</p>
            <p class="xuf-target" id="xuf-af-u"></p>
            <div class="xuf-prog-wrap">
              <div class="xuf-prog-track">
                <div class="xuf-prog-fill" id="xuf-af-prog" style="width:0%"></div>
              </div>
              <span class="xuf-prog-lbl" id="xuf-af-lbl">0 / ${total}</span>
            </div>
            <div class="xuf-cd-banner" id="xuf-af-cd" style="display:none"></div>
            <button class="xuf-btn xuf-btn-ghost" id="xuf-af-stop">Detener</button>
          </div>
        `;
        document.getElementById('xuf-af-stop').onclick = () => {
          S.stop = true;
          const s = document.getElementById('xuf-af-stop');
          if (s) { s.textContent = 'Deteniendo...'; s.disabled = true; }
        };
      },

      updateProgress(cur, total, username, remMs) {
        const pct = Math.round((cur / total) * 100);
        const h   = document.getElementById('xuf-af-h');
        const u   = document.getElementById('xuf-af-u');
        const p   = document.getElementById('xuf-af-prog');
        const l   = document.getElementById('xuf-af-lbl');
        const cd  = document.getElementById('xuf-af-cd');
        if (h)  h.textContent = 'Siguiendo a...';
        if (u)  u.textContent = '@' + username;
        if (p)  p.style.width = pct + '%';
        if (l)  l.textContent = cur + ' / ' + total + '  —  Espera ' + fmtSec(remMs);
        if (cd) cd.style.display = 'none';
      },

      updateCooldown(remMs, cur, total) {
        const h  = document.getElementById('xuf-af-h');
        const u  = document.getElementById('xuf-af-u');
        const cd = document.getElementById('xuf-af-cd');
        if (h)  h.textContent = 'Cooldown activo';
        if (u)  u.textContent = cur + ' de ' + total + ' completados';
        if (cd) {
          cd.style.display = 'block';
          cd.innerHTML = `Reanudando en <strong>${fmtMs(remMs)}</strong>`;
        }
      },

      showDone(count, stopped) {
        UI._setBodyMode('center');
        const b = UI._body();
        if (!b) return;
        const msg = stopped
          ? 'Proceso detenido manualmente.'
          : `Seguidos ${count} usuario${count !== 1 ? 's' : ''}. Espera 2 horas antes de la proxima sesion.`;
        b.innerHTML = `
          <div class="xuf-card xuf-anim">
            ${count > 0 ? `<p class="xuf-big-num">${count}</p>` : ''}
            <p class="xuf-heading">${stopped ? 'Proceso detenido' : 'Lote completado'}</p>
            <p class="xuf-sub">${esc(msg)}</p>
            <button class="xuf-btn xuf-btn-primary" id="xuf-af-dash">Volver al Dashboard</button>
          </div>
        `;
        document.getElementById('xuf-af-dash').onclick = () => CTRL.backToDashboard();
      },
    },
  };

  // =================================================================
  // CONTROLADOR PRINCIPAL
  // Orquesta la comunicacion entre modulos de datos y UI.
  // =================================================================
  const CTRL = {
    /** Detecta la pagina, construye el shell y muestra el dashboard */
    init() {
      const page = detectPage();
      S.sessionStart = S.sessionStart || Date.now();
      S.running = false;
      S.stop    = false;

      // Actualizar tabs segun pagina
      UI.buildShell(page);
      UI.showDashboard(page);
    },

    backToDashboard() {
      S.activeModule = null;
      S.running      = false;
      S.stop         = false;
      // Resetear estado del modulo que se usó
      S.uf.phase     = 'idle';
      S.af.phase     = 'idle';
      this.init();
    },

    // -----------------------------------------------------------------
    // Unfollower — flujo completo
    // -----------------------------------------------------------------
    startUnfollower() {
      S.activeModule   = 'unfollow';
      S.running        = true;
      S.stop           = false;
      S.uf.nonMutuals  = [];
      S.uf.selected.clear();
      S.uf.count       = 0;
      S.uf.phase       = 'scanning';

      // Asegurarse que el tab UF este activo visualmente
      document.getElementById('xuf-tab-uf')?.classList.add('xuf-tab-active');
      document.getElementById('xuf-tab-af')?.classList.remove('xuf-tab-active');

      UI.uf.showScan();
      this._doUnfollowerScan();
    },

    async _doUnfollowerScan() {
      await SCRAPER.scanUnfollowers((n, found) => UI.uf.updateScan(n, found));

      if (S.stop) { CTRL.backToDashboard(); return; }

      if (S.uf.nonMutuals.length === 0) {
        S.running = false;
        UI.uf.showDone(0, false);
        return;
      }

      S.uf.phase = 'results';
      S.running  = false; // resultados no cuentan como "corriendo"
      UI.uf.showResults(S.uf.nonMutuals);
    },

    runUnfollow() {
      const queue = S.uf.nonMutuals.filter(u => S.uf.selected.has(u.username));
      if (!queue.length) return;

      S.running  = true;
      S.stop     = false;
      S.uf.phase = 'running';
      UI.uf.showRunning(queue.length);

      UF.run(
        queue,
        (cur, total, user, remMs) => UI.uf.updateProgress(cur, total, user, remMs),
        (remMs, cur, total)       => UI.uf.updateCooldown(remMs, cur, total)
      ).then(({ done, stopped }) => {
        S.running  = false;
        S.uf.phase = 'done';
        UI.uf.showDone(done, stopped);
      });
    },

    // -----------------------------------------------------------------
    // Auto-Follow — flujo completo
    // -----------------------------------------------------------------
    startAutoFollow() {
      if (AF.batchCooldownActive()) {
        this.init(); // re-render dashboard con el aviso de cooldown
        return;
      }

      S.activeModule  = 'autofollow';
      S.running       = true;
      S.stop          = false;
      S.af.candidates = [];
      S.af.selected.clear();
      S.af.seen.clear();
      S.af.count      = 0;
      S.af.phase      = 'loading';
      S.af.scanDone   = false;
      S.af.stuckCount = 0;
      S.af.lastHeight = 0;

      document.getElementById('xuf-tab-af')?.classList.add('xuf-tab-active');
      document.getElementById('xuf-tab-uf')?.classList.remove('xuf-tab-active');

      UI.af.showLoading(0);
      this._doFollowerLoad();
    },

    async _doFollowerLoad() {
      await SCRAPER.scanFollowers(count => UI.af.updateLoading(count));

      if (S.stop) { CTRL.backToDashboard(); return; }

      S.running  = false;
      S.af.phase = 'results';
      UI.af.showResults(S.af.candidates);
    },

    /** Carga el siguiente chunk de seguidores */
    loadMoreFollowers() {
      if (S.af.scanDone) return;
      S.running = true;
      UI.af.showLoading(S.af.candidates.length);
      this._doFollowerLoad();
    },

    runAutoFollow() {
      const queue = S.af.candidates
        .filter(u => S.af.selected.has(u.username))
        .slice(0, CFG.AF_MAX_PER_BATCH);
      if (!queue.length) return;

      S.running  = true;
      S.stop     = false;
      S.af.phase = 'running';
      UI.af.showRunning(queue.length);

      AF.run(
        queue,
        (cur, total, user, remMs) => UI.af.updateProgress(cur, total, user, remMs),
        (remMs, cur, total)       => UI.af.updateCooldown(remMs, cur, total)
      ).then(({ done, stopped }) => {
        S.running  = false;
        S.af.phase = 'done';
        UI.af.showDone(done, stopped);
      });
    },
  };

  // =================================================================
  // INICIALIZACION
  // =================================================================

  UI.mount();
  CTRL.init();

  console.log(
    '%cUnfollowers-X v2.0 cargado',
    'color:#484848;font-weight:bold;font-size:13px'
  );

})();
