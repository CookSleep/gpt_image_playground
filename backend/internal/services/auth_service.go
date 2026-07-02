package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"gpt-image-backend/internal/auth"
	"gpt-image-backend/internal/database"
	"gpt-image-backend/internal/models"
	"gpt-image-backend/pkg/config"
	appjwt "gpt-image-backend/pkg/jwt"
)

// AuthService 把 OIDC 流程、用户持久化、JWT 签发组合成一个服务
type AuthService struct {
	registry *auth.ProviderRegistry
	users    *database.UserRepository
	jwtMgr   *appjwt.Manager
	states   *auth.StateStore
	admin    config.AdminConfig
}

// NewAuthService 构造 AuthService
func NewAuthService(reg *auth.ProviderRegistry, users *database.UserRepository, jwtMgr *appjwt.Manager, admin config.AdminConfig) *AuthService {
	return &AuthService{
		registry: reg,
		users:    users,
		jwtMgr:   jwtMgr,
		states:   auth.NewStateStore(10 * time.Minute),
		admin:    admin,
	}
}

// IsAdmin 判断某个用户是否是管理员（按 email，配置里 admin.emails 命中即为 true）
func (s *AuthService) IsAdmin(user *models.User) bool {
	if user == nil {
		return false
	}
	return s.admin.IsAdminEmail(user.Email)
}

// ListProviders 返回可用的 OIDC 提供商
func (s *AuthService) ListProviders() []auth.ProviderInfo {
	return s.registry.List()
}

// LoginInit 为指定 provider 生成授权 URL，同时缓存 PKCE/state 上下文
type LoginInit struct {
	AuthURL string
	State   string
}

// InitiateLogin 生成 OIDC 授权 URL
func (s *AuthService) InitiateLogin(providerName string) (*LoginInit, error) {
	p, ok := s.registry.Get(providerName)
	if !ok {
		return nil, fmt.Errorf("unknown provider: %s", providerName)
	}
	pkce, err := auth.NewPKCEPair()
	if err != nil {
		return nil, err
	}
	state, err := auth.NewState()
	if err != nil {
		return nil, err
	}
	s.states.Save(state, providerName, pkce.Verifier)
	return &LoginInit{
		AuthURL: p.AuthCodeURL(state, pkce),
		State:   state,
	}, nil
}

// CallbackResult 回调成功的产物：用户 + token 对
type CallbackResult struct {
	User             *models.User
	Tokens           *appjwt.TokenPair
	OIDCAccessToken  string
	OIDCRefreshToken string
	OIDCExpiresIn    int
	IssuerURL        string
}

// HandleCallback 处理 OIDC 回调：交换 token、upsert 用户、签发 JWT
func (s *AuthService) HandleCallback(ctx context.Context, providerName, state, code string) (*CallbackResult, error) {
	storedProvider, verifier, ok := s.states.Consume(state)
	if !ok {
		return nil, errors.New("invalid or expired state")
	}
	if storedProvider != providerName {
		return nil, errors.New("provider mismatch with state")
	}
	p, ok := s.registry.Get(providerName)
	if !ok {
		return nil, fmt.Errorf("unknown provider: %s", providerName)
	}
	claims, err := p.Exchange(ctx, code, verifier)
	if err != nil {
		return nil, err
	}

	// 解析并打印自定义claims（现在包含userinfo数据）
	var allClaims map[string]interface{}
	if err := json.Unmarshal(claims.RawJSON, &allClaims); err == nil {
		log.Printf("=== OIDC Callback Complete Claims ===")
		log.Printf("Provider: %s", providerName)
		log.Printf("User: %s (%s)", claims.Name, claims.Email)
		
		// 检查并打印apikey相关claims
		if apikey, ok := allClaims["sub2api:apikey"].(string); ok && apikey != "" {
			log.Printf("API Key: %s", apikey)
		} else {
			log.Printf("API Key: not found in claims")
		}
		
		// 检查并打印balance相关claims
		if balance, ok := allClaims["sub2api:balance"].(string); ok && balance != "" {
			log.Printf("Balance: %s", balance)
		} else if balance, ok := allClaims["sub2api:balance"].(float64); ok {
			log.Printf("Balance: %.2f", balance)
		} else {
			log.Printf("Balance: not found in claims")
		}
		
		// 打印所有claims用于调试
		log.Printf("All claims keys: ")
		for key := range allClaims {
			log.Printf("  - %s", key)
		}
		log.Printf("====================================")
	}

	user, err := s.users.UpsertFromOIDC(ctx, &models.User{
		OIDCProvider: claims.Provider,
		OIDCSub:      claims.Sub,
		Email:        claims.Email,
		Name:         claims.Name,
		PictureURL:   claims.PictureURL,
		RawClaims:    claims.RawJSON,
	})
	if err != nil {
		return nil, fmt.Errorf("upsert user: %w", err)
	}
	tokens, err := s.jwtMgr.IssueTokenPair(user.ID, user.Email, user.Name, user.OIDCProvider)
	if err != nil {
		return nil, err
	}
	return &CallbackResult{
		User:             user,
		Tokens:           tokens,
		OIDCAccessToken:  claims.OIDCAccessToken,
		OIDCRefreshToken: claims.OIDCRefreshToken,
		OIDCExpiresIn:    claims.OIDCExpiresIn,
		IssuerURL:        claims.IssuerURL,
	}, nil
}

// RefreshTokens 用 refresh token 换新的 access/refresh 对
func (s *AuthService) RefreshTokens(refreshToken string) (*appjwt.TokenPair, error) {
	return s.jwtMgr.RefreshAccessToken(refreshToken)
}

// RefreshOIDCToken 用 OIDC provider 的 refresh token 刷新 oidc_access_token，provider 取自登录态
func (s *AuthService) RefreshOIDCToken(ctx context.Context, providerName, refreshToken string) (*auth.OIDCTokens, error) {
	p, ok := s.registry.Get(providerName)
	if !ok {
		return nil, fmt.Errorf("unknown provider: %s", providerName)
	}
	return p.RefreshOIDCToken(ctx, refreshToken)
}

// GetUser 根据 user_id 取用户资料
func (s *AuthService) GetUser(ctx context.Context, userID string) (*models.User, error) {
	return s.users.FindByID(ctx, userID)
}
