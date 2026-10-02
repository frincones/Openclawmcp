/*
 * Puente MCP  ->  OpenClaw  (control 100%)
 *
 * Expone un servidor MCP (Streamable HTTP) que la Claude app consume como
 * "custom connector". Le da a Claude control TOTAL de OpenClaw:
 *
 *   - Tools de conveniencia para lo comun (ordenar al agente, ver estado).
 *   - Una tool UNIVERSAL (openclaw_api) que llama CUALQUIER endpoint de la API
 *     REST de OpenClaw (~130 rutas): agentes, conectores (WhatsApp, etc.),
 *     MCP servers, schedules/cron, memoria, tareas, credenciales, skills...
 *     Con esto Claude puede administrar el 100% de OpenClaw.
 *
 * Flujo:  Claude app  --MCP-->  este puente  --HTTP/A2A-->  OpenClaw  --> negocio
 *
 * Auth hacia OpenClaw:
 *   - A2A:  Bearer OPENCLAW_ACCESS_KEY
 *   - REST del dashboard:  cookie  sc_auth=<OPENCLAW_ACCESS_KEY>
 */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const OPENCLAW_URL = (process.env.OPENCLAW_URL || '').replace(/\/+$/, '');
const OPENCLAW_KEY = process.env.OPENCLAW_ACCESS_KEY || '';
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT_ID || 'default';
const PORT = process.env.PORT || 8080;

// El Cuartel: centro de mando personal de pendientes (backlog + panel).
// Las tools cuartel_* empujan al backlog crudo; Freddy clasifica en el panel.
const CUARTEL_URL = (process.env.CUARTEL_URL || '').replace(/\/+$/, '');
const CUARTEL_TOKEN = process.env.CUARTEL_TOKEN || '';

// Composio: agregador de integraciones (OAuth de 1 clic para 1000+ apps).
// La API key por defecto es de TDX; en produccion cada alumno puede poner la suya.
const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY || '';
const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3';
// URL publica de ESTE puente (para armar los links del QR). Railway la inyecta.
const SELF_URL = (process.env.PUBLIC_URL || `https://mcp-bridge-production-5313.up.railway.app`).replace(/\/+$/, '');

// ---- fetch con timeout duro (para que NADA cuelgue y pegue a Claude) --------

