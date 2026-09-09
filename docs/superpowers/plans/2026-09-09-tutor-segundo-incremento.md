# Tutor sobre LibreChat — Plan del segundo incremento: la interfaz

> **Para agentes ejecutores:** SUB-SKILL REQUERIDA: usar
> `superpowers:subagent-driven-development` (recomendado) o
> `superpowers:executing-plans` para implementar este plan tarea por tarea.

> **Estado: propuesta, no aprobada.** Deriva de
> `docs/superpowers/specs/2026-09-09-frontend-tutorias-librechat-design.md` §4.0, y
> presupone el primer incremento terminado.

**Objetivo:** que un estudiante inicie sesión una vez en el gestor de notas y pueda pasar
a la interfaz de tutoría sin volver a autenticarse, conversando con el tutor del curso.

**Arquitectura:** dos aplicaciones React + Vite bajo un dominio, con LibreChat detrás de
un reverse proxy como motor de chat, autenticación y persistencia. El gestor de notas ya
existe y aporta marimo embebido; la interfaz de tutoría es nueva.

**Stack:** React 19 + Vite + TypeScript, `librechat-data-provider` desde npm para el
contrato tipado, nginx (o Caddy) como proxy. Sin `@librechat/client` en este incremento —
ver spec §5.1: su instalación exige declarar 50 dependencias de pares.

**Spec:** `docs/superpowers/specs/2026-09-09-frontend-tutorias-librechat-design.md`

## Restricciones globales

- **Un solo origen para todo.** Es un requisito, no una preferencia: la cookie de refresco
  es `httpOnly` + `sameSite=strict` (`api/server/services/AuthService.js:721-726`) y el
  CORS de LibreChat no admite credenciales. Dos dominios ⇒ el estudiante pierde la sesión
  cada 15 minutos.
- **Ninguna app guarda contraseñas ni comparte tokens con la otra.** Cada una pide el suyo
  a `POST /api/auth/refresh`; el navegador aporta la cookie. Verificado en spec §4.0.
- **LibreChat no sirve interfaz**, pero necesita `client/dist/index.html` para arrancar:
  basta un HTML mínimo.
- El token de acceso vive en memoria, nunca en `localStorage`.

---

### Tarea 1: Un dominio para las tres cosas

**Archivos:**
- Crear: `tutor/proxy/nginx.conf`
- Modificar: `tutor/docker-compose.yml` (añadir el servicio `proxy`)

**Interfaces:**
- Produce: `/` → gestor de notas, `/tutor` → interfaz de tutoría, `/api/*` → LibreChat.
- Consume: el servicio `api` del primer incremento.

- [ ] **Paso 1: Escribir la configuración del proxy**

```nginx
# tutor/proxy/nginx.conf
server {
  listen 80;
  server_name _;

  location /api/ {
    proxy_pass http://api:3080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # El chat es SSE: sin esto la respuesta del tutor llega toda junta al final.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
  }

  location /tutor/ {
    alias /srv/tutoria/;
    try_files $uri $uri/ /tutor/index.html;
  }

  location / {
    root /srv/notas;
    try_files $uri $uri/ /index.html;
  }
}
```

`proxy_buffering off` es el detalle que más se olvida: con el buffering por defecto, nginx
retiene los eventos del stream y el estudiante ve la respuesta aparecer de golpe.

- [ ] **Paso 2: Añadir el servicio al compose**

```yaml
  proxy:
    image: nginx:1.27-alpine
    container_name: tutor-proxy
    ports:
      - 8080:80
    depends_on:
      - api
    volumes:
      - ./proxy/nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./notas/dist:/srv/notas:ro
      - ./tutoria/dist:/srv/tutoria:ro
```

- [ ] **Paso 3: Verificar las tres rutas**

Ejecutar:
```bash
curl -s -o /dev/null -w "api    %{http_code}\n" http://localhost:8080/api/config
curl -s -o /dev/null -w "notas  %{http_code}\n" http://localhost:8080/
curl -s -o /dev/null -w "tutor  %{http_code}\n" http://localhost:8080/tutor/
```
Esperado: `200` en las tres.

