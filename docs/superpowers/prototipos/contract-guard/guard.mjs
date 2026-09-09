#!/usr/bin/env node
// Guardián de contrato entre una interfaz propia y LibreChat.
//
// Para qué sirve: antes de promover una versión nueva de LibreChat a producción, esto
// ejerce el contrato completo que consume una interfaz propia y lo compara contra un
// snapshot conocido. Si el contrato cambió de forma, falla con el detalle exacto, y la
// actualización no se promueve.
//
// No depende de nada: solo fetch nativo de Node >= 18.
//
//   node guard.mjs                       # verifica contra contract-snapshot.json
//   node guard.mjs --update-snapshot     # regraba el snapshot (tras revisarlo a mano)
//
// Variables: BASE_URL, GUARD_EMAIL, GUARD_PASSWORD, GUARD_ENDPOINT, GUARD_MODEL

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3080';
const EMAIL = process.env.GUARD_EMAIL ?? 'guard@example.com';
const PASSWORD = process.env.GUARD_PASSWORD ?? 'Guard-Passw0rd!';
const ENDPOINT = process.env.GUARD_ENDPOINT ?? 'MockTutor';
const MODEL = process.env.GUARD_MODEL ?? 'mock-tutor';
const SNAPSHOT = new URL('./contract-snapshot.json', import.meta.url);
const UPDATE = process.argv.includes('--update-snapshot');

// LibreChat rechaza clientes cuyo User-Agent no parezca un navegador
// (api/server/middleware/uaParser.js). Un guardián en CI no es un navegador, así que
// declara uno: sin esto, todo responde "Illegal request".
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const NULL_PARENT = '00000000-0000-0000-0000-000000000000';

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  PASA' : '  FALLA'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const headers = (token) => ({
  'Content-Type': 'application/json',
  'User-Agent': UA,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

/** Forma observada del contrato: es lo que se compara entre versiones. */
const observed = {
  librechatVersion: null,
  authLoginKeys: null,
  chatStartKeys: null,
  generationProtocolVersion: null,
  generationProtocolHeader: null,
  streamContentType: null,
  streamEventTypes: null,
  assistantMessageShape: null,
  routes: {},
};

