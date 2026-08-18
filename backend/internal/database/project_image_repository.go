package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"gpt-image-backend/internal/models"
)

// SaveImage 幂等保存项目图片，仅允许项目所有者写入。
func (r *ProjectRepository) SaveImage(ctx context.Context, userID string, image models.ProjectImage, data []byte) (*models.ProjectImage, error) {
	const q = `
		INSERT INTO project_images (project_id, image_id, task_id, source, mime_type, width, height, image_data, image_size, image_sha256)
		SELECT p.id, $3, NULLIF($4, ''), NULLIF($5, ''), $6, $7, $8, $9, $10, $11
		FROM online_projects p
		WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
		ON CONFLICT (project_id, image_id) DO UPDATE SET
			task_id = EXCLUDED.task_id,
			source = EXCLUDED.source,
			mime_type = EXCLUDED.mime_type,
			width = EXCLUDED.width,
			height = EXCLUDED.height,
			image_data = EXCLUDED.image_data,
			image_size = EXCLUDED.image_size,
			image_sha256 = EXCLUDED.image_sha256,
			updated_at = NOW()
		RETURNING project_id, image_id, COALESCE(task_id, ''), COALESCE(source, ''), mime_type, width, height, image_size, image_sha256, created_at, updated_at`
	var saved models.ProjectImage
	err := r.db.QueryRowContext(ctx, q,
		image.ProjectID,
		userID,
		image.ImageID,
		image.TaskID,
		image.Source,
		image.MIMEType,
		image.Width,
		image.Height,
		data,
		len(data),
		image.SHA256,
	).Scan(
		&saved.ProjectID,
		&saved.ImageID,
		&saved.TaskID,
		&saved.Source,
		&saved.MIMEType,
		&saved.Width,
		&saved.Height,
		&saved.ImageSize,
		&saved.SHA256,
		&saved.CreatedAt,
		&saved.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProjectNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("save project image: %w", err)
	}
	return &saved, nil
}

// ListImages 返回项目图片元数据，不读取图片二进制。
func (r *ProjectRepository) ListImages(ctx context.Context, userID, projectID string) ([]models.ProjectImage, error) {
	const q = `
		SELECT i.project_id, i.image_id, COALESCE(i.task_id, ''), COALESCE(i.source, ''), i.mime_type,
			i.width, i.height, i.image_size, i.image_sha256, i.created_at, i.updated_at
		FROM project_images i
		JOIN online_projects p ON p.id = i.project_id
		WHERE i.project_id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
		ORDER BY i.created_at`
	rows, err := r.db.QueryContext(ctx, q, projectID, userID)
	if err != nil {
		return nil, fmt.Errorf("list project images: %w", err)
	}
	defer rows.Close()

	images := make([]models.ProjectImage, 0)
	for rows.Next() {
		var image models.ProjectImage
		if err := rows.Scan(
			&image.ProjectID,
			&image.ImageID,
			&image.TaskID,
			&image.Source,
			&image.MIMEType,
			&image.Width,
			&image.Height,
			&image.ImageSize,
			&image.SHA256,
			&image.CreatedAt,
			&image.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan project image: %w", err)
		}
		images = append(images, image)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list project images: %w", err)
	}
	return images, nil
}

// GetImage 返回项目图片元数据和二进制。
func (r *ProjectRepository) GetImage(ctx context.Context, userID, projectID, imageID string) (*models.ProjectImage, []byte, error) {
	const q = `
		SELECT i.project_id, i.image_id, COALESCE(i.task_id, ''), COALESCE(i.source, ''), i.mime_type,
			i.width, i.height, i.image_size, i.image_sha256, i.created_at, i.updated_at, i.image_data
		FROM project_images i
		JOIN online_projects p ON p.id = i.project_id
		WHERE i.project_id = $1 AND i.image_id = $2 AND p.user_id = $3 AND p.deleted_at IS NULL`
	var image models.ProjectImage
	var data []byte
	err := r.db.QueryRowContext(ctx, q, projectID, imageID, userID).Scan(
		&image.ProjectID,
		&image.ImageID,
		&image.TaskID,
		&image.Source,
		&image.MIMEType,
		&image.Width,
		&image.Height,
		&image.ImageSize,
		&image.SHA256,
		&image.CreatedAt,
		&image.UpdatedAt,
		&data,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, ErrProjectNotFound
	}
	if err != nil {
		return nil, nil, fmt.Errorf("get project image: %w", err)
	}
	return &image, data, nil
}

// DeleteImage 删除当前用户项目中的一张图片。
func (r *ProjectRepository) DeleteImage(ctx context.Context, userID, projectID, imageID string) error {
	const q = `
		DELETE FROM project_images i
		USING online_projects p
		WHERE i.project_id = $1 AND i.image_id = $2 AND p.id = i.project_id AND p.user_id = $3 AND p.deleted_at IS NULL`
	result, err := r.db.ExecContext(ctx, q, projectID, imageID, userID)
	if err != nil {
		return fmt.Errorf("delete project image: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete project image rows: %w", err)
	}
	if count == 0 {
		return ErrProjectNotFound
	}
	return nil
}
