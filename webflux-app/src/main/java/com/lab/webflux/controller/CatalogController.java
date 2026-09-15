package com.lab.webflux.controller;

import com.lab.webflux.model.Catalog;
import com.lab.webflux.repository.CatalogRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.Map;

@RestController
@RequestMapping("/api/catalogs")
public class CatalogController {

    private final CatalogRepository catalogRepository;

    public CatalogController(CatalogRepository catalogRepository) {
        this.catalogRepository = catalogRepository;
    }

    /**
     * GET /api/catalogs
     * Returns all catalogs as a Flux (stream of items).
     */
    @GetMapping
    public Flux<Catalog> getAll() {
        return catalogRepository.findAll();
    }

    /**
     * GET /api/catalogs/{id}
     * Returns a single catalog wrapped in Mono.
     */
    @GetMapping("/{id}")
    public Mono<ResponseEntity<Catalog>> getById(@PathVariable Long id) {
        return catalogRepository.findById(id)
                .map(ResponseEntity::ok)
                .defaultIfEmpty(ResponseEntity.notFound().build());
    }

    /**
     * GET /api/catalogs/category/{category}
     * Returns catalogs filtered by category.
     */
    @GetMapping("/category/{category}")
    public Flux<Catalog> getByCategory(@PathVariable String category) {
        return catalogRepository.findByCategory(category);
    }

    /**
     * GET /api/catalogs/slow
     *
     * ESTE ES EL ENDPOINT CLAVE DEL LABORATORIO.
     * Simula un servicio downstream lento (2 segundos de espera).
     *
     * En WebFlux, Mono.delay() NO bloquea ningún hilo. El hilo del event
     * loop registra el timer y sigue atendiendo otros requests de
     * inmediato. Cuando pasan los 2 segundos, retoma el trabajo.
     *
     * Con apenas un puñado de hilos de event loop esto sostiene miles de
     * requests concurrentes, porque ningún hilo se queda quieto esperando.
     *
     * IMPORTANTE — simetría con la versión imperativa:
     * el trabajo de base de datos acá es un count() y NADA más, igual que
     * en mvc-app. La única variable que este endpoint debe aislar es cómo
     * cada framework maneja la espera. Si cambias el query de un lado,
     * tienes que cambiarlo del otro o la comparación deja de valer.
     */
    @GetMapping("/slow")
    public Mono<Map<String, Object>> getSlowResponse() {
        long start = System.currentTimeMillis();

        // Mono.delay schedules a timer — the thread is FREE during the wait
        return Mono.delay(Duration.ofSeconds(2))
                .then(catalogRepository.count())
                .map(count -> {
                    long elapsed = System.currentTimeMillis() - start;
                    return Map.<String, Object>of(
                        "framework", "Spring WebFlux",
                        "thread", Thread.currentThread().getName(),
                        "elapsed_ms", elapsed,
                        "catalog_count", count
                    );
                });
    }

    /**
     * GET /api/catalogs/slow-nodb
     *
     * Variante de /slow SIN base de datos.
     *
     * El probe de concurrencia mostró que /slow se topa en el techo de
     * MySQL y no en el del framework: a 1600 VUs la base queda saturada
     * mientras la app usa un cuarto de su CPU. Con la base en el camino del
     * request es imposible medir el límite del modelo de ejecución.
     *
     * Este endpoint reduce el request a lo esencial: aceptar la conexión,
     * esperar 2 segundos, serializar dos campos. Nada más. Así la única
     * variable que queda es cómo maneja cada framework la espera.
     *
     * No se usa en el laboratorio principal. Existe solo para
     * concurrency-probe.js, y su gemelo en mvc-app debe mantenerse
     * simétrico.
     */
    @GetMapping("/slow-nodb")
    public Mono<Map<String, Object>> getSlowNoDb() {
        // Unica operacion del request: se registra un timer y el hilo
        // queda libre para atender otros requests durante la espera.
        return Mono.delay(Duration.ofSeconds(2))
                .map(tick -> Map.<String, Object>of(
                    "framework", "Spring WebFlux",
                    "thread", Thread.currentThread().getName()
                ));
    }

    /**
     * GET /api/catalogs/health-check
     * Quick endpoint to verify the app is alive and DB is reachable.
     */
    @GetMapping("/health-check")
    public Mono<Map<String, Object>> healthCheck() {
        return catalogRepository.count()
                .map(count -> Map.<String, Object>of(
                    "status", "UP",
                    "framework", "Spring WebFlux (Netty)",
                    "thread", Thread.currentThread().getName(),
                    "catalog_count", count
                ));
    }
}
