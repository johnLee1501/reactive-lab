package com.lab.mvc.controller;

import com.lab.mvc.model.Catalog;
import com.lab.mvc.repository.CatalogRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
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
     * Returns all catalogs. Simple query, fast response.
     */
    @GetMapping
    public List<Catalog> getAll() {
        return catalogRepository.findAll();
    }

    /**
     * GET /api/catalogs/{id}
     * Returns a single catalog by ID.
     */
    @GetMapping("/{id}")
    public ResponseEntity<Catalog> getById(@PathVariable Long id) {
        return catalogRepository.findById(id)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    /**
     * GET /api/catalogs/category/{category}
     * Returns catalogs filtered by category.
     */
    @GetMapping("/category/{category}")
    public List<Catalog> getByCategory(@PathVariable String category) {
        return catalogRepository.findByCategory(category);
    }

    /**
     * GET /api/catalogs/slow
     *
     * ESTE ES EL ENDPOINT CLAVE DEL LABORATORIO.
     * Simula un servicio downstream lento (2 segundos de espera).
     *
     * En MVC, Thread.sleep() BLOQUEA el hilo de Tomcat. Con un máximo de
     * 200 hilos y 2s de bloqueo cada uno, el techo teórico de este
     * endpoint es ~100 req/s. Por encima de eso los requests se encolan
     * y la latencia crece de forma lineal con la carga.
     *
     * IMPORTANTE — simetría con la versión reactiva:
     * el trabajo de base de datos acá es un count() y NADA más, igual que
     * en webflux-app. La única variable que este endpoint debe aislar es
     * cómo cada framework maneja la espera: un hilo bloqueado contra un
     * timer en el event loop. Si un lado hiciera más trabajo de BD que el
     * otro, la comparación mediría dos cosas a la vez y no serviría.
     */
    @GetMapping("/slow")
    public Map<String, Object> getSlowResponse() throws InterruptedException {
        long start = System.currentTimeMillis();

        // Simula la llamada a una API externa lenta.
        // Este hilo queda BLOQUEADO sin hacer nada durante 2 segundos.
        Thread.sleep(2000);

        long count = catalogRepository.count();
        long elapsed = System.currentTimeMillis() - start;

        return Map.of(
            "framework", "Spring MVC",
            "thread", Thread.currentThread().getName(),
            "elapsed_ms", elapsed,
            "catalog_count", count
        );
    }

    /**
     * GET /api/catalogs/health-check
     * Quick endpoint to verify the app is alive and DB is reachable.
     */
    @GetMapping("/health-check")
    public Map<String, Object> healthCheck() {
        long count = catalogRepository.count();
        return Map.of(
            "status", "UP",
            "framework", "Spring MVC (Tomcat)",
            "thread", Thread.currentThread().getName(),
            "catalog_count", count
        );
    }
}
