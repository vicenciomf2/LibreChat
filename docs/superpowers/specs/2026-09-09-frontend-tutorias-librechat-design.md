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
7. **Embeber LibreChat en otro portal está soportado oficialmente:**
   `CSP_FRAME_ANCESTORS` (`packages/api/src/security/csp.ts:164`) junto con
   `X_FRAME_OPTIONS=off`, documentado en `.env.example:155-158`.
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
- **Panel de uso y de contenido de conversaciones:** `/api/insights`, con permiso
  `VIEW_INSIGHTS` otorgable a usuarios, grupos o roles, y flag `ENABLE_INSIGHTS`
  (`docs/agent-insights-access-design.md`). Es la base de un panel docente.
- **Pedagogía como configuración:** agents con instrucciones, prompts, RAG/file search,
  MCP y endpoints custom se declaran en `librechat.yaml` (1.329 líneas de superficie
  declarativa; la ruta del archivo es configurable con `CONFIG_PATH`,
  `api/server/services/Config/loadCustomConfig.js:73`).
- **Temas como datos:** `packages/client/src/theme/` define un `ThemeDefinition`
  versionado (`version: 1`), aplicable por `ThemeProvider` o por variables
  `REACT_APP_THEME_*`, con adaptadores legacy.
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

## 3. Las cuatro maneras de acoplarse, ordenadas por lo que cuestan

| Vía | A qué te acoplas | Qué cambia por release | Veredicto |
|---|---|---|---|
| Fork de `client/src` | Código que se reescribe | 345-1.296 archivos | Descartada |
| Solo configuración | `librechat.yaml` + env | Aditivo | Necesaria, insuficiente sola |
| SPA propia sobre el contrato HTTP | Rutas + protocolo versionado | +70/−7 líneas | **Núcleo de la propuesta** |
| Capa satélite alrededor | Nada de LibreChat | Nada | Complemento para lo que falta |

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

## 7. Primer incremento propuesto

Lo más pequeño que ya sirve a un estudiante real:

1. LibreChat vanilla desplegado y anclado al último tag estable publicado (`v0.8.7` al 2026-09-09), con `librechat.yaml`
   configurado: marca de la universidad, registro restringido, un agente tutor con
   instrucciones pedagógicas y RAG sobre el material de un curso piloto.
2. La suite de contrato en CI (§4.1), corriendo contra esa versión.
3. Una SPA mínima servida desde el mismo origen: login, lista de conversaciones, chat con
   streaming, y una pantalla de "mis cursos" que aún puede ser estática.

Los puntos 1 y 2 ya entregan valor sin la SPA: un estudiante puede usar el tutor mientras
la interfaz propia se construye. Ese orden es deliberado — la interfaz es lo último, no lo
primero.

## 8. Decisiones que quedan abiertas

Ninguna de estas se puede deducir del código; todas cambian el diseño:

1. **¿Dónde se despliega y quién lo opera?** Servidor de la universidad, nube propia, o
   un servicio administrado. Determina si el satélite es viable y qué integración con
   Canvas es posible.
2. **¿Autenticación institucional?** Si los estudiantes entran con la cuenta UC (Entra
   ID / OIDC), los grupos se sincronizan solos y las cohortes salen gratis. Si no, hay
   que administrar usuarios a mano.
3. **¿Cuánto de la interfaz debe realmente ser distinta?** Si basta con marca, idioma y
   un tutor bien configurado, la capa 3 puede esperar meses. Si la experiencia de
   tutoría exige una interfaz propia (bloques, progreso visible, ejercicios), la SPA
   entra antes.
4. **¿Qué modelo y con qué presupuesto?** Define si conviene endpoint custom, agentes, o
   un proveedor con límites por estudiante (`balance`).
5. **¿Un curso piloto concreto?** Tener uno hace que el RAG y las instrucciones del tutor
   sean verificables en vez de hipotéticas.
