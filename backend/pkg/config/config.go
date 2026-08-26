package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/goccy/go-yaml"
)

// Config 应用配置（来自 YAML 文件）
type Config struct {
	Server         ServerConfig         `yaml:"server"`
	Database       DatabaseConfig       `yaml:"database"`
	JWT            JWTConfig            `yaml:"jwt"`
	OIDC           OIDCConfig           `yaml:"oidc"`
	Admin          AdminConfig          `yaml:"admin"`
	ModelWhitelist ModelWhitelistConfig `yaml:"model_whitelist"`
	InnerAPI       InnerAPIConfig       `yaml:"inner_api_rpc"`
	FileAPI        FileAPIConfig        `yaml:"file_api"`
}

// ModelWhitelistConfig 控制前端按使用场景展示的模型。空列表表示不限制。
type ModelWhitelistConfig struct {
	Image []string `yaml:"image"`
	Agent []string `yaml:"agent"`
}

type InnerAPIConfig struct {
	Target         string `yaml:"target"`
	AppToken       string `yaml:"app_token"`
	TimeoutSeconds int    `yaml:"timeout_seconds"`
}

func (c InnerAPIConfig) Enabled() bool {
	return strings.TrimSpace(c.Target) != "" && strings.TrimSpace(c.AppToken) != ""
}

type FileAPIConfig struct {
	DeveloperKey   string `yaml:"developer_key"`
	TimeoutSeconds int    `yaml:"timeout_seconds"`
}

func (c FileAPIConfig) Enabled() bool {
	return strings.TrimSpace(c.DeveloperKey) != ""
}

// AdminConfig 管理员身份配置
// emails 里的邮箱（大小写不敏感）会在 /auth/user 返回时被标记 is_admin=true，
// 仅用于放开管理员专属的前端提示/入口（例如新版本 NEW 徽标）。
type AdminConfig struct {
	Emails []string `yaml:"emails"`
}

// IsAdminEmail 判断给定邮箱是否属于管理员，大小写不敏感，空邮箱始终返回 false
func (a AdminConfig) IsAdminEmail(email string) bool {
	if email == "" {
		return false
	}
	target := strings.ToLower(strings.TrimSpace(email))
	for _, e := range a.Emails {
		if strings.EqualFold(strings.TrimSpace(e), target) {
			return true
		}
	}
	return false
}

// ServerConfig 服务器配置
type ServerConfig struct {
	Host        string   `yaml:"host"`
	Port        int      `yaml:"port"`
	Environment string   `yaml:"environment"`
	LogLevel    string   `yaml:"log_level"`
	BaseURL     string   `yaml:"base_url"`     // 后端对外基础地址，例如 https://app.example.com
	FrontendURL string   `yaml:"frontend_url"` // 前端入口地址，登录完成后回跳
	CORSOrigins []string `yaml:"cors_origins"`
}

// DatabaseConfig 数据库配置
type DatabaseConfig struct {
	Host         string `yaml:"host"`
	Port         int    `yaml:"port"`
	User         string `yaml:"user"`
	Password     string `yaml:"password"`
	Name         string `yaml:"name"`
	SSLMode      string `yaml:"ssl_mode"`
	MaxOpenConns int    `yaml:"max_open_conns"`
	MaxIdleConns int    `yaml:"max_idle_conns"`
	MaxLifetime  int    `yaml:"max_lifetime_seconds"`
}

// JWTConfig JWT配置
type JWTConfig struct {
	SecretKey    string `yaml:"secret_key"`
	Issuer       string `yaml:"issuer"`
	ExpireHours  int    `yaml:"expire_hours"`
	RefreshHours int    `yaml:"refresh_hours"`
}

// OIDCConfig OIDC配置
type OIDCConfig struct {
	Providers []OIDCProviderConfig `yaml:"providers"`
}

// OIDCProviderConfig 单个OIDC提供商配置
type OIDCProviderConfig struct {
	Name         string   `yaml:"name"`         // 内部唯一标识，例如 "corp-sso"
	DisplayName  string   `yaml:"display_name"` // 前端展示名称
	IssuerURL    string   `yaml:"issuer_url"`   // OIDC Issuer，用于 discovery
	ClientID     string   `yaml:"client_id"`
	ClientSecret string   `yaml:"client_secret"`
	RedirectURI  string   `yaml:"redirect_uri"`
	Scopes       []string `yaml:"scopes"`
}

