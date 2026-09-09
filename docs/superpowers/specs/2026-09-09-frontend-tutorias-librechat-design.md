# Frontend de tutorías sobre LibreChat resistente a actualizaciones — Diseño

**Estado:** borrador para revisión. Ninguna parte está implementada.
**Fecha:** 2026-09-09
**Base medida:** LibreChat v0.8.8-rc2, commit `968950a`. El fork `vicenciomf2/LibreChat`
está hoy sincronizado con `danny-avila/LibreChat`: 0 commits de divergencia en ambos
sentidos.

## 1. El problema, formulado con precisión

Queremos un chatbot de tutorías para estudiantes universitarios, con interfaz propia,
construido sobre LibreChat. La restricción dura es que **nuestra interfaz sobreviva a
las actualizaciones de LibreChat**: cuando LibreChat publique una versión nueva, lo
nuestro debe seguir funcionando sin rehacer el trabajo.

Esa restricción no se cumple eligiendo "bien" un framework. Se cumple eligiendo **a qué
nos acoplamos**. Todo lo que construyamos tocará a LibreChat en algún punto; la pregunta
de diseño es *qué superficie tocamos* y *qué tan rápido cambia esa superficie*.

## 2. Evidencia: qué cambia y qué no

Todas las cifras salen de la historia real del repositorio (5.493 commits, 101 tags,
2022-10-20 a 2026-09-08), no de estimaciones.

### 2.1 Ritmo de upstream

- **2.394 commits en los últimos 12 meses**, y acelerando: 478 solo en agosto de 2026.
- **Un release estable cada ~5 semanas**: v0.8.2 (28-ene-2026), v0.8.3 (09-mar),
  v0.8.4 (20-mar), v0.8.5 (22-abr), v0.8.6 (31-may), v0.8.7 (24-jun), v0.8.8-rc2 (sep).
- Existen 101 tags: hay puntos estables a los que anclarse.

### 2.2 El frontend se reescribe; el contrato no

Archivos modificados entre releases consecutivos:

| Salto | `client/src` | `api/server/routes` | `api-endpoints.ts` (líneas) |
|---|---|---|---|
| v0.8.4 → v0.8.5 | 389 archivos | 44 | +4 / −1 |
| v0.8.5 → v0.8.6 | 345 archivos | 38 | +53 / −1 |
| v0.8.6 → v0.8.7 | 460 archivos | 41 | +32 / −3 |
| v0.8.7 → v0.8.8-rc2 | 1.296 archivos | 89 | +70 / −7 |

En 12 meses, **1.885 de los 1.929 archivos de `client/src` (97,7%) fueron modificados**,
en 958 commits.

En el mismo período, el contrato HTTP solo perdió rutas *legacy* (`/api/edit/*`,
`plugins.js`, `tokenizer.js`) y el catálogo de endpoints creció de forma **casi
puramente aditiva**: entre 1 y 7 líneas eliminadas por release, contra decenas añadidas.

**Conclusión que ordena todo el diseño:** acoplarse al código del cliente es acoplarse a
algo que se reescribe cada mes; acoplarse al contrato HTTP es acoplarse a algo que crece
sin romperse.

### 2.3 Lo verificado ejecutando, no leyendo

Se levantó LibreChat localmente (Mongo efímero + un endpoint custom apuntando a un
servidor mock compatible con OpenAI) y se lo consumió desde un cliente externo que no usa
nada de `client/src`. Resultados:

1. **`client/dist` es un punto de sustitución del frontend.** Con `NODE_ENV=production`
   el server exige `client/dist/index.html` para arrancar; al poner ahí un `index.html`
   propio, lo sirve en `/` sin que se toque un solo archivo de `client/src`.
   `client/dist` está ignorado por git (`.gitignore:38`), así que sustituirlo no ensucia
   el árbol ni genera conflictos con upstream.

   Matiz que conviene conocer antes de montar una SPA propia: el contrato no es sólo
   `client/dist`. El servidor también sirve `client/public/assets` y `client/public/fonts`,
   y **reescribe el HTML al vuelo**: sustituye los literales `base href="/"` y
   `lang="en-US"`, inyecta el bootstrap de devtools y estampa el nonce del CSP
   (`api/server/index.js:286-300`). Un `index.html` propio que no contenga esos literales
   simplemente no recibe esas sustituciones — el despliegue en subdirectorio y el idioma
   del documento dejan de funcionar, en silencio.
