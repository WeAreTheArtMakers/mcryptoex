CREATE TABLE IF NOT EXISTS movement1_bootstrap (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note TEXT NOT NULL
);

INSERT INTO movement1_bootstrap(note)
SELECT 'mcryptoex-phase1-bootstrap'
WHERE NOT EXISTS (SELECT 1 FROM movement1_bootstrap WHERE note = 'mcryptoex-phase1-bootstrap');