const main = async () => {
  console.log(`Guardián de contrato — ${BASE}\n`);

  // 1. Config pública: existe y trae la versión del build
  {
    const res = await fetch(`${BASE}/api/config`, { headers: headers() });
    const body = await res.json();
    observed.routes['GET /api/config'] = res.status;
    observed.librechatVersion =
      body?.buildInfo?.version ??
      body?.buildInfo?.commitShort ??
      body?.version ??
      'desconocida';
    record('GET /api/config responde 200', res.status === 200, `status ${res.status}`);
  }

  // 2. Registro (idempotente: si ya existe, seguimos con login)
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name: 'Contract Guard',
      username: 'contractguard',
      email: EMAIL,
      password: PASSWORD,
      confirm_password: PASSWORD,
    }),
  }).catch(() => {});

  // 3. Login: devuelve un JWT utilizable como Bearer
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const loginBody = await login.json();
  const token = loginBody.token;
  observed.routes['POST /api/auth/login'] = login.status;
  observed.authLoginKeys = Object.keys(loginBody).sort();
  record('POST /api/auth/login devuelve token', Boolean(token), `claves: ${observed.authLoginKeys.join(',')}`);
  if (!token) return finish();

  // 4. El endpoint de modelo que usa la interfaz sigue existiendo
  {
    const res = await fetch(`${BASE}/api/endpoints`, { headers: headers(token) });
    const body = await res.json();
    observed.routes['GET /api/endpoints'] = res.status;
    record(`GET /api/endpoints incluye "${ENDPOINT}"`, ENDPOINT in body, `disponibles: ${Object.keys(body).join(',')}`);
  }

  // 5. Inicio de generación: forma de la respuesta y versión del protocolo
  const conversationId = randomUUID();
  const start = await fetch(`${BASE}/api/agents/chat/${encodeURIComponent(ENDPOINT)}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      text: 'Ping de contrato.',
      sender: 'User',
      isCreatedByUser: true,
      parentMessageId: NULL_PARENT,
      conversationId,
      messageId: randomUUID(),
      error: false,
      generation: '',
      endpoint: ENDPOINT,
      endpointType: 'custom',
      model: MODEL,
      ephemeralAgent: { execute_code: false, web_search: false, file_search: false, mcp: [] },
      isContinued: false,
      isRegenerate: false,
      isTemporary: false,
    }),
  });
  const started = await start.json();
  observed.routes['POST /api/agents/chat/:endpoint'] = start.status;
  observed.chatStartKeys = Object.keys(started).sort();
  observed.generationProtocolVersion = started.generationProtocolVersion ?? null;
  observed.generationProtocolHeader = start.headers.get('x-librechat-generation-protocol');
  record('POST de chat devuelve streamId', Boolean(started.streamId), `claves: ${observed.chatStartKeys.join(',')}`);
  record(
    'la versión del protocolo de generación es la esperada',
    started.generationProtocolVersion != null,
    `protocolo ${started.generationProtocolVersion} (header ${observed.generationProtocolHeader})`,
  );
  if (!started.streamId) return finish();

  // 6. Stream SSE: tipo de contenido y repertorio de eventos
  const streamUrl =
    `${BASE}/api/agents/chat/stream/${encodeURIComponent(started.streamId)}` +
    `?generationCreatedAt=${started.generationCreatedAt}` +
    `&generationProtocolVersion=${started.generationProtocolVersion}`;
  const stream = await fetch(streamUrl, { headers: { ...headers(token), Accept: 'text/event-stream' } });
  observed.routes['GET /api/agents/chat/stream/:id'] = stream.status;
  observed.streamContentType = (stream.headers.get('content-type') ?? '').split(';')[0];
  record('el stream responde text/event-stream', observed.streamContentType === 'text/event-stream', observed.streamContentType);

  const kinds = new Set();
  {
    const reader = stream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { kinds.add('[DONE]'); continue; }
        try {
          const ev = JSON.parse(data);
          kinds.add(ev.event ?? (ev.final ? 'final' : ev.created ? 'created' : Object.keys(ev)[0]));
        } catch { kinds.add('no-json'); }
      }
    }
  }
  observed.streamEventTypes = [...kinds].sort();
  record('el stream emite deltas y un evento final',
    kinds.has('on_message_delta') && kinds.has('final'),
    observed.streamEventTypes.join(','));

  // 7. Persistencia: el turno quedó guardado y la respuesta viene en partes de contenido
  {
    const res = await fetch(`${BASE}/api/messages/${conversationId}`, { headers: headers(token) });
    const msgs = await res.json();
    observed.routes['GET /api/messages/:conversationId'] = res.status;
    const assistant = Array.isArray(msgs) ? msgs.find((m) => !m.isCreatedByUser) : null;
    observed.assistantMessageShape = assistant
      ? { hasContentArray: Array.isArray(assistant.content), firstPartType: assistant.content?.[0]?.type ?? null }
      : null;
    record('el turno queda persistido y recuperable',
      Array.isArray(msgs) && msgs.length >= 2,
      `mensajes: ${Array.isArray(msgs) ? msgs.length : typeof msgs}`);
    record('la respuesta del asistente viene en content[]',
      observed.assistantMessageShape?.hasContentArray === true,
      `primera parte: ${observed.assistantMessageShape?.firstPartType}`);
  }

  // 8. Listado de conversaciones
  {
    const res = await fetch(`${BASE}/api/convos?pageNumber=1`, { headers: headers(token) });
    observed.routes['GET /api/convos'] = res.status;
    record('GET /api/convos responde 200', res.status === 200, `status ${res.status}`);
  }

  finish();
};

const diffContract = (before, now) => {
  const diffs = [];
  const walk = (a, b, path) => {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const k of keys) {
      const av = a?.[k];
      const bv = b?.[k];
      const p = path ? `${path}.${k}` : k;
      if (av && typeof av === 'object' && !Array.isArray(av)) { walk(av, bv, p); continue; }
      const as = JSON.stringify(av);
      const bs = JSON.stringify(bv);
      if (as !== bs) diffs.push(`${p}: ${as} → ${bs}`);
    }
  };
  walk(before, now, '');
  return diffs;
};

const finish = () => {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nLibreChat: ${observed.librechatVersion}`);
  console.log(`Verificaciones: ${checks.length - failed.length}/${checks.length} pasan`);

  if (UPDATE) {
    writeFileSync(SNAPSHOT, JSON.stringify(observed, null, 2) + '\n');
    console.log(`\nSnapshot regrabado en ${SNAPSHOT.pathname}`);
    process.exit(failed.length ? 1 : 0);
  }

  if (!existsSync(SNAPSHOT)) {
    console.log('\nNo hay snapshot previo. Ejecuta --update-snapshot para crear la línea base.');
    process.exit(failed.length ? 1 : 0);
  }

  // La versión de LibreChat cambia a propósito en cada upgrade: no es una ruptura.
  const previous = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const { librechatVersion: _a, ...prevRest } = previous;
  const { librechatVersion: _b, ...nowRest } = observed;
  const diffs = diffContract(prevRest, nowRest);

  if (diffs.length) {
    console.log(`\nEL CONTRATO CAMBIÓ respecto del snapshot (${previous.librechatVersion} → ${observed.librechatVersion}):`);
    for (const d of diffs) console.log(`  · ${d}`);
    console.log('\nRevisa si la interfaz propia necesita ajustes. Si el cambio es aceptable,');
    console.log('regraba el snapshot con --update-snapshot.');
  } else {
    console.log('Contrato idéntico al snapshot.');
  }

  process.exit(failed.length || diffs.length ? 1 : 0);
};

await main();