2. **La autenticación funciona desde fuera:** `POST /api/auth/register` y
   `POST /api/auth/login` → `{token, user}` (JWT) más cookies `refreshToken` y
   `token_provider`.
3. **El chat es un protocolo de dos fases y está versionado:**
   `POST /api/agents/chat/:endpoint` devuelve
   `{streamId, conversationId, generationCreatedAt, status:"started", generationProtocolVersion:1}`
   junto al header `x-librechat-generation-protocol: 1`; luego
   `GET /api/agents/chat/stream/:streamId` entrega el SSE. En una respuesta corta se
   observaron 22 frames tipados: `created`, `on_context_usage`, `on_run_step`,
   17 × `on_message_delta`, `on_run_step_closed`, `final`.
   *Que el protocolo lleve número de versión es lo que permite detectar una ruptura en
   tiempo de ejecución en vez de romperse en silencio.*
4. **Persistencia verificada:** `GET /api/messages/:conversationId` devuelve los mensajes;
   el del asistente trae el texto en `content: [{type:'text', …}]`, no en `text`.
5. **La API asume un navegador.** `api/server/middleware/uaParser.js:27` responde
   `{"message":"Illegal request"}` a cualquier cliente cuyo `User-Agent` no sea un
   navegador reconocido, y registra una violación. Aplica a los routers de `agents`,
   `files`, `assistants` y `accessPermissions`.
6. **CORS abierto pero sin credenciales:** `app.use(cors())` sin opciones
   (`api/server/index.js:338`) produce `Access-Control-Allow-Origin: *` y
   `Access-Control-Allow-Headers: authorization`, sin `Allow-Credentials`, y no es
   configurable por variables de entorno.
7. **Embeber LibreChat en otro portal está soportado oficialmente, con un matiz.**
   Verificado ejecutando: `X_FRAME_OPTIONS=off` quita el header `X-Frame-Options`, pero
   `CSP_FRAME_ANCESTORS` **no hace nada por sí solo** — el CSP está apagado por defecto
   (`CSP_ENABLED`, `.env.example:117`) y, al encenderlo, arranca en modo *report-only*
   salvo que se ponga `CSP_REPORT_ONLY=false`. Con las tres variables, la respuesta trae:

   ```
   Content-Security-Policy: … frame-ancestors 'self' https://canvas.uc.cl
   ```

   Es decir: para *permitir* el iframe basta apagar `X-Frame-Options`; para *restringir
   quién* puede embeber —lo correcto— hay que encender el CSP explícitamente.

   **Hallazgo adicional, verificado:** el nonce del CSP se inyecta también en un
   `index.html` propio colocado en `client/dist` (`api/server/index.js:299`,
   `applyCspNonce`). Una interfaz propia **hereda la postura de seguridad de LibreChat**
   en vez de perderla — lo comprobé sirviendo mi propio HTML y viendo el
   `nonce="…"` aplicado a sus scripts.
8. **Sesión de 15 minutos, refresh de 7 días** (`.env.example:885-886`), con el refresh
   en cookie httpOnly.

De (6) y (8) se sigue una restricción dura: **una SPA alojada en otro dominio no puede
refrescar la sesión**, porque con `Allow-Origin: *` la cookie no viaja. La SPA propia
debe quedar en el mismo origen que la API.

### 2.4 Lo que LibreChat ya resuelve para tutorías

- **Cohortes:** `packages/data-schemas/src/schema/group.ts` — grupos con `memberIds`,
  `tenantId` y `source: 'local' | 'entra'`, es decir sincronizables desde el directorio
  institucional (Entra ID).
- **Memoria del estudiante:** `schema/memory.ts` — entradas por usuario, con clave
  validada y partición opcional por agente.
- **Panel de uso por agente:** `/api/insights`, con permiso `VIEW_INSIGHTS` otorgable a
  usuarios, grupos o roles, y flag `ENABLE_INSIGHTS` (`docs/agent-insights-access-design.md`).
  Precisión importante: entrega **agregados y metadatos**, no transcripciones. Por
  conversación devuelve `conversationId`, agente, fecha, usuario, email, `firstMessage`,
  número de mensajes y tokens (`packages/data-provider/src/types/insights.ts:44-56`); el
  propio documento de diseño declara que ver transcripciones está fuera de alcance.

  Sirve para "cuántos estudiantes usan el tutor, cuánto y con qué empiezan"; **no** para
  "qué le respondió el tutor a este estudiante". Un panel docente que necesite lo segundo
  es desarrollo propio.