- [ ] **Paso 4: Commit**

```bash
git add tutor/proxy tutor/docker-compose.yml
git commit -m "feat: un dominio para gestor, tutoría y API"
```

---

### Tarea 2: Sesión compartida, probada antes de construir encima

**Archivos:**
- Crear: `tutor/tutoria/src/sesion.ts`
- Crear: `tutor/tutoria/src/sesion.test.ts`

**Interfaces:**
- Produce: `getToken(): Promise<string>` — devuelve un token de acceso válido, pidiéndolo
  a `/api/auth/refresh` y renovándolo antes de que expire.
- Consume: la cookie del dominio, puesta por el gestor de notas al iniciar sesión.

- [ ] **Paso 1: Escribir el test que falla**

```ts
// tutor/tutoria/src/sesion.test.ts
import { describe, expect, it, vi } from 'vitest';
import { crearSesion } from './sesion';

describe('sesion', () => {
  it('pide el token a /api/auth/refresh sin credenciales', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'abc', user: { email: 'a@b.cl' } }),
    });
    const sesion = crearSesion({ fetch: fetchSpy });

    const token = await sesion.getToken();

    expect(token).toBe('abc');
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/refresh', { method: 'POST' });
  });

  it('reutiliza el token en llamadas seguidas en vez de pedir uno nuevo', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'abc', user: { email: 'a@b.cl' } }),
    });
    const sesion = crearSesion({ fetch: fetchSpy });

    await sesion.getToken();
    await sesion.getToken();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Paso 2: Verlo fallar**

Ejecutar: `cd tutor/tutoria && npx vitest run src/sesion.test.ts`
Esperado: FALLA porque `./sesion` no existe.

- [ ] **Paso 3: Implementación mínima**

```ts
// tutor/tutoria/src/sesion.ts
interface Opciones {
  fetch?: typeof globalThis.fetch;
  /** Margen antes de la expiración real; la sesión de LibreChat dura 15 minutos. */
  margenMs?: number;
}

export function crearSesion({ fetch = globalThis.fetch, margenMs = 60_000 }: Opciones = {}) {
  let token: string | null = null;
  let expiraEn = 0;

  const pedirToken = async (): Promise<string> => {
    const res = await fetch('/api/auth/refresh', { method: 'POST' });
    const body = await res.json();
    if (!body?.token) {
      throw new Error('sin sesión: inicia sesión en el gestor de notas');
    }
    token = body.token;
    expiraEn = Date.now() + 15 * 60_000 - margenMs;
    return body.token;
  };

  return {
    async getToken(): Promise<string> {
      if (token && Date.now() < expiraEn) {
        return token;
      }
      return pedirToken();
    },
  };
}
```

- [ ] **Paso 4: Verlo pasar**

Ejecutar: `npx vitest run src/sesion.test.ts`
Esperado: 2 tests en verde.

- [ ] **Paso 5: Commit**

```bash
git add tutor/tutoria/src/sesion.ts tutor/tutoria/src/sesion.test.ts
git commit -m "feat: recuperar la sesión del dominio sin volver a autenticar"
```

---

### Tarea 3: La conversación con el tutor

**Archivos:**
- Crear: `tutor/tutoria/src/chat.ts` (iniciar generación y consumir el stream)
- Crear: `tutor/tutoria/src/chat.test.ts`
- Crear: `tutor/tutoria/src/App.tsx`

**Interfaces:**
- Consume: `crearSesion` de la Tarea 2; `EndpointURLs` y `EModelEndpoint` de
  `librechat-data-provider`.
- Produce: `enviar(texto, { onDelta, onFinal })`.

El contrato es el verificado en spec §2.3.3: `POST /api/agents/chat/:endpoint` devuelve
`{streamId, generationCreatedAt, generationProtocolVersion}`, y
`GET /api/agents/chat/stream/:streamId` entrega eventos `on_message_delta` y `final`.

- [ ] **Paso 1: Test del reductor de eventos (la parte con lógica)**

```ts
// tutor/tutoria/src/chat.test.ts
import { describe, expect, it } from 'vitest';
import { reducirEventos } from './chat';

