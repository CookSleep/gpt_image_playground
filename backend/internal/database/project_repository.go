package database

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"gpt-image-backend/internal/models"
)

var emptyProjectArchive = []byte{'P', 'K', 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}

// ErrProjectForbidden 表示项目 ID 已属于其他用户。
var ErrProjectForbidden = errors.New("project belongs to another user")

// ErrProjectNotFound 表示当前用户没有对应项目。
var ErrProjectNotFound = errors.New("project not found")

// ProjectRepository 负责在线项目归档持久化。
type ProjectRepository struct {
	db *DB
}

func NewProjectRepository(db *DB) *ProjectRepository {
	return &ProjectRepository{db: db}
}

// Ensure 创建尚未同步元数据的新项目，生成接口可据此先落图片记录。
func (r *ProjectRepository) Ensure(ctx context.Context, userID, id, title string) error {
	digest := sha256.Sum256(emptyProjectArchive)
	const q = `
		INSERT INTO online_projects (id, user_id, title, archive, archive_size, archive_sha256)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title
		WHERE online_projects.user_id = EXCLUDED.user_id AND online_projects.deleted_at IS NULL
		RETURNING id`
	var savedID string
	err := r.db.QueryRowContext(ctx, q, id, userID, title, emptyProjectArchive, len(emptyProjectArchive), hex.EncodeToString(digest[:])).Scan(&savedID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrProjectForbidden
	}
	if err != nil {
		return fmt.Errorf("ensure online project: %w", err)
	}
	return nil
}

// Save 使用前端生成的稳定 UUID 幂等保存项目，便于网络失败后安全重试。
func (r *ProjectRepository) Save(ctx context.Context, userID, id, title string, archive []byte, sha256 string) (*models.OnlineProject, error) {
	const q = `
		INSERT INTO online_projects (id, user_id, title, archive, archive_size, archive_sha256)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET
			title = EXCLUDED.title,
			archive = EXCLUDED.archive,
			archive_size = EXCLUDED.archive_size,
			archive_sha256 = EXCLUDED.archive_sha256,
			updated_at = NOW()
		WHERE online_projects.user_id = EXCLUDED.user_id AND online_projects.deleted_at IS NULL
		RETURNING id, user_id, title, archive_size, archive_sha256, created_at, updated_at`
	var project models.OnlineProject
	err := r.db.QueryRowContext(ctx, q, id, userID, title, archive, len(archive), sha256).Scan(
		&project.ID,
		&project.UserID,
		&project.Title,
		&project.ArchiveSize,
		&project.ArchiveSHA256,
		&project.CreatedAt,
		&project.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProjectForbidden
	}
	if err != nil {
		return nil, fmt.Errorf("save online project: %w", err)
	}
	return &project, nil
}

// List 返回用户的项目元数据，不读取归档字段。
func (r *ProjectRepository) List(ctx context.Context, userID string) ([]models.OnlineProject, error) {
	const q = `
		SELECT id, user_id, title, archive_size, archive_sha256, created_at, updated_at
		FROM online_projects
		WHERE user_id = $1 AND deleted_at IS NULL
		ORDER BY updated_at DESC`
	rows, err := r.db.QueryContext(ctx, q, userID)
	if err != nil {
		return nil, fmt.Errorf("list online projects: %w", err)
	}
	defer rows.Close()

	projects := make([]models.OnlineProject, 0)
	for rows.Next() {
		var project models.OnlineProject
		if err := rows.Scan(
			&project.ID,
			&project.UserID,
			&project.Title,
			&project.ArchiveSize,
			&project.ArchiveSHA256,
			&project.CreatedAt,
			&project.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan online project: %w", err)
		}
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list online projects: %w", err)
	}
	return projects, nil
}

// Get 返回当前用户的项目元数据和归档。
func (r *ProjectRepository) Get(ctx context.Context, userID, id string) (*models.OnlineProject, []byte, error) {
	const q = `
		SELECT id, user_id, title, archive_size, archive_sha256, created_at, updated_at, archive
		FROM online_projects
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`
	var project models.OnlineProject
	var archive []byte
	err := r.db.QueryRowContext(ctx, q, id, userID).Scan(
		&project.ID,
		&project.UserID,
		&project.Title,
		&project.ArchiveSize,
		&project.ArchiveSHA256,
		&project.CreatedAt,
		&project.UpdatedAt,
		&archive,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, ErrProjectNotFound
	}
	if err != nil {
		return nil, nil, fmt.Errorf("get online project: %w", err)
	}
	return &project, archive, nil
}

// Rename 只更新项目名称，归档内容保持不变。
func (r *ProjectRepository) Rename(ctx context.Context, userID, id, title string) (*models.OnlineProject, error) {
	const q = `
		UPDATE online_projects
		SET title = $3, updated_at = NOW()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING id, user_id, title, archive_size, archive_sha256, created_at, updated_at`
	var project models.OnlineProject
	err := r.db.QueryRowContext(ctx, q, id, userID, title).Scan(
		&project.ID,
		&project.UserID,
		&project.Title,
		&project.ArchiveSize,
		&project.ArchiveSHA256,
		&project.CreatedAt,
		&project.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProjectForbidden
	}
	if err != nil {
		return nil, fmt.Errorf("rename online project: %w", err)
	}
	return &project, nil
}

// Delete 标记删除当前用户的项目。
func (r *ProjectRepository) Delete(ctx context.Context, userID, id string) error {
	result, err := r.db.ExecContext(ctx, `
		UPDATE online_projects
		SET deleted_at = COALESCE(deleted_at, NOW()),
			updated_at = CASE WHEN deleted_at IS NULL THEN NOW() ELSE updated_at END
		WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return fmt.Errorf("delete online project: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete online project: %w", err)
	}
	if count == 0 {
		return ErrProjectNotFound
	}
	return nil
}

// PurgeDeleted 物理删除保留期之前已标记的项目，关联图片由外键级联删除。
func (r *ProjectRepository) PurgeDeleted(ctx context.Context, before time.Time) (int64, error) {
	result, err := r.db.ExecContext(ctx, `DELETE FROM online_projects WHERE deleted_at IS NOT NULL AND deleted_at <= $1`, before)
	if err != nil {
		return 0, fmt.Errorf("purge deleted online projects: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("purge deleted online project rows: %w", err)
	}
	return count, nil
}