- **Configuración por rol, grupo o usuario:** existe una capa de overrides en Mongo
  (`packages/data-schemas/src/schema/config.ts`) con `principalType`, `principalId`,
  `priority` y `tenantId`, editable por `/api/admin/config/:principalType/:principalId`,
  cuyo resultado se mezcla en `GET /api/config`. **Es la palanca más fuerte que encontré
  para tutorías**: permite que cada cohorte vea una configuración distinta —su tutor, sus
  permisos, su mensaje de bienvenida— sin reiniciar el servidor ni desplegar nada.
- **Pedagogía como configuración:** agents con instrucciones, prompts, RAG/file search,
  MCP y endpoints custom se declaran en `librechat.yaml` (1.329 líneas de superficie
  declarativa; la ruta del archivo es configurable con `CONFIG_PATH`,
  `api/server/services/Config/loadCustomConfig.js:73`).
- **Temas como datos, pero en tiempo de build:** `packages/client/src/theme/` define un
  `ThemeDefinition` versionado (`version: 1`) aplicable por `ThemeProvider`. La vía
  declarativa son las variables `REACT_APP_THEME_*` — y aquí está el matiz que cambia el
  diseño: `client/src/utils/getThemeFromEnv.js:11` las lee de `import.meta.env`, es decir
  **Vite las inlinea al compilar**. No son configuración de despliegue.

  **Consecuencia:** con la imagen oficial vanilla no se puede cambiar la paleta, ni el
  título, ni el favicon, ni el logo — el shell HTML los trae como literales y no hay
  ninguna clave de marca en `librechat.yaml`. Cambiar la identidad visual exige
  reconstruir el bundle... o servir uno propio. Esto es exactamente lo que hace la capa 3
  del diseño, y es un argumento a su favor que no había considerado: **para una
  universidad que necesita su propia identidad visual, "solo configuración" no alcanza.**
- **Identidad del estudiante propagada a sistemas externos:** los servidores MCP admiten
  `Authorization: Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}` (`librechat.example.yaml:483`),
  y además hay un flujo *on-behalf-of* completo — intercambio del token del usuario por
  uno para el servicio destino (`packages/api/src/mcp/oauth/obo.ts`,
  `packages/api/src/mcp/MCPManager.ts:1195`).

  Esto importa para el caso concreto: **un tutor conectado a Canvas por MCP podría
  consultar los cursos, plazos y entregas de cada estudiante con los permisos de ese
  estudiante**, sin credenciales compartidas ni un servicio propio que replique esos
  datos. Es la vía correcta para integrar el LMS, y no requiere escribir backend — solo
  un servidor MCP y configuración. (No verificado en ejecución: exige un despliegue con
  OIDC institucional real.)

### 2.5 Lo que sí costaría reimplementar

`client/src/hooks/SSE/useResumableSSE.ts` tiene **4.567 líneas**: es el cliente de
streaming con reanudación (reconexión, recuperación tras recarga, trabajos activos,
turnos en cola). Una interfaz propia con paridad total tendría que reimplementarlo. Una
que acepte "si recargas, pierdes el stream en curso" resuelve el caso feliz en unos
cientos de líneas.

Mitigación disponible: `createPayload` — la función que arma el cuerpo del POST de chat —
vive en `packages/data-provider/src/createPayload.ts` y se exporta desde el índice del
paquete, que **se publica en npm**. No hay que replicarla a mano.

Y los **tipos del protocolo** también son importables: `packages/data-provider/src/types/runs.ts`
define los nombres de evento, tipos de contenido y formas de payload del stream. Lo que no
está publicado es la *máquina de estados* que los consume. Es decir: no hay que adivinar el
contrato, solo implementar la reducción de eventos a mensajes.

## 3. Las cuatro maneras de acoplarse, ordenadas por lo que cuestan

