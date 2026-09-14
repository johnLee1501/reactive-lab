package com.lab.mvc.repository;

import com.lab.mvc.model.Catalog;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface CatalogRepository extends JpaRepository<Catalog, Long> {

    List<Catalog> findByCategory(String category);

    List<Catalog> findByActiveTrue();
}
