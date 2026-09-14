USE catalog_db;

CREATE TABLE IF NOT EXISTS catalogs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    category VARCHAR(100) NOT NULL,
    stock INT NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_category (category),
    INDEX idx_active (active)
);

-- Seed 1000 catalog items across 8 categories
DELIMITER //
CREATE PROCEDURE seed_catalogs()
BEGIN
    DECLARE i INT DEFAULT 1;
    DECLARE categories VARCHAR(500) DEFAULT 'Electronica,Ropa,Hogar,Deportes,Libros,Juguetes,Alimentos,Herramientas';
    DECLARE cat_count INT DEFAULT 8;
    DECLARE cat_name VARCHAR(100);

    WHILE i <= 1000 DO
        SET cat_name = SUBSTRING_INDEX(SUBSTRING_INDEX(categories, ',', (i % cat_count) + 1), ',', -1);

        INSERT INTO catalogs (name, description, price, category, stock, active) VALUES (
            CONCAT('Producto-', LPAD(i, 4, '0')),
            CONCAT('Descripcion detallada del producto numero ', i, '. Este producto pertenece a la categoria ', cat_name, ' y tiene caracteristicas premium con garantia extendida.'),
            ROUND(5 + (RAND() * 995), 2),
            cat_name,
            FLOOR(RAND() * 500),
            IF(RAND() > 0.1, TRUE, FALSE)
        );

        SET i = i + 1;
    END WHILE;
END //
DELIMITER ;

CALL seed_catalogs();
DROP PROCEDURE seed_catalogs;
