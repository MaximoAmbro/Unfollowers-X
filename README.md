# Unfollowers-X v2.0

> Dashboard bidireccional de automatizacion del navegador en JavaScript puro para gestionar cuentas en X (Twitter): detecta no-mutuos y los deja de seguir, o sigue en masa a los seguidores de cualquier perfil. Sin dependencias externas. 100% Vanilla JavaScript.

**Version:** 2.0
**Landing page:** [maximoambro.github.io/Unfollowers-X](https://maximoambro.github.io/Unfollowers-X/)

---

## Descripcion

Unfollowers-X es una herramienta de automatizacion del navegador que se ejecuta desde la Consola de DevTools de X. Al inyectarse, crea un **overlay full-screen** que cubre la interfaz de X y presenta un **dashboard con dos pestanas** para gestionar dos flujos completamente distintos:

- **Modulo Unfollower**: detecta todas las cuentas que no te siguen de vuelta y las deja de seguir con delays precisos y cooldowns obligatorios.
- **Modulo Auto-Follow**: carga los seguidores de cualquier perfil en chunks y los sigue selectivamente, respetando limites de lote estrictos.

La deteccion del modulo disponible es automatica segun la URL activa en el navegador.

---

## Caracteristicas principales

### Modulo Unfollower
- Escaneo invisible con scroll automatico detras del overlay full-screen
- Detecta no-mutuos leyendo el badge "Te sigue" / "Follows you" en el DOM
- Tabla interactiva con checkboxes para seleccion granular
- Sin limite de unfollows por sesion (el usuario decide cuando parar)
- Delays precisos con decimales: 10.23 — 64.32 segundos
- Cooldown obligatorio cada 10 unfollows: 4-10 minutos aleatorio

### Modulo Auto-Follow
- Carga seguidores en chunks de 250 usuarios (boton "Cargar mas" para chunks adicionales)
- Tabla con checkboxes, avatares de iniciales y seleccion granular
- Maximo 20 follows por lote (regla estricta anti-baneo)
- Delays: 45 — 95 segundos entre follows
- Cooldown obligatorio cada 10 follows: 4-10 minutos aleatorio
- Cooldown de 2 horas entre lotes dentro de la misma sesion

### Dashboard
- Deteccion automatica de URL: habilita el modulo correcto segun la pagina activa
- Modulos mutuamente excluyentes: uno debe completarse antes de acceder al otro
- Re-deteccion de pagina sin cerrar el script
- Boton de parada en cualquier punto del flujo

---

## Tecnologias utilizadas

| Tecnologia | Uso |
|---|---|
| Vanilla JavaScript ES2021+ | Nucleo del script, cero dependencias |
| DOM Manipulation API | Lectura de UserCells, inyeccion de overlay y CSS |
| Promises / async-await | Coordinacion de todos los delays asincronos |
| setTimeout + polling | Motor de delays precisos y deteccion del modal de X |
| MouseEvent API | Simulacion de hover antes de cada clic |
| DocumentFragment | Renderizado eficiente de tablas largas |
| CSS Animations | Spinner y animacion de entrada del overlay |
| HTML5 + CSS3 | Landing page estatica para GitHub Pages |
| Clipboard API | Boton "Copiar codigo" en la landing page |

---

## Como funciona

### Visual Masking (overlay full-screen)

El script inyecta `<div id="xuf-ov" style="position:fixed;inset:0;z-index:9999999">` que cubre el 100% del viewport. El usuario solo ve la interfaz del script. `window.scrollBy()` opera sobre el documento subyacente independientemente del overlay, lo que permite hacer scroll por la lista de X en background sin que el usuario lo vea.

### DOM Scraping

Lee `[data-testid="UserCell"]` del DOM de X en lugar de llamar a la API interna. La deteccion de mutuos busca el texto "Follows you" / "Te sigue" en el `innerText` de cada celda (mas robusto que buscar clases CSS que cambian con cada deploy).

### Por que NO la API GraphQL de X

**Headers dinamicos rotativos**: Los endpoints internos de X autentican cada peticion con tokens que rotan por request. Imposibles de replicar desde JavaScript del navegador.

**CSP bloquea fetch() directo**: La Content-Security-Policy de X impide llamadas a sus endpoints desde scripts inyectados (bookmarklets, consola).

**API oficial con restricciones**: Requiere aprobacion de desarrollador y tiene rate limits estrictos para acciones de follow/unfollow.

**La alternativa**: El DOM de X ya esta renderizado y autenticado en el navegador del usuario. Leerlo no requiere ningun token adicional.

### Scroll progresivo en el Unfollower y Auto-Follow

En lugar de guardar referencias a elementos del DOM durante el escaneo (invalidadas por la virtualizacion de la lista), los modulos hacen scroll desde el inicio buscando activamente cada `UserCell` en el momento de procesarlo.

---

## Sistema anti-baneo sofisticado

### Nivel 1: Delays precisos con decimales

```javascript
// Unfollower: 10.23 — 64.32 segundos (decimal preciso)
const delayMs = CFG.UF_DELAY_MIN + Math.random() * (CFG.UF_DELAY_MAX - CFG.UF_DELAY_MIN);

// Auto-Follow: 45 — 95 segundos
const delayMs = rndInt(CFG.AF_DELAY_MIN, CFG.AF_DELAY_MAX);
```

Los decimales rompen la periodicidad estadistica que detectan los algoritmos anti-bot. Un humano nunca actua con intervalos matematicamente regulares.

### Nivel 2: Cooldown obligatorio cada 10 acciones

```javascript
if (done > 0 && done % CFG.UF_CD_EVERY === 0 && pending.size > 0) {
  const cdMs = rndInt(CFG.UF_CD_MIN, CFG.UF_CD_MAX); // 4 - 10 min
  await countdown(cdMs, rem => onCooldown(rem, done, total));
}
```

La pausa de 4-10 minutos cada 10 acciones simula el comportamiento humano de descansar entre rafagas de actividad.

### Nivel 3: Limite de lote en Auto-Follow

```javascript
const CFG = {
  AF_MAX_PER_BATCH: 20,
  AF_BATCH_WAIT:    2 * 60 * 60 * 1_000, // 2 horas
};
```

20 follows con delays de 45-95s equivalen a una sesion de 30-50 minutos. La espera de 2 horas entre lotes mantiene la actividad diaria dentro de umbrales normales.

### Nivel 4: Simulacion de comportamiento humano

```javascript
btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
await sleep(250 + Math.random() * 150); // hover antes del clic
btn.click();
```

Los bots hacen clic directo. El script simula hover con pausa variable antes de cada accion.

### Nivel 5: Scroll variable durante escaneo

Delays de 500ms a 2s entre scrolls evitan patrones de scroll mecanico.

### Nivel 6: Timeout global de sesion

```javascript
CFG.TIMEOUT = 2 * 60 * 60 * 1_000; // 2 horas maximas por sesion
```

---

## Instrucciones de uso

### Modulo Unfollower

1. Navegar a: `https://x.com/TU_USUARIO/following`
2. Abrir DevTools (F12) → Console
3. Pegar el contenido de `unfollowers-x.js` y presionar Enter
4. El dashboard detecta `/following` y habilita el Modulo Unfollower
5. Hacer clic en "Iniciar Modulo Unfollower"
6. Esperar el escaneo (el contador muestra el progreso en tiempo real)
7. Revisar la tabla, desmarcar usuarios que no deseas dejar de seguir
8. Hacer clic en "Dejar de seguir seleccionados"
9. El panel muestra el countdown preciso antes de cada accion

### Modulo Auto-Follow

1. Navegar a: `https://x.com/@USUARIO/followers` (el perfil cuya audiencia quieres seguir)
2. Abrir DevTools (F12) → Console
3. Pegar el contenido de `unfollowers-x.js` y presionar Enter
4. El dashboard detecta `/followers` y habilita el Modulo Auto-Follow
5. Hacer clic en "Iniciar Modulo Auto-Follow"
6. Esperar la carga del primer chunk (250 usuarios)
7. Usar "Cargar mas seguidores" para chunks adicionales si es necesario
8. Revisar la tabla y desmarcar usuarios que no deseas seguir
9. Hacer clic en "Seguir seleccionados"
10. Esperar el lote (maximo 20 follows con delays de 45-95s)
11. Esperar 2 horas antes del siguiente lote

---

## Estructura del proyecto

```
Unfollowers-X/
│
├── unfollowers-x.js        Script principal comentado y modular
├── unfollowers-x.min.js    Version compacta para bookmarklet
├── index.html              Landing page para GitHub Pages
├── styles.css              Estilos de la landing page
└── README.md               Esta documentacion
```

### Arquitectura del script

```
(function () {
  CFG       — configuracion ajustable (delays, limites, timeouts)
  S         — estado global mutable (ambos modulos + sesion)
  Utilidades — sleep, rnd, esc, uname, fmtMs, fmtSec, icolor

  DETECT    — followsBack(), userInfo(), unfollowBtn(), followBtn()
  SCRAPER   — scanUnfollowers(), scanFollowers()
  UF        — waitConfirm(), countdown(), run()
  AF        — waitConfirm(), countdown(), batchCooldownActive(), run()
  UI        — CSS, mount/unmount, buildShell(), showDashboard()
              uf.* — fases del Modulo Unfollower
              af.* — fases del Modulo Auto-Follow
  CTRL      — init(), backToDashboard(), startUnfollower(),
              runUnfollow(), startAutoFollow(), loadMoreFollowers(),
              runAutoFollow()
})()
```

---

## Configuracion avanzada

El objeto `CFG` al inicio del script permite ajustar el comportamiento:

```javascript
const CFG = {
  // Unfollower
  UF_DELAY_MIN:  10_230,   // NO bajar de 8000
  UF_DELAY_MAX:  64_320,
  UF_CD_EVERY:   10,       // cooldown cada N unfollows
  UF_CD_MIN:     4 * 60 * 1_000,
  UF_CD_MAX:     10 * 60 * 1_000,

  // Auto-Follow
  AF_DELAY_MIN:      45_000,
  AF_DELAY_MAX:      95_000,
  AF_CD_EVERY:       10,
  AF_CD_MIN:         4 * 60 * 1_000,
  AF_CD_MAX:         10 * 60 * 1_000,
  AF_MAX_PER_BATCH:  20,   // NO superar 25
  AF_BATCH_WAIT:     2 * 60 * 60 * 1_000,
  AF_CHUNK_SIZE:     250,
};
```

---

## Limitaciones y riesgos

- El uso de automatizaciones puede violar los Terminos de Servicio de X. Riesgo de suspension temporal o permanente de la cuenta.
- X actualiza su DOM frecuentemente. Si cambian los `data-testid` o las estructuras de las celdas, el script puede dejar de funcionar hasta ser actualizado.
- El cooldown de 2 horas entre lotes de Auto-Follow no persiste si se recarga la pagina (no se usa localStorage por diseno). Llevar control manual del tiempo entre sesiones.
- El script no puede detectar si X devuelve un error de rate limit silencioso (sin modal). Si se notan comportamientos anormales, detener la sesion y esperar varias horas.
- No recomendado para cuentas con muchos seguidores o de alta visibilidad. Usar en cuentas personales con moderacion.

---

## Historial de versiones

| Version | Fecha | Cambios principales |
|---|---|---|
| v1.0 | 2024 | Panel flotante, scroll visible, limite de 22 unfollows, delays 35-85s |
| v1.2 | 2024 | Overlay full-screen, arquitectura modular (Detector/Scraper/Unfollower/UI), avatar de iniciales, landing page |
| v2.0 | 2024 | Dashboard bidireccional, Modulo Auto-Follow, deteccion automatica de URL, delays precisos con decimales (10.23-64.32s), cooldowns cada 10 acciones, carga por chunks, boton "Copiar codigo" en landing page |

---

## Descargo de responsabilidad

Este proyecto es de **caracter puramente educativo** y fue desarrollado como muestra de habilidades tecnicas para un portfolio profesional.

El uso de este script puede infringir los [Terminos de Servicio de X (Twitter)](https://twitter.com/en/tos). El autor no asume ninguna responsabilidad por consecuencias derivadas de su uso. El usuario es el unico responsable de las acciones realizadas con esta herramienta.

---

## Habilidades tecnicas demostradas

- Vanilla JavaScript avanzado: async/await, Promises, closures, IIFE, modulos objeto
- Manipulacion del DOM: lectura, traversal, inyeccion de nodos y estilos en runtime
- Web Scraping en el navegador: extraccion de datos de SPA con virtualizacion de listas
- Automatizacion del navegador: simulacion de MouseEvent, scroll programatico, polling del DOM
- Rate Limiting y anti-deteccion: delays con decimales precisos, cooldowns, limites por sesion
- Arquitectura modular: separacion de responsabilidades sin bundler ni framework
- UI/UX en runtime: dashboard completo con tabs, fases y CSS inyectado sin dependencias
- Manejo asincrono complejo: coordinacion de bucles, timeouts y polling simultaneos

---

*Desarrollado como proyecto de portfolio — Vanilla JavaScript — DOM Automation — 2024*

---

## Licencia

MIT License — libre para uso personal, educativo y de portfolio.
