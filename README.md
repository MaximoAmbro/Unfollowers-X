# Unfollowers-X

> Script de automatizacion del navegador en JavaScript puro para detectar y gestionar cuentas no-mutuas en X (Twitter), con overlay full-screen, escaneo invisible al usuario y sistema anti-baneo integrado.

**Version:** 1.2
**Tecnologia:** Vanilla JavaScript (ES2021+), sin dependencias externas
**Landing page:** [maximoambro.github.io/Unfollowers-X](https://maximoambro.github.io/Unfollowers-X/)

---

## Indice

1. [Descripcion del proyecto](#descripcion-del-proyecto)
2. [Novedades de V1.2](#novedades-de-v12)
3. [Tecnologias utilizadas](#tecnologias-utilizadas)
4. [Arquitectura del script](#arquitectura-del-script)
5. [Por que DOM Scraping y no API directa](#por-que-dom-scraping-y-no-api-directa)
6. [Sistema anti-baneo: gestion de rate limits](#sistema-anti-baneo-gestion-de-rate-limits)
7. [Instrucciones de uso](#instrucciones-de-uso)
8. [Estructura del proyecto](#estructura-del-proyecto)
9. [Configuracion avanzada](#configuracion-avanzada)
10. [Historial de versiones](#historial-de-versiones)
11. [Troubleshooting](#troubleshooting)
12. [Descargo de responsabilidad](#descargo-de-responsabilidad)

---

## Descripcion del proyecto

X (antes Twitter) no ofrece ninguna funcionalidad nativa para filtrar que cuentas de tu lista de "Siguiendo" no te siguen de vuelta. Revisar esto manualmente es inviable a partir de unos pocos cientos de seguidos.

**Unfollowers-X** resuelve este problema desde la Consola de Desarrollador del navegador. Al ejecutarse, inyecta un **overlay full-screen** que cubre completamente la interfaz de X, realiza un **escaneo automatizado** con scroll del DOM de la pagina `/following`, detecta los no-mutuos leyendo las etiquetas de "Te sigue" / "Follows you" en cada celda de usuario, y presenta una **tabla interactiva** con checkboxes para elegir exactamente quienes dejar de seguir antes de ejecutar ninguna accion.

---

## Novedades de V1.2

| Caracteristica                  | V1.0          | V1.2                          |
|---------------------------------|---------------|-------------------------------|
| Visual durante escaneo          | Panel flotante con scroll visible | Overlay full-screen, scroll invisible |
| Arquitectura del codigo         | Script monolitico | Modulos independientes (Detector, Scraper, Unfollower, UI) |
| Indicador de progreso           | Texto en barra de estado | Contadores grandes, spinner CSS, barra de progreso |
| Avatar de usuario               | Sin avatar    | Avatar de iniciales (sin carga de imagenes) |
| Aviso de limite de sesion       | Al final del proceso | Visible en la tabla de resultados |
| Landing page                    | No incluida   | GitHub Pages (index.html + styles.css) |
| Timeout de seguridad            | No incluido   | 30 minutos maximo por sesion  |

---

## Tecnologias utilizadas

| Tecnologia | Uso en el proyecto |
|---|---|
| Vanilla JavaScript (ES2021+) | Nucleo del script, sin dependencias externas |
| DOM Manipulation API | Lectura de UserCell, inyeccion del overlay y CSS |
| Promises / async-await | Coordinacion de delays y operaciones asincronas |
| setTimeout | Motor del sistema de delays aleatorios anti-baneo |
| MouseEvent API | Simulacion de hover antes de cada clic |
| DocumentFragment | Renderizado eficiente de tablas largas |
| CSS Animations | Spinner y transiciones del overlay |
| HTML5 / CSS3 | Landing page estatica para GitHub Pages |

---

## Arquitectura del script

El script esta organizado en cuatro modulos independientes encapsulados en una IIFE:

```
(function () {
  // CONFIG     — parametros ajustables
  // STATE      — estado global mutable
  // Utilities  — sleep(), rnd(), esc(), usernameFromHref()

  // Detector   — doesFollowBack(), extractInfo()
  // Scraper    — run(onProgress)
  // Unfollower — findBtn(), waitConfirm(), processQueue()
  // UI         — mount(), showScanPhase(), showResultsPhase(),
  //              showUnfollowPhase(), showDonePhase()

  // Controllers — runScan(), runUnfollow()
  // Init
})();
```

### Flujo de ejecucion

```
Init
 │
 ├─ UI.mount()          → crea el overlay en el DOM
 │
 └─ runScan()
     │
     ├─ UI.showScanPhase()          → muestra spinner y contadores
     │
     ├─ Scraper.run()               → scroll en background, lee UserCells
     │   └─ Detector.extractInfo()  → extrae username y displayName
     │   └─ Detector.doesFollowBack() → comprueba etiqueta "Te sigue"
     │
     ├─ UI.showResultsPhase()       → tabla con checkboxes
     │   └─ [usuario selecciona]
     │
     └─ runUnfollow()
         │
         ├─ UI.showUnfollowPhase()        → barra de progreso
         ├─ Unfollower.processQueue()     → scroll progresivo + unfollows
         │   └─ Unfollower.waitConfirm()  → polling del modal de X
         │   └─ UI.runCountdown()         → countdown visible por cada delay
         │
         └─ UI.showDonePhase()            → resumen final
```

### Tecnica: overlay como mascara visual

El overlay tiene `position: fixed; inset: 0; z-index: 9999999`. Cubre el 100% del viewport pero no interfiere con `window.scrollBy()`, que opera sobre el documento subyacente. Esto permite que el Scraper desplace la pagina de X para cargar mas usuarios en la lista virtualizada, mientras el usuario ve solo los contadores del overlay y no el scroll.

### Tecnica: scroll progresivo en el Unfollower

En lugar de guardar referencias a elementos del DOM durante el escaneo (que quedan invalidadas por la virtualizacion de la lista de X), el Unfollower hace scroll desde el inicio de la pagina buscando activamente cada `[data-testid="UserCell"]` en el momento de procesarlo. Esta tecnica es compatible con listas virtualizadas de cualquier longitud.

---

## Por que DOM Scraping y no API directa

Una pregunta frecuente al ver este tipo de herramienta es: "por que no usar la API de X directamente?". La respuesta tiene tres razones tecnicas:

### 1. Headers dinamicos rotativos

Los endpoints internos de X (como `https://x.com/i/api/graphql/...`) autentican cada peticion con tokens y headers que rotan por request. Interceptarlos desde JavaScript del navegador sin ser detectado es practicamente imposible con las medidas anti-bot que X tiene en produccion.

### 2. CSP bloquea fetch() directo

La politica Content Security Policy de X incluye directivas `connect-src` que impiden hacer `fetch()` a sus endpoints desde scripts inyectados. Esto bloquea tanto bookmarklets como scripts ejecutados desde la consola cuando intentan hacer llamadas de red directas a los dominios de X.

### 3. API oficial con restricciones

La API oficial de X requiere aprobacion de cuenta de desarrollador, tiene rate limits muy estrictos en el tier gratuito, y cualquier automatizacion de gestion de follows/unfollows requiere permisos especificos que no son aprobados facilmente.

### La solucion: DOM Scraping con autenticacion del browser

El DOM de la pagina `/following` ya esta cargado y autenticado en el contexto del navegador del usuario. Leer ese DOM con `querySelectorAll('[data-testid="UserCell"]')` no requiere ningun header ni token adicional. El browser ya tiene la sesion. El script solo lee lo que el browser ya descargo.

---

## Sistema anti-baneo: gestion de rate limits

Esta es la parte mas critica del proyecto. X tiene sistemas de deteccion de comportamiento automatizado que pueden resultar en restricciones de cuenta.

### Nivel 1: Delays aleatorios de larga duracion

```javascript
const CONFIG = {
  DELAY_MIN_MS: 35_000,  // 35 segundos
  DELAY_MAX_MS: 85_000,  // 85 segundos
};

const totalMs = rnd(CONFIG.DELAY_MIN_MS, CONFIG.DELAY_MAX_MS);
```

Un bot opera con intervalos matematicamente regulares. Los algoritmos de deteccion buscan periodicidad estadistica. Un rango amplio con distribucion uniforme aleatoria hace que el perfil de actividad sea estadisticamente indistinguible del de un usuario humano lento y deliberado.

Por que 35-85 segundos: valores por debajo de 30 segundos aumentan significativamente el riesgo de deteccion en acciones de unfollow, que son monitoreadas con mayor atencion que otras acciones.

### Nivel 2: Limite de sesion por lotes

```javascript
const CONFIG = {
  MAX_UNFOLLOWS: 22,
};

if (state.unfollowCount >= CONFIG.MAX_UNFOLLOWS) {
  return { done, limitReached: true };
}
```

Los sistemas anti-spam analizan la velocidad de acciones por ventana temporal. 22 unfollows con delays de 35-85 segundos equivale a una sesion de aproximadamente 15-30 minutos, que es un patron de comportamiento humano normal.

Recomendacion de uso seguro:
- Maximo 1-2 sesiones por dia
- Esperar al menos 3 horas entre sesiones
- No superar 40-50 unfollows en total por dia

### Nivel 3: Simulacion de comportamiento humano

```javascript
// Scroll suave al elemento antes de interactuar
cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
await sleep(500 + Math.random() * 400);

// Hover antes del clic
btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
await sleep(250 + Math.random() * 150);

btn.click();
```

Los bots hacen clic directo sin eventos previos de mouse. El script simula el flujo completo: scroll al elemento, hover con pausa variable, luego clic, con tiempos aleatorios en cada micro-accion.

### Nivel 4: Delays variables durante el scroll del escaneo

```javascript
const CONFIG = {
  SCROLL_MIN_MS: 500,
  SCROLL_MAX_MS: 2_000,
};
```

El scroll del escaneo tambien usa delays aleatorios para evitar un patron de scrolling mecanico y regular que podria ser detectado.

### Nivel 5: Timeout de sesion

```javascript
const CONFIG = {
  SESSION_TIMEOUT_MS: 30 * 60 * 1_000,  // 30 minutos
};
```

Si el script lleva mas de 30 minutos activo, se detiene automaticamente. Esto previene sesiones excesivamente largas que podrian llamar la atencion de los sistemas de monitoreo.

---

## Instrucciones de uso

### Metodo recomendado: Consola de DevTools

**Este es el unico metodo garantizado.** Los bookmarklets son bloqueados por la politica CSP de X en navegadores modernos (Chrome 98+, Firefox 100+).

**Paso 1 — Navegar a la pagina de seguidos**

```
https://x.com/TU_USERNAME/following
```

**Paso 2 — Abrir DevTools**

| Sistema | Atajo |
|---|---|
| Windows / Linux | F12 o Ctrl + Shift + I |
| macOS | Cmd + Option + I |

Seleccionar la pestana **Console**.

**Paso 3 — Ejecutar el script**

Abrir [unfollowers-x.js](unfollowers-x.js), seleccionar todo el contenido, pegarlo en la consola y presionar Enter.

**Paso 4 — Usar el overlay**

1. El overlay aparece automaticamente e inicia el escaneo
2. Esperar a que el contador se detenga (fin de la lista)
3. Revisar la tabla de no-mutuos detectados
4. Marcar/desmarcar con los checkboxes individuales
5. Usar "Seleccionar todo" / "Deseleccionar todo" segun necesidad
6. Hacer clic en **Dejar de seguir seleccionados**
7. Esperar al proceso (el countdown muestra el tiempo restante)
8. Hacer clic en **Cerrar** al finalizar

No cerrar la pestana del navegador ni navegar a otra URL mientras el proceso esta activo.

---

## Estructura del proyecto

```
Unfollowers-X/
│
├── unfollowers-x.js       Script principal — comentado y modular
├── unfollowers-x.min.js   Version compacta para bookmarklet
├── index.html             Landing page para GitHub Pages
├── styles.css             Estilos de la landing page
└── README.md              Esta documentacion
```

---

## Configuracion avanzada

El objeto `CONFIG` al inicio de `unfollowers-x.js` permite ajustar el comportamiento:

```javascript
const CONFIG = {
  // Delay minimo entre unfollows (ms) — NO bajar de 20000
  DELAY_MIN_MS: 35_000,

  // Delay maximo entre unfollows (ms)
  DELAY_MAX_MS: 85_000,

  // Maximo de unfollows por sesion — NO superar 25
  MAX_UNFOLLOWS: 22,

  // Delay minimo entre scrolls del escaneo (ms)
  SCROLL_MIN_MS: 500,

  // Delay maximo entre scrolls del escaneo (ms)
  SCROLL_MAX_MS: 2_000,

  // Pixeles por scroll durante el escaneo
  SCROLL_STEP_PX: 700,

  // Scrolls consecutivos sin cambio -> fin de lista
  MAX_STUCK_SCROLLS: 6,

  // Timeout maximo de toda la sesion (ms) — 30 minutos
  SESSION_TIMEOUT_MS: 30 * 60 * 1_000,
};
```

Advertencia: reducir `DELAY_MIN_MS` por debajo de 20 segundos o aumentar `MAX_UNFOLLOWS` por encima de 25 incrementa significativamente el riesgo de restricciones en la cuenta.

---

## Historial de versiones

### v1.2 (actual)
- Overlay full-screen que oculta el scroll de X al usuario
- Arquitectura modular: Detector, Scraper, Unfollower, UI
- Avatar de iniciales (sin carga de imagenes externas)
- Aviso en la tabla cuando hay mas no-mutuos que el limite de sesion
- Timeout de seguridad de 30 minutos
- Landing page en GitHub Pages (index.html + styles.css)
- Eliminacion de emojis en todo el codigo

### v1.0
- Panel flotante sobre el feed de X
- Escaneo con scroll visible
- Checkboxes y botones Seleccionar todo / Deseleccionar todo
- Delays anti-baneo de 35-85 segundos
- Limite de 22 unfollows por sesion

---

## Troubleshooting

**El overlay no aparece**
Verificar que el script se pego completo en la consola, incluyendo el ultimo `})();`. Buscar errores en rojo en la consola de DevTools.

**El escaneo termina con 0 usuarios**
Asegurarse de estar en la URL `/following` de tu propio perfil, no en la de otro usuario. X a veces requiere estar logueado y en el perfil propio.

**El boton de unfollow no se encuentra**
X actualiza su frontend frecuentemente. Si el `data-testid` del boton cambia, la funcion `findBtn()` tiene tres estrategias de fallback adicionales. En caso de persistir, abrir un issue en GitHub con la estructura del DOM actualizada.

**El modal de confirmacion no aparece**
En algunos casos X no muestra el modal (cuentas privadas o variantes de UI que X testea por segmentos de usuarios). El script maneja este caso con un timeout de 4 segundos: si el modal no aparece, continua al siguiente usuario.

**El script se detiene antes de terminar**
Verificar si se alcanzo el limite de sesion (22 unfollows) o el timeout de 30 minutos. Esperar al menos 2-3 horas antes de ejecutar una nueva sesion.

**La pagina de X no carga los seguidos**
X usa lazy loading. El script espera hasta 2 segundos entre scrolls para que el DOM se estabilice. Si la conexion es lenta, aumentar `SCROLL_MAX_MS` en la configuracion.

---

## Descargo de responsabilidad

Este proyecto es de **caracter puramente educativo** y fue desarrollado como muestra de habilidades tecnicas en JavaScript, automatizacion del DOM y tecnicas de web scraping para un portfolio profesional.

El uso de este script:

- Puede violar los [Terminos de Servicio de X (Twitter)](https://twitter.com/en/tos), en particular las clausulas sobre automatizacion y uso de herramientas de terceros no autorizadas.
- Puede resultar en restricciones temporales o permanentes de la cuenta de X.
- Es responsabilidad exclusiva del usuario que decida ejecutarlo.

El autor de este script:

- No se hace responsable de ninguna consecuencia derivada del uso de esta herramienta.
- No alienta el uso masivo, comercial ni malicioso de automatizaciones en plataformas de terceros.
- Proporciona este codigo unicamente con fines demostrativos de tecnicas de desarrollo front-end.

---

## Habilidades tecnicas demostradas

Este proyecto es una demostracion practica de las siguientes competencias:

- Vanilla JavaScript avanzado — async/await, Promises, closures, IIFE, modulos objeto
- Manipulacion del DOM — lectura, traversal, inyeccion de nodos, CSS en runtime
- Web Scraping en el navegador — extraccion de datos de SPA renderizadas dinamicamente
- Automatizacion del navegador — simulacion de MouseEvent, scroll programatico
- Rate Limiting y anti-deteccion — delays aleatorios, limites por sesion, simulacion de comportamiento humano
- UI/UX en runtime — inyeccion de interfaces completas (HTML + CSS) sin frameworks
- Arquitectura modular — separacion de responsabilidades en un script sin bundler
- Manejo asincrono complejo — coordinacion de bucles con timeouts y polling

---

*Desarrollado como proyecto de portfolio — Vanilla JavaScript — DOM Automation — 2024*
