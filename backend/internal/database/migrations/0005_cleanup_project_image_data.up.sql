UPDATE project_images
SET image_data = NULL
WHERE NULLIF(image_url, '') IS NOT NULL
  AND image_data IS NOT NULL;
