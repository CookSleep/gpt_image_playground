DROP INDEX IF EXISTS idx_online_projects_deleted;

DROP INDEX IF EXISTS idx_online_projects_user_updated;

ALTER TABLE online_projects
    DROP COLUMN IF EXISTS deleted_at;

CREATE INDEX IF NOT EXISTS idx_online_projects_user_updated
    ON online_projects (user_id, updated_at DESC);
