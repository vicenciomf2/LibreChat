# Tutor sobre LibreChat — Plan del primer incremento

> **Para agentes ejecutores:** SUB-SKILL REQUERIDA: usar
> `superpowers:subagent-driven-development` (recomendado) o
> `superpowers:executing-plans` para implementar este plan tarea por tarea. Los pasos
> usan casillas (`- [ ]`) para seguimiento.

> **Estado: propuesta, no aprobada.** El diseño del que deriva
> (`docs/superpowers/specs/2026-09-09-frontend-tutorias-librechat-design.md`) todavía no
> ha sido revisado por su autor humano. No ejecutar sin esa aprobación.

**Objetivo:** dejar a un estudiante real conversando con un tutor configurado sobre
LibreChat vanilla, con una verificación automática que impide promover una actualización
que rompa el contrato.

**Arquitectura:** LibreChat se despliega vanilla desde la imagen oficial anclada a un tag
estable, en un repositorio propio que contiene únicamente configuración (compose, `.env`,
`librechat.yaml`, material del curso) y el guardián de contrato. No se toca ningún archivo
del árbol de LibreChat. La pedagogía vive en un agente configurado, no en código.

**Stack:** Docker Compose, imagen `ghcr.io/danny-avila/librechat`, MongoDB,
RAG API oficial, Node ≥ 18 para el guardián (sin dependencias).

**Spec:** `docs/superpowers/specs/2026-09-09-frontend-tutorias-librechat-design.md`

## Restricciones globales

Cada tarea las hereda:

- **Ningún archivo del árbol de LibreChat se modifica.** Si una tarea parece exigirlo, es
  señal de que la tarea está mal planteada: detenerse y decirlo.
- **La imagen se ancla a un tag estable**, nunca a `latest`. Verificado contra el registro
  el 2026-09-09: `ghcr.io/danny-avila/librechat` publica hasta **`v0.8.7`** como estable;
  `v0.8.8` todavía es `-rc2` y no tiene imagen estable. El repositorio de trabajo está en
  `v0.8.8-rc2` (`968950a`), por delante de la última imagen publicada.
  Los `docker-compose` del repositorio apuntan a `registry.librechat.ai/danny-avila/…`,
  que es un espejo; el origen que publica CI es `ghcr.io` y Docker Hub
  (`.github/workflows/docker-publish.yml:118`).
- **La SPA propia no entra en este incremento.** Requiere decisiones abiertas del spec §8.
- Todo secreto vive en `.env`, nunca en el repositorio.
- El guardián apunta siempre a un entorno de ensayo, nunca a producción con datos reales.

---

### Tarea 1: Repositorio de despliegue con LibreChat anclado

**Archivos:**
- Crear: `tutor/docker-compose.yml`
- Crear: `tutor/.env.example`
- Crear: `tutor/.gitignore`
- Crear: `tutor/README.md`

**Interfaces:**
- Produce: un servicio `api` escuchando en `3080`, con `librechat.yaml` montado en
  `/app/librechat.yaml` y `client/dist` disponible como punto de montaje futuro.
- Consume: nada de tareas anteriores.

- [ ] **Paso 1: Crear la estructura y el compose anclado**

```yaml
# tutor/docker-compose.yml
services:
  api:
    image: ghcr.io/danny-avila/librechat:v0.8.7
    container_name: tutor-api
    ports:
      - 3080:3080
    depends_on:
      - mongodb
    restart: always
    env_file:
      - .env
    environment:
      - HOST=0.0.0.0
      - NODE_ENV=production
      - MONGO_URI=mongodb://mongodb:27017/LibreChat
      - CONFIG_PATH=/app/librechat.yaml
    volumes:
      - type: bind
        source: ./librechat.yaml
        target: /app/librechat.yaml
      - ./material:/app/material:ro
      - ./logs:/app/api/logs

  mongodb:
    image: mongo:8
    container_name: tutor-mongo
    restart: always
    volumes:
      - mongo-data:/data/db
    command: mongod --noauth

volumes:
  mongo-data:
```

- [ ] **Paso 2: Escribir `.env.example` con lo mínimo obligatorio**

```bash
# tutor/.env.example
HOST=0.0.0.0
PORT=3080
MONGO_URI=mongodb://mongodb:27017/LibreChat

# Generar con: openssl rand -hex 32 / openssl rand -hex 16
CREDS_KEY=
CREDS_IV=
JWT_SECRET=
JWT_REFRESH_SECRET=

ALLOW_REGISTRATION=true
ALLOW_EMAIL_LOGIN=true
SEARCH=false

# Clave del proveedor de modelo que use el tutor
TUTOR_API_KEY=
```

- [ ] **Paso 3: Ignorar secretos y datos**

```gitignore
# tutor/.gitignore
.env
logs/
material/*.pdf
```

- [ ] **Paso 4: Levantar y verificar que responde**

