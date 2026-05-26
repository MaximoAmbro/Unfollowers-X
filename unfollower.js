/**
 * ============================================================
 *  X (Twitter) — Non-Mutuals Unfollower
 *  v1.0.0  |  Vanilla JS  |  No dependencias externas
 * ============================================================
 *
 *  Detecta y permite dejar de seguir cuentas que NO te siguen
 *  de vuelta en X (Twitter), con medidas anti-baneo integradas.
 *
 *  INSTRUCCIONES DE USO:
 *  1. Navega a: https://x.com/TU_USERNAME/following
 *  2. Abre DevTools (F12) → pestaña "Console"
 *  3. Pega este script completo y presiona Enter
 *  4. Usa el panel flotante para escanear y gestionar unfollows
 *
 *  ADVERTENCIA: El uso de automatizaciones puede infringir los
 *  Términos de Servicio de X. Úsalo bajo tu propio riesgo.
 * ============================================================
 */

(function () {
  'use strict';

  // ============================================================
  // SECCIÓN 1 — CONFIGURACIÓN
  // Ajusta estos valores según tus necesidades.
  // ============================================================
  const CONFIG = {
    /** Espera mínima entre unfollows (ms) → 35 segundos */
    DELAY_MIN_MS: 35_000,

    /** Espera máxima entre unfollows (ms) → 85 segundos */
    DELAY_MAX_MS: 85_000,

    /** Máximo de unfollows por sesión antes de detenerse automáticamente */
    MAX_UNFOLLOWS_PER_SESSION: 22,

    /** Delay entre scrolls durante el escaneo (ms) */
    SCROLL_DELAY_MS: 1_800,

    /** Píxeles desplazados por cada scroll */
    SCROLL_STEP_PX: 600,

    /** Scrolls consecutivos sin cambio de altura → fin de lista */
    MAX_UNCHANGED_SCROLLS: 5,
  };

  // ============================================================
  // SECCIÓN 2 — ESTADO GLOBAL
  // ============================================================
  const state = {
    /** @type {Array<{username: string, displayName: string}>} */
    nonMutuals: [],

    /** Usernames actualmente marcados con checkbox */
    selectedUsernames: new Set(),

    /** @type {'idle'|'scanning'|'ready'|'processing'|'done'} */
    phase: 'idle',

    /** Unfollows realizados en esta sesión */
    unfollowsThisSession: 0,

    /** Flag para detener el bucle desde el botón Stop */
    stopRequested: false,
  };

  // ============================================================
  // SECCIÓN 3 — UTILIDADES
  // ============================================================

  /**
   * Devuelve una Promise que resuelve tras ms milisegundos.
   * Bloque básico para todos los delays del script.
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Delay aleatorio entre min y max ms.
   * La aleatoriedad es fundamental: los sistemas anti-bot detectan
   * intervalos regulares. Un humano nunca es perfectamente periódico.
   */
  function randomDelay(
    min = CONFIG.DELAY_MIN_MS,
    max = CONFIG.DELAY_MAX_MS
  ) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return sleep(ms);
  }

  /**
   * Escapa caracteres HTML para prevenir XSS en el panel inyectado.
   * Cualquier dato del DOM externo (nombres de usuario) pasa por aquí.
   */
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Extrae el username puro desde un href de perfil de X.
   * Ejemplos:
   *   "/johndoe"         → "johndoe"
   *   "/johndoe?s=21"    → "johndoe"
   *   "/johndoe/followers" → "johndoe"
   */
  function usernameFromHref(href) {
    if (!href) return null;
    const segment = href.split('/')[1] ?? '';
    return segment.split('?')[0].toLowerCase() || null;
  }

  // ============================================================
  // SECCIÓN 4 — DETECCIÓN DE NO-MUTUOS
  // ============================================================

  /**
   * Devuelve true si el usuario de este UserCell nos sigue de vuelta.
   *
   * X inyecta una pequeña etiqueta dentro de la celda con el texto
   * "Follows you" (inglés) o "Te sigue" (español).
   * Buscar el texto en innerText es más robusto que buscar clases CSS
   * que pueden cambiar con cada deploy de X.
   */
  function doesFollowBack(userCell) {
    const text = userCell.innerText || userCell.textContent || '';
    return /te sigue\b/i.test(text) || /follows you\b/i.test(text);
  }

  /**
   * Extrae username y nombre de display desde un UserCell del DOM.
   *
   * Estrategia de extracción del username:
   * - Recorre los <a href> del cell buscando el que apunte a un perfil.
   * - Descarta enlaces del sistema (explore, search, settings, etc.).
   *
   * Estrategia para el nombre de display:
   * - Intenta dos selectores conocidos de X (pueden cambiar con deploys).
   * - Hace fallback al username si no encuentra el nombre.
   */
  function extractUserInfo(cell) {
    const SYSTEM_PATHS = new Set([
      'search', 'explore', 'notifications', 'messages',
      'settings', 'home', 'i', 'following', 'followers',
    ]);

    let username = null;
    const links = cell.querySelectorAll('a[href^="/"]');

    for (const link of links) {
      const parsed = usernameFromHref(link.getAttribute('href'));
      if (parsed && !parsed.includes('#') && !SYSTEM_PATHS.has(parsed)) {
        username = parsed;
        break;
      }
    }

    // Selectores conocidos para el nombre de display en X
    const nameEl =
      cell.querySelector('[data-testid="User-Name"] span span') ||
      cell.querySelector('[data-testid="UserName"] span span');

    const displayName = nameEl?.textContent?.trim() || username || 'Desconocido';

    return { username, displayName };
  }

  // ============================================================
  // SECCIÓN 5 — ESCANEO (SCROLL AUTOMÁTICO + LECTURA DOM)
  // ============================================================

  /**
   * Proceso de escaneo completo.
   *
   * Algoritmo:
   * 1. Vuelve al inicio de la página.
   * 2. Lee los [data-testid="UserCell"] visibles en el DOM.
   * 3. Para cada celda nueva (no vista antes), comprueba si hay
   *    badge de "Te sigue" / "Follows you".
   * 4. Hace scroll hacia abajo y repite.
   * 5. Para cuando el scrollHeight no cambia N veces seguidas
   *    (se llegó al final de la lista).
   */
  async function scanFollowing() {
    if (state.phase === 'scanning' || state.phase === 'processing') return;

    state.phase = 'scanning';
    state.nonMutuals = [];
    state.selectedUsernames.clear();
    state.stopRequested = false;

    updateStatus('Volviendo al inicio de la lista...');
    window.scrollTo(0, 0);
    await sleep(1_500);

    const seen = new Set();
    let unchangedCount = 0;
    let lastScrollHeight = 0;

    updateStatus('Escaneando... por favor no interfieras con el scroll.');

    while (unchangedCount < CONFIG.MAX_UNCHANGED_SCROLLS && !state.stopRequested) {
      const cells = document.querySelectorAll('[data-testid="UserCell"]');

      cells.forEach(cell => {
        const { username, displayName } = extractUserInfo(cell);
        if (!username || seen.has(username)) return;

        seen.add(username);

        if (!doesFollowBack(cell)) {
          state.nonMutuals.push({ username, displayName });
        }
      });

      updateScanProgress(seen.size, state.nonMutuals.length);

      window.scrollBy(0, CONFIG.SCROLL_STEP_PX);
      await sleep(CONFIG.SCROLL_DELAY_MS);

      const newHeight = document.body.scrollHeight;
      unchangedCount = (newHeight === lastScrollHeight) ? unchangedCount + 1 : 0;
      lastScrollHeight = newHeight;
    }

    state.phase = 'ready';
    renderUserList();
    updateStatus(
      `✅ Escaneo completo — ${state.nonMutuals.length} no mutuas ` +
      `de ${[...seen].length} seguidos analizados.`
    );
  }

  // ============================================================
  // SECCIÓN 6 — PROCESO DE UNFOLLOW
  // ============================================================

  /**
   * Espera hasta timeoutMs ms a que aparezca el modal de confirmación
   * de X ([data-testid="confirmationSheetConfirm"]) y lo acepta.
   *
   * X muestra este modal para cuentas públicas para evitar
   * unfollows accidentales. Para cuentas privadas puede no aparecer.
   */
  function waitAndConfirmModal(timeoutMs = 3_500) {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;

      const tick = () => {
        const btn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
        if (btn) {
          btn.click();
          return resolve(true);
        }
        if (Date.now() < deadline) {
          setTimeout(tick, 150);
        } else {
          // Sin modal = operación directa (cuentas privadas o variante de UI)
          resolve(true);
        }
      };

      tick();
    });
  }

  /**
   * Countdown visible en el panel durante el delay anti-baneo.
   * El usuario ve cuánto falta para el próximo unfollow, lo que
   * también permite cancelar el proceso en cualquier momento.
   */
  async function countdownDelay(totalSecs, current, total) {
    for (let remaining = totalSecs; remaining > 0; remaining--) {
      if (state.stopRequested) break;
      updateStatus(
        `⏳ [${current}/${total}] Próximo unfollow en ${remaining}s...`
      );
      await sleep(1_000);
    }
  }

  /**
   * Estrategia de búsqueda del botón de unfollow dentro de un UserCell.
   *
   * X usa data-testid con el formato "[username]-follow" para este botón.
   * Se añaden fallbacks con aria-label e inspección de texto por si
   * X cambia el naming en futuros deploys.
   */
  function findFollowButton(cell) {
    return (
      cell.querySelector('[data-testid$="-follow"]') ||
      cell.querySelector('button[aria-label*="siguiendo" i]') ||
      cell.querySelector('button[aria-label*="Following" i]') ||
      [...cell.querySelectorAll('button')].find(btn =>
        /siguiendo|following/i.test(btn.textContent)
      ) ||
      null
    );
  }

  /**
   * Proceso principal de unfollow.
   *
   * Estrategia de scroll progresivo:
   * En lugar de almacenar referencias a elementos del DOM (que pueden
   * quedar invalidadas por la virtualización de la lista de X), el script
   * hace scroll desde el inicio buscando activamente los UserCells de los
   * usuarios seleccionados. Cuando encuentra uno, lo procesa inmediatamente.
   *
   * Esto es más robusto que guardar referencias durante el escaneo.
   */
  async function startUnfollowProcess() {
    if (state.phase === 'processing') return;

    const toProcess = state.nonMutuals.filter(u =>
      state.selectedUsernames.has(u.username)
    );

    if (toProcess.length === 0) {
      updateStatus('⚠️ Sin cuentas seleccionadas. Usa los checkboxes del panel.');
      return;
    }

    const sessionLimit = Math.min(toProcess.length, CONFIG.MAX_UNFOLLOWS_PER_SESSION);

    state.phase = 'processing';
    state.unfollowsThisSession = 0;
    state.stopRequested = false;

    disableActionButtons(true);
    updateStatus(`🚀 Iniciando — se procesarán ${sessionLimit} cuenta(s).`);

    // Set de usernames pendientes para búsqueda O(1)
    const pending = new Set(
      toProcess.slice(0, sessionLimit).map(u => u.username)
    );

    window.scrollTo(0, 0);
    await sleep(1_500);

    let processed = 0;
    let lastScrollHeight = 0;
    let stuckCount = 0;

    while (pending.size > 0 && !state.stopRequested && stuckCount < 6) {
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      let foundInThisPass = false;

      for (const cell of cells) {
        const { username } = extractUserInfo(cell);
        if (!username || !pending.has(username)) continue;

        foundInThisPass = true;
        pending.delete(username); // Marcar antes de procesar para evitar duplicados

        // Centrar la celda en pantalla → comportamiento más natural
        cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(600 + Math.random() * 400);

        const followBtn = findFollowButton(cell);
        if (!followBtn) {
          console.warn(`[Unfollower] Botón no encontrado para @${username}`);
          continue;
        }

        updateStatus(`🔄 [${processed + 1}/${sessionLimit}] Unfollow @${username}...`);

        // Hover antes del clic simula movimiento real del mouse
        followBtn.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true, cancelable: true })
        );
        await sleep(300 + Math.random() * 200);

        followBtn.click();
        await sleep(900 + Math.random() * 300);

        // Gestionar modal de confirmación de X
        await waitAndConfirmModal();
        await sleep(400);

        state.unfollowsThisSession++;
        processed++;
        markUserAsDone(username);

        updateStatus(`✓ Unfollowed @${username} (${processed}/${sessionLimit})`);

        // Verificar límite de sesión
        if (state.unfollowsThisSession >= CONFIG.MAX_UNFOLLOWS_PER_SESSION) {
          state.phase = 'done';
          disableActionButtons(false);
          updateStatus(
            `⛔ LÍMITE ALCANZADO — ${CONFIG.MAX_UNFOLLOWS_PER_SESSION} unfollows esta sesión. ` +
            `Espera 2-3 horas antes de continuar para proteger tu cuenta.`
          );
          return;
        }

        // Delay anti-baneo aleatorio entre cada unfollow
        if (pending.size > 0 && !state.stopRequested) {
          const delayMs =
            CONFIG.DELAY_MIN_MS +
            Math.random() * (CONFIG.DELAY_MAX_MS - CONFIG.DELAY_MIN_MS);
          await countdownDelay(
            Math.round(delayMs / 1_000),
            processed,
            sessionLimit
          );
        }
      }

      if (!foundInThisPass) {
        window.scrollBy(0, CONFIG.SCROLL_STEP_PX);
        await sleep(CONFIG.SCROLL_DELAY_MS);

        const newHeight = document.body.scrollHeight;
        stuckCount = newHeight === lastScrollHeight ? stuckCount + 1 : 0;
        lastScrollHeight = newHeight;
      } else {
        stuckCount = 0;
      }
    }

    state.phase = 'done';
    disableActionButtons(false);

    if (state.stopRequested) {
      updateStatus(`⏹ Detenido manualmente — ${state.unfollowsThisSession} unfollows realizados.`);
    } else {
      updateStatus(`✅ Completado — ${state.unfollowsThisSession} unfollows realizados en esta sesión.`);
    }
  }

  // ============================================================
  // SECCIÓN 7 — ESTILOS CSS DEL PANEL
  // ============================================================

  function injectStyles() {
    if (document.getElementById('xuf-styles')) return;

    const style = document.createElement('style');
    style.id = 'xuf-styles';
    style.textContent = `
      /* Panel contenedor */
      #xuf-panel {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 360px;
        max-height: 84vh;
        background: #0f1117;
        border: 1px solid #2f3336;
        border-radius: 16px;
        box-shadow: 0 8px 40px rgba(0, 0, 0, 0.65);
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
          'Helvetica Neue', Arial, sans-serif;
        font-size: 13px;
        color: #e7e9ea;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        resize: vertical;
        min-height: 200px;
      }

      /* Header arrastrable */
      #xuf-header {
        background: #16181c;
        padding: 12px 16px;
        border-bottom: 1px solid #2f3336;
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: grab;
        user-select: none;
        flex-shrink: 0;
      }
      #xuf-header:active { cursor: grabbing; }
      #xuf-header h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 700;
        color: #fff;
        letter-spacing: 0.2px;
      }
      #xuf-close {
        background: none;
        border: none;
        color: #71767b;
        cursor: pointer;
        font-size: 16px;
        padding: 4px 6px;
        border-radius: 50%;
        line-height: 1;
        transition: color 0.15s, background 0.15s;
      }
      #xuf-close:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }

      /* Barra de estado */
      #xuf-status {
        padding: 10px 16px;
        background: #1a1d23;
        border-bottom: 1px solid #2f3336;
        font-size: 12px;
        color: #1d9bf0;
        min-height: 38px;
        display: flex;
        align-items: center;
        flex-shrink: 0;
        line-height: 1.45;
      }

      /* Contador de cuentas */
      #xuf-counter {
        padding: 7px 16px;
        background: #16181c;
        border-bottom: 1px solid #2f3336;
        font-size: 11px;
        color: #71767b;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
      }
      #xuf-counter b { color: #e7e9ea; font-size: 13px; }

      /* Lista de usuarios */
      #xuf-list {
        overflow-y: auto;
        flex: 1;
        min-height: 0;
        scrollbar-width: thin;
        scrollbar-color: #2f3336 transparent;
      }
      #xuf-list::-webkit-scrollbar { width: 4px; }
      #xuf-list::-webkit-scrollbar-track { background: transparent; }
      #xuf-list::-webkit-scrollbar-thumb {
        background: #2f3336;
        border-radius: 2px;
      }

      /* Mensaje vacío */
      #xuf-empty {
        padding: 28px 16px;
        text-align: center;
        color: #71767b;
        font-size: 13px;
        line-height: 1.7;
      }

      /* Fila de usuario */
      .xuf-user-item {
        display: flex;
        align-items: center;
        padding: 8px 16px;
        border-bottom: 1px solid #1e2028;
        gap: 10px;
        transition: background 0.12s;
      }
      .xuf-user-item:hover { background: rgba(255, 255, 255, 0.03); }
      .xuf-user-item.xuf-done { opacity: 0.3; }
      .xuf-user-item.xuf-done .xuf-display-name { text-decoration: line-through; }

      /* Checkbox */
      .xuf-user-item input[type="checkbox"] {
        accent-color: #1d9bf0;
        width: 16px;
        height: 16px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .xuf-user-item input:disabled { opacity: 0.4; cursor: not-allowed; }

      /* Info del usuario */
      .xuf-user-info { flex: 1; min-width: 0; }
      .xuf-display-name {
        font-weight: 600;
        color: #e7e9ea;
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .xuf-username {
        color: #71767b;
        font-size: 11px;
        margin-top: 1px;
      }

      /* Controles */
      #xuf-controls {
        padding: 12px 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-top: 1px solid #2f3336;
        background: #16181c;
        flex-shrink: 0;
      }
      .xuf-btn-row { display: flex; gap: 8px; }

      /* Botones */
      .xuf-btn {
        flex: 1;
        padding: 8px 10px;
        border-radius: 20px;
        border: none;
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
        transition: background 0.15s, opacity 0.15s;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .xuf-btn:disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; }
      .xuf-btn:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 2px; }

      .xuf-btn-primary  { background: #1d9bf0; color: #fff; }
      .xuf-btn-primary:hover:not(:disabled)  { background: #1a8cd8; }

      .xuf-btn-ghost {
        background: transparent;
        color: #e7e9ea;
        border: 1px solid #3e4246;
      }
      .xuf-btn-ghost:hover:not(:disabled) { background: rgba(255, 255, 255, 0.06); }

      .xuf-btn-danger { background: #f4212e; color: #fff; }
      .xuf-btn-danger:hover:not(:disabled) { background: #d91f2a; }

      .xuf-btn-stop { background: #ff6b35; color: #fff; }
      .xuf-btn-stop:hover:not(:disabled) { background: #e5562a; }

      /* Disclaimer */
      #xuf-disclaimer {
        padding: 6px 16px;
        font-size: 10px;
        color: #414749;
        border-top: 1px solid #1e2028;
        text-align: center;
        flex-shrink: 0;
      }
    `;

    document.head.appendChild(style);
  }

  // ============================================================
  // SECCIÓN 8 — CONSTRUCCIÓN DEL PANEL UI
  // ============================================================

  function createPanel() {
    document.getElementById('xuf-panel')?.remove();
    injectStyles();

    const panel = document.createElement('div');
    panel.id = 'xuf-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'X Non-Mutuals Unfollower');

    panel.innerHTML = `
      <div id="xuf-header">
        <h3>✦ X Non-Mutuals Unfollower</h3>
        <button id="xuf-close" title="Cerrar" aria-label="Cerrar panel">✕</button>
      </div>

      <div id="xuf-status" aria-live="polite">
        Listo. Asegúrate de estar en /following antes de escanear.
      </div>

      <div id="xuf-counter">
        <span><b id="xuf-count-total">0</b> detectadas</span>
        <span><b id="xuf-count-selected">0</b> seleccionadas</span>
      </div>

      <div id="xuf-list">
        <div id="xuf-empty">
          Presiona <strong>Escanear</strong> para detectar<br>
          las cuentas que no te siguen de vuelta.
        </div>
      </div>

      <div id="xuf-controls">
        <div class="xuf-btn-row">
          <button class="xuf-btn xuf-btn-primary" id="xuf-scan">🔍 Escanear</button>
          <button class="xuf-btn xuf-btn-ghost"   id="xuf-sel-all">Sel. todo</button>
          <button class="xuf-btn xuf-btn-ghost"   id="xuf-desel-all">Desel.</button>
        </div>
        <div class="xuf-btn-row">
          <button class="xuf-btn xuf-btn-danger" id="xuf-start" disabled>
            🚫 Unfollow seleccionadas
          </button>
          <button class="xuf-btn xuf-btn-stop" id="xuf-stop" disabled>
            ⏹ Stop
          </button>
        </div>
      </div>

      <div id="xuf-disclaimer">
        Solo para uso educativo y de portfolio · Ejecutar con responsabilidad
      </div>
    `;

    document.body.appendChild(panel);
    bindPanelEvents(panel);
    makeDraggable(panel, document.getElementById('xuf-header'));
  }

  // ============================================================
  // SECCIÓN 9 — EVENTOS DEL PANEL
  // ============================================================

  function bindPanelEvents(panel) {
    const $ = id => document.getElementById(id);

    $('xuf-close').onclick = () => panel.remove();

    $('xuf-scan').onclick = () => {
      if (state.phase === 'scanning' || state.phase === 'processing') return;
      scanFollowing();
    };

    $('xuf-start').onclick = () => {
      if (state.phase === 'processing') return;
      startUnfollowProcess();
    };

    $('xuf-stop').onclick = () => {
      state.stopRequested = true;
      updateStatus('⏹ Deteniendo el proceso...');
    };

    $('xuf-sel-all').onclick = () => {
      state.nonMutuals.forEach(u => state.selectedUsernames.add(u.username));
      syncCheckboxes();
      updateCounter();
      refreshStartButton();
    };

    $('xuf-desel-all').onclick = () => {
      state.selectedUsernames.clear();
      syncCheckboxes();
      updateCounter();
      refreshStartButton();
    };
  }

  // ============================================================
  // SECCIÓN 10 — RENDERIZADO Y ACTUALIZACIÓN DE LA UI
  // ============================================================

  function renderUserList() {
    const listEl = document.getElementById('xuf-list');
    if (!listEl) return;

    if (state.nonMutuals.length === 0) {
      listEl.innerHTML = `
        <div id="xuf-empty">
          ¡Sin cuentas no mutuas detectadas!<br>
          <span style="color:#1d9bf0">Todos tus seguidos te siguen de vuelta.</span>
        </div>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const { username, displayName } of state.nonMutuals) {
      const item = document.createElement('div');
      item.className = 'xuf-user-item';
      item.id = `xuf-item-${username}`;

      const isChecked = state.selectedUsernames.has(username);

      item.innerHTML = `
        <input
          type="checkbox"
          id="xuf-cb-${escapeHtml(username)}"
          data-username="${escapeHtml(username)}"
          ${isChecked ? 'checked' : ''}
        />
        <div class="xuf-user-info">
          <div class="xuf-display-name">${escapeHtml(displayName)}</div>
          <div class="xuf-username">@${escapeHtml(username)}</div>
        </div>
      `;

      item.querySelector('input').addEventListener('change', function () {
        if (this.checked) {
          state.selectedUsernames.add(username);
        } else {
          state.selectedUsernames.delete(username);
        }
        updateCounter();
        refreshStartButton();
      });

      fragment.appendChild(item);
    }

    listEl.innerHTML = '';
    listEl.appendChild(fragment);
    updateCounter();
    refreshStartButton();
  }

  /** Sincroniza el estado checked de los checkboxes con state.selectedUsernames */
  function syncCheckboxes() {
    document
      .querySelectorAll('#xuf-list input[type="checkbox"]')
      .forEach(cb => {
        cb.checked = state.selectedUsernames.has(cb.dataset.username);
      });
  }

  function updateCounter() {
    const t = document.getElementById('xuf-count-total');
    const s = document.getElementById('xuf-count-selected');
    if (t) t.textContent = state.nonMutuals.length;
    if (s) s.textContent = state.selectedUsernames.size;
  }

  function updateStatus(msg) {
    const el = document.getElementById('xuf-status');
    if (el) el.textContent = msg;
    console.log(`%c[X Unfollower] ${msg}`, 'color:#1d9bf0;font-weight:bold');
  }

  function updateScanProgress(totalScanned, nonMutualsFound) {
    updateStatus(
      `🔍 Escaneando — ${totalScanned} revisados · ${nonMutualsFound} no mutuas`
    );
    const t = document.getElementById('xuf-count-total');
    if (t) t.textContent = nonMutualsFound;
  }

  function disableActionButtons(disable) {
    ['xuf-scan', 'xuf-start', 'xuf-sel-all', 'xuf-desel-all'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = disable;
    });
    const stopBtn = document.getElementById('xuf-stop');
    if (stopBtn) stopBtn.disabled = !disable;

    document
      .querySelectorAll('#xuf-list input[type="checkbox"]')
      .forEach(cb => (cb.disabled = disable));
  }

  function refreshStartButton() {
    const btn = document.getElementById('xuf-start');
    if (btn) {
      btn.disabled =
        state.selectedUsernames.size === 0 || state.phase === 'processing';
    }
  }

  function markUserAsDone(username) {
    document.getElementById(`xuf-item-${username}`)?.classList.add('xuf-done');
    const cb = document.getElementById(`xuf-cb-${username}`);
    if (cb) cb.disabled = true;
    state.selectedUsernames.delete(username);
    updateCounter();
  }

  // ============================================================
  // SECCIÓN 11 — PANEL ARRASTRABLE
  // ============================================================

  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0, startY = 0, origLeft = 0, origTop = 0;

    handle.addEventListener('mousedown', e => {
      if (e.target.id === 'xuf-close') return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const r = panel.getBoundingClientRect();
      origLeft = r.left;
      origTop = r.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });

    function onMove(e) {
      if (!dragging) return;
      panel.style.left = `${Math.max(0, origLeft + e.clientX - startX)}px`;
      panel.style.top  = `${Math.max(0, origTop  + e.clientY - startY)}px`;
      panel.style.right = 'auto';
    }

    function onUp() {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  }

  // ============================================================
  // SECCIÓN 12 — PUNTO DE ENTRADA
  // ============================================================

  if (!window.location.href.includes('/following')) {
    const go = confirm(
      '[X Unfollower]\n\n' +
      'Este script está diseñado para ejecutarse en:\n' +
      'https://x.com/TU_USERNAME/following\n\n' +
      '¿Continuar de todas formas?'
    );
    if (!go) return;
  }

  createPanel();

  console.log(
    '%c✦ X Non-Mutuals Unfollower — cargado correctamente',
    'color:#1d9bf0;font-weight:bold;font-size:15px'
  );
  console.log('%cCONFIG activa:', 'color:#71767b', CONFIG);

})();
