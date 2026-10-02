# Guion del Wizard "Pega y Listo" (para Claude)

Filosofia: **wow en 60 segundos, cero interrogatorios.** El dueño da UN dato (el link
de su web/Instagram/Google Maps) y Claude hace TODO lo demas: lee la pagina, rellena
la ficha, monta los agentes con sus datos reales y le muestra uno respondiendo. Los
ajustes van despues y son OPCIONALES.

Esto reemplaza el viejo flujo de 15 preguntas encadenadas (era largo y engorroso; ver
la tesis de onboarding sin friccion). El principio probado: el usuario debe SENTIR el
valor ANTES de configurar nada.

## El flujo (3 pasos, no 6)

### Paso 1 — UNA pregunta
`wizard_iniciar` -> luego tu primer mensaje al dueño es una sola pregunta corta:
   "¡Genial! Para dejarte los agentes listos con tus datos, pasame el link de tu pagina
    web, tu Instagram o tu Google Maps. Si no tienes, cuentame en una frase a que te dedicas."

### Paso 2 — Claude hace el trabajo (sin preguntar mas)
Cuando de el link:
   a) LEE esa URL con WebFetch/fetch. Extrae lo que encuentres: nombre, a que se dedica,
      servicios y precios, horarios, telefono/redes.
   b) Deduce el nicho y elige el equipo que mejor calce.
   c) Llama UNA VEZ a `wizard_ficha_completa` con todo (equipo + datos). Lo que no
      encuentres, omitelo — NO lo preguntes.
Si dio una frase en vez de link: arma una ficha base con el equipo del rubro y los datos
que dijo; los precios exactos se completan despues, no los pidas ahora.

### Paso 3 — Montar + el momento WOW
   - `wizard_montar` (de inmediato).
   - `wizard_probar` con UN solo agente. Muestrale la respuesta con sus datos:
     "Mira, ya tu agente responde asi cuando te escribe un cliente ->".
   - NO encadenes 3 pruebas (se cuelga y aburre). Una y listo.

### Despues del wow — ajustes OPCIONALES (solo si el dueño quiere)
En UNA linea: "¿Quieres afinar el tono, agregar recordatorios automaticos, o conectar
tu WhatsApp?". Si dice que si:
   - Tono/reglas: `wizard_guardar_dato` + `wizard_montar` (re-inyecta).
   - Automatizaciones: `wizard_diagnosticar` (pasa lo que diga) -> `wizard_automatizar`.
   - WhatsApp: `conectar_whatsapp` (link con QR).
Si dice que no: cierra. Ya tiene valor.

## Prohibido
- Menus tecnicos ("configurar nucleo", "limpiar duplicados").
- Preguntar 7 datos uno por uno.
- Encadenar varias pruebas de agentes en un turno.
- Usar openclaw_api / listar_agentes en el wizard.

## Tools del wizard
- `wizard_iniciar` — arranca/retoma, da este guion y la lista de equipos.
- `wizard_ficha_completa` — rellena TODA la ficha de una vez (tras leer la web). LA CLAVE del flujo rapido.
- `wizard_guardar_dato` — un dato suelto (para ajustes puntuales despues).
- `wizard_diagnosticar` — detecta automatizaciones + agentes extra (solo si el dueño pide mas).
- `wizard_montar` — instala el equipo e inyecta los datos. Robusto (identifica agentes por createdAt).
- `wizard_automatizar` — despliega crons.
- `wizard_probar` — prueba UN agente; sin agentId, elige el de atencion solo.

## Notas tecnicas
- La ficha vive como document en OpenClaw (`wizard_ficha_<usuario>`). Checkpoint/resume.
- `wizard_montar` y `ordenar()` tienen timeouts duros: no cuelgan aunque OpenClaw tarde.
- La inyeccion pone `## Datos de este negocio` al final del prompt; sin marcas de ninguna empresa.
