import http from 'k6/http';
import { check, sleep } from 'k6';

// ─────────────────────────────────────────────────────────────────────
// CONCURRENCY PROBE — ¿dónde está el límite de cada modelo?
//
// Distinto de load-test.js: este script NO compara escenarios variados,
// sino que sube la concurrencia en escalones sobre un único endpoint
// (/slow) para encontrar el punto de quiebre de cada framework.
//
//   docker compose run --rm k6 run --env TARGET=mvc  /scripts/concurrency-probe.js
//   docker compose run --rm k6 run --env TARGET=flux /scripts/concurrency-probe.js
//
// HIPÓTESIS QUE PONE A PRUEBA
//
// MVC: techo aritmético de 200 hilos / 2 s = 100 req/s. Sistema cerrado,
// así que por la ley de Little la latencia debería crecer lineal con la
// concurrencia: latencia ≈ VUs / 100. Predicción por escalón:
//     200 VUs -> ~2 s     (aún no satura: 200x(2/2.5) = 160 < 200 hilos)
//     400 VUs -> ~4 s
//     800 VUs -> ~8 s
//    1600 VUs -> ~16 s
//    3200 VUs -> ~32 s
//
// WebFlux: sin techo de hilos. Debería quedarse plano en ~2 s hasta que
// aparezca otro cuello de botella (pool de R2DBC de 20 conexiones,
// memoria, o CPU del event loop).
//
// TIMEOUT DE 90 s A PROPÓSITO
// El timeout del cliente es lo que convierte latencia en errores. Con los
// 15 s de load-test.js, MVC empezaría a fallar por timeout cerca de los
// 1500 VUs y no podríamos medir la latencia real de la cola. Acá se sube
// a 90 s para observar el encolamiento sin truncarlo.
// ─────────────────────────────────────────────────────────────────────

const TARGET = __ENV.TARGET || 'mvc';

const IN_NETWORK_URLS = {
    mvc: 'http://mvc-app:8080',
    flux: 'http://webflux-app:8080',
};

if (!IN_NETWORK_URLS[TARGET]) {
    throw new Error(`TARGET invalido: "${TARGET}". Usa "mvc" o "flux".`);
}

const BASE_URL = __ENV.BASE_URL || IN_NETWORK_URLS[TARGET];
const OUT_DIR = __ENV.OUT_DIR || '.';

// Escalones de concurrencia. Cada uno es su propio escenario para que k6
// lo etiquete por separado y podamos ver la curva escalón por escalón.
//
// Configurable porque el techo detectable está acotado por los VUs: con N
// usuarios y un ideal de 2 s + 0.5 s de think time, el throughput máximo
// que se puede provocar es N / 2.5 req/s. Con 3200 VUs eso son 1280 req/s,
// así que para buscar techos más altos hay que agregar escalones:
//
//   --env STEPS=200,400,800,1600,3200,6400
const STEPS = (__ENV.STEPS || '200,400,800,1600,3200')
    .split(',')
    .map((s) => parseInt(s.trim(), 10));
const STEP_DURATION = 45;   // s de carga sostenida por escalón
const STEP_GAP = 15;        // s de respiro entre escalones (drenar la cola)

const scenarios = {};
const thresholds = {};

STEPS.forEach((vus, i) => {
    const name = `vu_${vus}`;
    scenarios[name] = {
        executor: 'constant-vus',
        vus: vus,
        duration: `${STEP_DURATION}s`,
        exec: 'slowEndpoint',
        startTime: `${i * (STEP_DURATION + STEP_GAP)}s`,
        tags: { step: String(vus) },
        gracefulStop: '30s',
    };

    // Declarar el threshold es lo que hace que k6 exponga la sub-métrica
    // de este escalón por separado en handleSummary.
    thresholds[`http_req_duration{step:${vus}}`] = ['max>=0'];
    thresholds[`http_req_failed{step:${vus}}`] = ['rate>=0'];
    thresholds[`iterations{step:${vus}}`] = ['count>=0'];
});

export const options = {
    scenarios,
    thresholds,
    summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
    discardResponseBodies: false,
};

export function slowEndpoint() {
    const res = http.get(`${BASE_URL}/api/catalogs/slow`, { timeout: '90s' });

    check(res, { 'status is 200': (r) => r.status === 200 });

    sleep(0.5);
}

export function handleSummary(data) {
    const m = data.metrics;
    const lines = [];
    const W = 86;

    lines.push(`\n${'='.repeat(W)}`);
    lines.push(`  CONCURRENCY PROBE: ${TARGET.toUpperCase()}  (${BASE_URL})`);
    lines.push(`  endpoint /api/catalogs/slow  |  ideal teorico = 2000 ms`);
    lines.push(`${'='.repeat(W)}\n`);

    lines.push(
        '  ' +
        'VUs'.padStart(6) +
        'avg'.padStart(10) +
        'p95'.padStart(10) +
        'p99'.padStart(10) +
        'max'.padStart(10) +
        'err%'.padStart(8) +
        'req/s'.padStart(9) +
        'vs ideal'.padStart(10)
    );
    lines.push('  ' + '-'.repeat(W - 4));

    const rows = [];

    for (const vus of STEPS) {
        const dur = m[`http_req_duration{step:${vus}}`];
        const fail = m[`http_req_failed{step:${vus}}`];
        const iters = m[`iterations{step:${vus}}`];
        if (!dur) { continue; }

        const v = dur.values;
        const errPct = fail ? (fail.values.rate * 100) : 0;
        const rps = iters ? iters.values.count / STEP_DURATION : 0;
        const ratio = v.avg / 2000;

        rows.push({ vus, avg: v.avg, err: errPct, rps: rps, ratio: ratio });

        lines.push(
            '  ' +
            String(vus).padStart(6) +
            v.avg.toFixed(0).padStart(10) +
            (v['p(95)'] !== undefined ? v['p(95)'].toFixed(0) : '-').padStart(10) +
            (v['p(99)'] !== undefined ? v['p(99)'].toFixed(0) : '-').padStart(10) +
            v.max.toFixed(0).padStart(10) +
            errPct.toFixed(2).padStart(8) +
            rps.toFixed(1).padStart(9) +
            (ratio.toFixed(2) + 'x').padStart(10)
        );
    }

    // Validez: si k6 no alcanzo a generar la carga, el generador fue el
    // cuello de botella y el escalon no dice nada sobre la app.
    const dropped = m.dropped_iterations ? m.dropped_iterations.values.count : 0;
    lines.push('');
    lines.push(
        dropped > 0
            ? `  [!] dropped_iterations = ${dropped} -> el GENERADOR se quedo corto en algun escalon.`
            : `  dropped_iterations = 0 -> k6 sostuvo todos los escalones.`
    );

    lines.push(`${'='.repeat(W)}\n`);

    return {
        stdout: lines.join('\n'),
        [`${OUT_DIR}/probe-${TARGET}.json`]: JSON.stringify({
            run: { target: TARGET, base_url: BASE_URL, steps: STEPS, step_duration_s: STEP_DURATION, timestamp: new Date().toISOString() },
            rows: rows,
            metrics: m,
        }, null, 2),
    };
}
