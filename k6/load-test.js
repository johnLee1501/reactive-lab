import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ─────────────────────────────────────────────────────
// CONFIGURATION
//
// Dentro de la red de compose (forma recomendada):
//   docker compose run --rm k6 run --env TARGET=mvc  /scripts/load-test.js
//   docker compose run --rm k6 run --env TARGET=flux /scripts/load-test.js
//
// Desde el host, con k6 nativo (agrega el salto del proxy de puertos
// de Docker Desktop, así que los números salen algo peores):
//   k6 run --env TARGET=mvc --env BASE_URL=http://localhost:8081 k6/load-test.js
// ─────────────────────────────────────────────────────

const TARGET = __ENV.TARGET || 'mvc';

// Nombres de servicio de compose: el tráfico va container a container.
const IN_NETWORK_URLS = {
    mvc: 'http://mvc-app:8080',
    flux: 'http://webflux-app:8080',
};

if (!IN_NETWORK_URLS[TARGET]) {
    throw new Error(`TARGET invalido: "${TARGET}". Usa "mvc" o "flux".`);
}

const BASE_URL = __ENV.BASE_URL || IN_NETWORK_URLS[TARGET];

// Directorio de salida del JSON. En el contenedor lo inyecta compose
// como /results (bind mount a ./results en el host).
const OUT_DIR = __ENV.OUT_DIR || '.';

// Custom metrics for clearer reporting
const errorRate = new Rate('custom_errors');
const catalogLatency = new Trend('catalog_latency', true);
const slowLatency = new Trend('slow_endpoint_latency', true);

// ─────────────────────────────────────────────────────────────────────
// ESCENARIOS
//
// 0. warmup   (0s-20s)     20 VUs  → /api/catalogs
//    No es una medición: existe para que el JIT compile los caminos
//    calientes y para que los pools de conexiones se llenen. Sin esto,
//    el primer escenario real mide compilación en lugar de rendimiento.
//    Se excluye del reporte.
//
// 1. baseline (25s-55s)    50 VUs  → /api/catalogs
//    Tráfico normal. Los dos deberían ir cómodos.
//
// 2. stress   (60s-120s)   10→300  → /api/catalogs
//    Sube la concurrencia sobre el endpoint que devuelve 1000 filas.
//    OJO con la expectativa: este escenario mide sobre todo costo de
//    serialización, y ahí MVC (JDBC + Jackson) tiene ventaja real sobre
//    WebFlux (R2DBC + Reactor), que paga más overhead por fila.
//    Si MVC gana acá, no es un error del lab: es el resultado correcto.
//
// 3. slow_io  (125s-185s)  50→600  → /api/catalogs/slow
//    EL ESCENARIO QUE IMPORTA. Acá se aísla el modelo de ejecución.
//
//    La aritmética de la calibración:
//      · Tomcat tiene 200 hilos (default de Spring, sin tocar).
//      · /slow retiene su hilo 2s, así que el techo de MVC es
//        200 hilos / 2s = 100 req/s.
//      · 600 VUs con respuesta de 2s + 0.5s de think time dan un ciclo
//        de 2.5s, o sea una demanda de 600 / 2.5 = 240 req/s.
//      · 240 pedidos contra 100 de capacidad = 2.4x sobresuscrito.
//      · Por la ley de Little, en saturación la latencia se estabiliza
//        en 600 VUs / 100 req/s = ~6s.
//
//    WebFlux no tiene ese techo: no hay hilo retenido durante la espera,
//    así que debería quedarse pegado a los 2s del delay.
//
//    Con los 200 VUs de la calibración anterior la concurrencia efectiva
//    era 200 × (2 / 2.5) = 160 < 200 hilos. MVC nunca encolaba nada y los
//    dos frameworks daban el mismo número. Medido: 2032ms vs 2040ms y 0%
//    de error en ambos. El escenario no probaba nada.
//
//    Se deja Tomcat en su default a propósito: bajar el pool de hilos
//    haría aparecer el quiebre más rápido, pero invita a la objeción de
//    "configuraste MVC para que fallara". Subir la carga no.
//
// 4. spike    (190s-220s)  0→500→0 → /api/catalogs
//    Pico súbito. Mide cómo absorbe cada uno un cambio brusco de carga.
// ─────────────────────────────────────────────────────────────────────