async function fetchT(url, opt = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opt, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---- helpers hacia Composio -------------------------------------------------

async function composio(method, path, body, apiKey = COMPOSIO_KEY) {
  const r = await fetchT(`${COMPOSIO_BASE}${path}`, {
    method,
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, ok: r.ok, data };
}

// Asegura que exista un auth_config para un toolkit (Gmail, Calendar, etc.).
// Reusa uno si ya existe; si no, lo crea con la auth gestionada de Composio.
async function ensureAuthConfig(toolkitSlug, apiKey = COMPOSIO_KEY) {
  // buscar existente
  const list = await composio('GET', `/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=1`, undefined, apiKey);
  const items = (list.data && (list.data.items || list.data.auth_configs)) || [];
  if (items.length && items[0].id) return items[0].id;
  // crear
  const created = await composio('POST', '/auth_configs', {
    toolkit: { slug: toolkitSlug },
    auth_config: { type: 'use_composio_managed_auth' },
  }, apiKey);
  return created.data?.auth_config?.id || null;
}

// ---- helpers hacia OpenClaw -------------------------------------------------

// Llama la API REST del dashboard de OpenClaw (autentica con cookie sc_auth).
async function rest(method, path, body) {
  const url = `${OPENCLAW_URL}${path.startsWith('/') ? path : '/' + path}`;
  const headers = {
    'Cookie': `sc_auth=${OPENCLAW_KEY}`,
    'Authorization': `Bearer ${OPENCLAW_KEY}`,
    'Content-Type': 'application/json',
  };
  const opt = { method, headers };
  if (body !== undefined && method !== 'GET') opt.body = typeof body === 'string' ? body : JSON.stringify(body);
  const r = await fetchT(url, opt, 15000);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, ok: r.ok, data };
}

// Consulta el estado/resultado de una tarea, esperando un poco si aun corre.
// timeout corto por defecto (8s) para no pegar a Claude.
async function esperarTarea(boardId, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  let intervalo = 2000;
  let ultimo = 'submitted';
  while (Date.now() - t0 < timeoutMs) {
    const st = await fetchT(`${OPENCLAW_URL}/api/a2a/tasks/${boardId}/status`, {
      headers: { 'Authorization': `Bearer ${OPENCLAW_KEY}` },
    }, 10000).then((x) => x.json()).catch(() => ({}));
    ultimo = st.status || ultimo;
    if (['completed', 'done', 'failed', 'error'].includes(String(st.status || '').toLowerCase())) {
      return { taskId: boardId, status: st.status, result: st.result, error: st.error, listo: true };
    }
    await new Promise((r) => setTimeout(r, intervalo));
    if (intervalo < 4000) intervalo += 500;
  }
  return { taskId: boardId, status: ultimo, listo: false };
}

// Envia una orden al agente (A2A executeTask).
// esperar:true  -> espera hasta ~timeoutMs; si no termina, devuelve listo:false + taskId
// esperar:false -> devuelve el taskId de inmediato (para tareas largas)
// timeoutMs bajo (8s) para NO pegar a Claude: si no termina, devuelve taskId y Claude sigue consultando.
async function ordenar(orden, { esperar = true, timeoutMs = 8000, agentId = OPENCLAW_AGENT } = {}) {
  // IMPORTANTE: fetchT (timeout duro 12s) y NO fetch pelado. Sin timeout, si OpenClaw
  // tarda en aceptar la orden, este fetch colgaba para siempre y la tool nunca devolvia
  // -> la app se quedaba en "responding in the background" eternamente.
  let r;
  try {
    r = await fetchT(`${OPENCLAW_URL}/api/a2a`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENCLAW_KEY}`,
        'Content-Type': 'application/json',
        'x-a2a-target-agent-id': agentId,
      },
      // OpenClaw lee el contenido en `message` (NO en `task`); `taskName` es el titulo.
      // "just answer" hace que trate la tarea como respuesta directa y no rechace cortas.
      body: JSON.stringify({
        jsonrpc: '2.0', id: Date.now(), method: 'executeTask',
        params: { agentId, taskName: 'Orden desde Claude (just answer)', message: orden },
      }),
    }, 12000);
  } catch (e) {
    // OpenClaw no acepto la orden a tiempo: devolvemos sin colgar.
    return { taskId: null, status: 'sin_respuesta', listo: false, error: `OpenClaw no respondio a tiempo (${e.message}).` };
  }
  let j; try { j = await r.json(); } catch { j = {}; }
  if (j.error) throw new Error(j.error.message || 'error A2A');
  const boardId = j.result?.boardTaskId || j.result?.taskId;
  if (!boardId) return { taskId: null, status: 'sin_task', listo: false, error: 'OpenClaw no devolvio un taskId.' };
  if (!esperar) return { taskId: boardId, status: j.result.status || 'submitted', async: true, listo: false };
  return esperarTarea(boardId, { timeoutMs });
}

// ============================================================================
//  WIZARD DE CONFIGURACION  (el dueño monta sus agentes paso a paso desde Claude)
// ============================================================================
//
//  Idea de arquitecto: el wizard NO es una UI aparte. Es Claude siguiendo un
//  guion (WIZARD.md) apoyado en estas tools. El estado (la "ficha del negocio")
//  se guarda como un document en OpenClaw -> el dueño puede parar y retomar.
//
//  El truco que hace que quede "100% configurado" y no generico: la ficha del
//  negocio (nombre, horarios, precios, reglas, tono) se INYECTA al final del
//  systemPrompt de cada agente como un bloque "## Datos de este negocio". Asi el
//  template sigue atado al proceso (sin marcas) pero el agente responde con los
//  datos REALES del dueño.

const MARKETPLACE_URL = (process.env.MARKETPLACE_URL || 'https://tdx-marketplace-production.up.railway.app').replace(/\/+$/, '');

// Marcador para inyectar/reemplazar el bloque de datos sin duplicar en cada re-montaje.
const MARCA_INI = '\n\n<!-- TDX_DATOS_NEGOCIO_INI -->';
const MARCA_FIN = '<!-- TDX_DATOS_NEGOCIO_FIN -->';

// Los pasos del wizard, en orden. Claude sabe donde va el dueño mirando la ficha.
const PASOS_WIZARD = ['equipo', 'datos', 'montado', 'conectado', 'probado'];

// Clave del document que guarda la ficha de un negocio/usuario.
function fichaKey(usuario) { return `wizard_ficha_${usuario || 'tdx_demo'}`; }

// Lee la ficha del negocio desde los documents de OpenClaw. Devuelve {ficha, docId} o {ficha:null}.
async function leerFicha(usuario) {
  const r = await rest('GET', '/api/documents');
  const docs = r.data || {};
  const key = fichaKey(usuario);
  for (const [id, d] of Object.entries(docs)) {
    if (d && d.title === key) {
      let ficha; try { ficha = JSON.parse(d.content || '{}'); } catch { ficha = {}; }
      return { ficha, docId: id };
    }
  }
  return { ficha: null, docId: null };
}

// Guarda (crea o actualiza) la ficha del negocio.
async function guardarFicha(usuario, ficha) {
  const { docId } = await leerFicha(usuario);
  const content = JSON.stringify(ficha);
  if (docId) {
    await rest('PUT', `/api/documents/${docId}`, { content });
    return docId;
  }
  const r = await rest('POST', '/api/documents', { title: fichaKey(usuario), content, tags: ['wizard'] });
  return r.data?.id || null;
}

// Ficha vacia por defecto (la estructura de datos que el wizard va llenando).
function fichaVacia(usuario) {
  return {
    usuario: usuario || 'tdx_demo',
    paso: 'equipo',              // en que paso del wizard va
    equipo: null,               // id del equipo por nicho elegido (ej "equipo/barberia")
    negocio: {
      nombre: null,             // como se llama el negocio (el agente lo usa al hablar)
      que_hace: null,           // en una frase, a que se dedica
      horarios: null,           // texto libre: "Lun-Vie 9am-7pm, Sab 9am-2pm"
      servicios_precios: null,  // texto libre: "Corte 20k, barba 15k, tinte desde 60k"
      canales: null,            // por donde atiende: "WhatsApp 300..., Instagram @..."
      reglas: null,             // que si/que no: "no da precios de tratamientos medicos, agenda solo con 2h de anticipacion"
      tono: null,               // como habla: "cercano y breve, tuteando"
      extra: null,              // cualquier dato adicional que el dueño quiera
    },
    agentes: [],                // [{id, nombre, proceso, rol}] tras montar el equipo
    conexiones: [],             // ['whatsapp:cid', 'googlecalendar:...'] tras conectar
    creado: Date.now(),
  };
}

// Construye el bloque de datos del negocio que se inyecta en cada agente.
function bloqueDatos(ficha) {
  const n = (ficha && ficha.negocio) || {};
  const linea = (etq, val) => (val ? `- ${etq}: ${val}` : null);
  const filas = [
    linea('Negocio', n.nombre),
    linea('A que se dedica', n.que_hace),
    linea('Horarios de atencion', n.horarios),
    linea('Servicios y precios', n.servicios_precios),
    linea('Canales de contacto', n.canales),
    linea('Reglas (que si y que no puedes hacer)', n.reglas),
    linea('Tono al hablar', n.tono),
    linea('Otros datos', n.extra),
  ].filter(Boolean);
  const cuerpo = filas.length
    ? filas.join('\n')
    : '- (aun no se han cargado los datos del negocio; pidelos antes de responder como si los supieras)';
  return `${MARCA_INI}\n## Datos de este negocio\n` +
    `Responde SIEMPRE usando estos datos reales del negocio. No inventes horarios, precios ni servicios: si algo no esta aqui, dilo y ofrece confirmarlo.\n` +
    `${cuerpo}\n${MARCA_FIN}`;
}

// Inyecta (o reemplaza) el bloque de datos en un systemPrompt existente, sin duplicar.
function inyectarDatos(systemPrompt, ficha) {
  const base = String(systemPrompt || '');
  const iniIdx = base.indexOf(MARCA_INI.trim());
  let limpio = base;
  if (iniIdx !== -1) {
    const finIdx = base.indexOf(MARCA_FIN);
    if (finIdx !== -1) limpio = base.slice(0, iniIdx).trimEnd() + base.slice(finIdx + MARCA_FIN.length);
    else limpio = base.slice(0, iniIdx).trimEnd();
  }
  return limpio.trimEnd() + bloqueDatos(ficha);
}

// ---- CEREBRO DEL WIZARD: catalogo de automatizaciones + diagnostico ---------
//
//  El wizard no solo instala agentes: detecta AUTOMATIZACIONES (crons que un
//  agente ejecuta solo) y AGENTES EXTRA que el equipo base no trae pero el dueño
//  necesita. Cada automatizacion apunta al agente del equipo que la ejecuta.
//
//  Cada entrada:
//   - id, titulo, para_que (en lenguaje del dueño)
//   - agente: nombre (aprox) del agente que la ejecuta; se resuelve contra los agentes montados
//   - cron: horario por defecto
//   - taskPrompt: la orden que corre sola
//   - dispara: palabras del dueño que la sugieren
//   - nichos: en que nichos aplica ('*' = todos)

const CATALOGO_AUTOMATIZACIONES = [
  {
    id: 'recordatorio-citas',
    titulo: 'Recordatorio automatico de citas',
    para_que: 'Que ningun cliente falte por olvido: el dia antes se le recuerda la cita y se le pide confirmar.',
    funcion: 'agenda', cron: '0 18 * * *',
    taskPrompt: 'Revisa las citas de mañana y envia a cada cliente un recordatorio amable pidiendole que confirme su asistencia. Avisa al negocio de las que cancelen para llenar ese espacio.',
    dispara: ['cita', 'agenda', 'no-show', 'no show', 'falta', 'recordar', 'reserva', 'turno', 'olvidan'],
    nichos: ['barberia', 'clinica', 'restaurante', 'servicios', '*'],
  },
  {
    id: 'seguimiento-postventa',
    titulo: 'Seguimiento despues de la compra',
    para_que: 'Que el cliente se sienta atendido y vuelva: unos dias despues de comprar se le escribe para saber como le fue.',
    funcion: 'seguimiento', cron: '0 10 * * *',
    taskPrompt: 'Identifica a los clientes que compraron o fueron atendidos hace unos dias y escribeles para saber como les fue, ofrecer ayuda y, si aplica, invitarlos a volver.',
    dispara: ['seguimiento', 'postventa', 'volver', 'fideliz', 'no regresan', 'recompra', 'despues de'],
    nichos: ['*'],
  },
  {
    id: 'reactivar-inactivos',
    titulo: 'Reactivacion de clientes inactivos',
    para_que: 'Recuperar a los que no vuelven hace tiempo con un mensaje o una promocion.',
    funcion: 'seguimiento', cron: '0 11 * * 1',
    taskPrompt: 'Detecta clientes que llevan tiempo sin comprar o sin agendar y escribeles un mensaje de reactivacion con un motivo real para volver. No inventes promociones que el negocio no autorizo.',
    dispara: ['inactivo', 'reactivar', 'perdidos', 'no vuelven', 'recuperar', 'dormidos', 'antiguos'],
    nichos: ['*'],
  },
  {
    id: 'pedir-resenas',
    titulo: 'Solicitud automatica de reseñas',
    para_que: 'Mas reseñas de 5 estrellas: se le pide la reseña al cliente contento en el momento justo.',
    funcion: 'resenas', cron: '0 12 * * *',
    taskPrompt: 'Identifica clientes recien atendidos que quedaron satisfechos y pideles amablemente una reseña, facilitandoles el enlace. No presiones a quien no quiera.',
    dispara: ['reseña', 'resena', 'reputacion', 'estrellas', 'opiniones', 'google', 'recomend'],
    nichos: ['barberia', 'clinica', 'restaurante', 'servicios', 'tienda', '*'],
  },
  {
    id: 'reporte-diario-dueno',
    titulo: 'Reporte diario para el dueño',
    para_que: 'El dueño ve sus numeros cada dia sin pedirlos: ventas, citas y lo que necesita su atencion.',
    funcion: 'reportes', cron: '0 20 * * *',
    taskPrompt: 'Arma un reporte corto del dia para el dueño: ventas, citas atendidas, lo pendiente y cualquier cosa que necesite su decision. Claro y en pocos numeros.',
    dispara: ['reporte', 'numeros', 'ventas', 'saber como va', 'cierre', 'resumen', 'cuanto vendi', 'indicadores'],
    nichos: ['*'],
  },
  {
    id: 'cobranza-pendientes',
    titulo: 'Seguimiento de pagos pendientes',
    para_que: 'Cobrar sin perseguir: se le recuerda el pago pendiente al cliente de forma amable y constante.',
    funcion: 'cobranza', cron: '0 9 * * *',
    taskPrompt: 'Revisa los pagos pendientes y envia a cada cliente un recordatorio amable de su saldo, con la forma de pago. Escala al dueño los casos vencidos.',
    dispara: ['cobrar', 'cobranza', 'pago', 'deben', 'pendiente', 'factura', 'cartera', 'moroso'],
    nichos: ['servicios', 'tienda', 'pyme', '*'],
  },
  {
    id: 'recuperar-carritos',
    titulo: 'Recuperacion de ventas abandonadas',
    para_que: 'Recuperar al que pregunto y no compro: se le da seguimiento para cerrar la venta.',
    funcion: 'seguimiento', cron: '0 15 * * *',
    taskPrompt: 'Detecta a quienes preguntaron por un producto o cotizaron y no cerraron, y escribeles para resolver dudas y cerrar la venta, sin presionar.',
    dispara: ['carrito', 'no compro', 'cotizo', 'abandonan', 'preguntan y no', 'perder ventas', 'cerrar'],
    nichos: ['tienda', 'inmobiliaria', 'servicios', '*'],
  },
];

// Mapa de FUNCION -> palabras que identifican al agente que la ejecuta.
// Los equipos usan nombres distintos ("Agendador", "Asistente de Agendamiento",
// "Asistente de Recordatorios"...) segun sean el equipo de nicho o los procesos.
// Buscamos por funcion, no por nombre literal, para no colgar todo del coordinador.
const FUNCION_PALABRAS = {
  agenda:      ['agenda', 'agendam', 'cita', 'recordator', 'reagenda', 'confirm', 'turno'],
  seguimiento: ['seguimiento', 'postventa', 'vendedor', 'venta', 'lealtad', 'reactiv', 'lead', 'fideliz'],
  resenas:     ['reseñ', 'resen', 'reputac', 'vendedor', 'seguimiento'],
  reportes:    ['contable', 'reporte', 'indicador', 'cierre', 'numeros', 'facturac', 'finanz'],
  cobranza:    ['cobr', 'cartera', 'pago', 'facturac', 'contable'],
  atencion:    ['atencion', 'recep', 'atiende', 'mano derecha', 'copiloto'],
};

// Agentes EXTRA que un dueño suele necesitar y que el equipo base tal vez no trae.
// Se resuelven contra el catalogo del marketplace por su numero de proceso.
const AGENTES_EXTRA_SUGERIDOS = [
  { proceso: '4.8', nombre: 'Asistente de Quejas', dispara: ['queja', 'molesto', 'reclamo', 'insatisfecho', 'problema con', 'devolucion'] },
  { proceso: '4.4', nombre: 'Asistente de Lealtad', dispara: ['puntos', 'lealtad', 'premios', 'frecuente', 'programa de', 'tarjeta'] },
  { proceso: '4.9', nombre: 'Asistente de Venta Cruzada', dispara: ['vender mas', 'combo', 'adicional', 'ticket', 'upsell', 'cruzada'] },
  { proceso: '3.5', nombre: 'Asistente de Precalificacion', dispara: ['calificar', 'filtrar', 'perder tiempo', 'no aptos', 'precalific', 'presupuesto del cliente'] },
  { proceso: '4.6', nombre: 'Asistente de Encuestas', dispara: ['por que no vuelven', 'encuesta', 'feedback', 'que opinan', 'satisfaccion'] },
  { proceso: '6.5', nombre: 'Asistente de Indicadores', dispara: ['tablero', 'kpi', 'indicadores', 'metricas', 'como voy', 'decidir con datos'] },
];

// Diagnostica lo que el dueño describio: sugiere automatizaciones y agentes extra.
function diagnosticar(texto, nicho) {
  const t = (texto || '').toLowerCase();
  const enNicho = (arr) => !nicho || arr.includes('*') || arr.includes(nicho);
  const autos = CATALOGO_AUTOMATIZACIONES
    .filter((a) => enNicho(a.nichos) && a.dispara.some((w) => t.includes(w)))
    .map((a) => ({ id: a.id, titulo: a.titulo, para_que: a.para_que, funcion: a.funcion, cron: a.cron }));
  const extras = AGENTES_EXTRA_SUGERIDOS
    .filter((e) => e.dispara.some((w) => t.includes(w)))
    .map((e) => ({ proceso: e.proceso, nombre: e.nombre }));
  return { autos, extras };
}

// Limpia la respuesta del agente: a veces OpenClaw devuelve el texto con un
// objeto JSON de metadata (summary/invariants/derived) pegado o entrelazado.
// Nos quedamos solo con el texto para el humano.
function limpiarRespuesta(txt) {
  let s = String(txt || '');
  // caso 1: el texto trae un bloque JSON pegado con "summary"/"invariants".
  const marca = s.search(/\{\s*"?summary"?\s*:/i);
  if (marca !== -1) s = s.slice(0, marca);
  // caso 2: metadata entrelazada palabra a palabra (el gate parte el JSON entre el texto).
  s = s.replace(/"?(summary|invariants|derived|reasoning)"?\s*:\s*/gi, ' ')
       .replace(/\[\s*"[^"]*"(\s*,\s*"[^"]*")*\s*\]?/g, ' ') // arrays de strings JSON
       .replace(/[{}]/g, ' ');
  // caso 3: coletilla de "auto-reporte" que el agente pega al final (no es para el cliente).
  // Cortamos desde la primera de estas frases meta hasta el final.
  const meta = s.search(/(Resumen de ejecuci[oó]n|Confirmo que el precio|No hay pasos adicionales|No fue necesario ejecutar|Quedo atento para asistirle con agendamiento o cualquier)/i);
  if (meta !== -1) s = s.slice(0, meta);
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// Mapa de lo que Claude puede administrar (para la tool de capacidades).
const CAPACIDADES = `OpenClaw expone una API REST completa. Con la tool openclaw_api puedes llamar CUALQUIER endpoint.
Rutas principales (usa method GET/POST/PUT/DELETE + path):

AGENTES         GET /api/agents · POST /api/agents · GET|PUT|DELETE /api/agents/{id} · POST /api/agents/{id}/clone
CONECTORES      GET /api/connectors · POST /api/connectors · GET|PUT|DELETE /api/connectors/{id}
                (WhatsApp, Telegram, Slack, email... se crean/configuran aqui)
                GET /api/connectors/{id}/health · GET /api/connectors/{id}/doctor
MCP SERVERS     GET /api/mcp-servers · POST /api/mcp-servers · GET|PUT|DELETE /api/mcp-servers/{id}
                (conectar tools externas a los agentes)
SCHEDULES/CRON  GET /api/schedules · POST /api/schedules · GET|PUT|DELETE /api/schedules/{id} · POST /api/schedules/{id}/run
TAREAS          GET /api/tasks · POST /api/tasks · GET /api/tasks/{id} · POST /api/tasks/{id}/retry
CHATS           GET /api/chats · POST /api/chats/{id}/chat (conversar con un agente)
CREDENCIALES    GET /api/credentials · POST /api/credentials (guardar API keys cifradas)
PROVIDERS       GET /api/providers · PUT /api/providers/{id} (elegir modelo/motor)
MEMORIA/DOCS    GET /api/documents · POST /api/documents
SKILLS          GET /api/skills · POST /api/skills/import · GET /api/clawhub/search
SETTINGS        GET|PUT /api/settings
SISTEMA         GET /api/system/status · GET /api/usage · GET /api/activity
WEBHOOKS        GET /api/webhooks · POST /api/webhooks
CHATROOMS       GET /api/chatrooms (equipos de agentes que colaboran)

Ejemplos:
  Ver agentes:            openclaw_api(method="GET", path="/api/agents")
  Crear un agente:        openclaw_api(method="POST", path="/api/agents", body={"name":"Ventas","provider":"openai","model":"gpt-4.1-mini"})
  Ver conectores:         openclaw_api(method="GET", path="/api/connectors")
  Programar un cron:      openclaw_api(method="POST", path="/api/schedules", body={...})
  Ver estado del sistema: openclaw_api(method="GET", path="/api/system/status")`;

// ---- servidor MCP y tools ---------------------------------------------------

function nuevoServidor() {
  const server = new McpServer({ name: 'openclaw-bridge', version: '3.0.0' });

  // === TOOL UNIVERSAL: control 100% de OpenClaw ===
  server.tool(
    'openclaw_api',
    'Control TOTAL de OpenClaw: llama CUALQUIER endpoint de su API REST (agentes, conectores como WhatsApp, MCP servers, schedules/cron, tareas, memoria, credenciales, skills, settings, sistema). ' +
      'Primero usa openclaw_capacidades para ver las rutas. Devuelve el JSON de la respuesta.',
    {
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).describe('Metodo HTTP'),
      path: z.string().describe('Ruta del endpoint, ej: /api/agents  o  /api/connectors/abc123'),
      body: z.any().optional().describe('Cuerpo JSON para POST/PUT/PATCH (objeto)'),
    },
    async ({ method, path, body }) => {
      const r = await rest(method, path, body);
      // Para listados grandes (agentes), compacta: quita los campos gigantes
      // (systemPrompt, soul) que ocupan casi todo el peso y hacen que la
      // respuesta llegue cortada a Claude. Asi caben todos los items.
      let data = r.data;
      const esAgentes = method === 'GET' && /\/api\/agents\/?$/.test(path);
      if (esAgentes && data && typeof data === 'object') {
        const compacto = {};
        for (const [id, a] of Object.entries(data)) {
          if (a && typeof a === 'object') {
            compacto[id] = {
              name: a.name, id: a.id || id, model: a.model, provider: a.provider,
              role: a.role, description: a.description,
              tools: a.tools, mcpServerIds: a.mcpServerIds,
              delegationTargetAgentIds: a.delegationTargetAgentIds,
              orgChart: a.orgChart,
              systemPrompt: a.systemPrompt ? `(${String(a.systemPrompt).length} chars, oculto)` : undefined,
            };
          } else compacto[id] = a;
        }
        data = compacto;
      }
      const out = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      const LIMITE = 28000;
      const cortado = out.length > LIMITE ? `${out.slice(0, LIMITE)}\n\n[...RESPUESTA CORTADA: ${out.length} chars. Pide un item especifico o usa un filtro.]` : out;
      return { content: [{ type: 'text', text: `HTTP ${r.status}\n${cortado}` }] };
    },
  );

  // === TOOL: listar el equipo de agentes (vista limpia, garantiza no cortarse) ===
  server.tool(
    'listar_agentes',
    'Lista TODOS los agentes del equipo con su ficha resumida (nombre, rol, modelo, herramientas, a quien delega). ' +
      'Vista compacta que nunca se corta. Usala cuando quieras ver el equipo completo.',
    {},
    async () => {
      const r = await rest('GET', '/api/agents');
      const d = r.data || {};
      const lineas = [];
      for (const [id, a] of Object.entries(d)) {
        if (!a || typeof a !== 'object') continue;
        const deleg = (a.delegationTargetAgentIds || []).length;
        const mcp = (a.mcpServerIds || []).length;
        lineas.push(
          `- ${a.name} [${a.role || 'worker'}] id=${a.id || id} · modelo=${a.model} · ` +
          `tools=${(a.tools || []).length}${mcp ? ` · mcp=${mcp}` : ''}${deleg ? ` · delega a ${deleg}` : ''}\n` +
          `    ${(a.description || '').slice(0, 90)}`
        );
      }
      return { content: [{ type: 'text', text: `EQUIPO (${lineas.length} agentes):\n${lineas.join('\n')}` }] };
    },
  );

  // === TOOL: organizar el organigrama visual (usa bulk patch que SI persiste orgChart) ===
  server.tool(
    'organizar_equipo',
    'Arma el organigrama VISUAL del equipo: define quien es el coordinador (jefe) y cuelga a los demas debajo, ' +
      'con posiciones para que se vea ordenado en el dashboard de OpenClaw. Usa el bulk patch correcto ' +
      '(el PUT normal NO persiste el organigrama). Pasa el id del jefe y los ids de los subordinados.',
    {
      jefeId: z.string().describe('id del agente coordinador (el jefe, ej. el Copiloto)'),
      subordinadosIds: z.array(z.string()).describe('ids de los agentes que cuelgan del jefe'),
    },
    async ({ jefeId, subordinadosIds }) => {
      const patches = [];
      // jefe: coordinator, arriba centrado
      patches.push({ id: jefeId, patch: {
        role: 'coordinator',
        orgChart: { parentId: null, teamLabel: 'Direccion', teamColor: '#7C6BFF', x: 400, y: 40 },
      }});
      // subordinados: worker, en fila debajo del jefe
      const paso = 200, inicio = 400 - ((subordinadosIds.length - 1) * paso) / 2;
      subordinadosIds.forEach((sid, i) => {
        patches.push({ id: sid, patch: {
          role: 'worker',
          orgChart: { parentId: jefeId, teamLabel: 'Operacion', teamColor: '#4FDDA0', x: inicio + i * paso, y: 300 },
        }});
      });
      const r = await rest('PATCH', '/api/agents/bulk', { patches });
      const okN = r.data?.updated || 0;
      return { content: [{ type: 'text', text:
        okN > 0
          ? `Organigrama armado: ${jefeId} como coordinador arriba, ${subordinadosIds.length} agentes colgando debajo. ` +
            `Actualizados ${okN}. Refresca el dashboard de OpenClaw para verlo.`
          : `No se pudo armar el organigrama: ${JSON.stringify(r.data).slice(0, 200)}` }] };
    },
  );

  // === TOOL: configurar un agente (system prompt, tools) sin cortes ===
  server.tool(
    'configurar_agente',
    'Configura un agente: su system prompt (personalidad, reglas, datos del negocio), su modelo, o sus herramientas. ' +
      'Usa esto para poner los datos REALES del negocio (servicios, horarios, precios, reglas) en cada agente.',
    {
      agentId: z.string().describe('id del agente a configurar'),
      systemPrompt: z.string().optional().describe('nuevo system prompt (personalidad + datos del negocio)'),
      model: z.string().optional().describe('modelo, ej. gpt-4.1-mini'),
      tools: z.array(z.string()).optional().describe('lista de herramientas'),
    },
    async ({ agentId, systemPrompt, model, tools }) => {
      const patch = {};
      if (systemPrompt !== undefined) patch.systemPrompt = systemPrompt;
      if (model !== undefined) patch.model = model;
      if (tools !== undefined) patch.tools = tools;
      if (!Object.keys(patch).length) return { content: [{ type: 'text', text: 'Pasa al menos systemPrompt, model o tools.' }] };
      const r = await rest('PUT', `/api/agents/${agentId}`, patch);
      if (!r.ok) return { content: [{ type: 'text', text: `Error configurando: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 150)}` }] };
      return { content: [{ type: 'text', text: `Agente ${r.data?.name || agentId} configurado. ${systemPrompt ? 'System prompt actualizado. ' : ''}${model ? `Modelo: ${model}. ` : ''}${tools ? `Tools: ${tools.length}. ` : ''}` }] };
    },
  );

  // === TOOL: diagnostico de procesos (que tarea pasar a un agente) ===
  server.tool(
    'diagnosticar_proceso',
    'Analiza una tarea o proceso del negocio y dice si conviene automatizarla con un agente, cual del equipo la haria, ' +
      'y que datos hacen falta. Usala cuando el dueno describe algo que hace a mano y quiere saber si un agente lo puede tomar.',
    {
      proceso: z.string().describe('descripcion de la tarea/proceso que hace el dueno, en sus palabras'),
    },
    async ({ proceso }) => {
      // Reglas simples de enrutamiento por palabras clave (rapido, sin costo).
      const p = proceso.toLowerCase();
      const reglas = [
        { k: ['whatsapp', 'mensaje', 'responder', 'contestar', 'atender', 'chat', 'dudas', 'consulta'], agente: 'Recepcionista', porque: 'atiende y responde a clientes 24/7' },
        { k: ['cita', 'agenda', 'reservar', 'turno', 'horario', 'recordar', 'confirmar', 'no-show', 'no show'], agente: 'Agendador', porque: 'agenda, confirma y recuerda citas' },
        { k: ['seguimiento', 'lead', 'promocion', 'reactivar', 'resena', 'reseña', 'contenido', 'campana', 'vender', 'venta'], agente: 'Vendedor', porque: 'da seguimiento a leads y hace marketing' },
        { k: ['reporte', 'numero', 'número', 'venta', 'gasto', 'rentabilidad', 'factura', 'cobro', 'margen', 'contab', 'cierre'], agente: 'Contable', porque: 'lleva los numeros y arma reportes' },
      ];
      const matches = reglas.filter((r) => r.k.some((w) => p.includes(w)));
      let out;
      if (!matches.length) {
        out = `Analisis de "${proceso.slice(0, 80)}":\n\n` +
          `Este proceso no encaja claro en un agente del equipo actual. Opciones:\n` +
          `- Si es repetitivo y sigue reglas -> conviene un agente NUEVO (dime el detalle y lo creo).\n` +
          `- Si necesita criterio humano cada vez -> mejor que lo escale al dueno.\n` +
          `Preguntas para decidir: ¿se repite seguido? ¿sigue siempre los mismos pasos? ¿que apps toca?`;
      } else {
        const lista = matches.map((m) => `- ${m.agente}: ${m.porque}`).join('\n');
        out = `Analisis de "${proceso.slice(0, 80)}":\n\n` +
          `SI conviene pasarlo a un agente. Encaja con:\n${lista}\n\n` +
          `Para que funcione bien, ese agente necesita saber del negocio: horarios, precios/servicios, ` +
          `reglas (que si y que no puede hacer), y con que app trabaja (WhatsApp, calendario, etc.). ` +
          `Dime esos datos y lo configuro con configurar_agente.`;
      }
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // === TOOL: buscar templates de agentes/tools (marketplace SwarmDock + registro) ===
  server.tool(
    'buscar_templates',
    'Busca plantillas de agentes o tools (MCP servers) disponibles en el marketplace de OpenClaw (SwarmDock) ' +
      'y en el registro de MCP. Usala para ver si ya existe un template listo antes de armar uno desde cero.',
    {
      busqueda: z.string().optional().describe('palabra clave, ej: whatsapp, calendar, crm'),
    },
    async ({ busqueda }) => {
      // El marketplace de SwarmDock es un servicio externo que a veces esta caido (502/404).
      // Consultamos el proxy de OpenClaw y damos un mensaje claro si no responde.
      const r = await rest('GET', '/api/mcp-registry');
      if (!r.ok || !r.data) {
        return { content: [{ type: 'text', text:
          `El marketplace de SwarmDock no responde ahora mismo (es un servicio externo que a veces se cae). ` +
          `No es un problema de tu OpenClaw. Puedes:\n` +
          `- Reintentar en un rato.\n` +
          `- O conectar cualquier MCP server manualmente con openclaw_api (POST /api/mcp-servers).\n` +
          `- Para apps (Gmail, Calendar, etc.) usa mejor conectar_app (Composio), que si funciona.` }] };
      }
      let items = Array.isArray(r.data) ? r.data : (r.data.items || r.data.servers || []);
      if (busqueda) {
        const q = busqueda.toLowerCase();
        items = items.filter((x) => JSON.stringify(x).toLowerCase().includes(q));
      }
      if (!items.length) return { content: [{ type: 'text', text: `No hay templates${busqueda ? ` para "${busqueda}"` : ''} en el marketplace ahora.` }] };
      const lineas = items.slice(0, 15).map((x) => `- ${x.name || x.slug || x.title || '?'}: ${(x.description || '').slice(0, 70)}`);
      return { content: [{ type: 'text', text: `Templates disponibles (${items.length}):\n${lineas.join('\n')}` }] };
    },
  );

  // === TOOL: documentacion de capacidades ===
  server.tool(
    'openclaw_capacidades',
    'Muestra el mapa completo de lo que Claude puede administrar en OpenClaw y ejemplos de uso de openclaw_api.',
    {},
    async () => ({ content: [{ type: 'text', text: CAPACIDADES }] }),
  );

  // === TOOL: dar una orden al agente y esperar ===
  server.tool(
    'openclaw_ordenar',
    'Da una orden en lenguaje natural al Clon Operativo (el agente) y espera su resultado. ' +
      'Para pedirle que responda mensajes, agende, haga un reporte, busque algo, etc. ' +
      'Acepta un agentId opcional para dirigir la orden a un agente especifico.',
    {
      orden: z.string().describe('La orden en lenguaje natural'),
      agentId: z.string().optional().describe('id del agente (por defecto el principal)'),
    },
    async ({ orden, agentId }) => {
      const r = await ordenar(orden, { esperar: true, agentId: agentId || OPENCLAW_AGENT });
      if (r.listo) {
        const txt = limpiarRespuesta(r.result || r.error || `(estado: ${r.status})`);
        return { content: [{ type: 'text', text: String(txt) }] };
      }
      // Aun procesando: instruye a Claude a seguir consultando (para que sea dinamico).
      return { content: [{ type: 'text', text:
        `[EN PROCESO] La orden se esta ejecutando (estado: ${r.status}). taskId=${r.taskId}. ` +
        `IMPORTANTE: vuelve a llamar la tool openclaw_estado_tarea con este taskId para obtener el resultado; ` +
        `sigue consultando cada pocos segundos hasta que este listo, sin esperar a que el usuario te lo pida.` }] };
    },
  );

  // === TOOL: orden en background (tareas largas) ===
  server.tool(
    'openclaw_ordenar_async',
    'Da una orden al agente SIN esperar (tareas largas). Devuelve un taskId para consultar despues con openclaw_estado_tarea.',
    {
      orden: z.string().describe('La orden en lenguaje natural'),
      agentId: z.string().optional(),
    },
    async ({ orden, agentId }) => {
      const r = await ordenar(orden, { esperar: false, agentId: agentId || OPENCLAW_AGENT });
      return { content: [{ type: 'text', text: `Tarea enviada. taskId=${r.taskId} estado=${r.status}` }] };
    },
  );

  // === TOOL: consultar una tarea ===
  server.tool(
    'openclaw_estado_tarea',
    'Consulta el resultado de una tarea (de openclaw_ordenar u openclaw_ordenar_async). ' +
      'Espera hasta ~25s por si aun no termina. Si sigue en proceso, vuelve a llamarla hasta obtener el resultado.',
    { taskId: z.string().describe('El taskId de la tarea') },
    async ({ taskId }) => {
      const r = await esperarTarea(taskId, { timeoutMs: 25000 });
      if (r.listo) {
        const txt = r.result || r.error || `estado: ${r.status}`;
        return { content: [{ type: 'text', text: String(txt) }] };
      }
      return { content: [{ type: 'text', text:
        `[EN PROCESO] Todavia se esta ejecutando (estado: ${r.status}). taskId=${r.taskId}. ` +
        `Vuelve a llamar openclaw_estado_tarea con este mismo taskId para seguir esperando el resultado.` }] };
    },
  );

  // === TOOL: salud del sistema ===
  server.tool(
    'openclaw_estado',
    'Verifica que OpenClaw esta vivo y muestra el estado del sistema (agentes, conectores, tareas).',
    {},
    async () => {
      const h = await fetch(`${OPENCLAW_URL}/api/healthz`).then((x) => x.json()).catch(() => null);
      const sys = await rest('GET', '/api/system/status').catch(() => ({ data: null }));
      const vivo = h && h.ok ? 'VIVO y 24/7' : 'no responde';
      const extra = sys.data ? `\nSistema: ${JSON.stringify(sys.data).slice(0, 1500)}` : '';
      return { content: [{ type: 'text', text: `OpenClaw: ${vivo}${extra}` }] };
    },
  );

  // ===== AUTENTICACION DE APPS DESDE EL CHAT (links que el usuario presiona) =====

  // Conectar una app via Composio (OAuth de 1 clic). Devuelve un LINK.
  server.tool(
    'conectar_app',
    'Conecta una app (Gmail, Google Calendar, Slack, HubSpot, Notion, etc.) a los agentes via Composio. ' +
      'Devuelve un LINK que el usuario abre para autorizar la app con OAuth (1 clic). ' +
      'Usa el slug de la app en minusculas: gmail, googlecalendar, slack, notion, hubspot, etc.',
    {
      app: z.string().describe('slug de la app en Composio, ej: gmail, googlecalendar, slack, notion'),
      usuario: z.string().optional().describe('id del usuario/alumno (para aislar sus cuentas). Por defecto "tdx_demo".'),
    },
    async ({ app, usuario }) => {
      if (!COMPOSIO_KEY) return { content: [{ type: 'text', text: 'Falta configurar COMPOSIO_API_KEY en el puente.' }] };
      const userId = usuario || 'tdx_demo';
      const slug = app.toLowerCase().trim();
      const authId = await ensureAuthConfig(slug, COMPOSIO_KEY);
      if (!authId) return { content: [{ type: 'text', text: `No pude preparar la app "${slug}". Revisa el slug (ej: gmail, googlecalendar).` }] };
      const link = await composio('POST', '/connected_accounts/link', { auth_config_id: authId, user_id: userId });
      const url = link.data?.redirect_url;
      if (!url) return { content: [{ type: 'text', text: `No se pudo generar el link para "${slug}": ${JSON.stringify(link.data).slice(0, 200)}` }] };
      const cid = link.data?.connected_account_id || '';
      return { content: [{ type: 'text', text:
        `Para conectar ${slug.toUpperCase()}, abre este link y autoriza con tu cuenta:\n\n${url}\n\n` +
        `Cuando termines, la app queda conectada al usuario "${userId}". ` +
        `(id de conexion: ${cid}) Puedes verificar con estado_conexion.` }] };
    },
  );

  // Conectar WhatsApp por QR (nativo de OpenClaw, WhatsApp personal o business normal, sin Business API).
  server.tool(
    'conectar_whatsapp',
    'Conecta un numero de WhatsApp (personal o business normal, SIN Business API) a un agente, por codigo QR. ' +
      'Crea el conector en OpenClaw y devuelve un LINK donde el usuario ve el QR para escanear con su WhatsApp ' +
      '(Ajustes > Dispositivos vinculados). Sirve para que el agente atienda ese numero 24/7.',
    {
      nombre: z.string().optional().describe('nombre del conector, ej: "WhatsApp del negocio"'),
      agentId: z.string().optional().describe('id del agente que atendera (por defecto el Recepcionista o el principal)'),
    },
    async ({ nombre, agentId }) => {
      const body = {
        name: nombre || 'WhatsApp',
        platform: 'whatsapp',
        agentId: agentId || OPENCLAW_AGENT,
        autoStart: true, // arranca el socket para que genere el QR
      };
      const r = await rest('POST', '/api/connectors', body);
      if (!r.ok || !r.data?.id) return { content: [{ type: 'text', text: `No se pudo crear el conector de WhatsApp: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}` }] };
      const cid = r.data.id;
      const qrLink = `${SELF_URL}/qr/${cid}`;
      // Espera corta (tope 7s) a que el QR se genere, para que el link ya lo muestre.
      // No pega a Claude: si no aparece en 7s, igual devuelve el link (la pagina se auto-refresca).
      let qrListo = false;
      for (let i = 0; i < 5; i++) {
        await new Promise((res) => setTimeout(res, 1400));
        const chk = await rest('GET', `/api/connectors/${cid}`).catch(() => ({ data: {} }));
        if (chk.data?.qrDataUrl || chk.data?.authenticated) { qrListo = true; break; }
      }
      return { content: [{ type: 'text', text:
        `WhatsApp listo para vincular${qrListo ? ' (el QR ya esta en la pagina)' : ''}. ` +
        `Abre este link para ver el codigo QR y escanealo con tu WhatsApp ` +
        `(Ajustes > Dispositivos vinculados > Vincular dispositivo):\n\n${qrLink}\n\n` +
        `El QR se refresca solo. En cuanto lo escanees, el agente empieza a atender ese numero. ` +
        `(id del conector: ${cid})` }] };
    },
  );

  // Verificar el estado de una conexion (app de Composio o conector de OpenClaw).
  server.tool(
    'estado_conexion',
    'Verifica si una app o un WhatsApp ya quedo conectado. Pasa el id del conector de OpenClaw (para WhatsApp) ' +
      'o el usuario y app de Composio (para apps OAuth).',
    {
      connectorId: z.string().optional().describe('id del conector de OpenClaw (WhatsApp)'),
      usuario: z.string().optional().describe('usuario de Composio, si verificas una app OAuth'),
    },
    async ({ connectorId, usuario }) => {
      if (connectorId) {
        const r = await rest('GET', `/api/connectors/${connectorId}`);
        const c = r.data || {};
        const est = c.authenticated ? 'CONECTADO' : (c.qrDataUrl ? 'esperando escaneo del QR' : (c.status || 'desconocido'));
        return { content: [{ type: 'text', text: `WhatsApp (${c.name || connectorId}): ${est}` }] };
      }
      if (usuario) {
        const r = await composio('GET', `/connected_accounts?user_id=${encodeURIComponent(usuario)}&limit=20`);
        const items = (r.data && r.data.items) || [];
        if (!items.length) return { content: [{ type: 'text', text: `El usuario "${usuario}" no tiene apps conectadas todavia.` }] };
        const lineas = items.map((a) => `- ${a.toolkit?.slug || a.appName || '?'}: ${a.status || a.connectionStatus || '?'}`).join('\n');
        return { content: [{ type: 'text', text: `Apps conectadas de "${usuario}":\n${lineas}` }] };
      }
      return { content: [{ type: 'text', text: 'Pasa connectorId (WhatsApp) o usuario (apps de Composio).' }] };
    },
  );

  // Refrescar la conexion de un agente con sus herramientas de Composio.
  // Problema que resuelve: asociar un servidor MCP (mcpServerIds) a un agente NO basta;
  // cada tool de Composio (GMAIL_*, OUTLOOK_*, etc.) debe estar ademas en el array `tools`
  // del agente, o este responde "no tengo autorizacion" sin llamar nada. Ademas, cuando
  // se agregan toolkits nuevos (ej: Outlook) al servidor MCP de Composio, OpenClaw necesita
  // RE-LEER la lista de tools. Esta tool hace las dos cosas de una:
  //   1) (opcional) re-guarda el servidor MCP para que OpenClaw refresque su catalogo.
  //   2) agrega (o quita) las tools indicadas en el array `tools` del agente, preservando
  //      las que ya tenia (email, memory, delegate_to_agent, etc.).
  server.tool(
    'refrescar_tools_agente',
    'Refresca la conexion de un agente con sus herramientas de Composio (Gmail, Outlook, etc.). ' +
      'Agrega las tools indicadas al agente para que REALMENTE pueda usarlas (no basta con asociar el servidor MCP: ' +
      'cada tool debe estar en el array tools del agente o el agente dice "no tengo autorizacion"). ' +
      'Opcionalmente re-sincroniza el servidor MCP para que OpenClaw vea toolkits recien agregados (ej: Outlook). ' +
      'Usa esto cuando un agente no logra usar una herramienta de correo/calendario que deberia tener.',
    {
      agentId: z.string().describe('id del agente a refrescar (ej: 093e7090)'),
      agregar: z.array(z.string()).optional().describe('tools de Composio a habilitar en el agente, ej: ["OUTLOOK_SEARCH_MESSAGES","OUTLOOK_GET_MESSAGE"]'),
      quitar: z.array(z.string()).optional().describe('tools a remover del agente (opcional)'),
      mcpServerId: z.string().optional().describe('id del servidor MCP a re-sincronizar primero (ej: 23ea11c0). Si se pasa, se re-guarda para forzar el refresh del catalogo de tools.'),
    },
    async ({ agentId, agregar, quitar, mcpServerId }) => {
      const pasos = [];
      // 1) refrescar el catalogo del servidor MCP (re-guardarlo dispara la recarga en OpenClaw)
      if (mcpServerId) {
        const g = await rest('GET', `/api/mcp-servers/${mcpServerId}`);
        if (g.ok && g.data && g.data.url) {
          const body = { name: g.data.name, transport: g.data.transport, url: g.data.url, headers: g.data.headers };
          const u = await rest('PUT', `/api/mcp-servers/${mcpServerId}`, body);
          pasos.push(u.ok ? `Servidor MCP ${mcpServerId} re-sincronizado (catalogo refrescado).` : `No pude re-sincronizar el servidor MCP ${mcpServerId}: HTTP ${u.status}.`);
        } else {
          pasos.push(`No encontre el servidor MCP ${mcpServerId} (HTTP ${g.status}); sigo con el agente.`);
        }
      }
      // 2) leer el agente y recomponer su array tools
      const ag = await rest('GET', `/api/agents/${agentId}`);
      if (!ag.ok || !ag.data) return { content: [{ type: 'text', text: `No encontre el agente ${agentId} (HTTP ${ag.status}). ${pasos.join(' ')}` }] };
      const actuales = Array.isArray(ag.data.tools) ? ag.data.tools : [];
      const quitarSet = new Set(quitar || []);
      let nuevas = actuales.filter((t) => !quitarSet.has(t));
      for (const t of (agregar || [])) if (!nuevas.includes(t)) nuevas.push(t);
      // nada que cambiar
      const sinCambios = nuevas.length === actuales.length && nuevas.every((t) => actuales.includes(t));
      if (sinCambios) {
        return { content: [{ type: 'text', text:
          `${pasos.join(' ')}\nEl agente "${ag.data.name}" ya tenia esas tools; no hubo cambios.\nTools: ${nuevas.join(', ')}` }] };
      }
      const put = await rest('PUT', `/api/agents/${agentId}`, { tools: nuevas });
      if (!put.ok) return { content: [{ type: 'text', text: `${pasos.join(' ')}\nNo pude actualizar las tools del agente: HTTP ${put.status} ${JSON.stringify(put.data).slice(0, 200)}` }] };
      const añadidas = (agregar || []).filter((t) => !actuales.includes(t));
      const removidas = (quitar || []).filter((t) => actuales.includes(t));
      return { content: [{ type: 'text', text:
        `${pasos.length ? pasos.join(' ') + '\n' : ''}` +
        `Agente "${ag.data.name}" refrescado.\n` +
        (añadidas.length ? `+ Habilitadas: ${añadidas.join(', ')}\n` : '') +
        (removidas.length ? `- Removidas: ${removidas.join(', ')}\n` : '') +
        `Tools ahora (${nuevas.length}): ${nuevas.join(', ')}\n` +
        `Nota: el agente usara las tools nuevas en su proximo turno; no requiere reiniciar.` }] };
    },
  );

  // ==========================================================================
  //  TOOLS DEL WIZARD DE CONFIGURACION
  // ==========================================================================

  // === 1. Iniciar el wizard: crea/retoma la ficha y muestra los equipos ===
  server.tool(
    'wizard_iniciar',
    'PUNTO DE ENTRADA OBLIGATORIO cuando alguien quiere configurar, montar o automatizar sus agentes / su negocio. ' +
      'Siempre que el usuario diga algo como "quiero configurar unos agentes", "montar mi negocio", "automatizar", ' +
      'LLAMA ESTA TOOL PRIMERO, antes que cualquier otra (no uses openclaw_api, listar_agentes ni menus tecnicos). ' +
      'Arranca/retoma el wizard, crea la ficha del negocio y te da el guion para conducirlo. ' +
      'La PRIMERA pregunta al dueño es SIEMPRE "¿a que se dedica tu negocio?" — nunca opciones tecnicas.',
    {
      usuario: z.string().optional().describe('id del dueño/alumno (aisla su negocio). Por defecto "tdx_demo".'),
    },
    async ({ usuario }) => {
      const uid = usuario || 'tdx_demo';
      let { ficha } = await leerFicha(uid);
      const retoma = !!ficha;
      if (!ficha) { ficha = fichaVacia(uid); await guardarFicha(uid, ficha); }
      // traer los equipos del marketplace
      let equipos = [];
      try {
        const r = await fetchT(`${MARKETPLACE_URL}/api/equipos`, {}, 12000);
        const j = await r.json();
        equipos = (j.equipos || []).map((e) => `- ${e.id}  —  ${e.nombre} (${e.agentes} agentes): ${e.descripcion}`);
      } catch { equipos = ['(no se pudo leer el marketplace ahora; reintenta)']; }
      const cabecera = retoma
        ? `Retomando el wizard de "${uid}". Vas en el paso: ${ficha.paso}.\n` +
          (ficha.equipo ? `Equipo elegido: ${ficha.equipo}.\n` : '')
        : `Wizard iniciado para "${uid}".\n`;
      return { content: [{ type: 'text', text:
        `${cabecera}\n` +
        `FILOSOFIA: "pega y listo, wow en 60 segundos". Nada de interrogatorios. El dueño da UN dato y tu haces el resto.\n\n` +
        `REGLA #1 — Tu PRIMER mensaje es UNA sola pregunta, calida y corta:\n` +
        `   "¡Genial! Para dejarte los agentes listos con tus datos, pasame el link de tu pagina web, tu Instagram o tu Google Maps. ` +
        `Si no tienes, cuentame en una frase a que te dedicas."\n\n` +
        `REGLA #2 — Cuando te de el link (o la frase), NO preguntes campo por campo. Haz esto TU solo:\n` +
        `   a) LEE esa URL con tu herramienta de navegacion web (WebFetch/fetch). Extrae: nombre del negocio, a que se dedica, ` +
        `servicios y precios, horarios, telefono/canales. Lo que encuentres.\n` +
        `   b) Deduce el nicho y elige el equipo que mejor calce (lista abajo).\n` +
        `   c) Llama UNA VEZ a wizard_ficha_completa con todo lo que extrajiste (equipo + los datos). ` +
        `Lo que no encuentres, dejalo vacio (se completa despues, no lo preguntes ahora).\n\n` +
        `REGLA #3 — Monta de inmediato con wizard_montar y prueba UN solo agente con wizard_probar. ` +
        `Muestrale la respuesta con SUS datos. Ese es el momento wow. Di algo como: "Mira, ya tu agente responde asi ->".\n\n` +
        `REGLA #4 — Solo DESPUES del wow, y solo si el dueño quiere, ofrece ajustes OPCIONALES en una linea: ` +
        `"¿Quieres afinar el tono, agregar recordatorios automaticos, o conectar tu WhatsApp?". No lo obligues.\n\n` +
        `PROHIBIDO: menus tecnicos, preguntar 7 datos uno por uno, encadenar 3 pruebas de agentes (se cuelga y aburre). ` +
        `NO uses openclaw_api ni listar_agentes.\n\n` +
        `EQUIPOS DISPONIBLES (tu referencia para elegir nicho; no los listes crudos):\n${equipos.join('\n')}\n\n` +
        `Empieza YA con la pregunta de la REGLA #1.` }] };
    },
  );

  // === 2. Guardar un dato de la ficha (equipo, o cualquier dato del negocio) ===
  server.tool(
    'wizard_guardar_dato',
    'Guarda un dato de la ficha del negocio durante el wizard (checkpoint: el dueño puede parar y retomar). ' +
      'Claves validas: "equipo" (id del equipo elegido), o datos del negocio: "nombre", "que_hace", "horarios", ' +
      '"servicios_precios", "canales", "reglas", "tono", "extra". Llamala cada vez que el dueño responda algo.',
    {
      clave: z.enum(['equipo', 'nombre', 'que_hace', 'horarios', 'servicios_precios', 'canales', 'reglas', 'tono', 'extra']),
      valor: z.string().describe('el valor que dio el dueño, en sus palabras'),
      usuario: z.string().optional(),
    },
    async ({ clave, valor, usuario }) => {
      const uid = usuario || 'tdx_demo';
      let { ficha } = await leerFicha(uid);
      if (!ficha) ficha = fichaVacia(uid);
      if (clave === 'equipo') { ficha.equipo = valor.trim(); if (ficha.paso === 'equipo') ficha.paso = 'datos'; }
      else ficha.negocio[clave] = valor.trim();
      await guardarFicha(uid, ficha);
      // que datos del negocio faltan aun (para que Claude sepa que preguntar despues)
      const campos = ['nombre', 'que_hace', 'horarios', 'servicios_precios', 'canales', 'reglas', 'tono'];
      const faltan = campos.filter((c) => !ficha.negocio[c]);
      return { content: [{ type: 'text', text:
        `Guardado: ${clave} = "${valor.slice(0, 60)}". ` +
        (clave === 'equipo'
          ? `Equipo del negocio fijado.`
          : (faltan.length
              ? `Aun faltan por preguntar (uno a la vez): ${faltan.join(', ')}.`
              : `Ya estan todos los datos clave del negocio. Puedes montar con wizard_montar.`)) }] };
    },
  );

  // === 2b. Rellenar TODA la ficha de una vez (flujo "pega y listo") ===
  server.tool(
    'wizard_ficha_completa',
    'RELLENA toda la ficha del negocio de UNA sola vez, tras leer la web/Instagram del dueño. Usala en el flujo rapido: ' +
      'el dueño da un link, tu lees la pagina, extraes los datos y los pasas TODOS aqui en una sola llamada (en vez de ' +
      'preguntar campo por campo). Pasa el equipo (nicho) que dedujiste y los datos que encontraste; lo que no halles, omitelo.',
    {
      usuario: z.string().optional(),
      equipo: z.string().optional().describe('id del equipo por nicho que dedujiste, ej. "equipo/barberia"'),
      nombre: z.string().optional().describe('nombre del negocio'),
      que_hace: z.string().optional().describe('a que se dedica, en una frase'),
      horarios: z.string().optional().describe('dias y horas de atencion'),
      servicios_precios: z.string().optional().describe('servicios y precios que encontraste'),
      canales: z.string().optional().describe('telefono, WhatsApp, redes'),
      reglas: z.string().optional().describe('reglas del negocio si las hay'),
      tono: z.string().optional().describe('tono de comunicacion, si lo infieres del sitio'),
      fuente: z.string().optional().describe('el link/fuente de donde sacaste los datos'),
    },
    async ({ usuario, equipo, nombre, que_hace, horarios, servicios_precios, canales, reglas, tono, fuente }) => {
      const uid = usuario || 'tdx_demo';
      let { ficha } = await leerFicha(uid);
      if (!ficha) ficha = fichaVacia(uid);
      if (equipo) ficha.equipo = equipo.trim();
      const set = (k, v) => { if (v && String(v).trim()) ficha.negocio[k] = String(v).trim(); };
      set('nombre', nombre); set('que_hace', que_hace); set('horarios', horarios);
      set('servicios_precios', servicios_precios); set('canales', canales);
      set('reglas', reglas); set('tono', tono);
      if (fuente) ficha.negocio.extra = `Datos tomados de: ${fuente}`;
      ficha.paso = 'datos';
      await guardarFicha(uid, ficha);
      const n = ficha.negocio;
      const tiene = ['nombre', 'que_hace', 'horarios', 'servicios_precios', 'canales'].filter((c) => n[c]);
      const faltanClave = ['horarios', 'servicios_precios'].filter((c) => !n[c]);
      return { content: [{ type: 'text', text:
        `FICHA RELLENADA para "${n.nombre || uid}"${equipo ? ` (equipo: ${equipo})` : ''}.\n` +
        `Datos capturados: ${tiene.join(', ') || 'ninguno'}.\n` +
        (faltanClave.length
          ? `Faltan datos clave (${faltanClave.join(', ')}): si el sitio no los tenia, montamos igual y el agente dira ` +
            `"dejame confirmarte ese dato" cuando se lo pregunten. NO interrogues al dueño por ellos ahora.\n`
          : `Tienes lo esencial.\n`) +
        `SIGUIENTE: monta YA con wizard_montar y prueba un agente con wizard_probar para el momento wow. ` +
        `Los ajustes van despues, opcionales.` }] };
    },
  );

  // === 3. Diagnosticar: detectar automatizaciones y agentes extra necesarios ===
  server.tool(
    'wizard_diagnosticar',
    'CEREBRO del wizard. Analiza lo que el dueño describe (que le quita tiempo, que quiere lograr) y devuelve un PLAN: ' +
      'que automatizaciones conviene desplegar y que agentes EXTRA (fuera del equipo base) podria necesitar. ' +
      'Usala en cuanto el dueño cuente su dolor, ANTES de montar. Combina su resultado con tu propio criterio para proponer.',
    {
      descripcion: z.string().describe('lo que el dueño dijo sobre su negocio, sus dolores y lo que quiere automatizar'),
      usuario: z.string().optional(),
    },
    async ({ descripcion, usuario }) => {
      const uid = usuario || 'tdx_demo';
      const { ficha } = await leerFicha(uid);
      const nicho = ficha?.equipo ? String(ficha.equipo).split('/').pop() : null;
      const { autos, extras } = diagnosticar(descripcion, nicho);
      if (ficha) { ficha.paso = ficha.paso === 'equipo' || ficha.paso === 'datos' ? ficha.paso : 'datos'; }
      const bloqueAutos = autos.length
        ? autos.map((a) => `- [${a.id}] ${a.titulo} — ${a.para_que}`).join('\n')
        : '- (ninguna automatizacion evidente en lo que dijo; puedes proponer por criterio si detectas una necesidad clara)';
      const bloqueExtras = extras.length
        ? extras.map((e) => `- proceso ${e.proceso}: ${e.nombre}`).join('\n')
        : '- (ningun agente extra evidente; el equipo base deberia cubrirlo)';
      return { content: [{ type: 'text', text:
        `PLAN DE AUTOMATIZACION detectado${nicho ? ` (nicho: ${nicho})` : ''}:\n\n` +
        `AUTOMATIZACIONES sugeridas (crons que un agente corre solo):\n${bloqueAutos}\n\n` +
        `AGENTES EXTRA sugeridos (no vienen en el equipo base):\n${bloqueExtras}\n\n` +
        `COMO SEGUIR: presentaselo al dueño en lenguaje simple ("ademas de tus agentes, te dejo esto trabajando solo: ..."). ` +
        `Cuando lo apruebe: monta el equipo + los agentes extra con wizard_montar (pasa los procesos extra en agentesExtra), ` +
        `y despliega las automatizaciones con wizard_automatizar (pasa los ids que aprobo). ` +
        `Si por tu criterio detectas una necesidad que no salio aqui, proponla igual.` }] };
    },
  );

  // === 4. Montar: instala el equipo + agentes extra e inyecta los datos ===
  server.tool(
    'wizard_montar',
    'PASO CLAVE. Instala el equipo del nicho elegido MAS los agentes extra detectados, y luego INYECTA los datos del ' +
      'negocio (horarios, precios, reglas, tono) en el system prompt de cada agente para que respondan como el negocio real. ' +
      'Llamala cuando ya haya equipo elegido y los datos principales cargados.',
    {
      usuario: z.string().optional(),
      agentesExtra: z.array(z.string()).optional().describe('numeros de proceso de agentes extra a añadir, ej. ["4.8","4.4"]'),
    },
    async ({ usuario, agentesExtra }) => {
      const uid = usuario || 'tdx_demo';
      const { ficha } = await leerFicha(uid);
      if (!ficha) return { content: [{ type: 'text', text: 'No hay ficha. Llama wizard_iniciar primero.' }] };
      if (!ficha.equipo) return { content: [{ type: 'text', text: 'Falta elegir el equipo. Usa wizard_guardar_dato clave "equipo".' }] };
      const t0 = Date.now();
      // marca de tiempo ANTES de instalar: asi identificamos los agentes recien creados
      // por su createdAt (robusto), en vez de filtrar por "[equipo <nicho>]" en la descripcion
      // (fragil: agarraba agentes de instalaciones previas del mismo nicho y colgaba la inyeccion).
      const desde = Date.now() - 5000; // margen de 5s por reloj
      // 1) instalar el equipo via marketplace
      let instalados = [];
      try {
        const r = await fetchT(`${MARKETPLACE_URL}/api/instalar-equipo`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: ficha.equipo, openclawUrl: OPENCLAW_URL, accessKey: OPENCLAW_KEY }),
        }, 45000);
        const j = await r.json();
        if (j.error) return { content: [{ type: 'text', text: `El marketplace rechazo la instalacion: ${j.error}` }] };
        instalados = j.agentes || [];
      } catch (e) { return { content: [{ type: 'text', text: `No se pudo instalar el equipo (${e.message}). Reintenta wizard_montar.` }] }; }
      // 2) instalar agentes extra (uno a uno, por proceso)
      const extraProcs = agentesExtra || [];
      const extraNombres = [];
      for (const proc of extraProcs) {
        try {
          const r = await fetchT(`${MARKETPLACE_URL}/api/instalar`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: proc, openclawUrl: OPENCLAW_URL, accessKey: OPENCLAW_KEY }),
          }, 20000);
          const j = await r.json();
          if (j.ok) extraNombres.push(j.instalado);
        } catch { /* sigue */ }
      }
      // 3) releer agentes y quedarnos SOLO con los recien creados (createdAt >= desde).
      //    Es robusto ante duplicados: no toca agentes de instalaciones anteriores.
      const ag = await rest('GET', '/api/agents');
      const todos = Object.values(ag.data || {}).filter((a) => a && a.id);
      const nombresInstalados = new Set([...instalados, ...extraNombres]);
      let recien = todos.filter((a) => (a.createdAt || 0) >= desde && nombresInstalados.has(a.name));
      // respaldo: si por reloj no calzo nada, usa nombre + los mas nuevos, tope al nro instalado
      if (!recien.length) {
        recien = todos
          .filter((a) => nombresInstalados.has(a.name))
          .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))
          .slice(0, instalados.length + extraNombres.length);
      }
      // 4) inyectar los datos del negocio en cada agente recien creado (con tope de tiempo global)
      let inyectados = 0;
      const fichaAgentes = [];
      for (const a of recien) {
        fichaAgentes.push({ id: a.id, nombre: a.name, descripcion: (a.description || '').slice(0, 60) });
        if (Date.now() - t0 > 40000) continue; // corte de seguridad: no colgar la tool
        try {
          const nuevo = inyectarDatos(a.systemPrompt, ficha);
          const up = await rest('PUT', `/api/agents/${a.id}`, { systemPrompt: nuevo });
          if (up.ok) inyectados++;
        } catch { /* sigue con el resto */ }
      }
      // 5) guardar en la ficha
      ficha.agentes = fichaAgentes;
      ficha.paso = 'montado';
      await guardarFicha(uid, ficha);
      const listaAg = fichaAgentes.map((a) => `- ${a.nombre} (id ${a.id})`).join('\n');
      const faltaron = fichaAgentes.length - inyectados;
      return { content: [{ type: 'text', text:
        `EQUIPO MONTADO Y PERSONALIZADO.\n` +
        `- Instalados: ${instalados.length}${extraNombres.length ? ` + extra: ${extraNombres.join(', ')}` : ''}.\n` +
        `- Datos del negocio inyectados en ${inyectados} de ${fichaAgentes.length} agentes` +
        (faltaron > 0 ? ` (a ${faltaron} les faltan datos; vuelve a llamar wizard_montar para completar).` : ' (ya responden con horarios/precios/reglas reales).') +
        `\n\nAGENTES DEL NEGOCIO:\n${listaAg}\n\n` +
        `SIGUIENTE: si aprobaron automatizaciones, despliegalas con wizard_automatizar. ` +
        `Luego conecta WhatsApp con conectar_whatsapp y prueba cada agente con wizard_probar.` }] };
    },
  );

  // === 5. Automatizar: desplegar las automatizaciones aprobadas (crons) ===
  server.tool(
    'wizard_automatizar',
    'Despliega las AUTOMATIZACIONES aprobadas por el dueño: crea los crons en OpenClaw enganchados al agente que ' +
      'los ejecuta (recordatorios de citas, seguimiento postventa, reactivacion, reseñas, reportes, cobranza...). ' +
      'Pasa los ids de automatizacion (de wizard_diagnosticar). Requiere el equipo ya montado.',
    {
      ids: z.array(z.string()).describe('ids de automatizacion a desplegar, ej. ["recordatorio-citas","reporte-diario-dueno"]'),
      usuario: z.string().optional(),
    },
    async ({ ids, usuario }) => {
      const uid = usuario || 'tdx_demo';
      const { ficha } = await leerFicha(uid);
      if (!ficha || !ficha.agentes?.length) return { content: [{ type: 'text', text: 'Primero monta el equipo con wizard_montar.' }] };
      // helper: encontrar el agente del negocio que cumple una FUNCION.
      // Puntua cada agente por cuantas palabras de la funcion calzan en su nombre/descripcion;
      // asi "recordatorio-citas" (funcion agenda) cae en "Asistente de Agendamiento", no en el coordinador.
      const buscarPorFuncion = (funcion) => {
        const palabras = FUNCION_PALABRAS[funcion] || [funcion];
        let mejor = null, mejorPunt = 0;
        for (const a of ficha.agentes) {
          const txt = `${a.nombre} ${a.descripcion || ''}`.toLowerCase();
          const punt = palabras.reduce((s, w) => s + (txt.includes(w) ? 1 : 0), 0);
          if (punt > mejorPunt) { mejorPunt = punt; mejor = a; }
        }
        return mejor || ficha.agentes[0]; // si nada calza, al coordinador/primero
      };
      const creadas = [], fallidas = [];
      for (const id of ids) {
        const def = CATALOGO_AUTOMATIZACIONES.find((a) => a.id === id);
        if (!def) { fallidas.push(`${id} (no existe)`); continue; }
        const agente = buscarPorFuncion(def.funcion);
        const nombreSched = `${def.titulo} — ${ficha.negocio.nombre || uid}`;
        const r = await rest('POST', '/api/schedules', {
          name: nombreSched, agentId: agente.id, cron: def.cron,
          taskPrompt: def.taskPrompt, enabled: true,
        });
        if (r.ok && r.data?.id) creadas.push(`${def.titulo} (la corre ${agente.nombre}, ${def.cron})`);
        else fallidas.push(`${def.titulo}`);
      }
      // registrar en ficha
      ficha.automatizaciones = (ficha.automatizaciones || []).concat(creadas);
      await guardarFicha(uid, ficha);
      return { content: [{ type: 'text', text:
        `AUTOMATIZACIONES DESPLEGADAS (${creadas.length}):\n${creadas.map((c) => `- ${c}`).join('\n') || '- (ninguna)'}` +
        (fallidas.length ? `\n\nNo se pudieron crear: ${fallidas.join(', ')}` : '') +
        `\n\nYa quedan trabajando solas en el horario indicado. El dueño no tiene que hacer nada.` }] };
    },
  );

  // === 6. Probar un agente uno por uno (el dueño hace su prueba) ===
  server.tool(
    'wizard_probar',
    'PASO FINAL. Prueba un agente del negocio enviandole un mensaje como si fueras un cliente, para que el dueño vea ' +
      'que responde con SUS datos. Puedes pasar el agentId (de wizard_montar) o el nombre/funcion del agente ' +
      '(ej. "atencion", "agenda"); si no pasas ninguno, prueba el agente de atencion del negocio. ' +
      'Si no pasas mensaje, usa uno tipico.',
    {
      agentId: z.string().optional().describe('id del agente a probar (de la ficha, tras wizard_montar)'),
      agente: z.string().optional().describe('nombre o funcion del agente si no tienes el id, ej. "atencion", "agenda", "recordatorios"'),
      mensaje: z.string().optional().describe('mensaje de prueba como cliente; si se omite, se usa uno tipico'),
      usuario: z.string().optional(),
    },
    async ({ agentId, agente, mensaje, usuario }) => {
      const uid = usuario || 'tdx_demo';
      const { ficha } = await leerFicha(uid);
      // resolver el agente a probar: id explicito > por nombre/funcion > agente de atencion > primero de la ficha
      let objetivo = agentId;
      if (!objetivo && ficha?.agentes?.length) {
        const busca = (agente || 'atencion').toLowerCase();
        const palabras = FUNCION_PALABRAS[busca] || [busca];
        let mejor = null, mp = 0;
        for (const a of ficha.agentes) {
          const txt = `${a.nombre} ${a.descripcion || ''}`.toLowerCase();
          const punt = palabras.reduce((s, w) => s + (txt.includes(w) ? 1 : 0), 0);
          if (punt > mp) { mp = punt; mejor = a; }
        }
        // si no calzo por funcion, toma el de atencion o el primero
        objetivo = (mejor || ficha.agentes.find((a) => /atenci|recep/i.test(a.nombre)) || ficha.agentes[0]).id;
      }
      if (!objetivo) return { content: [{ type: 'text', text: 'No hay agente para probar. Monta el equipo con wizard_montar o pasa un agentId.' }] };
      const prueba = mensaje || 'Hola, buenas. Queria saber si atienden hoy, que precios manejan y como agendo una cita.';
      const r = await ordenar(prueba, { esperar: true, timeoutMs: 14000, agentId: objetivo });
      if (ficha && ficha.paso === 'montado') { ficha.paso = 'probado'; await guardarFicha(uid, ficha); }
      const nombreAg = ficha?.agentes?.find((a) => a.id === objetivo)?.nombre || objetivo;
      if (r.listo) {
        const limpia = limpiarRespuesta(r.result || r.error || r.status);
        return { content: [{ type: 'text', text:
          `PRUEBA del agente "${nombreAg}":\n\nCliente dijo: "${prueba}"\n\nAgente respondio:\n${limpia}\n\n` +
          `Preguntale al dueño si asi le sirve o quiere ajustar tono/reglas (se cambia al instante con configurar_agente).` }] };
      }
      // sin taskId: OpenClaw no acepto la orden a tiempo. Devolver claro, NO colgar.
      if (!r.taskId) {
        return { content: [{ type: 'text', text:
          `El agente "${nombreAg}" no alcanzo a responder en este intento (${r.error || 'timeout'}). ` +
          `Dile al dueño "dame un segundo" y vuelve a llamar wizard_probar; suele responder al segundo intento.` }] };
      }
      return { content: [{ type: 'text', text:
        `[EN PROCESO] El agente "${nombreAg}" esta respondiendo (taskId=${r.taskId}). Espera unos segundos y ` +
        `vuelve a consultar con openclaw_estado_tarea usando ese taskId (una sola vez mas, no en bucle).` }] };
    },
  );

  // ============================================================================
  // EL CUARTEL — captura autónoma de pendientes al backlog central.
  // ============================================================================

  // Helper: cualquier método al Cuartel con el token.
  async function cuartelReq(method, path, body) {
    if (!CUARTEL_URL || !CUARTEL_TOKEN) return { ok: false, error: 'Cuartel no configurado (falta CUARTEL_URL/CUARTEL_TOKEN)' };
    try {
      const opts = { method, headers: { Authorization: `Bearer ${CUARTEL_TOKEN}` } };
      if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      const r = await fetch(`${CUARTEL_URL}${path}`, opts);
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  const cuartelPost = (path, body) => cuartelReq('POST', path, body);
  // Formatea una tarea en una línea legible para el chat.
  const fmtTarea = (t) => {
    const venc = t.vence ? ` · vence ${String(t.vence).slice(0, 10)}` : '';
    const esf = t.esfuerzo ? ` [${t.esfuerzo}]` : '';
    const imp = t.importante ? ' ★' : '';
    const est = t.estado && t.estado !== 'abierta' ? ` (${t.estado})` : '';
    return `#${t.id} [${t.pilar || '—'}${t.proyecto ? '/' + t.proyecto : ''}] ${t.titulo}${esf}${venc}${imp}${est}`;
  };

  // TOOL PRINCIPAL: captura pendientes de este turno al backlog.
  // Claude la llama al final de cada turno donde detecte algo con trazabilidad.
  // Todo cae al backlog CRUDO — Freddy decide en el panel qué es tarea real.
  server.tool(
    'cuartel_capturar',
    'Registra en El Cuartel (centro de mando de Freddy) los pendientes, decisiones, acciones o cosas ' +
      'con trazabilidad que surgieron en este turno. CAPTURA TODO lo que podría ser un pendiente, sin filtrar: ' +
      'es preferible sobre-capturar (Freddy descarta luego en el panel) que perder algo. Cada item cae al ' +
      'BACKLOG crudo. Llama esta tool al final de cada turno de trabajo donde haya algo que rastrear.',
    {
      items: z.array(z.object({
        titulo: z.string().describe('El pendiente en una linea clara y accionable'),
        contexto: z.string().optional().describe('Por que surgio / de que se trata (para trazabilidad)'),
        pilar: z.enum(['TDX', 'CTG', 'Personal']).optional().describe('Pilar si es evidente; si no, dejalo vacio'),
        proyecto: z.string().optional().describe('Proyecto si se conoce, ej: Prosuministros, Ponencia'),
      })).describe('Lista de pendientes detectados en este turno'),
      fuente_ref: z.string().optional().describe('Nombre de la carpeta/proyecto de esta ventana de trabajo'),
      sesion: z.string().optional().describe('Identificador de la sesion/ventana (opcional)'),
    },
    async ({ items, fuente_ref, sesion }) => {
      if (!items?.length) return { content: [{ type: 'text', text: 'Sin pendientes que capturar.' }] };
      const conRef = items.map((it) => ({ ...it, fuente_ref: it.fuente_ref || fuente_ref }));
      const r = await cuartelPost('/api/capturar', { items: conRef, sesion });
      if (!r.ok) return { content: [{ type: 'text', text: `No se pudo capturar: ${r.error || r.status}` }] };
      return { content: [{ type: 'text', text: `Capturados ${r.data?.guardados ?? 0} pendientes al backlog del Cuartel.` }] };
    },
  );

  // TOOL: qué atacar hoy (lee el Cuartel priorizado).
  server.tool(
    'cuartel_hoy',
    'Devuelve la lista priorizada de pendientes de Freddy (por vencimiento + importancia) desde El Cuartel, ' +
      'con resumen por pilar. Usala cuando Freddy pregunte que atacar hoy o su estado de pendientes. ' +
      'Muestra el #id de cada tarea para poder completarla o editarla luego.',
    {},
    async () => {
      const r = await cuartelReq('GET', '/api/hoy');
      if (!r.ok) return { content: [{ type: 'text', text: `Error leyendo el Cuartel: ${r.error || r.status}` }] };
      const d = r.data;
      const lista = (d.hoy || []).slice(0, 20).map((t, i) => `${i + 1}. ${fmtTarea(t)}`).join('\n');
      const res = d.resumen ? `\n\nResumen: ${d.resumen.total} abiertas · ${JSON.stringify(d.resumen.porPilar)}` : '';
      return { content: [{ type: 'text', text: `QUE ATACAR HOY:\n${lista || 'Sin pendientes abiertos.'}${res}` }] };
    },
  );

  // TOOL: ver la bandeja de entrada (backlog crudo sin clasificar).
  server.tool(
    'cuartel_backlog',
    'Muestra la BANDEJA DE ENTRADA del Cuartel: los pendientes que se capturaron pero Freddy aun no ha ' +
      'clasificado como tarea real. Usala para revisar que hay por decidir. Muestra el #id de cada uno.',
    {},
    async () => {
      const r = await cuartelReq('GET', '/api/backlog');
      if (!r.ok) return { content: [{ type: 'text', text: `Error: ${r.error || r.status}` }] };
      const bk = r.data.backlog || [];
      if (!bk.length) return { content: [{ type: 'text', text: 'Bandeja de entrada vacía. Todo clasificado.' }] };
      const lista = bk.map((t) => `#${t.id} · ${t.titulo}${t.contexto ? `\n     ↳ ${t.contexto}` : ''}${t.fuente_ref ? ` [${t.fuente_ref}]` : ''}`).join('\n');
      return { content: [{ type: 'text', text: `BANDEJA DE ENTRADA (${bk.length} sin clasificar):\n${lista}` }] };
    },
  );

  // TOOL: clasificar una captura del backlog -> convertirla en tarea real.
  server.tool(
    'cuartel_clasificar',
    'Convierte una captura del backlog en una TAREA real (estado abierta), asignandole pilar, proyecto, ' +
      'fecha de vencimiento e importancia. Usala cuando Freddy diga que un item de la bandeja SI es tarea.',
    {
      id: z.number().int().describe('El #id de la captura en el backlog'),
      pilar: z.enum(['TDX', 'CTG', 'Personal']).describe('Pilar al que pertenece'),
      proyecto: z.string().optional().describe('Proyecto, ej: Prosuministros, Ponencia'),
      inicio: z.string().optional().describe('Fecha de inicio YYYY-MM-DD (cuándo empezar; opcional)'),
      vence: z.string().optional().describe('Deadline/fecha fin YYYY-MM-DD (opcional)'),
      esfuerzo: z.enum(['S', 'M', 'L', 'XL']).optional().describe('Talla de esfuerzo: S≈½h, M≈2h, L≈½día, XL≈+día'),
      importante: z.boolean().optional().describe('Marca ★ importante'),
    },
    async ({ id, pilar, proyecto, inicio, vence, esfuerzo, importante }) => {
      const body = { estado: 'abierta', pilar };
      if (proyecto !== undefined) body.proyecto = proyecto;
      if (inicio !== undefined) body.inicio = inicio;
      if (vence !== undefined) body.vence = vence;
      if (esfuerzo !== undefined) body.esfuerzo = esfuerzo;
      if (importante !== undefined) body.importante = importante;
      const r = await cuartelReq('PATCH', `/api/tareas/${id}`, body);
      if (!r.ok) return { content: [{ type: 'text', text: `No se pudo clasificar: ${r.error || r.status}` }] };
      return { content: [{ type: 'text', text: `Clasificada como tarea: ${fmtTarea(r.data.tarea)}` }] };
    },
  );

  // TOOL: descartar una captura (no era tarea real).
  server.tool(
    'cuartel_descartar',
    'Descarta una captura del backlog (marca que NO era una tarea real). Usala cuando Freddy diga que un ' +
      'item de la bandeja no sirve. No lo borra, lo archiva como descartado.',
    { id: z.number().int().describe('El #id de la captura a descartar') },
    async ({ id }) => {
      const r = await cuartelReq('PATCH', `/api/tareas/${id}`, { estado: 'descartada' });
      if (!r.ok) return { content: [{ type: 'text', text: `No se pudo descartar: ${r.error || r.status}` }] };
      return { content: [{ type: 'text', text: `Descartada la captura #${id}.` }] };
    },
  );

  // TOOL: crear una tarea manual directa (ya clasificada, no pasa por backlog).
  server.tool(
    'cuartel_crear',
    'Crea una tarea nueva ya clasificada en el Cuartel (estado abierta, aparece en Hoy). Usala cuando Freddy ' +
      'dicte un pendiente directo, ej: "agrega a CTG: llamar al cliente, vence viernes, importante".',
    {
      titulo: z.string().describe('El pendiente en una linea accionable'),
      pilar: z.enum(['TDX', 'CTG', 'Personal']).describe('Pilar'),
      proyecto: z.string().optional().describe('Proyecto (opcional)'),
      inicio: z.string().optional().describe('Fecha de inicio YYYY-MM-DD (cuándo empezar; opcional)'),
      vence: z.string().optional().describe('Deadline/fecha fin YYYY-MM-DD (opcional)'),
      esfuerzo: z.enum(['S', 'M', 'L', 'XL']).optional().describe('Talla de esfuerzo: S≈½h, M≈2h, L≈½día, XL≈+día'),
      importante: z.boolean().optional().describe('Marca ★ importante'),
      detalle: z.string().optional().describe('Detalle o nota (opcional)'),
    },
    async ({ titulo, pilar, proyecto, inicio, vence, esfuerzo, importante, detalle }) => {
      const r = await cuartelPost('/api/tareas', {
        titulo, pilar, proyecto, inicio, vence, esfuerzo, importante, detalle, estado: 'abierta', origen: 'manual',
      });
      if (!r.ok) return { content: [{ type: 'text', text: `No se pudo crear: ${r.error || r.status}` }] };
      return { content: [{ type: 'text', text: `Tarea creada: ${fmtTarea(r.data.tarea)}` }] };
    },
  );

  // TOOL: completar una tarea.
  server.tool(
    'cuartel_completar',
    'Marca una tarea como HECHA. Usala cuando Freddy diga que terminó un pendiente (por su #id).',
    { id: z.number().int().describe('El #id de la tarea a completar') },
    async ({ id }) => {
      const r = await cuartelReq('PATCH', `/api/tareas/${id}`, { estado: 'hecha' });
      if (!r.ok) return { content: [{ type: 'text', text: `No se pudo completar: ${r.error || r.status}` }] };
      return { content: [{ type: 'text', text: `✓ Completada la tarea #${id}.` }] };
    },
  );

  // TOOL: editar una tarea (cambiar titulo, pilar, fecha, importancia...).
  server.tool(
    'cuartel_editar',
    'Edita una tarea existente del Cuartel: cambia titulo, pilar, proyecto, inicio, deadline, esfuerzo o importancia. ' +
      'Pasa solo los campos que quieras cambiar (por el #id de la tarea).',
    {
      id: z.number().int().describe('El #id de la tarea'),
      titulo: z.string().optional(),
      pilar: z.enum(['TDX', 'CTG', 'Personal']).optional(),
      proyecto: z.string().optional(),
      inicio: z.string().optional().describe('Fecha de inicio YYYY-MM-DD (cuándo empezar)'),
      vence: z.string().optional().describe('Deadline/fecha fin YYYY-MM-DD'),
      esfuerzo: z.enum(['S', 'M', 'L', 'XL']).optional().describe('Talla: S≈½h, M≈2h, L≈½día, XL≈+día'),
      importante: z.boolean().optional(),
    },
    async ({ id, ...campos }) => {
      const body = Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) return { content: [{ type: 'text', text: 'Nada que editar: pasa al menos un campo.' }] };
      const r = await cuartelReq('PATCH', `/api/tareas/${id}`, body);
      if (!r.ok) return { content: [{ type: 'text', text: `No se pudo editar: ${r.error || r.status}` }] };
      return { content: [{ type: 'text', text: `Editada: ${fmtTarea(r.data.tarea)}` }] };
    },
  );

  // TOOL: listar tareas por pilar/estado (vista flexible).
  server.tool(
    'cuartel_listar',
    'Lista tareas del Cuartel con filtros opcionales por pilar (TDX/CTG/Personal) y estado ' +
      '(abierta/hecha/backlog/descartada). Sin filtros, lista las abiertas de todos los pilares.',
    {
      pilar: z.enum(['TDX', 'CTG', 'Personal']).optional(),
      estado: z.enum(['abierta', 'hecha', 'backlog', 'descartada']).optional(),
    },
    async ({ pilar, estado }) => {
      const qs = new URLSearchParams();
      qs.set('estado', estado || 'abierta');
      if (pilar) qs.set('pilar', pilar);
      const r = await cuartelReq('GET', `/api/tareas?${qs.toString()}`);
      if (!r.ok) return { content: [{ type: 'text', text: `Error: ${r.error || r.status}` }] };
      const ts = r.data.tareas || [];
      if (!ts.length) return { content: [{ type: 'text', text: 'No hay tareas con esos filtros.' }] };
      const lista = ts.slice(0, 40).map((t) => fmtTarea(t)).join('\n');
      return { content: [{ type: 'text', text: `TAREAS (${ts.length}):\n${lista}` }] };
    },
  );

  // TOOL: armar el plan del día (Mi Día).
  server.tool(
    'cuartel_mi_dia',
    'Arma el PLAN DEL DÍA de Freddy: primero lo que vence, luego prioridad, hasta llenar su capacidad de ' +
      'foco (4h/día por defecto, calculada de su calendario real). Devuelve qué atacar hoy en orden, ' +
      'cuántas horas suma y qué queda para después. Usala cuando Freddy diga "arma mi día", "qué hago hoy", ' +
      '"organiza mi día". Pasa horas si el día tiene menos/más foco de lo normal (ej. 3 si tiene muchas reuniones).',
    { horas: z.number().optional().describe('Horas de foco disponibles hoy (default 4)') },
    async ({ horas }) => {
      const qs = horas ? `?capacidad=${horas}` : '';
      const r = await cuartelReq('GET', `/api/mi-dia${qs}`);
      if (!r.ok) return { content: [{ type: 'text', text: `Error: ${r.error || r.status}` }] };
      const d = r.data;
      const lista = (d.plan || []).map((t, i) => {
        const venc = t.vence ? ` · vence ${String(t.vence).slice(0, 10)}` : '';
        const esf = t.esfuerzo ? ` [${t.esfuerzo}·${t._horas}h]` : ` [~${t._horas}h]`;
        return `${i + 1}. [${t.pilar || '—'}${t.proyecto ? '/' + t.proyecto : ''}] ${t.titulo}${esf}${venc}${t.importante ? ' ★' : ''}`;
      }).join('\n');
      const citas = (d.citas || []).map((t) => `◷ ${t.titulo}${t.vence ? ` (${String(t.vence).slice(0, 10)})` : ''}`).join('\n');
      const bal = d.resumen.porPilar ? Object.entries(d.resumen.porPilar).map(([p, n]) => `${p}:${n}`).join(' · ') : '';
      const alerta = d.sobrecarga ? `\n⚠ Plan supera tu foco (${d.horasPlaneadas}h > ${d.capacidadH}h) por tareas que vencen hoy.` : '';
      return { content: [{ type: 'text', text:
        `MI DÍA (${d.horasPlaneadas}h de ${d.capacidadH}h de foco · balance ${bal}):\n${lista || 'Nada que planear.'}` +
        (citas ? `\n\nCITAS de hoy (en tu calendario, no ocupan foco):\n${citas}` : '') +
        `\n\n${d.resumen.enPlan} tareas de foco · ${d.restantes} para después · vencen hoy: ${d.resumen.vencenHoy}${alerta}` }] };
    },
  );

  // TOOL: marcar como cita/evento (no consume foco) o volver a tarea.
  server.tool(
    'cuartel_marcar_cita',
    'Marca tareas como CITA/evento de calendario (no ocupan tiempo de foco en el plan del día) o las vuelve ' +
      'a tarea. Útil para terapias, citas médicas, reuniones ya agendadas. Puedes pasar un #id específico, o ' +
      'un patrón de texto para marcar todas las que lo contengan (ej. "matilde", "cita", "terapia").',
    {
      patron: z.string().optional().describe('Texto en el título para marcar en lote, ej: "matilde"'),
      id: z.number().int().optional().describe('O el #id de una tarea específica'),
      tipo: z.enum(['cita', 'tarea']).describe('cita = no ocupa foco; tarea = trabajo de foco'),
    },
    async ({ patron, id, tipo }) => {
      if (id) {
        const r = await cuartelReq('PATCH', `/api/tareas/${id}`, { tipo });
        if (!r.ok) return { content: [{ type: 'text', text: `Error: ${r.error || r.status}` }] };
        return { content: [{ type: 'text', text: `#${id} marcada como ${tipo}.` }] };
      }
      if (!patron) return { content: [{ type: 'text', text: 'Pasa un patrón de texto o un #id.' }] };
      const r = await cuartelReq('POST', '/api/marcar-tipo', { patron, tipo });
      if (!r.ok) return { content: [{ type: 'text', text: `Error: ${r.error || r.status}` }] };
      return { content: [{ type: 'text', text: `${r.data.actualizadas} tarea(s) con "${patron}" marcadas como ${tipo}.` }] };
    },
  );

  // TOOL: eliminar una tarea definitivamente.
  server.tool(
    'cuartel_eliminar',
    'Elimina una tarea del Cuartel de forma permanente (por su #id). Usala solo si Freddy pide borrarla ' +
      'de verdad; para archivar sin borrar, usa cuartel_completar o cuartel_descartar.',
    { id: z.number().int().describe('El #id de la tarea a eliminar') },
    async ({ id }) => {
      const r = await cuartelReq('DELETE', `/api/tareas/${id}`);
      if (!r.ok) return { content: [{ type: 'text', text: `No se pudo eliminar: ${r.error || r.status}` }] };
      return { content: [{ type: 'text', text: `Eliminada la tarea #${id}.` }] };
    },
  );

  return server;
}

