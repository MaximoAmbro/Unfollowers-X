/**
 * =============================================================
 *  Unfollowers-X  v1.2
 *  Vanilla JavaScript  —  Sin dependencias externas
 * =============================================================
 *
 *  Detecta y gestiona cuentas no-mutuas en X (Twitter) desde
 *  la Consola de Desarrollador del navegador.
 *
 *  Arquitectura V1.2:
 *  - Overlay full-screen: el usuario ve solo la UI del script
 *  - DOM Scraping en background: X scrollea invisible al usuario
 *  - Modulos independientes: Detector, Scraper, Unfollower, UI
 *
 *  USO:
 *  1. Navegar a https://x.com/TU_USERNAME/following
 *  2. Abrir DevTools (F12) -> Console
 *  3. Pegar este script completo y presionar Enter
 *
 *  ADVERTENCIA: El uso de automatizaciones puede infringir los
 *  Terminos de Servicio de X. Usar bajo responsabilidad propia.
 * =============================================================
 */

(function () {
  'use strict';

  // =============================================================
  // CONFIGURACION
  // Ajustar segun tolerancia al riesgo. No bajar DELAY_MIN_MS
  // por debajo de 20000 ni subir MAX_UNFOLLOWS por encima de 25.
  // =============================================================
  const CONFIG = {
    DELAY_MIN_MS:       35_000,  // 35s minimo entre unfollows
    DELAY_MAX_MS:       85_000,  // 85s maximo entre unfollows
    MAX_UNFOLLOWS:      22,      // limite de seguridad por sesion
    SCROLL_MIN_MS:      500,     // delay minimo entre scrolls del escaneo
    SCROLL_MAX_MS:      2_000,   // delay maximo entre scrolls del escaneo
    SCROLL_STEP_PX:     700,     // pixeles por cada scroll
    MAX_STUCK_SCROLLS:  6,       // scrolls sin cambio de altura -> fin de lista
    SESSION_TIMEOUT_MS: 30 * 60 * 1_000,  // 30 min de timeout total
  };

  // =============================================================
  // ESTADO GLOBAL
  // =============================================================
  const state = {
    /** @type {Array<{username: string, displayName: string}>} */
    nonMutuals: [],

    /** Usernames marcados con checkbox para unfollow */
    selected: new Set(),

    /** @type {'idle'|'scanning'|'results'|'unfollowing'|'done'} */
    phase: 'idle',

    unfollowCount: 0,
    stopFlag: false,
    sessionStart: null,
  };

  // =============================================================
  // UTILIDADES
  // =============================================================

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** Entero aleatorio entre min y max inclusive */
  const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  /** Escapa HTML para prevenir XSS al inyectar datos del DOM en la UI */
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  /** Extrae el username limpio de un href de perfil de X */
  function usernameFromHref(href) {
    if (!href) return null;
    return (href.split('/')[1] ?? '').split('?')[0].toLowerCase() || null;
  }

  /**
   * Asigna un color de fondo al avatar de iniciales.
   * Deterministico por letra, sin colores brillantes que rompan el tema oscuro.
   */
  function initialColor(ch) {
    const palette = [
      '#1e3a5f', '#1e4d3a', '#3d2260', '#5c2020',
      '#1a4a4a', '#3a3a1e', '#2d1f4f', '#1f3d2d',
    ];
    const idx = ((ch || 'a').toLowerCase().charCodeAt(0) - 97 + 26) % 26;
    return palette[idx % palette.length];
  }

  /** Devuelve true si la sesion supero el timeout maximo */
  function sessionExpired() {
    return state.sessionStart !== null &&
      (Date.now() - state.sessionStart) > CONFIG.SESSION_TIMEOUT_MS;
  }

  // =============================================================
  // MODULO: DETECTOR
  // Responsabilidad: analizar celdas del DOM de X para determinar
  // si un usuario es mutuo y extraer sus datos.
  // =============================================================
  const Detector = {
    _systemPaths: new Set([
      'search', 'explore', 'notifications', 'messages',
      'settings', 'home', 'i', 'following', 'followers',
    ]),

    /**
     * Determina si el usuario de este UserCell nos sigue de vuelta.
     *
     * X inyecta la etiqueta "Follows you" / "Te sigue" directamente
     * en el innerText de la celda. Buscar el texto es mas robusto
     * que buscar clases CSS, que cambian con cada deploy de X.
     */
    doesFollowBack(cell) {
      const text = cell.innerText || cell.textContent || '';
      return /te sigue\b/i.test(text) || /follows you\b/i.test(text);
    },

    /**
     * Extrae username y nombre de display desde un [data-testid="UserCell"].
     *
     * Estrategia de username: recorre los <a href> de la celda descartando
     * rutas del sistema de X (explore, settings, etc.).
     *
     * Estrategia de nombre: intenta dos selectores conocidos de X con
     * fallback al username si ninguno esta presente.
     */
    extractInfo(cell) {
      let username = null;

      for (const a of cell.querySelectorAll('a[href^="/"]')) {
        const u = usernameFromHref(a.getAttribute('href'));
        if (u && !u.includes('#') && !this._systemPaths.has(u)) {
          username = u;
          break;
        }
      }

      const nameEl =
        cell.querySelector('[data-testid="User-Name"] span span') ||
        cell.querySelector('[data-testid="UserName"] span span');

      const displayName = nameEl?.textContent?.trim() || username || 'Usuario';

      return { username, displayName };
    },
  };

  // =============================================================
  // MODULO: SCRAPER
  // Responsabilidad: desplazar la pagina de X en background
  // mientras el overlay oculta el scroll al usuario.
  // =============================================================
  const Scraper = {
    /**
     * Recorre la pagina /following haciendo scroll automatico.
     *
     * El overlay de la UI esta activo durante esta fase, por lo que
     * el usuario no ve el scroll. window.scrollBy() opera sobre el
     * documento subyacente independientemente del overlay.
     *
     * Algoritmo de terminacion: si el scrollHeight no cambia
     * CONFIG.MAX_STUCK_SCROLLS veces consecutivas, se considera
     * que se llego al final de la lista.
     *
     * @param {function(number, number): void} onProgress
     *   Callback con (totalRevisados, noMutuosEncontrados)
     */
    async run(onProgress) {
      window.scrollTo(0, 0);
      await sleep(1_200);

      const seen = new Set();
      let stuckCount = 0;
      let lastHeight = 0;

      while (stuckCount < CONFIG.MAX_STUCK_SCROLLS && !state.stopFlag) {
        if (sessionExpired()) {
          console.warn('[Unfollowers-X] Timeout de sesion alcanzado durante escaneo.');
          break;
        }

        document.querySelectorAll('[data-testid="UserCell"]').forEach(cell => {
          const { username, displayName } = Detector.extractInfo(cell);
          if (!username || seen.has(username)) return;

          seen.add(username);

          if (!Detector.doesFollowBack(cell)) {
            state.nonMutuals.push({ username, displayName });
          }
        });

        onProgress(seen.size, state.nonMutuals.length);

        window.scrollBy(0, CONFIG.SCROLL_STEP_PX);
        await sleep(rnd(CONFIG.SCROLL_MIN_MS, CONFIG.SCROLL_MAX_MS));

        const newHeight = document.body.scrollHeight;
        stuckCount = (newHeight === lastHeight) ? stuckCount + 1 : 0;
        lastHeight = newHeight;
      }

      return { scanned: seen.size, found: state.nonMutuals.length };
    },
  };

  // =============================================================
  // MODULO: UNFOLLOWER
  // Responsabilidad: ejecutar las acciones de unfollow con
  // delays anti-baneo y confirmacion del modal de X.
  // =============================================================
  const Unfollower = {
    /**
     * Localiza el boton de unfollow dentro de un UserCell.
     *
     * X usa data-testid="[username]-follow" para este boton.
     * Se incluyen tres estrategias de fallback para sobrevivir
     * a cambios de nomenclatura en futuros deploys de X.
     */
    findBtn(cell) {
      return (
        cell.querySelector('[data-testid$="-follow"]')                        ||
        cell.querySelector('button[aria-label*="Unfollow" i]')                ||
        cell.querySelector('button[aria-label*="Dejar de seguir" i]')         ||
        [...cell.querySelectorAll('button')].find(b =>
          /siguiendo|following/i.test(b.textContent)
        )                                                                      ||
        null
      );
    },

    /**
     * Polling del modal de confirmacion de X.
     *
     * X muestra [data-testid="confirmationSheetConfirm"] al hacer
     * clic en "Siguiendo" para cuentas publicas. El polling cada
     * 150ms hasta el timeout evita race conditions con la animacion
     * de apertura del modal.
     */
    async waitConfirm(timeoutMs = 4_000) {
      const deadline = Date.now() + timeoutMs;
      return new Promise(resolve => {
        const check = () => {
          const btn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
          if (btn) {
            btn.click();
            return resolve(true);
          }
          Date.now() < deadline ? setTimeout(check, 150) : resolve(true);
        };
        check();
      });
    },

    /**
     * Procesa la cola de unfollows con scroll progresivo.
     *
     * Por que scroll progresivo en lugar de referencias guardadas:
     * X virtualiza la lista eliminando nodos del DOM al scrollear.
     * Las referencias a elementos guardadas durante el escaneo pueden
     * quedar invalidadas. Buscar activamente cada UserCell al momento
     * de procesarlo es el unico metodo fiable para listas largas.
     *
     * @param {Array<{username, displayName}>} queue
     * @param {function(number, number, string): void} onProgress
     * @param {function(number, number, number): Promise<void>} onCountdown
     * @returns {Promise<{done: number, limitReached: boolean, stopped: boolean}>}
     */
    async processQueue(queue, onProgress, onCountdown) {
      state.unfollowCount = 0;
      window.scrollTo(0, 0);
      await sleep(1_500);

      const pending = new Set(queue.map(u => u.username));
      let done = 0;
      let lastHeight = 0;
      let stuckCount = 0;

      while (pending.size > 0 && !state.stopFlag && stuckCount < 7) {
        if (sessionExpired()) {
          console.warn('[Unfollowers-X] Timeout de sesion alcanzado durante unfollow.');
          break;
        }

        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        let foundInThisPass = false;

        for (const cell of cells) {
          const { username } = Detector.extractInfo(cell);
          if (!username || !pending.has(username)) continue;

          foundInThisPass = true;
          pending.delete(username); // eliminar antes de procesar evita duplicados

          cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(500 + Math.random() * 400);

          const btn = this.findBtn(cell);

          if (!btn) {
            console.warn('[Unfollowers-X] Boton no encontrado para @' + username);
            continue;
          }

          onProgress(done + 1, queue.length, username);

          try {
            // Hover antes del clic simula comportamiento humano
            btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
            await sleep(250 + Math.random() * 150);

            btn.click();
            await sleep(800 + Math.random() * 300);

            await this.waitConfirm();
            await sleep(400);

            state.unfollowCount++;
            done++;
          } catch (err) {
            console.error('[Unfollowers-X] Error procesando @' + username + ':', err);
          }

          // Verificar limite de sesion
          if (state.unfollowCount >= CONFIG.MAX_UNFOLLOWS) {
            return { done, limitReached: true, stopped: false };
          }

          // Delay anti-baneo aleatorio antes del proximo unfollow
          if (pending.size > 0 && !state.stopFlag) {
            const totalMs  = rnd(CONFIG.DELAY_MIN_MS, CONFIG.DELAY_MAX_MS);
            const totalSec = Math.round(totalMs / 1_000);
            await onCountdown(totalSec, done, queue.length);
          }
        }

        if (!foundInThisPass) {
          window.scrollBy(0, CONFIG.SCROLL_STEP_PX);
          await sleep(rnd(CONFIG.SCROLL_MIN_MS, CONFIG.SCROLL_MAX_MS));
          const newHeight = document.body.scrollHeight;
          stuckCount = (newHeight === lastHeight) ? stuckCount + 1 : 0;
          lastHeight = newHeight;
        } else {
          stuckCount = 0;
        }
      }

      return { done, limitReached: false, stopped: state.stopFlag };
    },
  };

  // =============================================================
  // MODULO: UI
  // Responsabilidad: crear y gestionar el overlay full-screen,
  // renderizar cada fase del flujo y exponer callbacks.
  // =============================================================
  const UI = {
    _el: null, // referencia al elemento #xuf-overlay

    // -----------------------------------------------------------
    // CSS del overlay: inyectado una sola vez en <head>
    // -----------------------------------------------------------
    _CSS: `
      /* ── Base overlay ────────────────────────────────────── */
      #xuf-overlay {
        position: fixed;
        inset: 0;
        z-index: 9999999;
        background: #0f0f0f;
        color: #e0e0e0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                     'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.55;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }

      /* ── Animacion de entrada ────────────────────────────── */
      @keyframes xuf-in {
        from { opacity: 0; transform: translateY(10px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .xuf-anim { animation: xuf-in 0.22s ease; }

      /* ── Card centrada (escaneo / unfollow / done) ───────── */
      .xuf-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 28px;
        width: 100%;
        max-width: 440px;
        padding: 56px 32px;
        text-align: center;
      }

      /* ── Marca ───────────────────────────────────────────── */
      .xuf-brand {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 2.5px;
        text-transform: uppercase;
        color: #2e2e2e;
        margin: 0;
      }

      /* ── Spinner CSS puro ────────────────────────────────── */
      @keyframes xuf-spin { to { transform: rotate(360deg); } }
      .xuf-spinner {
        width: 30px;
        height: 30px;
        border: 2px solid #1c1c1c;
        border-top-color: #666;
        border-radius: 50%;
        animation: xuf-spin 0.85s linear infinite;
        flex-shrink: 0;
      }

      /* ── Tipografia ──────────────────────────────────────── */
      .xuf-heading {
        font-size: 20px;
        font-weight: 600;
        color: #e0e0e0;
        margin: 0;
        letter-spacing: -0.3px;
      }
      .xuf-sub {
        font-size: 13px;
        color: #484848;
        margin: 0;
        max-width: 320px;
        line-height: 1.6;
      }
      .xuf-big-num {
        font-size: 80px;
        font-weight: 700;
        color: #e0e0e0;
        line-height: 1;
        margin: 0;
        letter-spacing: -4px;
      }
      .xuf-target {
        font-size: 17px;
        font-weight: 600;
        color: #606060;
        margin: 0;
        min-height: 24px;
      }

      /* ── Fila de estadisticas (fase escaneo) ─────────────── */
      .xuf-stats {
        display: flex;
        gap: 52px;
        align-items: flex-end;
      }
      .xuf-stat {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
      }
      .xuf-stat-n {
        font-size: 42px;
        font-weight: 700;
        color: #e0e0e0;
        line-height: 1;
        letter-spacing: -1.5px;
        min-width: 60px;
        text-align: center;
      }
      .xuf-stat-l {
        font-size: 10px;
        color: #303030;
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
        background: #1c1c1c;
        border-radius: 1px;
        overflow: hidden;
      }
      .xuf-prog-fill {
        height: 100%;
        background: #e0e0e0;
        border-radius: 1px;
        transition: width 0.35s ease;
      }
      .xuf-prog-lbl {
        font-size: 11px;
        color: #383838;
      }

      /* ── Panel de resultados ─────────────────────────────── */
      #xuf-overlay.xuf-panel-mode {
        align-items: stretch;
        justify-content: flex-start;
      }
      .xuf-panel {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        max-width: 860px;
        margin: 0 auto;
      }
      .xuf-panel-hd {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 18px 28px;
        border-bottom: 1px solid #181818;
        flex-shrink: 0;
        gap: 16px;
      }
      .xuf-panel-hd-r {
        display: flex;
        align-items: center;
        gap: 20px;
      }
      .xuf-counter-lbl {
        font-size: 12px;
        color: #404040;
        white-space: nowrap;
      }
      .xuf-counter-lbl strong {
        color: #c0c0c0;
        font-weight: 600;
      }

      /* Aviso cuando hay mas no-mutuos que el limite */
      .xuf-warn-bar {
        background: #161200;
        border-bottom: 1px solid #201800;
        padding: 8px 28px;
        font-size: 12px;
        color: #585030;
        flex-shrink: 0;
      }
      .xuf-warn-bar strong { color: #907830; }

      .xuf-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 11px 28px;
        border-bottom: 1px solid #181818;
        flex-shrink: 0;
      }
      .xuf-table-scroll {
        flex: 1;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: #1c1c1c transparent;
      }
      .xuf-table-scroll::-webkit-scrollbar       { width: 3px; }
      .xuf-table-scroll::-webkit-scrollbar-thumb { background: #1c1c1c; }

      .xuf-table {
        width: 100%;
        border-collapse: collapse;
      }
      .xuf-tr {
        border-bottom: 1px solid #131313;
        transition: background 0.1s;
      }
      .xuf-tr:hover { background: #111111; }
      .xuf-td {
        padding: 10px 12px;
        vertical-align: middle;
      }
      .xuf-td-cb { width: 48px; text-align: center; }
      .xuf-td-av { width: 52px; }

      /* Avatar de iniciales: sin carga de imagenes externas */
      .xuf-avatar {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 700;
        color: rgba(255, 255, 255, 0.65);
        flex-shrink: 0;
      }
      .xuf-u-name {
        display: block;
        font-weight: 600;
        font-size: 14px;
        color: #d0d0d0;
      }
      .xuf-u-handle {
        display: block;
        font-size: 12px;
        color: #404040;
        margin-top: 2px;
      }

      .xuf-panel-ft {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 28px;
        border-top: 1px solid #181818;
        flex-shrink: 0;
        gap: 16px;
      }
      .xuf-limit-note {
        font-size: 12px;
        color: #303030;
        margin: 0;
      }

      /* ── Botones ─────────────────────────────────────────── */
      .xuf-btn {
        padding: 8px 20px;
        border-radius: 5px;
        border: none;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: background 0.15s, color 0.15s, opacity 0.15s, border-color 0.15s;
        white-space: nowrap;
        font-family: inherit;
        line-height: 1.4;
      }
      .xuf-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
        pointer-events: none;
      }
      .xuf-btn:focus-visible {
        outline: 2px solid #505050;
        outline-offset: 2px;
      }
      .xuf-btn-primary {
        background: #e0e0e0;
        color: #0f0f0f;
      }
      .xuf-btn-primary:hover:not(:disabled) { background: #ffffff; }

      .xuf-btn-ghost {
        background: transparent;
        color: #505050;
        border: 1px solid #1e1e1e;
      }
      .xuf-btn-ghost:hover:not(:disabled) {
        background: #181818;
        color: #c0c0c0;
        border-color: #282828;
      }
      .xuf-btn-icon {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 11px;
        font-weight: 700;
        color: #303030;
        padding: 6px 8px;
        border-radius: 4px;
        transition: color 0.1s, background 0.1s;
        font-family: inherit;
        line-height: 1;
      }
      .xuf-btn-icon:hover { color: #e0e0e0; background: #181818; }

      /* ── Checkbox ────────────────────────────────────────── */
      .xuf-cb {
        width: 14px;
        height: 14px;
        cursor: pointer;
        accent-color: #c0c0c0;
      }
      .xuf-cb:disabled { opacity: 0.3; cursor: not-allowed; }
    `,

    // -----------------------------------------------------------
    // Metodos de ciclo de vida del overlay
    // -----------------------------------------------------------

    /** Inyecta el CSS en <head>. Idempotente. */
    _injectStyles() {
      if (document.getElementById('xuf-css')) return;
      const s = document.createElement('style');
      s.id = 'xuf-css';
      s.textContent = this._CSS;
      document.head.appendChild(s);
    },

    /** Crea el elemento overlay en el DOM y lo retorna. */
    mount() {
      document.getElementById('xuf-overlay')?.remove();
      this._injectStyles();
      this._el = document.createElement('div');
      this._el.id = 'xuf-overlay';
      document.body.appendChild(this._el);
      return this._el;
    },

    /** Elimina el overlay del DOM y restaura el feed de X. */
    unmount() {
      this._el?.remove();
      this._el = null;
    },

    // -----------------------------------------------------------
    // FASE 1: Escaneo
    // -----------------------------------------------------------

    /** Renderiza la pantalla de escaneo con spinner y contadores. */
    showScanPhase() {
      if (!this._el) return;
      this._el.classList.remove('xuf-panel-mode');
      this._el.innerHTML = `
        <div class="xuf-card xuf-anim">
          <p class="xuf-brand">Unfollowers-X &nbsp; v1.2</p>
          <div class="xuf-spinner"></div>
          <p class="xuf-heading">Escaneando lista de seguidos</p>
          <p class="xuf-sub" id="xuf-scan-sub">Iniciando...</p>
          <div class="xuf-stats">
            <div class="xuf-stat">
              <span class="xuf-stat-n" id="xuf-n-scanned">0</span>
              <span class="xuf-stat-l">Revisados</span>
            </div>
            <div class="xuf-stat">
              <span class="xuf-stat-n" id="xuf-n-found">0</span>
              <span class="xuf-stat-l">No-mutuos</span>
            </div>
          </div>
          <button class="xuf-btn xuf-btn-ghost" id="xuf-cancel-scan">Cancelar</button>
        </div>
      `;
      document.getElementById('xuf-cancel-scan').onclick = () => {
        state.stopFlag = true;
      };
    },

    /** Actualiza los contadores de la fase de escaneo. */
    updateScanProgress(scanned, found) {
      const sub = document.getElementById('xuf-scan-sub');
      const ns  = document.getElementById('xuf-n-scanned');
      const nf  = document.getElementById('xuf-n-found');
      if (sub) sub.textContent = 'Escaneando usuario ' + scanned + '...';
      if (ns)  ns.textContent  = scanned;
      if (nf)  nf.textContent  = found;
    },

    // -----------------------------------------------------------
    // FASE 2: Tabla de resultados
    // -----------------------------------------------------------

    /**
     * Renderiza el panel con la tabla de no-mutuos y checkboxes.
     * El panel ocupa el 100% del overlay con header y footer fijos.
     */
    showResultsPhase(nonMutuals) {
      if (!this._el) return;
      this._el.classList.add('xuf-panel-mode');

      const showWarning = nonMutuals.length > CONFIG.MAX_UNFOLLOWS;
      const warningHTML = showWarning ? `
        <div class="xuf-warn-bar">
          <strong>Atencion:</strong> Se detectaron ${nonMutuals.length} no-mutuos,
          pero el limite de seguridad es <strong>${CONFIG.MAX_UNFOLLOWS} por sesion</strong>.
          Ejecuta el script varias veces para procesar el resto.
        </div>
      ` : '';

      const rows = nonMutuals.map(({ username, displayName }) => {
        const initial = (displayName[0] || username[0] || 'U').toUpperCase();
        const color   = initialColor(initial);
        return `
          <tr class="xuf-tr">
            <td class="xuf-td xuf-td-cb">
              <input type="checkbox" class="xuf-cb" data-u="${esc(username)}" checked />
            </td>
            <td class="xuf-td xuf-td-av">
              <div class="xuf-avatar" style="background:${color}">${esc(initial)}</div>
            </td>
            <td class="xuf-td">
              <span class="xuf-u-name">${esc(displayName)}</span>
              <span class="xuf-u-handle">@${esc(username)}</span>
            </td>
          </tr>
        `;
      }).join('');

      this._el.innerHTML = `
        <div class="xuf-panel xuf-anim">
          <div class="xuf-panel-hd">
            <p class="xuf-brand">Unfollowers-X &nbsp; v1.2</p>
            <div class="xuf-panel-hd-r">
              <span class="xuf-counter-lbl">
                <strong id="xuf-sel-cnt">${nonMutuals.length}</strong>
                de ${nonMutuals.length} seleccionados
              </span>
              <button class="xuf-btn-icon" id="xuf-btn-close" title="Cerrar">X</button>
            </div>
          </div>
          ${warningHTML}
          <div class="xuf-toolbar">
            <button class="xuf-btn xuf-btn-ghost" id="xuf-sel-all">Seleccionar todo</button>
            <button class="xuf-btn xuf-btn-ghost" id="xuf-desel-all">Deseleccionar todo</button>
          </div>
          <div class="xuf-table-scroll">
            <table class="xuf-table">
              <tbody>${rows}</tbody>
            </table>
          </div>
          <div class="xuf-panel-ft">
            <p class="xuf-limit-note">Maximo ${CONFIG.MAX_UNFOLLOWS} unfollows por sesion</p>
            <button class="xuf-btn xuf-btn-primary" id="xuf-btn-unfollow">
              Dejar de seguir seleccionados
            </button>
          </div>
        </div>
      `;

      // Inicializar selected con todos los usuarios
      state.selected.clear();
      nonMutuals.forEach(u => state.selected.add(u.username));

      // Checkboxes individuales
      this._el.querySelectorAll('.xuf-cb').forEach(cb => {
        cb.addEventListener('change', () => {
          const u = cb.dataset.u;
          cb.checked ? state.selected.add(u) : state.selected.delete(u);
          this._refreshSelCounter(nonMutuals.length);
          this._refreshUnfollowBtn();
        });
      });

      document.getElementById('xuf-sel-all').onclick = () => {
        this._el.querySelectorAll('.xuf-cb').forEach(cb => {
          cb.checked = true;
          state.selected.add(cb.dataset.u);
        });
        this._refreshSelCounter(nonMutuals.length);
        this._refreshUnfollowBtn();
      };

      document.getElementById('xuf-desel-all').onclick = () => {
        this._el.querySelectorAll('.xuf-cb').forEach(cb => {
          cb.checked = false;
          state.selected.delete(cb.dataset.u);
        });
        this._refreshSelCounter(nonMutuals.length);
        this._refreshUnfollowBtn();
      };

      document.getElementById('xuf-btn-close').onclick = () => this.unmount();

      document.getElementById('xuf-btn-unfollow').onclick = () => {
        if (state.selected.size === 0) return;
        runUnfollow();
      };
    },

    _refreshSelCounter(total) {
      const el = document.getElementById('xuf-sel-cnt');
      if (el) el.textContent = state.selected.size;
    },

    _refreshUnfollowBtn() {
      const btn = document.getElementById('xuf-btn-unfollow');
      if (btn) btn.disabled = state.selected.size === 0;
    },

    // -----------------------------------------------------------
    // FASE 3: Progreso de unfollow
    // -----------------------------------------------------------

    /** Renderiza la pantalla de progreso de unfollow. */
    showUnfollowPhase(total) {
      if (!this._el) return;
      this._el.classList.remove('xuf-panel-mode');
      this._el.innerHTML = `
        <div class="xuf-card xuf-anim">
          <p class="xuf-brand">Unfollowers-X &nbsp; v1.2</p>
          <p class="xuf-heading" id="xuf-uf-heading">Preparando...</p>
          <p class="xuf-target" id="xuf-uf-target"></p>
          <div class="xuf-prog-wrap">
            <div class="xuf-prog-track">
              <div class="xuf-prog-fill" id="xuf-prog" style="width:0%"></div>
            </div>
            <span class="xuf-prog-lbl" id="xuf-prog-lbl">0 / ${total}</span>
          </div>
          <p class="xuf-sub" id="xuf-countdown"></p>
          <button class="xuf-btn xuf-btn-ghost" id="xuf-btn-stop">Detener</button>
        </div>
      `;
      document.getElementById('xuf-btn-stop').onclick = () => {
        state.stopFlag = true;
        const btn = document.getElementById('xuf-btn-stop');
        if (btn) { btn.textContent = 'Deteniendo...'; btn.disabled = true; }
      };
    },

    /** Actualiza heading, usuario activo y barra de progreso. */
    updateUnfollowProgress(current, total, username) {
      const pct     = Math.round((current / total) * 100);
      const fill    = document.getElementById('xuf-prog');
      const lbl     = document.getElementById('xuf-prog-lbl');
      const heading = document.getElementById('xuf-uf-heading');
      const target  = document.getElementById('xuf-uf-target');

      if (fill)    fill.style.width  = pct + '%';
      if (lbl)     lbl.textContent   = current + ' / ' + total;
      if (heading) heading.textContent = 'Dejando de seguir...';
      if (target)  target.textContent = '@' + username;
    },

    /**
     * Muestra el countdown de espera anti-baneo en la UI.
     * Se ejecuta segundo a segundo para que el usuario vea el progreso.
     */
    async runCountdown(totalSecs, current, total) {
      const el = document.getElementById('xuf-countdown');
      for (let r = totalSecs; r > 0; r--) {
        if (state.stopFlag) break;
        if (el) el.textContent = 'Esperando ' + r + 's antes del siguiente...';
        await sleep(1_000);
      }
      if (el) el.textContent = '';
    },

    // -----------------------------------------------------------
    // FASE 4: Pantalla final
    // -----------------------------------------------------------

    /** Renderiza la pantalla de finalizacion con el resumen. */
    showDonePhase(count, limitReached, stopped) {
      if (!this._el) return;
      this._el.classList.remove('xuf-panel-mode');

      let subtitle;
      if (stopped) {
        subtitle = 'Proceso detenido manualmente.';
      } else if (limitReached) {
        subtitle = `Limite de sesion alcanzado (${CONFIG.MAX_UNFOLLOWS}). Espera 2-3 horas antes de continuar para proteger tu cuenta.`;
      } else {
        subtitle = count === 0
          ? 'No se encontraron cuentas no-mutuas.'
          : `${count} ${count === 1 ? 'usuario eliminado' : 'usuarios eliminados'} correctamente.`;
      }

      this._el.innerHTML = `
        <div class="xuf-card xuf-anim">
          <p class="xuf-brand">Unfollowers-X &nbsp; v1.2</p>
          ${count > 0 ? `<p class="xuf-big-num">${count}</p>` : ''}
          <p class="xuf-heading">${limitReached ? 'Limite alcanzado' : stopped ? 'Proceso detenido' : 'Completado'}</p>
          <p class="xuf-sub">${esc(subtitle)}</p>
          <button class="xuf-btn xuf-btn-primary" id="xuf-btn-final-close">Cerrar</button>
        </div>
      `;

      document.getElementById('xuf-btn-final-close').onclick = () => this.unmount();
    },
  };

  // =============================================================
  // CONTROLADORES
  // =============================================================

  /**
   * Orquesta la fase de escaneo:
   * monta el overlay, ejecuta Scraper en background y
   * transiciona a resultados o pantalla final segun resultado.
   */
  async function runScan() {
    state.sessionStart = Date.now();
    state.stopFlag     = false;
    state.nonMutuals   = [];
    state.selected.clear();
    state.phase        = 'scanning';

    UI.showScanPhase();

    await Scraper.run((scanned, found) => {
      UI.updateScanProgress(scanned, found);
    });

    if (state.stopFlag) {
      UI.unmount();
      return;
    }

    if (state.nonMutuals.length === 0) {
      state.phase = 'done';
      UI.showDonePhase(0, false, false);
      return;
    }

    state.phase = 'results';
    UI.showResultsPhase(state.nonMutuals);
  }

  /**
   * Orquesta la fase de unfollow:
   * toma la seleccion del estado global, ejecuta Unfollower
   * y muestra la pantalla de finalizacion.
   */
  async function runUnfollow() {
    const queue = state.nonMutuals.filter(u => state.selected.has(u.username));
    if (queue.length === 0) return;

    const batch = queue.slice(0, CONFIG.MAX_UNFOLLOWS);

    state.stopFlag = false;
    state.phase    = 'unfollowing';

    UI.showUnfollowPhase(batch.length);

    const { done, limitReached, stopped } = await Unfollower.processQueue(
      batch,
      (cur, tot, user) => UI.updateUnfollowProgress(cur, tot, user),
      (secs, cur, tot) => UI.runCountdown(secs, cur, tot)
    );

    state.phase = 'done';
    UI.showDonePhase(done, limitReached, stopped);
  }

  // =============================================================
  // INICIALIZACION
  // =============================================================

  if (!window.location.href.includes('/following')) {
    const proceed = confirm(
      'Unfollowers-X v1.2\n\n' +
      'Este script debe ejecutarse en la pagina /following:\n' +
      'https://x.com/TU_USERNAME/following\n\n' +
      'Continuar de todas formas?'
    );
    if (!proceed) return;
  }

  UI.mount();
  runScan();

  console.log(
    '%cUnfollowers-X v1.2 cargado',
    'color:#606060;font-weight:bold;font-size:13px'
  );

})();