export const options = {
    scenarios: {

        warmup: {
            executor: 'constant-vus',
            vus: 20,
            duration: '20s',
            exec: 'catalogEndpoint',
            tags: { scenario: 'warmup' },
        },

        baseline: {
            executor: 'constant-vus',
            vus: 50,
            duration: '30s',
            exec: 'catalogEndpoint',
            startTime: '25s',
            tags: { scenario: 'baseline' },
        },

        stress: {
            executor: 'ramping-vus',
            startVUs: 10,
            stages: [
                { duration: '15s', target: 100 },
                { duration: '30s', target: 300 },
                { duration: '15s', target: 300 },
            ],
            exec: 'catalogEndpoint',
            startTime: '60s',
            tags: { scenario: 'stress' },
        },

        slow_io: {
            executor: 'ramping-vus',
            startVUs: 50,
            stages: [
                { duration: '15s', target: 600 },   // rampa: se ve el punto de quiebre
                { duration: '45s', target: 600 },   // saturación sostenida
            ],
            exec: 'slowEndpoint',
            startTime: '125s',
            tags: { scenario: 'slow_io' },
        },

        spike: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '5s',  target: 500 },
                { duration: '20s', target: 500 },
                { duration: '5s',  target: 0 },
            ],
            exec: 'catalogEndpoint',
            startTime: '190s',
            tags: { scenario: 'spike' },
        },
    },

    // Los thresholds cumplen doble función. Además de validar, declarar
    // uno sobre una sub-métrica con tag hace que k6 la exponga por
    // separado en handleSummary. Sin esto, data.metrics solo trae el
    // agregado global de los 5 escenarios mezclados, que para comparar
    // dos modelos de ejecución no dice nada útil.
    thresholds: {
        http_req_failed: ['rate<0.5'],
        custom_errors: ['rate<0.5'],

        'http_req_duration{scenario:baseline}': ['p(95)<5000'],
        'http_req_duration{scenario:stress}': ['p(95)<15000'],
        'http_req_duration{scenario:slow_io}': ['p(95)<30000'],
        'http_req_duration{scenario:spike}': ['p(95)<20000'],

        'http_req_failed{scenario:baseline}': ['rate<0.5'],
        'http_req_failed{scenario:stress}': ['rate<0.5'],
        'http_req_failed{scenario:slow_io}': ['rate<0.5'],
        'http_req_failed{scenario:spike}': ['rate<0.5'],
    },

    // Por defecto k6 no calcula p99, y la cola es justo donde se ve la
    // diferencia entre los dos modelos: el promedio esconde el problema.
    summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

// ─────────────────────────────────────────────────────
// TEST FUNCTIONS
// ─────────────────────────────────────────────────────

export function catalogEndpoint() {
    const res = http.get(`${BASE_URL}/api/catalogs`);

    catalogLatency.add(res.timings.duration);

    const passed = check(res, {
        'status is 200': (r) => r.status === 200,
        'response has data': (r) => r.body.length > 100,
    });

    errorRate.add(!passed);
    sleep(0.1); // small think-time between requests
}

export function slowEndpoint() {
    const res = http.get(`${BASE_URL}/api/catalogs/slow`, {
        timeout: '15s',
    });

    slowLatency.add(res.timings.duration);

    const passed = check(res, {
        'status is 200': (r) => r.status === 200,
        'has framework info': (r) => {
            try {
                const body = JSON.parse(r.body);
                return body.framework !== undefined;
            } catch {
                return false;
            }
        },
    });

    errorRate.add(!passed);
    sleep(0.5);
}

// ─────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────