Ejecutar: `cd tutor && cp .env.example .env && (rellenar claves) && docker compose up -d`
Luego: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3080/api/config`
Esperado: `200`

- [ ] **Paso 5: Commit**

```bash
git add tutor/docker-compose.yml tutor/.env.example tutor/.gitignore tutor/README.md
git commit -m "feat: despliegue de LibreChat anclado a v0.8.7"
```

---

### Tarea 2: Guardián de contrato en integración continua

**Archivos:**
- Crear: `tutor/guard/guard.mjs` (copiar desde `docs/superpowers/prototipos/contract-guard/guard.mjs`)
- Crear: `tutor/guard/contract-snapshot.json`
- Crear: `.github/workflows/contract-guard.yml`

**Interfaces:**
- Consume: el servicio `api` de la Tarea 1.
- Produce: exit 0 si el contrato coincide con el snapshot; exit 1 si cambió o si alguna
  verificación falla.

- [ ] **Paso 1: Ver el guardián fallar sin línea base**

Ejecutar: `node tutor/guard/guard.mjs`
Esperado: informa que no hay snapshot previo y pide crearlo. Este paso existe para
comprobar que el guardián corre antes de confiar en su veredicto.

- [ ] **Paso 2: Grabar la línea base contra la versión anclada**

Ejecutar: `node tutor/guard/guard.mjs --update-snapshot`
Esperado: 10/10 verificaciones pasan y se escribe `contract-snapshot.json`.
Revisar el JSON a mano antes de commitearlo: es el contrato que se promete sostener.

- [ ] **Paso 3: Ver el guardián detectar una ruptura (rojo)**

Alterar a mano una entrada del snapshot, por ejemplo `generationProtocolVersion` a `0`,
y ejecutar `node tutor/guard/guard.mjs`.
Esperado: reporta `generationProtocolVersion: 0 → 1` y sale con código 1.
Restaurar el snapshot después. **Sin ver este paso fallar, el guardián no sirve de nada.**

- [ ] **Paso 4: Cablearlo a CI**

```yaml
# .github/workflows/contract-guard.yml
name: Guardián de contrato
on:
  workflow_dispatch:
  pull_request:
    paths:
      - 'tutor/docker-compose.yml'
      - 'tutor/guard/**'

jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Levantar el entorno
        working-directory: tutor
        run: |
          cp .env.example .env
          sed -i "s|^CREDS_KEY=.*|CREDS_KEY=$(openssl rand -hex 32)|" .env
          sed -i "s|^CREDS_IV=.*|CREDS_IV=$(openssl rand -hex 16)|" .env
          sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
          sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -hex 32)|" .env
          docker compose up -d
          until curl -s -o /dev/null http://localhost:3080/api/config; do sleep 3; done
      - name: Verificar el contrato
        run: node tutor/guard/guard.mjs
```

- [ ] **Paso 5: Commit**

```bash
git add tutor/guard .github/workflows/contract-guard.yml
git commit -m "test: guardián de contrato contra la versión anclada"
```

---

### Tarea 3: El tutor, como configuración

**Archivos:**
- Crear: `tutor/librechat.yaml`
- Crear: `tutor/material/README.md`

**Interfaces:**
- Consume: `TUTOR_API_KEY` del `.env` de la Tarea 1.
- Produce: un endpoint de modelo llamado `Tutor` visible en `GET /api/endpoints`, y la
  interfaz marcada con el nombre y el mensaje de bienvenida del curso.

- [ ] **Paso 1: Escribir la configuración con la marca y el endpoint del tutor**

```yaml
# tutor/librechat.yaml
version: 1.2.8
cache: true

interface:
  customWelcome: 'Bienvenido. Soy tu tutor del curso. Preguntame lo que no entendiste.'
  modelSelect: false
  parameters: false
  presets: false
  bookmarks: true
  multiConvo: false
  agents:
    use: true
    create: false

endpoints:
  custom:
    - name: 'Tutor'
      apiKey: '${TUTOR_API_KEY}'
      baseURL: 'https://api.openai.com/v1'
      models:
        default: ['gpt-4o-mini']
        fetch: false
      titleConvo: true
      titleModel: 'gpt-4o-mini'
      modelDisplayLabel: 'Tutor'
```

`modelSelect: false` y `create: false` son deliberados: el estudiante no elige modelo ni
crea agentes; entra y conversa con el tutor del curso.

- [ ] **Paso 2: Verificar que el endpoint aparece**

Ejecutar: `docker compose restart api && curl -s http://localhost:3080/api/endpoints -H "Authorization: Bearer $TOKEN"`
Esperado: la respuesta incluye la clave `Tutor`.

- [ ] **Paso 3: Ajustar el guardián al endpoint real**

Ejecutar: `GUARD_ENDPOINT=Tutor GUARD_MODEL=gpt-4o-mini node tutor/guard/guard.mjs --update-snapshot`
Esperado: 10/10 pasan contra el endpoint real, no contra el mock.

- [ ] **Paso 4: Commit**

```bash
git add tutor/librechat.yaml tutor/material/README.md
git commit -m "feat: configuración del tutor y marca del curso"
```

---

## Lo que este plan deliberadamente no cubre

- **La interfaz propia (SPA).** Depende de las decisiones abiertas del spec §8, en
  particular de cuánto debe diferir realmente la experiencia. Tendrá su propio plan.
- **Autenticación institucional (OIDC/Entra).** Depende de si la universidad la habilita;
  cambia la configuración de usuarios y de cohortes.
- **RAG sobre el material del curso.** Requiere el servicio `rag_api` y decisiones sobre
  dónde viven los documentos; se planifica cuando exista un curso piloto concreto.
- **Panel docente.** LibreChat ya trae `/api/insights` con permisos por grupo; hay que
  evaluarlo con un docente real antes de construir nada propio.

## Autorrevisión del plan

- **Cobertura del spec:** cubre §4 capas 1 y 2, y §4.1 (contrato de actualización).
  No cubre §4 capas 3 y 4, declarado arriba de forma explícita.
- **Sin marcadores de relleno:** cada paso tiene el archivo, el contenido y el comando.
- **Consistencia de nombres:** el endpoint se llama `Tutor` en `librechat.yaml`, en
  `GUARD_ENDPOINT` y en la verificación de la Tarea 3.
- **Ciclo rojo-verde:** la Tarea 2 incluye el paso de ver fallar al guardián antes de
  confiar en él.
