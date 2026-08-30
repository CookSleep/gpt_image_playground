package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"gpt-image-backend/pkg/config"
)

// Provider 表示一个已经完成 discovery 的 OIDC 提供商
type Provider struct {
	Name        string
	DisplayName string
	cfg         config.OIDCProviderConfig
	provider    *oidc.Provider
	oauth2Cfg   *oauth2.Config
	verifier    *oidc.IDTokenVerifier
}

// ProviderRegistry 管理已加载的 OIDC providers
type ProviderRegistry struct {
	providers map[string]*Provider
}

// NewProviderRegistry 根据配置初始化所有 providers，failed 的会被记录但不阻塞启动
func NewProviderRegistry(ctx context.Context, cfg config.OIDCConfig) (*ProviderRegistry, error) {
	reg := &ProviderRegistry{providers: make(map[string]*Provider)}

	for _, pc := range cfg.Providers {
		p, err := buildProvider(ctx, pc)
		if err != nil {
			return nil, fmt.Errorf("init oidc provider %s: %w", pc.Name, err)
		}
		reg.providers[p.Name] = p
	}
	return reg, nil
}

func buildProvider(ctx context.Context, pc config.OIDCProviderConfig) (*Provider, error) {
	op, err := oidc.NewProvider(ctx, pc.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	oauth2Cfg := &oauth2.Config{
		ClientID:     pc.ClientID,
		ClientSecret: pc.ClientSecret,
		RedirectURL:  pc.RedirectURI,
		Endpoint:     op.Endpoint(),
		Scopes:       pc.Scopes,
	}
	return &Provider{
		Name:        pc.Name,
		DisplayName: pc.DisplayName,
		cfg:         pc,
		provider:    op,
		oauth2Cfg:   oauth2Cfg,
		verifier:    op.Verifier(&oidc.Config{ClientID: pc.ClientID}),
	}, nil
}

// Get 根据 name 取 provider
func (r *ProviderRegistry) Get(name string) (*Provider, bool) {
	p, ok := r.providers[name]
	return p, ok
}

// ResourceBaseURL 返回 provider 的受信任资源服务基址。
func (r *ProviderRegistry) ResourceBaseURL(name string) (string, bool) {
	p, ok := r.providers[name]
	if !ok {
		return "", false
	}
	baseURL := p.cfg.ResourceBaseURL
	if strings.TrimSpace(baseURL) == "" {
		baseURL = p.cfg.IssuerURL
	}
	return strings.TrimRight(baseURL, "/"), true
}

// List 列出所有 provider 的展示信息（供前端登录页使用）
func (r *ProviderRegistry) List() []ProviderInfo {
	out := make([]ProviderInfo, 0, len(r.providers))
	for _, p := range r.providers {
		out = append(out, ProviderInfo{
			Name:        p.Name,
			DisplayName: p.DisplayName,
		})
	}
	return out
}

// ProviderInfo 暴露给前端的提供商信息
type ProviderInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
}

// ---- Authorization Code + PKCE ----

// PKCEPair PKCE verifier + S256 challenge
type PKCEPair struct {
	Verifier  string
	Challenge string
}

// NewPKCEPair 生成一对 PKCE verifier/challenge
func NewPKCEPair() (PKCEPair, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return PKCEPair{}, err
	}
	verifier := base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	return PKCEPair{Verifier: verifier, Challenge: challenge}, nil
}

// AuthCodeURL 生成 OIDC 提供商授权 URL
func (p *Provider) AuthCodeURL(state string, pkce PKCEPair) string {
	return p.oauth2Cfg.AuthCodeURL(state,
		oauth2.SetAuthURLParam("code_challenge", pkce.Challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	)
}

// Exchange 用授权码换 ID token，并校验
func (p *Provider) Exchange(ctx context.Context, code, codeVerifier string) (*UserClaims, error) {
	tok, err := p.oauth2Cfg.Exchange(ctx, code,
		oauth2.SetAuthURLParam("code_verifier", codeVerifier),
	)
	if err != nil {
		return nil, fmt.Errorf("exchange code: %w", err)
	}

	rawIDToken, ok := tok.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return nil, errors.New("id_token not found in token response")
	}
	idToken, err := p.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, fmt.Errorf("verify id_token: %w", err)
	}

	var claims rawClaims
	if err := idToken.Claims(&claims); err != nil {
		return nil, fmt.Errorf("decode id_token claims: %w", err)
	}
	var idTokenClaims map[string]interface{}
	if err := idToken.Claims(&idTokenClaims); err != nil {
		return nil, fmt.Errorf("decode id_token raw claims: %w", err)
	}

	// 调用userinfo端点获取完整的claims信息
	allClaims := make(map[string]interface{}, len(idTokenClaims))
	for key, value := range idTokenClaims {
		allClaims[key] = value
	}
	userInfo, err := p.provider.UserInfo(ctx, oauth2.StaticTokenSource(tok))
	if err == nil && userInfo != nil {
		var userInfoClaims map[string]interface{}
		if err := userInfo.Claims(&userInfoClaims); err == nil {
			for key, value := range userInfoClaims {
				allClaims[key] = value
			}
		}
	}

	// 合并id_token和userinfo的claims
	allClaims["email"] = claims.Email
	allClaims["name"] = claims.Name
	allClaims["preferred_username"] = claims.PreferredUsername
	allClaims["picture"] = claims.Picture

	rawJSON, _ := json.Marshal(allClaims)
	expiresIn := 0
	if !tok.Expiry.IsZero() {
		expiresIn = int(time.Until(tok.Expiry).Seconds())
	}
	return &UserClaims{
		Provider:         p.Name,
		Sub:              idToken.Subject,
		Email:            claims.Email,
		Name:             firstNonEmpty(claims.Name, claims.PreferredUsername),
		PictureURL:       claims.Picture,
		RawJSON:          rawJSON,
		OIDCAccessToken:  tok.AccessToken,
		OIDCRefreshToken: tok.RefreshToken,
		OIDCExpiresIn:    expiresIn,
		IssuerURL:        p.cfg.IssuerURL,
	}, nil
}