| Vía | A qué te acoplas | Qué cambia por release | Veredicto |
|---|---|---|---|
| Fork de `client/src` | Código que se reescribe | 345-1.296 archivos | Descartada |
| Solo configuración | `librechat.yaml` + env | Aditivo | Necesaria, insuficiente sola |
| SPA propia sobre el contrato HTTP | Rutas + protocolo versionado | +70/−7 líneas | **Núcleo de la propuesta** |
| Capa satélite alrededor | Nada de LibreChat | Nada | Complemento para lo que falta |

### 3.1 Contraste con un panel independiente

Se generaron cinco arquitecturas candidatas de forma independiente y se juzgó cada una
con cuatro lentes separadas (costo de actualización, esfuerzo hasta el primer estudiante,
techo funcional para tutorías, riesgo operacional y de datos). Promedios:

| Arquitectura | Upgrade | Esfuerzo | Techo | Riesgo | Promedio |
|---|---|---|---|---|---|
| Solo configuración | 8 | 9 | 6 | 8 | **7,75** |
| Portal propio + LibreChat embebido | 8,5 | 8 | 6 | 8 | **7,63** |
| Tutoría como agente + consola aparte | 7 | 9 | 7 | 5 | **7,00** |
| SPA propia headless | 7 | 3 | 8,5 | 5,5 | **6,00** |
| Fork del cliente (versión más disciplinada posible) | 5 | 7 | 4 | 6 | **5,50** |

Dos lecturas importan más que el orden:

1. **El fork queda último incluso en su mejor versión.** El defensor del ángulo midió que
   `ChatForm.tsx` pasó de 364 a 946 líneas en seis meses conservando el 59% de sus líneas,
   que `Nav.tsx` fue **borrado** y reemplazado por otro componente, y que upstream usa
   squash merges (0 merge commits en 12 meses), así que cada PR llega como un commit
   gigante imposible de bisecar. Su propia conclusión coincide con la de este diseño.

2. **La SPA propia gana en techo (8,5) y pierde en esfuerzo (3/10).** La crítica textual
   del juez es que "no hay entregable intermedio: el estudiante no puede usar nada hasta
   que estén terminadas varias piezas a la vez". Es una crítica correcta — y es
   exactamente la razón por la que §7 pone configuración y guardián en el primer
   incremento y la SPA en el segundo. El diseño ya la incorpora.

El panel puntúa "solo configuración" primera por esfuerzo y costo de actualización. Su
techo (6/10) es el límite real, y §2.4 lo explica: sin tocar el bundle no se puede cambiar
la paleta, el título ni el logo. Para un piloto eso basta; para un producto con identidad
institucional, no. De ahí que la arquitectura propuesta sea configuración **primero** y
SPA **después**, no una u otra.

## 4. Arquitectura propuesta: cáscara propia sobre núcleo intacto

**LibreChat se trata como una dependencia de infraestructura, no como un punto de
partida para editar.** Se despliega vanilla, desde la imagen oficial anclada a un tag
estable, y se actualiza subiendo el tag. Nada de lo nuestro vive dentro de su árbol de
código.

Cuatro capas, de más estable a más nuestra:

1. **Núcleo (LibreChat vanilla, sin fork).** Imagen `ghcr.io/danny-avila/librechat:vX.Y.Z` (CI publica a ghcr.io y Docker Hub; `registry.librechat.ai` es un espejo).
   Actualizar = cambiar el tag y reiniciar.
2. **Configuración declarativa.** `librechat.yaml` montado por bind mount + variables de
   entorno. Aquí vive: la marca (`REACT_APP_THEME_*`), los permisos por rol, el registro,
   los endpoints de modelo, y **la pedagogía** — agentes tutores con sus instrucciones,
   RAG sobre el material del curso, MCP hacia sistemas de la universidad.
3. **Interfaz propia (SPA), servida en el mismo origen.** Un build propio ocupa
   `client/dist` por bind mount, o bien un reverse proxy sirve la SPA en `/` y proxea
   `/api` al contenedor. En ambos casos: mismo origen (obligatorio por §2.3.6/§2.3.8),
   cero archivos de `client/src` tocados.
   La SPA consume el contrato HTTP y, desde npm, `librechat-data-provider` (tipos,
   `createPayload`, catálogo de endpoints) y opcionalmente `@librechat/client`
   (primitivas, preset de Tailwind, sistema de temas). **Las piezas compartidas llegan
   por `npm update` con semver, no por merge de git.** Eso es, literalmente, "cuando
   LibreChat se actualiza, nuestra interfaz también".
