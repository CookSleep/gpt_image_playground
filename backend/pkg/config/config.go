package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/goccy/go-yaml"
)

// Config 应用配置（来自 YAML 文件）
type Config struct {
	Server         ServerConfig         `yaml:"server"`
	Log            LogConfig            `yaml:"log"`
	Database       DatabaseConfig       `yaml:"database"`
	JWT            JWTConfig            `yaml:"jwt"`
	OIDC           OIDCConfig           `yaml:"oidc"`
	Admin          AdminConfig          `yaml:"admin"`
	ModelWhitelist ModelWhitelistConfig `yaml:"model_whitelist"`
	Upstreams      UpstreamConfig       `yaml:"upstreams"`
	InnerAPI       InnerAPIConfig       `yaml:"inner_api_rpc"`
	FileAPI        FileAPIConfig        `yaml:"file_api"`
}

// LogConfig 控制日志级别、落盘和文件轮转。
type LogConfig struct {
	Level      string `yaml:"level"`
	File       string `yaml:"file"`
	MaxSizeMB  int    `yaml:"max_size_mb"`
	MaxBackups int    `yaml:"max_backups"`
	MaxAgeDays int    `yaml:"max_age_days"`
}

// ModelWhitelistConfig 控制前端按使用场景展示的模型。空列表表示不限制。
type ModelWhitelistConfig struct {
	Image []string `yaml:"image"`
	Agent []string `yaml:"agent"`
}

// 固定的上游接口路径。配置文件只允许覆盖各组上游的 base_url。
const (
	ImageGenerationsPath = "/v1/images/generations"
	ImageEditsPath       = "/v1/images/edits"
	ImageResponsesPath   = "/v1/responses"
	ImageStatusPath      = "/v1/images/status/"
	ResourceAPIKeysPath  = "/oidc/resource/api-keys"
	ResourceModelsPath   = "/v1/models"
	CompositeModelPath   = "/api/v1/model"
	FileAPIPath          = "/api/v1/file/"
)

// UpstreamConfig 配置生图相关上游的基址。base_url 为空时沿用当前 OIDC provider 地址。
type UpstreamConfig struct {
	ImageAPI     ImageAPIUpstreamConfig     `yaml:"image_api"`
	ResourceAPI  ResourceAPIUpstreamConfig  `yaml:"resource_api"`
	CompositeAPI CompositeAPIUpstreamConfig `yaml:"composite_api"`
	FileAPI      FileAPIUpstreamConfig      `yaml:"file_api"`
}

type ImageAPIUpstreamConfig struct {
	BaseURL  string `yaml:"base_url"`
	CodexCLI bool   `yaml:"codex_cli"`
}

type ResourceAPIUpstreamConfig struct {
	BaseURL string `yaml:"base_url"`
}

type CompositeAPIUpstreamConfig struct {
	BaseURL string `yaml:"base_url"`
}

type FileAPIUpstreamConfig struct {
	BaseURL string `yaml:"base_url"`
}

func DefaultUpstreamConfig() UpstreamConfig {
	return UpstreamConfig{
		ImageAPI:     ImageAPIUpstreamConfig{},
		ResourceAPI:  ResourceAPIUpstreamConfig{},
		CompositeAPI: CompositeAPIUpstreamConfig{},
		FileAPI:      FileAPIUpstreamConfig{},
	}
}

func (c UpstreamConfig) withDefaults() UpstreamConfig {
	c.ImageAPI.BaseURL = normalizeUpstreamBaseURL(c.ImageAPI.BaseURL)
	c.ResourceAPI.BaseURL = normalizeUpstreamBaseURL(c.ResourceAPI.BaseURL)
	c.CompositeAPI.BaseURL = normalizeUpstreamBaseURL(c.CompositeAPI.BaseURL)
	c.FileAPI.BaseURL = normalizeUpstreamBaseURL(c.FileAPI.BaseURL)
	return c
}

// NormalizeUpstreamConfig 规范化各上游的可选基址。
func NormalizeUpstreamConfig(c UpstreamConfig) UpstreamConfig {
	return c.withDefaults()
}

func normalizeUpstreamBaseURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	return strings.TrimRight(value, "/")
}

