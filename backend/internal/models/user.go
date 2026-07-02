package models

import (
	"encoding/json"
	"time"
)

// User 表示一个本地用户记录，资料完全来自 OIDC 提供商
type User struct {
	ID           string     `json:"id" db:"id"`
	OIDCProvider string     `json:"oidc_provider" db:"oidc_provider"`
	OIDCSub      string     `json:"oidc_sub" db:"oidc_sub"`
	Email        string     `json:"email,omitempty" db:"email"`
	Name         string     `json:"name,omitempty" db:"name"`
	PictureURL   string     `json:"picture_url,omitempty" db:"picture_url"`
	RawClaims    []byte     `json:"-" db:"raw_claims"` // JSONB 原始 claims
	CreatedAt    time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at" db:"updated_at"`
	LastLoginAt  *time.Time `json:"last_login_at,omitempty" db:"last_login_at"`
}

// PublicProfile 暴露给前端 /auth/user 的字段子集
type PublicProfile struct {
	ID           string                 `json:"id"`
	OIDCProvider string                 `json:"oidc_provider"`
	Email        string                 `json:"email,omitempty"`
	Name         string                 `json:"name,omitempty"`
	PictureURL   string                 `json:"picture_url,omitempty"`
	IsAdmin      bool                   `json:"is_admin,omitempty"`
	Claims       map[string]interface{} `json:"claims,omitempty"`
}

// ToPublicProfile 转换为对外可见的资料
func (u *User) ToPublicProfile() PublicProfile {
	var claims map[string]interface{}
	if len(u.RawClaims) > 0 {
		json.Unmarshal(u.RawClaims, &claims)
	}

	return PublicProfile{
		ID:           u.ID,
		OIDCProvider: u.OIDCProvider,
		Email:        u.Email,
		Name:         u.Name,
		PictureURL:   u.PictureURL,
		Claims:       claims,
	}
}
