# Reactive Lab: Spring MVC vs Spring WebFlux

Laboratorio para medir cómo se comportan dos backends idénticos —uno imperativo,
uno reactivo— ante el mismo perfil de carga, con los mismos recursos y contra la
misma base de datos. La única variable es el modelo de ejecución.

## Qué mide este laboratorio, y qué no

**Mide** la diferencia relativa entre dos modelos de ejecución bajo condiciones
controladas e idénticas. Concretamente: qué pasa cuando un hilo se queda
bloqueado esperando I/O contra qué pasa cuando el event loop registra un
callback y sigue atendiendo.

**No mide** rendimiento absoluto de producción. Los números salen de una laptop
con Docker Desktop sobre WSL2, no de hardware dedicado. Los valores absolutos no
son transferibles; la comparación relativa sí, porque las dos apps corren bajo
exactamente las mismas restricciones.

Esa distinción importa: el objetivo es aislar una variable, no publicar un
benchmark.

## Resultados medidos

Corridas del 14 de septiembre de 2026. Cada app medida en aislamiento (la otra
apagada), k6 generando carga desde dentro de la red de contenedores.
`dropped_iterations = 0` en ambas, o sea que k6 generó toda la carga pedida y las
dos corridas son comparables.

Los números de abajo son los que están en `results/`, reproducibles con
`.\run-lab.ps1 -Action test -Target both`.

### `slow_io` — 600 VUs sobre `/api/catalogs/slow`

Este es el escenario que aísla el modelo de ejecución. Ambas apps hacen
exactamente el mismo trabajo: esperar 2 segundos y ejecutar un `count()`.

| | MVC | WebFlux |
|---|---|---|
| avg | 4918 ms | **2012 ms** |
| p95 | 5513 ms | **2077 ms** |
| p99 | 5519 ms | **2208 ms** |
| max | 5531 ms | **2389 ms** |
| errores | 0% | 0% |
| **hilos vivos (pico)** | **215** | **22** |

El ideal teórico de este endpoint es 2000 ms: los 2 s de espera más un `count()`
que cuesta entre 4 y 8 ms. WebFlux queda a 12 ms de ese ideal en promedio y a
208 ms en el p99, con 600 usuarios concurrentes. MVC se va a 4918 ms, o sea
**2.5x el ideal**, y su distribución se aplana arriba (p95, p99 y max casi
idénticos) porque la cola de espera domina todo.

MVC llega a 215 hilos vivos: los 200 de Tomcat saturados más los internos de la
JVM. WebFlux sostiene la misma concurrencia con 22.

### Escenarios sobre `/api/catalogs` (1000 filas por respuesta)

| escenario | carga | métrica | MVC | WebFlux |
|---|---|---|---|---|
| baseline | 50 VUs | avg / p95 | **147** / **288** ms | 328 / 498 ms |
| stress | 10→300 VUs | avg / p95 | **618** / **1277** ms | 1308 / 2372 ms |
| spike | 0→500→0 VUs | avg / p95 | **1511** / **2372** ms | 2885 / 3780 ms |

Acá gana MVC, y no es un error del laboratorio: es el resultado correcto. Estos
escenarios están dominados por el costo de serializar 1000 filas, y JDBC +
Jackson paga menos overhead por fila que R2DBC + Reactor.

### Totales

| | MVC | WebFlux |
|---|---|---|
| requests | 38,191 | 30,028 |
| req/s | 173.6 | 136.2 |
| error rate | 0% | 0% |
| hilos (reposo → pico) | 24 → 215 | 20 → 22 |

## Cómo leer estos resultados

**El modelo reactivo gana cuando el cuello de botella es esperar.** En `slow_io`
la app no hace trabajo: espera. MVC paga un hilo por cada espera simultánea y se
topa con su pool. WebFlux no paga nada, y por eso sostiene 600 concurrentes con
22 hilos.

**El modelo imperativo gana cuando el cuello de botella es procesar bytes.**
Traer y serializar 1000 filas es trabajo de CPU y memoria. Ahí el overhead por
fila de la pila reactiva se nota, y MVC sale entre 1.9x y 2.2x mejor en promedio.