// ---- HTTP (Streamable HTTP transport para la Claude app) --------------------

const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/', (_req, res) => res.json({ ok: true, service: 'openclaw-mcp-bridge', version: '10.0.2-web-test', openclaw: OPENCLAW_URL, control: '100%', auth: 'composio+whatsapp-qr', wizard: 'diagnostico+automatizaciones' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Pagina del QR de WhatsApp: lee el qrDataUrl del conector y lo muestra,
// auto-refrescando hasta que quede vinculado. El usuario abre este link desde el chat.
app.get('/qr/:connectorId', async (req, res) => {
  const cid = req.params.connectorId;
  const r = await rest('GET', `/api/connectors/${cid}`).catch(() => ({ data: null }));
  const c = r.data || {};
  const qr = c.qrDataUrl || null;
  const conectado = c.authenticated === true;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vincular WhatsApp</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0B0E18;color:#EDF0F7;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#161C2C;border:1px solid #2A3348;border-radius:20px;padding:32px 28px;max-width:400px;text-align:center}
  h1{font-size:1.4rem;margin:0 0 8px}
  p{color:#A6AFC6;margin:6px 0 20px;font-size:.95rem}
  .qr{background:#fff;border-radius:14px;padding:16px;display:inline-block}
  .qr img{width:260px;height:260px;display:block}
  .ok{color:#4FDDA0;font-size:1.1rem;font-weight:700}
  .wait{color:#F5B144;font-size:.9rem;margin-top:14px}
  ol{text-align:left;color:#A6AFC6;font-size:.88rem;margin:16px 0 0;padding-left:20px}
</style></head><body><div class="card">
${conectado
  ? `<h1>✅ WhatsApp conectado</h1><p class="ok">Ya puedes cerrar esta pagina. Tu agente empezara a atender este numero.</p>`
  : qr
    ? `<h1>📱 Vincula tu WhatsApp</h1><p>Escanea este codigo con tu telefono</p>
       <div class="qr"><img src="${qr}" alt="QR de WhatsApp"></div>
       <ol><li>Abre WhatsApp en tu telefono</li><li>Ajustes &gt; Dispositivos vinculados</li><li>Vincular un dispositivo</li><li>Escanea este QR</li></ol>
       <p class="wait">El codigo se actualiza solo. Esperando escaneo...</p>`
    : `<h1>Generando el codigo...</h1><p class="wait">Espera unos segundos, el QR aparecera aqui.</p>`}
</div>
<script>setTimeout(function(){location.reload()}, ${conectado ? 999999 : 5000});</script>
</body></html>`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

app.post('/mcp', async (req, res) => {
  try {
    const server = nuevoServidor();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e.message || e) }, id: null });
    }
  }
});

app.listen(PORT, () => {
  console.log(`openclaw-mcp-bridge v2 (control 100%) escuchando en :${PORT}`);
  console.log(`  OpenClaw: ${OPENCLAW_URL} (agente ${OPENCLAW_AGENT})`);
  console.log(`  MCP endpoint: .../mcp`);
});
