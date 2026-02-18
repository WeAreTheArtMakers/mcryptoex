CREATE DATABASE IF NOT EXISTS mcryptoex;

CREATE TABLE IF NOT EXISTS mcryptoex.movement1_bootstrap
(
    created_at DateTime64(3) DEFAULT now64(3),
    note String
)
ENGINE = MergeTree
ORDER BY created_at;
