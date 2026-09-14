package com.lab.webflux.repository;

import com.lab.webflux.model.Catalog;
import org.springframework.data.repository.reactive.ReactiveCrudRepository;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Flux;

/**
 * Reactive repository — all methods return Mono or Flux instead of
 * direct objects. The calling thread is never blocked.
 */
@Repository
public interface CatalogRepository extends ReactiveCrudRepository<Catalog, Long> {

    Flux<Catalog> findByCategory(String category);

    Flux<Catalog> findByActiveTrue();
}
