package models

import "time"

// OnlineProject 表示用户上传到服务端的项目归档。
type OnlineProject struct {
	ID            string    `json:"id"`
	UserID        string    `json:"-"`
	Title         string    `json:"title"`
	ArchiveSize   int64     `json:"archive_size"`
	ArchiveSHA256 string    `json:"archive_sha256"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// ProjectImage 表示在线项目中独立持久化的一张图片。
type ProjectImage struct {
	ProjectID string    `json:"project_id"`
	ImageID   string    `json:"image_id"`
	TaskID    string    `json:"task_id,omitempty"`
	Source    string    `json:"source,omitempty"`
	MIMEType  string    `json:"mime_type"`
	ImageURL  string    `json:"image_url,omitempty"`
	Width     *int      `json:"width,omitempty"`
	Height    *int      `json:"height,omitempty"`
	ImageSize int64     `json:"image_size"`
	SHA256    string    `json:"image_sha256"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