**WebFlux acota mejor el peor caso.** En `stress` su máximo es 2501 ms contra
3790 ms de MVC, y en `spike` 4111 ms contra 4460 ms, aunque pierde el promedio en
los dos. Peor throughput, mejor latencia de cola: Netty aplica contrapresión y el
peor caso queda contenido. Si tu SLA se escribe en p99 y no en promedio, eso pesa.
En `baseline` la relación se invierte (702 ms de MVC contra 777 ms), pero la
diferencia es chica y cae dentro del ruido entre corridas.

**No hubo un solo error en ninguna corrida.** Ni un 503. La degradación de MVC es
de latencia, no de disponibilidad. Provocar errores requeriría empujar la carga a
extremos que invitan a la objeción de "lo configuraste para que fallara".

La conclusión útil no es "reactivo es mejor". Es que la elección depende de dónde
está tu cuello de botella: si tu servicio pasa el tiempo esperando a terceros,
el modelo reactivo te da headroom que el imperativo no; si pasa el tiempo
moviendo payloads grandes, el imperativo es más eficiente.

## Arquitectura

```
Windows + Docker Desktop
│
└── VM WSL2 (kernel Linux real, 16 CPU / 15.5 GB disponibles)
    │
    └── red bridge  reactive-lab-net
        │
        ├── k6            4 CPU / 1 GB    (generador de carga)
        │    │
        │    ├──► mvc-app:8080      2 CPU / 1 GB   Tomcat + JDBC
        │    └──► webflux-app:8080  2 CPU / 1 GB   Netty + R2DBC
        │              │
        │              └──► mysql:3306   4 CPU / 2 GB   1000 catálogos
```

k6 vive dentro de la red y apunta a los nombres de servicio, así que el tráfico
de carga va container a container. No atraviesa el proxy de puertos de Docker
Desktop, que en Windows es la principal fuente de ruido en la medición.

Los puertos publicados (`8081`, `8082`, `3307`) quedan solo para inspección
manual: curl, actuator, cliente de MySQL.

### Igualdad de condiciones

Las dos apps reciben recursos y opciones de JVM idénticas, declaradas una sola
vez con anclas YAML en el compose para que no puedan desincronizarse por
descuido:

- 2 CPU / 1 GB por app (cgroups reales, verificables con `docker inspect`)
- `-XX:MaxRAMPercentage=50.0 -XX:+UseG1GC` en ambas
- Spring Boot 3.2.5, Java 17, misma imagen base

MySQL va deliberadamente holgado (4 CPU / 2 GB) porque es la dependencia
compartida, no el sujeto del experimento. Si la base se estrangula, las dos apps
se frenan por igual y el laboratorio no muestra nada.

## Requisitos

- Docker Desktop con Compose v2 (probado en v2.24.5)
- PowerShell 5.1 o superior (Windows), o bash con los comandos de compose directos

k6 **no** hace falta instalarlo: corre como contenedor (`grafana/k6:1.8.1`).

## Cómo correrlo

### Windows (PowerShell)

```powershell
.\run-lab.ps1                          # build + mide ambas + compara
.\run-lab.ps1 -Action test -Target mvc # solo MVC
.\run-lab.ps1 -Action compare          # recompara resultados ya guardados
.\run-lab.ps1 -Action status           # qué está arriba
.\run-lab.ps1 -Action down             # limpiar
```

El script levanta cada app en aislamiento, lanza k6 dentro de la red y muestrea
`jvm.threads.live` vía actuator durante la corrida.

### Compose directo (cualquier plataforma)

Los perfiles garantizan el aislamiento: `docker compose up -d` a secas levanta
únicamente MySQL, así que no se pueden arrancar las dos apps por accidente y
contaminar la medición.

```bash
docker compose --profile mvc up -d --build
docker compose run --rm k6 run --env TARGET=mvc /scripts/load-test.js
docker compose --profile mvc stop mvc-app

docker compose --profile flux up -d --build
docker compose run --rm k6 run --env TARGET=flux /scripts/load-test.js

docker compose --profile mvc --profile flux --profile load down
```

Los resultados quedan en `results/`:

| archivo | contenido |
|---|---|
| `results-mvc.json` | métricas completas de k6, con desglose por escenario |
| `results-flux.json` | idem |
| `threads-mvc.csv` | serie temporal de `jvm.threads.live` |
| `threads-flux.csv` | idem |

## Endpoints

Ambas apps exponen la misma superficie:

| Endpoint | Descripción |
|---|---|
| `GET /api/catalogs` | 1000 catálogos completos (323 KB por respuesta) |
| `GET /api/catalogs/{id}` | Un catálogo por ID |
| `GET /api/catalogs/category/{cat}` | Filtrar por categoría |
| `GET /api/catalogs/slow` | **Endpoint clave** — 2 s de espera + `count()` |
| `GET /api/catalogs/health-check` | Estado + nombre del hilo que atendió |
| `GET /actuator/health` | Health check de Spring |
| `GET /actuator/metrics/jvm.threads.live` | Hilos vivos en la JVM |

`/slow` es el corazón del laboratorio y hace **exactamente el mismo trabajo de
base de datos en las dos apps**: un `count()` y nada más. La única diferencia es
cómo se maneja la espera:

```java
// MVC — el hilo de Tomcat queda BLOQUEADO 2 segundos
Thread.sleep(2000);
long count = catalogRepository.count();

// WebFlux — se registra un timer, el hilo sigue libre
return Mono.delay(Duration.ofSeconds(2))
        .then(catalogRepository.count());
```

Si cambias el query de un lado, tienes que cambiarlo del otro. Si no, el
endpoint mide dos cosas a la vez y la comparación deja de valer.

## Escenarios de carga

`k6/load-test.js` corre cinco fases en secuencia (~220 s por app):

| fase | ventana | carga | endpoint |
|---|---|---|---|
| `warmup` | 0-20 s | 20 VUs | `/api/catalogs` |
| `baseline` | 25-55 s | 50 VUs | `/api/catalogs` |
| `stress` | 60-120 s | 10→300 VUs | `/api/catalogs` |
| `slow_io` | 125-185 s | 50→600 VUs | `/api/catalogs/slow` |
| `spike` | 190-220 s | 0→500→0 VUs | `/api/catalogs` |

`warmup` no es una medición: existe para que el JIT compile los caminos calientes
y los pools de conexiones se llenen. Se excluye del reporte.

### La aritmética de `slow_io`

La calibración de este escenario no es arbitraria. Para que MVC muestre su
límite, la concurrencia efectiva tiene que superar el pool de hilos:

- Tomcat tiene 200 hilos (el default de Spring, sin tocar)
- `/slow` retiene su hilo 2 s, así que el techo de MVC es `200 / 2s = 100 req/s`
- 600 VUs con respuesta de 2 s + 0.5 s de think time dan un ciclo de 2.5 s, o sea
  una demanda de `600 / 2.5 = 240 req/s`
- 240 pedidos contra 100 de capacidad = **2.4x sobresuscrito**
- Por la ley de Little, en saturación la latencia tiende a `600 / 100 = ~6 s`

Medido: 4896 ms de promedio. La diferencia contra los 6 s teóricos es la fase de
rampa, que aporta latencias más bajas al promedio.

Con la calibración anterior de 200 VUs, la concurrencia efectiva era
`200 × (2 / 2.5) = 160 < 200` hilos. MVC nunca encolaba nada y las dos apps daban
el mismo número (2032 ms contra 2040 ms, 0% de error en ambas). El escenario no
probaba nada.

## Decisiones de diseño del experimento

Las que sostienen la validez de los resultados, por si alguien pregunta:

**Tomcat queda en su default de 200 hilos.** Bajarlo haría aparecer el quiebre
mucho antes y con menos carga, pero invita a la objeción de "configuraste MVC
para que fallara". Subir la carga no tiene ese problema.

**Cada app se mide con la otra apagada.** Si las dos corren, compiten por CPU del
host y por conexiones a MySQL.

**k6 corre dentro de la red de contenedores.** Desde el host, cada request
atravesaría el proxy de puertos de Docker Desktop, que es un recurso compartido
capaz de saturarse antes que la app.

**Se revisa `dropped_iterations` en cada corrida.** Si k6 no alcanza a generar la
carga pedida, el generador fue el cuello de botella y la corrida no es
comparable. El resumen lo reporta explícitamente.