4. **Servicio satélite propio**, para lo que LibreChat no tiene: progreso por estudiante
   más allá de la memoria, rúbricas, planificación de cursos, integración con Canvas.
   Base de datos propia. **No puede hablar con la API de LibreChat servidor-a-servidor**
   por el filtro de User-Agent (§2.3.5): se integra desde el navegador del usuario o con
   su propia telemetría.

### 4.0 La forma concreta, ya decidida

Decisiones tomadas por el autor el 2026-09-09, que fijan la arquitectura:

- La experiencia es **dos aplicaciones bajo un dominio**, no una sola. El gestor de notas
  propio (con marimo embebido) y la interfaz de tutoría conviven como zonas separadas, con
  navegación entre ellas — el gestor ya tiene resuelto su panel lateral.
- Ambas son **React + Vite**, el mismo stack que los paquetes de LibreChat esperan.

De ahí sale esta topología:

```
                  reverse proxy en tutor.example.cl
   estudiante ──►  /            → gestor de notas (build propio, marimo embebido)
                   /tutor       → interfaz de tutoría (build propio)
                   /api/*       → LibreChat (imagen oficial anclada, :3080)
```

Tres consecuencias que se siguen de lo verificado, no de preferencias:

1. **La sesión se comparte sola.** La cookie `refreshToken` es `httpOnly`, `sameSite:
   'strict'` y de path `/` (`api/server/services/AuthService.js:721-726`). Bajo un mismo
   dominio, ambas apps la envían automáticamente a `POST /api/auth/refresh` y cada una
   obtiene su token de acceso. No hay que inventar ningún puente entre apps, ni pasar
   tokens por la URL, ni duplicar login. En dominios distintos nada de esto funcionaría:
   `sameSite: 'strict'` más `Access-Control-Allow-Origin: *` sin credenciales lo impiden.
2. **LibreChat deja de servir interfaz.** Con el proxy, solo recibe `/api/*`. Pero sigue
   exigiendo `client/dist/index.html` para arrancar (§2.3.1), así que basta dejar ahí un
   HTML mínimo. Su cliente oficial no se usa ni se toca.
3. **Marimo cabe sin pelear con la seguridad.** Si se activa el CSP, sus directivas por
   defecto ya admiten lo que necesita Pyodide: `frame-src` incluye `blob:` y `data:`,
   `worker-src` incluye `blob:`, y `script-src` incluye `'wasm-unsafe-eval'`
   (`packages/api/src/security/csp.ts`), con banderas dedicadas `CSP_ALLOW_WASM` y
   `CSP_ALLOW_DATA_WORKERS`. Queda por comprobar contra el montaje real si el notebook
   exportado necesita además aislamiento cross-origin (COOP/COEP): la documentación de
   marimo no lo especifica, y LibreChat hoy envía `Cross-Origin-Opener-Policy: same-origin`
   pero **no** `Cross-Origin-Embedder-Policy`.

Lo que esto le hace al resto del diseño: la capa 3 deja de ser "el segundo incremento" y
pasa a ser el producto. La capa 4 (satélite) se disuelve — el gestor de notas *es* esa
capa, y ya existe.

### 4.1 El contrato de actualización

Lo que hace que esto "sobreviva" no es la elección de capas, sino un contrato explícito y
verificable:

- **Se actualiza solo:** el núcleo (bump de tag) y las piezas npm (`npm update` dentro de
  los rangos semver).
- **Requiere intervención:** un cambio mayor de `generationProtocolVersion`, la
  desaparición de una ruta que consumimos, o un cambio de forma en los eventos SSE.
- **Cómo se detecta antes que un estudiante:** una suite de contrato — el mismo spike de
  §2.3, automatizado — que corre contra la versión nueva en CI antes de promoverla:
  login, POST de chat, lectura del stream, persistencia, y una aserción sobre
  `generationProtocolVersion`. Si falla, la actualización no se promueve.

Esa suite es el entregable que convierte la promesa en garantía. Sin ella, "sobrevive a
las actualizaciones" es una intención.

## 5. Stack propuesto para la SPA

La elección no es de gusto: **adoptar el stack que los paquetes de LibreChat ya esperan**
minimiza la fricción, porque `@librechat/client` declara 50 peerDependencies y ninguna
dependencia propia.

