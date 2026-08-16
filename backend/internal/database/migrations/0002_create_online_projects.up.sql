CREATE TABLE IF NOT EXISTS online_projects (
    id             UUID PRIMARY KEY,
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    archive        BYTEA NOT NULL,
    archive_size   BIGINT NOT NULL,
    archive_sha256 TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_online_projects_user_updated
    ON online_projects (user_id, updated_at DESC);
