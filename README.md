# ✦ X Non-Mutuals Unfollower

> Script de automatización de navegador en JavaScript puro para detectar y dejar de seguir cuentas que no te siguen de vuelta en X (Twitter), con un sistema anti-baneo integrado y una interfaz visual inyectada en el DOM.

---

## Índice

1. [Descripción del Proyecto](#descripción-del-proyecto)
2. [Demostración](#demostración)
3. [Tecnologías Utilizadas](#tecnologías-utilizadas)
4. [Arquitectura del Script](#arquitectura-del-script)
5. [Sistema Anti-Baneo: Gestión de Rate Limits](#sistema-anti-baneo-gestión-de-rate-limits)
6. [Instrucciones de Uso](#instrucciones-de-uso)
7. [Estructura del Proyecto](#estructura-del-proyecto)
8. [Configuración Avanzada](#configuración-avanzada)
9. [Limitaciones Conocidas](#limitaciones-conocidas)
10. [Descargo de Responsabilidad](#descargo-de-responsabilidad)

---

## Descripción del Proyecto

**X Non-Mutuals Unfollower** es un script de automatización de navegador desarrollado en Vanilla JavaScript que permite a los usuarios de X (antes Twitter) identificar y gestionar las cuentas que siguen pero que no les siguen de vuelta —conocidas como *non-mutuals*—, todo desde la comodidad de la Consola de Desarrollador del navegador.

### Problema que resuelve

X no ofrece nativas ninguna funcionalidad para filtrar o ver qué cuentas de tu lista de "Siguiendo" no son mutuos. La única alternativa es revisar manualmente perfil por perfil, lo que resulta impráctico a partir de 200-300 seguidos.

### Solución implementada

El script inyecta un **panel flotante** directamente en el DOM de X, realiza un **escaneo automatizado** con scroll de toda la página `/following`, detecta los no-mutuos leyendo las etiquetas de "Te sigue" / "Follows you" en cada celda de usuario, y ofrece una interfaz para seleccionar individualmente qué cuentas dejar de seguir, con un robusto sistema de protección contra baneos.

### Inspiración

El proyecto está inspirado en el trabajo de **David Arroyo** y su famoso script de unfollow para Instagram, adaptando la misma filosofía —simplicidad, zero-dependencias, ejecución en consola— al ecosistema actual de X.

---

## Demostración

```
┌──────────────────────────────────────┐
│  ✦ X Non-Mutuals Unfollower          │
├──────────────────────────────────────┤
│  ✅ 47 no mutuas de 312 seguidos      │
├──────────────────────────────────────┤
│  47 detectadas        12 seleccionadas│
├──────────────────────────────────────┤
│  ☑  John Doe          @johndoe       │
│  ☑  Jane Smith        @janesmith     │
│  ☐  Tech Brand        @techbrand     │
│  ☑  Random User       @randuser      │
│  ...                                  │
├──────────────────────────────────────┤
│  [🔍 Escanear] [Sel. todo] [Desel.]  │
│  [🚫 Unfollow seleccionadas] [⏹ Stop]│
└──────────────────────────────────────┘
```

**Flujo de uso:**

```
/following → Pegar script → Escanear → Revisar lista → Seleccionar → Unfollow
```

---

## Tecnologías Utilizadas

| Tecnología | Uso en el proyecto |
|---|---|
| **Vanilla JavaScript (ES2021+)** | Núcleo del script sin dependencias externas |
| **DOM Manipulation API** | Lectura de `UserCell`, inyección del panel y CSS |
| **Promises / async-await** | Gestión de delays asíncronos entre acciones |
| **setTimeout / clearTimeout** | Motor del sistema de delays aleatorios anti-baneo |
| **MutationObserver (indirecto)** | Detección del modal de confirmación de X |
| **CSS Injected Styles** | Panel flotante con diseño fiel a la UI de X |
| **MouseEvent API** | Simulación de hover y clics para comportamiento natural |
| **DocumentFragment** | Renderizado eficiente de listas largas sin repintados innecesarios |

**Sin frameworks. Sin dependencias. Sin instalación.** Solo JavaScript puro ejecutado en el contexto de la página.

---

## Arquitectura del Script

El script está organizado en **12 secciones modulares** encapsuladas en una IIFE (*Immediately Invoked Function Expression*) para no contaminar el scope global de la página:

```
IIFE (función autoejecutable)
│
├── SECCIÓN 1  — CONFIG: parámetros ajustables por el usuario
├── SECCIÓN 2  — STATE: objeto de estado global mutable
├── SECCIÓN 3  — UTILS: sleep(), randomDelay(), escapeHtml(), usernameFromHref()
│
├── SECCIÓN 4  — DETECCIÓN
│   ├── doesFollowBack(cell)    → lee el innerText buscando "Te sigue"/"Follows you"
│   └── extractUserInfo(cell)   → extrae username y displayName del DOM
│
├── SECCIÓN 5  — ESCANEO
│   └── scanFollowing()         → scroll automático + lectura de UserCells
│
├── SECCIÓN 6  — UNFOLLOW
│   ├── waitAndConfirmModal()   → polling del modal [data-testid="confirmationSheetConfirm"]
│   ├── countdownDelay()        → countdown visible en la UI
│   ├── findFollowButton()      → localiza el botón con múltiples fallbacks
│   └── startUnfollowProcess()  → bucle principal con scroll progresivo
│
├── SECCIÓN 7  — ESTILOS CSS: inyección de estilos con tema oscuro de X
├── SECCIÓN 8  — PANEL UI: construcción del HTML del panel flotante
├── SECCIÓN 9  — EVENTOS: binding de clicks y checkboxes
├── SECCIÓN 10 — RENDER: renderUserList(), updateStatus(), counters
├── SECCIÓN 11 — DRAGGABLE: panel arrastrable con mousedown/mousemove/mouseup
└── SECCIÓN 12 — ENTRYPOINT: validación de URL e inicialización
```

### Patrón de detección de no-mutuos

```javascript
function doesFollowBack(userCell) {
  const text = userCell.innerText || userCell.textContent || '';
  return /te sigue\b/i.test(text) || /follows you\b/i.test(text);
}
```

X inyecta dinámicamente una etiqueta de texto dentro del `[data-testid="UserCell"]` cuando el usuario nos sigue de vuelta. Leer `innerText` del elemento completo es más resiliente que buscar por clases CSS, ya que X cambia sus nombres de clases frecuentemente con cada deploy.

### Estrategia de scroll progresivo para unfollow

Para evitar referencias inválidas al DOM (X virtualiza la lista eliminando nodos fuera de la vista), el proceso de unfollow **no almacena referencias a elementos durante el escaneo**. En su lugar, al comenzar el unfollow:

1. Vuelve al inicio de la página
2. Hace scroll progresivo buscando activamente los `UserCell` de los usuarios pendientes
3. En cuanto encuentra uno, lo procesa inmediatamente
4. Continúa el scroll para los siguientes

Este patrón es compatible con listas virtualizadas de cualquier longitud.

---

## Sistema Anti-Baneo: Gestión de Rate Limits

Esta es la parte más crítica del script. X (como Instagram y otras redes) implementa sistemas de detección de comportamiento automatizado que pueden resultar en restricciones de cuenta (shadowban, suspensión temporal de la función de seguir/dejar de seguir o, en casos extremos, suspensión de cuenta).

### Capas de protección implementadas

#### 1. Delays aleatorios de larga duración

```javascript
const CONFIG = {
  DELAY_MIN_MS: 35_000,  // 35 segundos
  DELAY_MAX_MS: 85_000,  // 85 segundos
};

function randomDelay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(ms);
}
```

**Por qué funciona:** Un bot opera con intervalos matemáticamente regulares (ej: cada 5 segundos exactos). Un humano nunca es periódico. Los algoritmos de detección buscan periodicidad estadística en las acciones. Al usar rangos amplios con distribución uniforme aleatoria, el perfil de actividad del script imita el de un usuario humano lento y deliberado.

**Por qué 35-85 segundos:** Los rate limits de X para acciones de unfollow son más estrictos que los de otras acciones. Valores por debajo de 30 segundos aumentan significativamente el riesgo de detección. El rango 35-85s ofrece el equilibrio entre seguridad y velocidad práctica.

#### 2. Límite de sesión por lotes

```javascript
const CONFIG = {
  MAX_UNFOLLOWS_PER_SESSION: 22,
};

if (state.unfollowsThisSession >= CONFIG.MAX_UNFOLLOWS_PER_SESSION) {
  updateStatus('⛔ LÍMITE ALCANZADO. Espera 2-3h antes de continuar.');
  return;
}
```

**Por qué funciona:** Los sistemas anti-spam de X analizan la velocidad de acciones por ventana temporal. Realizar 100 unfollows en una hora es una señal de alerta inequívoca. Al limitar a ~22 por sesión y requerir esperas de horas entre sesiones, el script mantiene la actividad dentro de los umbrales que X considera "normal".

**Recomendación de uso seguro:**
- Máximo 1-2 sesiones por día
- Esperar al menos 3 horas entre sesiones
- No exceder ~40-50 unfollows por día en total

#### 3. Simulación de comportamiento humano

```javascript
// Scroll suave al elemento antes de interactuar
cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
await sleep(600 + Math.random() * 400);

// Hover antes del clic (como lo haría un humano)
followBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
await sleep(300 + Math.random() * 200);

// Clic principal
followBtn.click();
```

Los bots típicamente hacen clic directo sobre elementos sin eventos previos de mouse. El script simula el flujo completo: scroll → hover → pausa variable → clic, con tiempos aleatorios en cada micro-acción.

#### 4. Verificación del modal de confirmación

X muestra un diálogo de confirmación (`[data-testid="confirmationSheetConfirm"]`) antes de ejecutar el unfollow. El script espera activamente este modal con polling cada 150ms (hasta 3.5 segundos) antes de confirmarlo, en lugar de asumir que ya está presente, lo que evita errores silenciosos.

---

## Instrucciones de Uso

### Método recomendado: Consola de Desarrollador

**Este es el único método garantizado.** Los bookmarklets son bloqueados por la política CSP de X en navegadores modernos.

**Paso 1 — Preparación**

1. Inicia sesión en tu cuenta de X
2. Navega a la página de "Siguiendo" de tu perfil:
   ```
   https://x.com/TU_USERNAME/following
   ```
3. Espera a que la página cargue completamente

**Paso 2 — Abrir DevTools**

| Sistema Operativo | Atajo |
|---|---|
| Windows / Linux | `F12` o `Ctrl + Shift + I` |
| macOS | `Cmd + Option + I` |

Luego selecciona la pestaña **"Console"** (Consola).

**Paso 3 — Ejecutar el script**

1. Abre el archivo `unfollower.js` de este repositorio
2. Selecciona todo el contenido (`Ctrl+A` / `Cmd+A`)
3. Pégalo en la consola del navegador
4. Presiona `Enter`

Verás aparecer el panel flotante en la esquina superior derecha de la pantalla.

**Paso 4 — Escanear**

1. Haz clic en el botón **"🔍 Escanear"**
2. El script comenzará a hacer scroll automático por tu lista de seguidos
3. Espera a que el escaneo termine (puede tardar varios minutos dependiendo del número de seguidos)
4. Al finalizar verás el mensaje "✅ Escaneo completo"

**Paso 5 — Seleccionar y hacer unfollow**

1. Revisa la lista de cuentas no mutuas detectadas
2. Marca con checkbox las que deseas dejar de seguir
   - Usa **"Sel. todo"** para seleccionar todas
   - Desmarca individualmente las que quieras mantener
3. Haz clic en **"🚫 Unfollow seleccionadas"**
4. El panel mostrará un countdown entre cada acción
5. Al finalizar verás el resumen de la sesión

> **Importante:** No cierres la pestaña del navegador ni navegues a otra página mientras el proceso está en ejecución.

### Método alternativo: Bookmarklet

> ⚠️ **Limitación:** X usa Content Security Policy (CSP) estricta que bloquea la ejecución de `javascript:` bookmarklets en Chrome 98+, Firefox 100+ y Safari 15.4+. Este método puede no funcionar.

Si quieres intentarlo:
1. Crea un nuevo marcador en tu navegador
2. En el campo "URL", pega el contenido del archivo `bookmarklet.js` (la línea que empieza con `javascript:`)
3. Guarda el marcador
4. Navega a `/following` y haz clic en el marcador

---

## Estructura del Proyecto

```
x-non-mutuals-unfollower/
│
├── unfollower.js       # Script principal — código limpio y comentado
│                       # (12 secciones modulares, ~450 líneas)
│
├── bookmarklet.js      # Versión compacta para bookmarklet + notas de uso
│                       # (incluye explicación de limitaciones CSP)
│
└── README.md           # Esta documentación
```

---

## Configuración Avanzada

El objeto `CONFIG` al inicio de `unfollower.js` permite personalizar el comportamiento del script:

```javascript
const CONFIG = {
  // Delay mínimo entre unfollows (ms) — NO bajar de 20000
  DELAY_MIN_MS: 35_000,

  // Delay máximo entre unfollows (ms)
  DELAY_MAX_MS: 85_000,

  // Máximo de unfollows por sesión — NO superar 25
  MAX_UNFOLLOWS_PER_SESSION: 22,

  // Delay entre scrolls durante el escaneo (ms)
  SCROLL_DELAY_MS: 1_800,

  // Píxeles por scroll
  SCROLL_STEP_PX: 600,

  // Scrolls sin cambio → fin de lista
  MAX_UNCHANGED_SCROLLS: 5,
};
```

> ⚠️ **Advertencia:** Reducir `DELAY_MIN_MS` por debajo de 20 segundos o aumentar `MAX_UNFOLLOWS_PER_SESSION` por encima de 25 aumenta significativamente el riesgo de recibir restricciones en la cuenta.

---

## Limitaciones Conocidas

| Limitación | Descripción |
|---|---|
| **Dependencia del DOM de X** | X actualiza su DOM frecuentemente. Si cambian los `data-testid` ("UserCell", "confirmationSheetConfirm"), el script necesitará actualización. |
| **Idioma de la UI** | El script detecta "Te sigue" (español) y "Follows you" (inglés). Otros idiomas pueden requerir añadir sus patrones a `doesFollowBack()`. |
| **Cuentas privadas** | Las cuentas privadas pueden no mostrar el modal de confirmación; el script maneja este caso con timeout. |
| **Lista virtualizada** | X usa virtualización para listas grandes. El escaneo puede perder cuentas si el scroll es muy rápido. Aumentar `SCROLL_DELAY_MS` mejora la precisión. |
| **CSP en bookmarklet** | Los navegadores modernos bloquean `javascript:` bookmarklets en sitios con CSP estricta como X. |
| **Sesión requerida** | El script necesita que el usuario esté autenticado; no accede a la API oficial de X. |

---

## Descargo de Responsabilidad

> **AVISO LEGAL Y DE RESPONSABILIDAD**

Este proyecto es de **carácter puramente educativo** y fue desarrollado como muestra de habilidades técnicas en JavaScript, automatización del DOM y técnicas de web scraping para un portfolio profesional.

**El uso de este script:**

- Puede violar los [Términos de Servicio de X (Twitter)](https://twitter.com/en/tos), concretamente las cláusulas sobre automatización y uso de herramientas de terceros no autorizadas.
- Puede resultar en restricciones temporales o permanentes de tu cuenta de X.
- Es responsabilidad **exclusiva del usuario** que decida ejecutarlo.

**El autor de este script:**

- No se hace responsable de ninguna consecuencia derivada del uso de esta herramienta.
- No alienta el uso masivo o malicioso de automatizaciones en plataformas de terceros.
- Proporciona este código únicamente con fines demostrativos de técnicas de desarrollo front-end.

**Recomendaciones:**

- Úsalo con moderación y respetando los límites descritos en este README.
- Nunca uses este tipo de herramientas para prácticas de spam o acoso.
- Consulta siempre los Términos de Servicio de la plataforma antes de usar cualquier automatización.

---

## Habilidades Técnicas Demostradas

Este proyecto sirve como demostración práctica de las siguientes competencias:

- **Vanilla JavaScript avanzado** — async/await, Promises, closures, IIFE pattern
- **Manipulación del DOM** — Lectura, traversal, inyección de nodos y estilos
- **Web Scraping en el navegador** — Extracción de datos de SPA renderizadas dinámicamente
- **Automatización del navegador** — Simulación de eventos de usuario (MouseEvent, scroll, click)
- **Rate Limiting y Anti-Detección** — Implementación de delays aleatorios y límites por sesión
- **UI/UX en runtime** — Inyección de interfaces completas (HTML + CSS) sin frameworks
- **Arquitectura modular** — Separación clara de responsabilidades en un script monolítico
- **Manejo asíncrono complejo** — Coordinación de múltiples operaciones con timeouts y polling

---

*Desarrollado como proyecto de portfolio · Vanilla JavaScript · DOM Automation · 2024*
