package database

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
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

// ErrProjectCanvasNotFound 表示项目归档中没有可恢复的画布数据。
var ErrProjectCanvasNotFound = errors.New("project canvas not found")

// ProjectRepository 负责在线项目归档持久化。
type ProjectRepository struct {
	db *DB
}

// SaveTaskRecord 将单条任务直接写入项目归档，避免浏览器为每次生成重新上传完整 ZIP。
func (r *ProjectRepository) SaveTaskRecord(ctx context.Context, userID, id, title, taskID string, project, task json.RawMessage) (*models.OnlineProject, error) {
	if err := r.Ensure(ctx, userID, id, title); err != nil {
		return nil, err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin task record update: %w", err)
	}
	defer tx.Rollback()

	var archive []byte
	if err := tx.QueryRowContext(ctx, `
		SELECT archive FROM online_projects
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		FOR UPDATE`, id, userID).Scan(&archive); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProjectForbidden
	} else if err != nil {
		return nil, fmt.Errorf("lock online project: %w", err)
	}
	archive, err = rewriteProjectTaskArchive(archive, project, task, taskID, false)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(archive)
	var saved models.OnlineProject
	err = tx.QueryRowContext(ctx, `
		UPDATE online_projects
		SET title = $3, archive = $4, archive_size = $5, archive_sha256 = $6, updated_at = NOW()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING id, user_id, title, archive_size, archive_sha256, created_at, updated_at`,
		id, userID, title, archive, len(archive), hex.EncodeToString(digest[:]),
	).Scan(&saved.ID, &saved.UserID, &saved.Title, &saved.ArchiveSize, &saved.ArchiveSHA256, &saved.CreatedAt, &saved.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("save project task record: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit project task record: %w", err)
	}
	return &saved, nil
}

// SaveCanvas 只更新项目归档中的画布状态，避免为一次位置变化重新上传完整项目 ZIP。
func (r *ProjectRepository) SaveCanvas(ctx context.Context, userID, id string, canvas json.RawMessage) (*models.OnlineProject, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin canvas update: %w", err)
	}
	defer tx.Rollback()

	var archive []byte
	if err := tx.QueryRowContext(ctx, `
		SELECT archive FROM online_projects
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		FOR UPDATE`, id, userID).Scan(&archive); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProjectNotFound
	} else if err != nil {
		return nil, fmt.Errorf("lock online project: %w", err)
	}
	archive, err = rewriteProjectCanvasArchive(archive, id, canvas)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(archive)
	var saved models.OnlineProject
	err = tx.QueryRowContext(ctx, `
		UPDATE online_projects
		SET archive = $3, archive_size = $4, archive_sha256 = $5, updated_at = NOW()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING id, user_id, title, archive_size, archive_sha256, created_at, updated_at`,
		id, userID, archive, len(archive), hex.EncodeToString(digest[:]),
	).Scan(&saved.ID, &saved.UserID, &saved.Title, &saved.ArchiveSize, &saved.ArchiveSHA256, &saved.CreatedAt, &saved.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("save project canvas: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit project canvas: %w", err)
	}
	return &saved, nil
}

// SaveCanvasViewport 只更新项目归档中的画布视口，避免上传完整图片项目数据。
func (r *ProjectRepository) SaveCanvasViewport(ctx context.Context, userID, id string, viewport json.RawMessage) (*models.OnlineProject, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin canvas viewport update: %w", err)
	}
	defer tx.Rollback()

	var archive []byte
	if err := tx.QueryRowContext(ctx, `
		SELECT archive FROM online_projects
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		FOR UPDATE`, id, userID).Scan(&archive); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProjectNotFound
	} else if err != nil {
		return nil, fmt.Errorf("lock online project: %w", err)
	}
	archive, err = rewriteProjectCanvasViewportArchive(archive, id, viewport)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(archive)
	var saved models.OnlineProject
	err = tx.QueryRowContext(ctx, `
		UPDATE online_projects
		SET archive = $3, archive_size = $4, archive_sha256 = $5, updated_at = NOW()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING id, user_id, title, archive_size, archive_sha256, created_at, updated_at`,
		id, userID, archive, len(archive), hex.EncodeToString(digest[:]),
	).Scan(&saved.ID, &saved.UserID, &saved.Title, &saved.ArchiveSize, &saved.ArchiveSHA256, &saved.CreatedAt, &saved.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("save project canvas viewport: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit project canvas viewport: %w", err)
	}
	return &saved, nil
}

// DeleteTaskRecord 从项目归档移除任务记录。
func (r *ProjectRepository) DeleteTaskRecord(ctx context.Context, userID, id, taskID string) (*models.OnlineProject, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin task record delete: %w", err)
	}
	defer tx.Rollback()

	var archive []byte
	if err := tx.QueryRowContext(ctx, `
		SELECT archive FROM online_projects
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		FOR UPDATE`, id, userID).Scan(&archive); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProjectNotFound
	} else if err != nil {
		return nil, fmt.Errorf("lock online project: %w", err)
	}
	archive, err = rewriteProjectTaskArchive(archive, nil, nil, taskID, true)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(archive)
	var saved models.OnlineProject
	err = tx.QueryRowContext(ctx, `
		UPDATE online_projects
		SET archive = $3, archive_size = $4, archive_sha256 = $5, updated_at = NOW()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING id, user_id, title, archive_size, archive_sha256, created_at, updated_at`,
		id, userID, archive, len(archive), hex.EncodeToString(digest[:]),
	).Scan(&saved.ID, &saved.UserID, &saved.Title, &saved.ArchiveSize, &saved.ArchiveSHA256, &saved.CreatedAt, &saved.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("delete project task record: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit project task delete: %w", err)
	}
	return &saved, nil
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

// GetCanvas 只读取项目归档中的画布状态，避免为恢复画布下载完整 ZIP。
func (r *ProjectRepository) GetCanvas(ctx context.Context, userID, id string) (*models.OnlineProject, json.RawMessage, error) {
	project, archive, err := r.Get(ctx, userID, id)
	if err != nil {
		return nil, nil, err
	}
	canvas, err := readProjectCanvasArchive(archive, id)
	if err != nil {
		return nil, nil, err
	}
	return project, canvas, nil
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
