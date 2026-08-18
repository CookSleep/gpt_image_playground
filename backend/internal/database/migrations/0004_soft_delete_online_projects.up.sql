ALTER TABLE online_projects
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_online_projects_user_updated;

CREATE INDEX IF NOT EXISTS idx_online_projects_user_updated
    ON online_projects (user_id, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_online_projects_deleted
    ON online_projects (deleted_at)
    WHERE deleted_at IS NOT NULL;
