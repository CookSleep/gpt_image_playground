CREATE TABLE IF NOT EXISTS project_images (
    project_id   UUID NOT NULL REFERENCES online_projects(id) ON DELETE CASCADE,
    image_id     TEXT NOT NULL,
    task_id      TEXT,
    source       TEXT,
    mime_type    TEXT NOT NULL,
    width        INTEGER,
    height       INTEGER,
    image_data   BYTEA NOT NULL,
    image_size   BIGINT NOT NULL,
    image_sha256 TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, image_id)
);

CREATE INDEX IF NOT EXISTS idx_project_images_project_created
    ON project_images (project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_project_images_task
    ON project_images (project_id, task_id)
    WHERE task_id IS NOT NULL;