| Pieza | Elección | Por qué |
|---|---|---|
| Build | Vite | Es lo que usa `client/`; el bundle resultante encaja en `client/dist` |
| UI | React 19 + TypeScript | `@librechat/client` pide `react ^18.2 \|\| ^19.1` |
| Estilos | Tailwind + `@librechat/client/tailwind-preset` | El preset viene publicado; hereda los tokens semánticos |
| Datos | TanStack Query | Es peer de `@librechat/client` (`^4.28 \|\| ^5`) |
| Estado local | Jotai | Es peer del paquete; y es hacia donde migra el cliente oficial |
| Contrato | `librechat-data-provider` | Tipos y `createPayload` oficiales, versionados en npm |
| i18n | i18next + react-i18next | Peers del paquete; el español ya existe upstream |

Nada de esto obliga a usar `@librechat/client` para todo: se puede empezar con las
primitivas y el preset, y escribir los componentes de tutoría propios.

### 5.1 Verificación del stack (ejecutada, no supuesta)

Se creó una app externa (Vite 8 + React 19, fuera del monorepo) y se compiló y ejecutó en
Chromium real:

| Paquete | Instalación | Resultado |
|---|---|---|
| `librechat-data-provider` | limpia: 55 paquetes en 6 s | Compila y **corre en navegador**: `EndpointURLs[agents]` resuelve a `/api/agents/chat`, 88 query keys disponibles, cero errores de consola |
| `@librechat/client` | **con fricción** | Requiere declarar sus 50 dependencias de pares como dependencias propias y usar `--legacy-peer-deps`; entonces instala 213 paquetes en 19 s |

La fricción de `@librechat/client` tiene causa concreta: el paquete declara 0 dependencias
y 50 peers, varios **fijados a versiones exactas antiguas** (`@radix-ui/react-alert-dialog@1.0.2`,
`@radix-ui/react-dialog@1.0.2`), que chocan con la resolución normal de npm. Sin
instalarlos, el build falla al resolver `@radix-ui/react-icons` desde su bundle.
Una vez satisfechos, `Button` y `ThemeProvider` se importan y ejecutan sin errores, pero
el bundle con solo esos dos imports pesa 1,07 MB sin dividir.

**Consecuencia práctica:** adoptar `librechat-data-provider` es barato y de alto valor —
es el contrato tipado. Adoptar `@librechat/client` es una decisión aparte, con costo de
mantenimiento propio: conviene tomarla sólo si se van a usar bastantes componentes, con
lockfile propio y vigilando el tamaño del bundle.

**Advertencia sobre las versiones npm:** el número publicado coincide con el del repo
(0.8.522 / 0.4.77), pero el tarball no es el árbol de trabajo: se publicó el 2026-09-03 y
desde entonces hay 22 commits sobre `packages/data-provider/src` que no están en npm. Una
app externa consume la versión publicada, que es lo correcto — pero al depurar contra un
LibreChat más nuevo que el paquete, la diferencia explica discrepancias que de otro modo
parecen bugs.

Dos advertencias del empaquetado: `librechat-data-provider` importa `crypto` y `url` de
Node, que Vite externaliza para el navegador. No rompió nada en esta prueba, pero hay que
comprobarlo en las rutas de código que se usen de verdad.

### 5.2 El esqueleto completo, funcionando

Las tres verificaciones anteriores prueban piezas sueltas. Esta las une: se compiló una
SPA propia de ~120 líneas (sin usar nada de `client/src`), se copió a `client/dist`, se
levantó LibreChat, y se manejó la página en un Chromium real.

Resultado, con cero errores de consola:

```
título de la página: Tutor
estado inicial: sin sesión
tras login: sesión iniciada como spike-1@example.com
--- conversación en pantalla ---
   estudiante: ¿Me explicas la regla de la cadena?
   tutor: Respuesta del tutor mock a: ¿Me explicas la regla de la cadena?
conversationId persistido: aef4f2b7-ff1f-4ac3-bf4f-c97e04240683
```

La SPA obtiene la ruta de chat del paquete oficial (`EndpointURLs[EModelEndpoint.agents]`),
registra al estudiante, inicia sesión, ejecuta las dos fases del protocolo y pinta los
deltas del stream a medida que llegan.