// OIDCTokens OIDC provider 刷新后返回的 token
type OIDCTokens struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    int // 秒
}

// RefreshOIDCToken 用 OIDC provider 的 refresh token 换新的 access token。
// oauth2 库在响应未返回新 refresh_token 时会沿用旧值，因此返回的 RefreshToken 始终非空。
func (p *Provider) RefreshOIDCToken(ctx context.Context, refreshToken string) (*OIDCTokens, error) {
	if refreshToken == "" {
		return nil, errors.New("missing oidc refresh token")
	}
	src := p.oauth2Cfg.TokenSource(ctx, &oauth2.Token{RefreshToken: refreshToken})
	tok, err := src.Token()
	if err != nil {
		return nil, fmt.Errorf("refresh oidc token: %w", err)
	}
	expiresIn := 0
	if !tok.Expiry.IsZero() {
		expiresIn = int(time.Until(tok.Expiry).Seconds())
	}
	return &OIDCTokens{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		ExpiresIn:    expiresIn,
	}, nil
}

// FetchUserInfo 使用当前 OIDC access token 读取最新 UserInfo，不会触发 refresh。
func (p *Provider) FetchUserInfo(ctx context.Context, accessToken string) (*UserClaims, error) {
	if strings.TrimSpace(accessToken) == "" {
		return nil, errors.New("missing oidc access token")
	}
	userInfo, err := p.provider.UserInfo(ctx, oauth2.StaticTokenSource(&oauth2.Token{AccessToken: accessToken}))
	if err != nil {
		return nil, fmt.Errorf("fetch oidc userinfo: %w", err)
	}
	var raw map[string]interface{}
	if err := userInfo.Claims(&raw); err != nil {
		return nil, fmt.Errorf("decode oidc userinfo: %w", err)
	}
	getString := func(key string) string {
		value, _ := raw[key].(string)
		return strings.TrimSpace(value)
	}
	sub := getString("sub")
	if sub == "" {
		return nil, errors.New("oidc userinfo missing sub")
	}
	name := getString("name")
	if name == "" {
		name = getString("preferred_username")
	}
	return &UserClaims{
		Provider:   p.Name,
		Sub:        sub,
		Email:      getString("email"),
		Name:       name,
		PictureURL: getString("picture"),
		RawJSON:    mustMarshalClaims(raw),
		IssuerURL:  p.cfg.IssuerURL,
	}, nil
}

func mustMarshalClaims(claims map[string]interface{}) []byte {
	data, _ := json.Marshal(claims)
	return data
}

// rawClaims 标准 OIDC claims 子集
type rawClaims struct {
	Email             string `json:"email"`
	Name              string `json:"name"`
	PreferredUsername string `json:"preferred_username"`
	Picture           string `json:"picture"`
}

// UserClaims 经过校验后用于 upsert 数据库的用户声明
type UserClaims struct {
	Provider   string
	Sub        string
	Email      string
	Name       string
	PictureURL string
	RawJSON    []byte

	// OIDC 服务端原始 access_token / refresh_token / issuer，前端用于直接调 provider 的资源端点并在过期后刷新
	OIDCAccessToken  string
	OIDCRefreshToken string
	OIDCExpiresIn    int // 秒；0 表示未知
	IssuerURL        string
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// ---- State + PKCE 暂存（内存，重启即清空） ----

// StateStore 暂存 OAuth state -> PKCE verifier 映射，含 TTL
type StateStore struct {
	mu    sync.Mutex
	items map[string]stateEntry
	ttl   time.Duration
}

type stateEntry struct {
	verifier  string
	provider  string
	expiresAt time.Time
}

// NewStateStore 创建带 TTL 的 state 暂存
func NewStateStore(ttl time.Duration) *StateStore {
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	return &StateStore{items: make(map[string]stateEntry), ttl: ttl}
}

// Save 保存 state -> (provider, pkce verifier)
func (s *StateStore) Save(state, provider, verifier string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items[state] = stateEntry{
		verifier:  verifier,
		provider:  provider,
		expiresAt: time.Now().Add(s.ttl),
	}
	s.gcLocked()
}

// Consume 取出并删除一个 state，过期的视为不存在
func (s *StateStore) Consume(state string) (provider, verifier string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, exists := s.items[state]
	if !exists {
		return "", "", false
	}
	delete(s.items, state)
	if time.Now().After(e.expiresAt) {
		return "", "", false
	}
	return e.provider, e.verifier, true
}

func (s *StateStore) gcLocked() {
	now := time.Now()
	for k, v := range s.items {
		if now.After(v.expiresAt) {
			delete(s.items, k)
		}
	}
}

// NewState 生成 32 字节随机 state
func NewState() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
