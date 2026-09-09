# Guardián de contrato — prototipo verificado

Pieza central de la estrategia descrita en
`docs/superpowers/specs/2026-09-09-frontend-tutorias-librechat-design.md`.

Una interfaz propia sobrevive a las actualizaciones de LibreChat si se acopla al
contrato HTTP (que crece de forma aditiva) en vez de al código del cliente (que se
reescribe cada release). Pero "aditivo" es una tendencia histórica, no una garantía. Este
guardián convierte esa tendencia en una verificación ejecutable: ejerce el contrato
completo contra una instancia de LibreChat, lo compara con un snapshot conocido, y falla
si algo cambió de forma.

En una tubería de despliegue, esto corre contra la versión nueva **antes** de promoverla.
Si el contrato cambió, la actualización no llega a los estudiantes.

## Qué verifica

| Verificación | Qué protege |
|---|---|
| `GET /api/config` responde 200 | El arranque y la configuración pública |
| `POST /api/auth/login` devuelve token | El flujo de autenticación de la SPA |
| `GET /api/endpoints` incluye el endpoint del tutor | Que el modelo configurado siga expuesto |
| El POST de chat devuelve `streamId` | La fase 1 del protocolo de generación |
| La versión del protocolo es la esperada | **La señal más importante**: LibreChat versiona su protocolo de generación; un cambio aquí es una ruptura anunciada |
| El stream responde `text/event-stream` | La fase 2, el canal de streaming |
| El stream emite deltas y evento final | El repertorio de eventos que consume la interfaz |
| El turno queda persistido | Que el historial se guarde y se pueda releer |
| La respuesta viene en `content[]` | La forma de los mensajes del asistente |
| `GET /api/convos` responde 200 | El listado de conversaciones |

Además del PASA/FALLA, compara el **contrato observado** contra `contract-snapshot.json`
y reporta cada diferencia campo por campo.

## Uso

```bash
# Línea base contra la versión que hoy funciona (revisa el JSON antes de commitearlo)
node guard.mjs --update-snapshot

# Verificación antes de promover una versión nueva
BASE_URL=https://tutor.example.cl node guard.mjs   # exit 1 si algo cambió
```

Variables: `BASE_URL`, `GUARD_EMAIL`, `GUARD_PASSWORD`, `GUARD_ENDPOINT`, `GUARD_MODEL`.

No tiene dependencias: solo `fetch` nativo (Node ≥ 18).

## Estado de verificación

Ejecutado contra LibreChat `968950a` (v0.8.8-rc2) levantado localmente con MongoDB
efímero y un endpoint custom apuntando a un servidor mock compatible con OpenAI:

- **10/10 verificaciones pasan**, exit 0.
- Con un snapshot alterado a mano para simular tres rupturas plausibles —protocolo de
  generación 1 → 0, renombre de `on_message_delta` a `on_text_delta`, y renombre del
  campo `token` a `accessToken`— el guardián **detecta las tres** y sale con exit 1.

Es decir: se lo vio fallar antes de confiar en que pasa.

## Límites conocidos

- No cubre subida de archivos, RAG, agentes persistidos, memoria ni permisos. Cada uno
  merece su propia verificación cuando la interfaz empiece a usarlos.
- Registra un usuario de prueba: apúntalo a un entorno de ensayo, nunca a producción con
  datos reales.
- El User-Agent va falseado a propósito: `api/server/middleware/uaParser.js` rechaza a
  cualquier cliente que no parezca un navegador. Es una restricción real de LibreChat,
  no un atajo del prototipo.