export function handleSummary(data) {
    // El JSON queda autodescriptivo: al comparar dos corridas necesitas
    // saber contra qué apuntó cada una y cuándo se ejecutó.
    const output = {
        run: {
            target: TARGET,
            base_url: BASE_URL,
            timestamp: new Date().toISOString(),
        },
        metrics: data.metrics,
        root_group: data.root_group,
    };

    const filename = `${OUT_DIR}/results-${TARGET}.json`;

    return {
        stdout: textSummary(data),
        [filename]: JSON.stringify(output, null, 2),
    };
}

// Escenarios que se reportan, en orden de ejecución. warmup queda fuera
// a propósito: es calentamiento de JIT, no una medición.
const REPORTED_SCENARIOS = [
    { name: 'baseline', endpoint: '/api/catalogs' },
    { name: 'stress', endpoint: '/api/catalogs' },
    { name: 'slow_io', endpoint: '/slow' },
    { name: 'spike', endpoint: '/api/catalogs' },
];

function ms(value) {
    return value === undefined || value === null ? '-' : value.toFixed(0);
}

function textSummary(data) {
    const metrics = data.metrics;
    const lines = [];
    const W = 74;

    lines.push(`\n${'='.repeat(W)}`);
    lines.push(`  ${TARGET.toUpperCase()}  (${BASE_URL})`);
    lines.push(`${'='.repeat(W)}`);

    // ── Desglose por escenario ───────────────────────────────────────
    // El agregado global mezcla 5 escenarios con perfiles de carga
    // distintos, así que su promedio no significa nada. Lo que compara
    // de verdad es cada escenario contra su equivalente en la otra app.
    lines.push(`\n  LATENCIA POR ESCENARIO (ms)\n`);
    lines.push(
        '  ' +
        'escenario'.padEnd(11) +
        'endpoint'.padEnd(17) +
        'avg'.padStart(8) +
        'p95'.padStart(8) +
        'p99'.padStart(8) +
        'max'.padStart(8) +
        'err%'.padStart(8)
    );
    lines.push('  ' + '-'.repeat(W - 4));

    for (const sc of REPORTED_SCENARIOS) {
        const dur = metrics[`http_req_duration{scenario:${sc.name}}`];
        const fail = metrics[`http_req_failed{scenario:${sc.name}}`];

        if (!dur) {
            continue;
        }

        const v = dur.values;
        const errPct = fail ? (fail.values.rate * 100).toFixed(2) : '-';

        lines.push(
            '  ' +
            sc.name.padEnd(11) +
            sc.endpoint.padEnd(17) +
            ms(v.avg).padStart(8) +
            ms(v['p(95)']).padStart(8) +
            ms(v['p(99)']).padStart(8) +
            ms(v.max).padStart(8) +
            String(errPct).padStart(8)
        );
    }

    // ── Totales ─────────────────────────────────────────────────────
    lines.push(`\n  TOTALES (incluye warmup)\n`);

    if (metrics.http_reqs) {
        lines.push(`    Requests:        ${metrics.http_reqs.values.count}`);
        lines.push(`    Requests/seg:    ${metrics.http_reqs.values.rate.toFixed(1)}`);
    }

    if (metrics.http_req_failed) {
        lines.push(`    Error rate:      ${(metrics.http_req_failed.values.rate * 100).toFixed(2)}%`);
    }

    // ── Validez de la corrida ───────────────────────────────────────
    // Si k6 no alcanzó a lanzar las iteraciones pedidas, el generador de
    // carga fue el cuello de botella y esta corrida NO es comparable.
    const dropped = metrics.dropped_iterations
        ? metrics.dropped_iterations.values.count
        : 0;

    // Solo ASCII en la salida a stdout: la consola de Windows no usa UTF-8
    // por defecto y los guiones largos salen como "ΓÇö".
    lines.push(
        dropped > 0
            ? `\n  [!] dropped_iterations = ${dropped} -> CORRIDA NO VALIDA: k6 no alcanzo a generar la carga pedida`
            : `\n  dropped_iterations = 0 -> corrida valida, k6 genero toda la carga`
    );

    lines.push(`${'='.repeat(W)}\n`);
    return lines.join('\n');
}