**El resumen desglosa por escenario.** El agregado global mezcla cinco fases con
perfiles de carga distintos, así que su promedio no significa nada. El script
declara thresholds sobre sub-métricas con tag de escenario, que es lo que hace
que k6 exponga cada fase por separado.

## Limitaciones conocidas

- **Los números publicados son de una sola corrida por app.** El script sobrescribe
  `results/`, así que en disco queda únicamente la última. Se corrió dos veces, y
  la varianza observada entre corridas no es uniforme:

  | escenario | variación MVC | variación WebFlux |
  |---|---|---|
  | `slow_io` | +0.4% | +0.5% |
  | `stress` | +3% | −11% |
  | `spike` | +2% | +8% |
  | `baseline` | +32% | +20% |

  El escenario que sostiene la conclusión principal es el más estable de todos:
  `slow_io` se repitió dentro del 1%, y los picos de hilos (215 y 22) fueron
  idénticos en las dos corridas. Los escenarios sobre `/api/catalogs` son
  bastante más ruidosos, sobre todo `baseline`, donde las latencias son de
  centenas de milisegundos y cualquier interferencia del host pesa
  proporcionalmente más. Conviene leer esas cifras como órdenes de magnitud, no
  como valores exactos. Para afirmaciones más firmes habría que promediar tres o
  más corridas y archivarlas por separado.
- **El generador de carga comparte host con el sistema bajo prueba.** Se mitiga
  capando las apps a 2 CPU y dejando el resto para k6, pero no se elimina.
- **`/api/catalogs` sin paginación.** Devolver 1000 filas por request hace que
  tres de los cinco escenarios midan sobre todo serialización. Es un caso real,
  pero conviene saber qué se está midiendo.
- **Latencia absoluta inflada** por la capa de virtualización de Docker Desktop
  sobre WSL2.

## Qué observar durante una corrida

```bash
docker stats lab-mvc lab-webflux lab-mysql
```

El nombre del hilo que responde delata el modelo:

```bash
curl http://localhost:8081/api/catalogs/slow   # -> http-nio-8080-exec-7
curl http://localhost:8082/api/catalogs/slow   # -> reactor-tcp-epoll-4
```

Ese detalle dice más de lo que parece. En MVC, `http-nio-8080-exec-7` acepta la
conexión, duerme los 2 segundos, ejecuta el query y serializa la respuesta: un
hilo hace el request completo de punta a punta, y está ocupado todo ese tiempo.

En WebFlux el hilo que responde es `reactor-tcp-epoll-4`, que es un event loop
del driver de R2DBC, **no** el que aceptó la conexión HTTP. El trabajo va
saltando de hilo en hilo según qué evento se completa, y ninguno queda asignado
al request. Por eso 22 hilos alcanzan para 600 usuarios concurrentes: no hay
nada que reservar.

Y el conteo de hilos en vivo, que es la explicación causal de todo lo demás:

```bash
curl http://localhost:8081/actuator/metrics/jvm.threads.live
curl http://localhost:8082/actuator/metrics/jvm.threads.live
```

## Estructura del proyecto

```
reactive-lab/
├── docker-compose.yml          # perfiles, límites por anclas YAML, k6 en la red
├── run-lab.ps1                 # runner de PowerShell + muestreo de hilos
├── init-db/init.sql            # schema + 1000 catálogos seed
├── k6/load-test.js             # 5 escenarios, desglose por escenario
├── results/                    # JSON de k6 + CSV de hilos
├── mvc-app/                    # Spring MVC — Tomcat, JPA/Hibernate, JDBC
│   └── src/main/java/com/lab/mvc/
│       ├── model/Catalog.java          # entidad JPA
│       ├── repository/                 # JpaRepository (bloqueante)
│       └── controller/                 # Thread.sleep() en /slow
└── webflux-app/                # Spring WebFlux — Netty, R2DBC
    └── src/main/java/com/lab/webflux/
        ├── model/Catalog.java          # entidad R2DBC, sin JPA
        ├── repository/                 # ReactiveCrudRepository (no bloqueante)
        └── controller/                 # Mono.delay() en /slow
```
