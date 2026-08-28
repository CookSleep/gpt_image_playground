ALTER TABLE project_images
    ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE project_images
    ALTER COLUMN image_data DROP NOT NULL;

UPDATE project_images
SET image_data = NULL
WHERE NULLIF(image_url, '') IS NOT NULL
  AND image_data IS NOT NULL;