describe('reducirEventos', () => {
  it('acumula los deltas en orden', () => {
    const estado = reducirEventos([
      { event: 'on_message_delta', data: { delta: { content: [{ text: 'Una ' }] } } },
      { event: 'on_message_delta', data: { delta: { content: [{ text: 'derivada' }] } } },
    ]);
    expect(estado.texto).toBe('Una derivada');
    expect(estado.terminado).toBe(false);
  });

  it('el evento final reemplaza el texto acumulado y cierra el turno', () => {
    const estado = reducirEventos([
      { event: 'on_message_delta', data: { delta: { content: [{ text: 'parcial' }] } } },
      { final: true, responseMessage: { content: [{ type: 'text', text: 'texto final' }] } },
    ]);
    expect(estado.texto).toBe('texto final');
    expect(estado.terminado).toBe(true);
  });
});
```

- [ ] **Paso 2: Verlo fallar**

Ejecutar: `npx vitest run src/chat.test.ts` → FALLA, `reducirEventos` no existe.

- [ ] **Paso 3: Implementar el reductor y el transporte**

`reducirEventos(eventos)` devuelve `{ texto, terminado }`; el transporte hace las dos
fases y llama al reductor por cada frame. El texto final se toma de
`responseMessage.content[]`, no de `text` (spec §2.3.4).

- [ ] **Paso 4: Verlo pasar y montar la pantalla**

`npx vitest run` en verde; `App.tsx` usa `crearSesion` + `enviar` y pinta los deltas.

- [ ] **Paso 5: Commit**

```bash
git add tutor/tutoria/src
git commit -m "feat: conversación con el tutor y streaming"
```

---

### Tarea 4: Ida y vuelta entre las dos apps

**Archivos:**
- Modificar: el panel lateral del gestor de notas (enlace a `/tutor/`)
- Modificar: `tutor/tutoria/src/App.tsx` (enlace de vuelta a `/`)

- [ ] **Paso 1: Enlazar en ambos sentidos**

Enlaces normales, no `window.open`: misma pestaña, mismo origen, la sesión viaja sola.

- [ ] **Paso 2: Probar el recorrido completo del estudiante**

Con un navegador: entrar a `/`, iniciar sesión, ir al tutor, preguntar, volver a las notas.
Verificar que en ningún punto se pide iniciar sesión otra vez.

- [ ] **Paso 3: Añadir el recorrido al guardián**

Extender el guardián del primer incremento con una comprobación de que
`POST /api/auth/refresh` devuelve token: si un upgrade rompe eso, se rompe la unión entre
las dos apps.

- [ ] **Paso 4: Commit**

```bash
git commit -am "feat: navegación entre notas y tutoría"
```

---

## Lo que este plan deliberadamente no cubre

- **marimo**: ya está resuelto en el gestor de notas. Si al servirlo tras el proxy con el
  CSP activo aparecieran errores de WASM o de workers, las banderas son `CSP_ALLOW_WASM` y
  `CSP_ALLOW_DATA_WORKERS`, y queda por comprobar si el notebook exige COOP/COEP (spec §4.0).
- **SSO institucional**: cambia el flujo de sesión; se planifica cuando esté decidido.
- **RAG del curso**: requiere `rag_api` y un curso piloto.
- **Historial y adjuntos** en la interfaz de tutoría: son `/api/convos` y `/api/files`,
  ya mapeados, pero no hacen falta para el primer estudiante.

## Autorrevisión

- **Cobertura del spec:** implementa §4.0 (topología y sesión compartida) y §4 capa 3.
- **Sin marcadores de relleno:** cada paso trae archivo, contenido y comando.
- **Ciclo rojo-verde:** las tareas 2 y 3 escriben el test y lo ven fallar antes de implementar.
- **Consistencia:** `crearSesion` se define en la Tarea 2 y se consume con ese nombre en la 3.