// ResolveUpstreamBaseURL 使用配置地址，否则回退到 OIDC provider 的资源地址。
func ResolveUpstreamBaseURL(configured, fallback string) string {
	if value := normalizeUpstreamBaseURL(configured); value != "" {
		return value
	}
	return strings.TrimRight(strings.TrimSpace(fallback), "/")
}

// JoinUpstreamURL 将配置的基址和路径拼接为请求地址。
func JoinUpstreamURL(baseURL, path string) string {
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(path, "/")
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
// 同时用于后端管理员接口的权限校验。
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
	Name            string   `yaml:"name"`              // 内部唯一标识，例如 "corp-sso"
	DisplayName     string   `yaml:"display_name"`      // 前端展示名称
	IssuerURL       string   `yaml:"issuer_url"`        // OIDC Issuer，用于 discovery
	ResourceBaseURL string   `yaml:"resource_base_url"` // 资源 API 基址，留空时使用 issuer_url
	ClientID        string   `yaml:"client_id"`
	ClientSecret    string   `yaml:"client_secret"`
	RedirectURI     string   `yaml:"redirect_uri"`
	Scopes          []string `yaml:"scopes"`
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
	// 兼容旧配置中的 server.log_*，新 log 段始终优先。
	var legacy struct {
		Server struct {
			Level      string `yaml:"log_level"`
			File       string `yaml:"log_file"`
			MaxSizeMB  int    `yaml:"log_max_size_mb"`
			MaxBackups int    `yaml:"log_max_backups"`
			MaxAgeDays int    `yaml:"log_max_age_days"`
		} `yaml:"server"`
	}
	if err := yaml.Unmarshal(data, &legacy); err == nil {
		if cfg.Log.Level == "" {
			cfg.Log.Level = legacy.Server.Level
		}
		if cfg.Log.File == "" {
			cfg.Log.File = legacy.Server.File
		}
		if cfg.Log.MaxSizeMB == 0 {
			cfg.Log.MaxSizeMB = legacy.Server.MaxSizeMB
		}
		if cfg.Log.MaxBackups == 0 {
			cfg.Log.MaxBackups = legacy.Server.MaxBackups
		}
		if cfg.Log.MaxAgeDays == 0 {
			cfg.Log.MaxAgeDays = legacy.Server.MaxAgeDays
		}
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
	if c.Log.Level == "" {
		c.Log.Level = "info"
	}
	c.Log.File = strings.TrimSpace(c.Log.File)
	if c.Log.MaxSizeMB == 0 {
		c.Log.MaxSizeMB = 100
	}
	if c.Log.MaxBackups == 0 {
		c.Log.MaxBackups = 10
	}
	if c.Log.MaxAgeDays == 0 {
		c.Log.MaxAgeDays = 30
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
	c.Upstreams = c.Upstreams.withDefaults()
	c.ModelWhitelist.Image = normalizeModelWhitelist(c.ModelWhitelist.Image)
	c.ModelWhitelist.Agent = normalizeModelWhitelist(c.ModelWhitelist.Agent)
	for i := range c.OIDC.Providers {
		p := &c.OIDC.Providers[i]
		p.ResourceBaseURL = normalizeUpstreamBaseURL(p.ResourceBaseURL)
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
	if c.Log.MaxSizeMB < 1 || c.Log.MaxBackups < 1 || c.Log.MaxAgeDays < 1 {
		return errors.New("log rotation values must be positive")
	}
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
		if p.ResourceBaseURL != "" {
			if err := validateHTTPBaseURL(p.ResourceBaseURL); err != nil {
				return fmt.Errorf("oidc.providers[%s].resource_base_url: %w", p.Name, err)
			}
		}
	}
	for name, baseURL := range map[string]string{
		"image_api.base_url":     c.Upstreams.ImageAPI.BaseURL,
		"resource_api.base_url":  c.Upstreams.ResourceAPI.BaseURL,
		"composite_api.base_url": c.Upstreams.CompositeAPI.BaseURL,
		"file_api.base_url":      c.Upstreams.FileAPI.BaseURL,
	} {
		if baseURL != "" {
			if err := validateHTTPBaseURL(baseURL); err != nil {
				return fmt.Errorf("upstreams.%s: %w", name, err)
			}
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

func validateHTTPBaseURL(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return errors.New("must be an http(s) URL with a host, such as https://api.example.com or http://10.0.0.5:8080")
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