**Esto es la arquitectura de §4 funcionando de extremo a extremo.** Lo que queda por
construir para un producto real es interfaz y pedagogía, no integración: la integración
está demostrada.

El código del esqueleto es material de spike, deliberadamente desechable — sin estilos,
sin manejo de errores, sin reanudación de stream. Su valor es la evidencia, no el código.

## 6. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| El protocolo de generación sube de versión mayor | La suite de contrato lo detecta en CI; el tag anterior sigue desplegado |
| Reimplementar el streaming reanudable es caro (4.567 líneas) | El primer incremento no soporta reanudación: si recargas, relees el historial |
| `uaParser` bloquea integraciones servidor-a-servidor | Toda integración pasa por el navegador del usuario; el satélite no llama a la API de LibreChat |
| Dependencia de un upstream con un mantenedor principal | Licencia MIT y despliegue anclado a tag: siempre se puede congelar |
| Datos personales de estudiantes | Despliegue propio, base de datos propia; el material y las conversaciones no salen de la infraestructura de la universidad |
| Migraciones de base entre versiones | Actualizar de a un release estable por vez, con respaldo previo y verificación en un entorno de ensayo |

## 7. Los dos primeros incrementos

**Primer incremento** — lo más pequeño que ya sirve a un estudiante real, y lo único que
no depende de decisiones abiertas. Está planificado en detalle en
`docs/superpowers/plans/2026-09-09-tutor-primer-incremento.md`:

1. LibreChat vanilla desplegado y anclado al último tag estable publicado (`v0.8.7` al
   2026-09-09), con `librechat.yaml` configurado: marca de la universidad, registro
   restringido, y un agente tutor con instrucciones pedagógicas.
2. El guardián de contrato (§4.1) corriendo en CI contra esa versión.

Con eso un estudiante ya conversa con el tutor, y una actualización que rompa el contrato
se detiene antes de llegar a él.

**Segundo incremento** — ahora desbloqueado por las decisiones de §4.0:

3. El reverse proxy que pone gestor de notas, interfaz de tutoría y `/api` bajo un
   dominio, y la sesión compartida funcionando entre las dos apps (que es lo único
   realmente nuevo respecto del esqueleto ya verificado en §5.2).
4. La interfaz de tutoría propia: login apoyado en la sesión del dominio, lista de
   conversaciones, chat con streaming.
5. RAG sobre el material de un curso piloto (requiere `rag_api` y un curso concreto).

Nota sobre el orden: antes este documento dejaba la interfaz para el final, con el
argumento de que el valor no dependía de ella. Con dos aplicaciones y un gestor de notas
ya avanzado, ese argumento se cae — la interfaz *es* el producto. Lo que sigue en pie es
que el primer incremento entrega valor sin ella, así que sigue yendo primero, pero por
semanas, no por meses.

## 8. Decisiones que quedan abiertas

Ninguna de estas se puede deducir del código; todas cambian el diseño:

1. **¿Dónde se despliega y quién lo opera?** Servidor de la universidad, nube propia, o
   un servicio administrado. Determina si el satélite es viable y qué integración con
   Canvas es posible.
2. **¿Autenticación institucional?** Si los estudiantes entran con la cuenta UC (Entra
   ID / OIDC), los grupos se sincronizan solos y las cohortes salen gratis. Si no, hay
   que administrar usuarios a mano.
3. ~~**¿Cuánto de la interfaz debe realmente ser distinta?**~~ **RESUELTA el 2026-09-09:**
   pantallas propias. Dos aplicaciones React + Vite bajo un dominio —un gestor de notas
   propio con marimo embebido, ya avanzado, y la interfaz de tutoría— con LibreChat detrás
   como motor. Ver §4.0. El texto original de la pregunta se conserva abajo porque su
   razonamiento explica el diseño anterior:

   ~~Si basta con marca, idioma y
   un tutor bien configurado, la capa 3 puede esperar meses. Si la experiencia de
   tutoría exige una interfaz propia (bloques, progreso visible, ejercicios), la SPA
   entra antes.~~
4. **¿Qué modelo y con qué presupuesto?** Define si conviene endpoint custom, agentes, o
   un proveedor con límites por estudiante (`balance`).
5. **¿Un curso piloto concreto?** Tener uno hace que el RAG y las instrucciones del tutor
   sean verificables en vez de hipotéticas.