// LoadConfig 从 YAML 文件加载配置。
// 加载顺序：
//  1. 显式参数 path（优先）
//  2. 环境变量 BACKEND_CONFIG_PATH
//  3. ./config/config.yaml
//  4. ./config.yaml
func LoadConfig(path string) (*Config, error) {
	resolved, err := resolveConfigPath(path)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(resolved)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", resolved, err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", resolved, err)
	}

	cfg.applyDefaults()
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func resolveConfigPath(explicit string) (string, error) {
	candidates := []string{}
	if explicit != "" {
		candidates = append(candidates, explicit)
	}
	if env := os.Getenv("BACKEND_CONFIG_PATH"); env != "" {
		candidates = append(candidates, env)
	}
	candidates = append(candidates,
		filepath.Join("config", "config.yaml"),
		"config.yaml",
	)

	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("config file not found in candidates: %s", strings.Join(candidates, ", "))
}

func (c *Config) applyDefaults() {
	if c.Server.Host == "" {
		c.Server.Host = "0.0.0.0"
	}
	if c.Server.Port == 0 {
		c.Server.Port = 8080
	}
	if c.Server.Environment == "" {
		c.Server.Environment = "development"
	}
	if c.Server.LogLevel == "" {
		c.Server.LogLevel = "info"
	}
	if c.Database.Port == 0 {
		c.Database.Port = 5432
	}
	if c.Database.SSLMode == "" {
		c.Database.SSLMode = "disable"
	}
	if c.Database.MaxOpenConns == 0 {
		c.Database.MaxOpenConns = 25
	}
	if c.Database.MaxIdleConns == 0 {
		c.Database.MaxIdleConns = 5
	}
	if c.Database.MaxLifetime == 0 {
		c.Database.MaxLifetime = 300
	}
	if c.JWT.Issuer == "" {
		c.JWT.Issuer = "gpt-image-backend"
	}
	if c.JWT.ExpireHours == 0 {
		c.JWT.ExpireHours = 24
	}
	if c.JWT.RefreshHours == 0 {
		c.JWT.RefreshHours = 24 * 7
	}
	if c.InnerAPI.TimeoutSeconds == 0 {
		c.InnerAPI.TimeoutSeconds = 30
	}
	if c.FileAPI.TimeoutSeconds == 0 {
		c.FileAPI.TimeoutSeconds = 10 * 60
	}
	c.ModelWhitelist.Image = normalizeModelWhitelist(c.ModelWhitelist.Image)
	c.ModelWhitelist.Agent = normalizeModelWhitelist(c.ModelWhitelist.Agent)
	for i := range c.OIDC.Providers {
		p := &c.OIDC.Providers[i]
		if len(p.Scopes) == 0 {
			p.Scopes = []string{"openid", "profile", "email"}
		}
		if p.DisplayName == "" {
			p.DisplayName = p.Name
		}
	}
}

func normalizeModelWhitelist(models []string) []string {
	seen := make(map[string]struct{}, len(models))
	result := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		result = append(result, model)
	}
	return result
}

// Validate 校验关键字段
func (c *Config) Validate() error {
	if c.JWT.SecretKey == "" {
		return errors.New("jwt.secret_key is required")
	}
	if c.Database.Host == "" || c.Database.Name == "" || c.Database.User == "" {
		return errors.New("database.host/name/user are required")
	}
	for i, p := range c.OIDC.Providers {
		if p.Name == "" {
			return fmt.Errorf("oidc.providers[%d].name is required", i)
		}
		if p.IssuerURL == "" {
			return fmt.Errorf("oidc.providers[%s].issuer_url is required", p.Name)
		}
		if p.ClientID == "" || p.ClientSecret == "" {
			return fmt.Errorf("oidc.providers[%s].client_id/client_secret are required", p.Name)
		}
		if p.RedirectURI == "" {
			return fmt.Errorf("oidc.providers[%s].redirect_uri is required", p.Name)
		}
	}
	if (strings.TrimSpace(c.InnerAPI.Target) == "") != (strings.TrimSpace(c.InnerAPI.AppToken) == "") {
		return errors.New("inner_api_rpc.target and inner_api_rpc.app_token must be configured together")
	}
	if c.InnerAPI.TimeoutSeconds < 1 {
		return errors.New("inner_api_rpc.timeout_seconds must be positive")
	}
	if c.FileAPI.TimeoutSeconds < 1 {
		return errors.New("file_api.timeout_seconds must be positive")
	}
	return nil
}

// FindProvider 根据名称查找 OIDC 提供商配置
func (c *Config) FindProvider(name string) (*OIDCProviderConfig, bool) {
	for i := range c.OIDC.Providers {
		if c.OIDC.Providers[i].Name == name {
			return &c.OIDC.Providers[i], true
		}
	}
	return nil, false
}

// DatabaseURL 生成 PostgreSQL DSN
func (d *DatabaseConfig) DatabaseURL() string {
	return fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		d.Host, d.Port, d.User, d.Password, d.Name, d.SSLMode)
}

// Address 拼接监听地址
func (s *ServerConfig) Address() string {
	return fmt.Sprintf("%s:%d", s.Host, s.Port)
}
