package database

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"gpt-image-backend/internal/models"
)

var ErrAnnouncementNotFound = errors.New("announcement not found")

type AnnouncementRepository struct {
	db *DB
}

func NewAnnouncementRepository(db *DB) *AnnouncementRepository {
	return &AnnouncementRepository{db: db}
}

func (r *AnnouncementRepository) List(ctx context.Context) ([]models.Announcement, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, title, content, status, notification, starts_at, ends_at, created_at, updated_at
		FROM announcements ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []models.Announcement
	for rows.Next() {
		item, err := scanAnnouncement(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *AnnouncementRepository) GetActive(ctx context.Context, now time.Time) (*models.Announcement, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, title, content, status, notification, starts_at, ends_at, created_at, updated_at
		FROM announcements
		WHERE status = 'published'
		  AND (starts_at IS NULL OR starts_at <= $1)
		  AND (ends_at IS NULL OR ends_at > $1)
		ORDER BY created_at DESC, id DESC
		LIMIT 1`, now)
	item, err := scanAnnouncement(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrAnnouncementNotFound
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (r *AnnouncementRepository) Create(ctx context.Context, input models.Announcement) (*models.Announcement, error) {
	id, err := newAnnouncementID()
	if err != nil {
		return nil, err
	}
	row := r.db.QueryRowContext(ctx, `
		INSERT INTO announcements (id, title, content, status, notification, starts_at, ends_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, title, content, status, notification, starts_at, ends_at, created_at, updated_at`,
		id, input.Title, input.Content, input.Status, input.Notification, input.StartsAt, input.EndsAt,
	)
	item, err := scanAnnouncement(row)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (r *AnnouncementRepository) Update(ctx context.Context, id string, input models.Announcement) (*models.Announcement, error) {
	row := r.db.QueryRowContext(ctx, `
		UPDATE announcements
		SET title=$2, content=$3, status=$4, notification=$5, starts_at=$6, ends_at=$7, updated_at=NOW()
		WHERE id=$1
		RETURNING id, title, content, status, notification, starts_at, ends_at, created_at, updated_at`,
		id, input.Title, input.Content, input.Status, input.Notification, input.StartsAt, input.EndsAt,
	)
	item, err := scanAnnouncement(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrAnnouncementNotFound
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (r *AnnouncementRepository) Delete(ctx context.Context, id string) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM announcements WHERE id=$1`, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrAnnouncementNotFound
	}
	return nil
}

type announcementScanner interface {
	Scan(dest ...any) error
}

func scanAnnouncement(row announcementScanner) (models.Announcement, error) {
	var item models.Announcement
	if err := row.Scan(
		&item.ID, &item.Title, &item.Content, &item.Status, &item.Notification,
		&item.StartsAt, &item.EndsAt, &item.CreatedAt, &item.UpdatedAt,
	); err != nil {
		return models.Announcement{}, err
	}
	return item, nil
}

func newAnnouncementID() (string, error) {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate announcement id: %w", err)
	}
	return fmt.Sprintf("ann_%x", raw), nil
}
