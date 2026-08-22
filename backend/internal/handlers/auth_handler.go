package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/database"
	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/services"
	"gpt-image-backend/pkg/config"
)

// AuthHandler 处理 /auth/* 路由
type AuthHandler struct {
	svc         *services.AuthService
	frontendURL string
}

// NewAuthHandler 构造 AuthHandler；frontendURL 是登录完成后回跳的前端地址
func NewAuthHandler(svc *services.AuthService, srvCfg config.ServerConfig) *AuthHandler {
	return &AuthHandler{svc: svc, frontendURL: srvCfg.FrontendURL}
}

// Register 把 handler 挂到 gin 引擎
func (h *AuthHandler) Register(r *gin.Engine, authMW gin.HandlerFunc) {
	g := r.Group("/auth")
	g.GET("/providers", h.ListProviders)
	g.GET("/login/:provider", h.Login)
	g.GET("/callback/:provider", h.Callback)
	g.POST("/refresh", h.Refresh)

	// 需要登录的接口
	g.GET("/user", authMW, h.GetUser)
	g.POST("/logout", authMW, h.Logout)
	g.POST("/oidc/refresh", authMW, h.RefreshOIDC)
	g.POST("/oidc/sync", authMW, h.SyncOIDCProfile)
}

// ListProviders GET /auth/providers
func (h *AuthHandler) ListProviders(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"providers": h.svc.ListProviders(),
	})
}

// Login GET /auth/login/:provider
// 直接 302 到 OIDC 提供商授权地址
func (h *AuthHandler) Login(c *gin.Context) {
	providerName := c.Param("provider")
	init, err := h.svc.InitiateLogin(providerName)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
	c.Redirect(http.StatusFound, init.AuthURL)
}

// Callback GET /auth/callback/:provider?code=...&state=...
// 成功后把 token 通过 fragment 回跳前端：{frontend_url}/#access_token=...&refresh_token=...
func (h *AuthHandler) Callback(c *gin.Context) {
	providerName := c.Param("provider")
	code := c.Query("code")
	state := c.Query("state")
	if code == "" || state == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "missing code or state"})
		return
	}

	result, err := h.svc.HandleCallback(c.Request.Context(), providerName, state, code)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": err.Error()})
		return
	}

	if h.frontendURL == "" {
		// 没配置前端回跳地址：直接返回 JSON
		profile := result.User.ToPublicProfile()
		profile.IsAdmin = h.svc.IsAdmin(result.User)
		c.JSON(http.StatusOK, gin.H{
			"user":   profile,
			"tokens": result.Tokens,
		})
		return
	}

	frag := url.Values{}
	frag.Set("access_token", result.Tokens.AccessToken)
	frag.Set("refresh_token", result.Tokens.RefreshToken)
	frag.Set("token_type", result.Tokens.TokenType)
	if result.OIDCAccessToken != "" {
		frag.Set("oidc_access_token", result.OIDCAccessToken)
	}
	if result.OIDCRefreshToken != "" {
		frag.Set("oidc_refresh_token", result.OIDCRefreshToken)
	}
	if result.OIDCExpiresIn > 0 {
		frag.Set("oidc_expires_in", strconv.Itoa(result.OIDCExpiresIn))
	}
	if result.IssuerURL != "" {
		frag.Set("oidc_issuer", result.IssuerURL)
	}
	c.Redirect(http.StatusFound, h.frontendURL+"/#"+frag.Encode())
}

// Refresh POST /auth/refresh  body: {"refresh_token": "..."}
func (h *AuthHandler) Refresh(c *gin.Context) {
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.RefreshToken == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "refresh_token required"})
		return
	}
	tokens, err := h.svc.RefreshTokens(body.RefreshToken)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, tokens)
}

// RefreshOIDC POST /auth/oidc/refresh  body: {"refresh_token": "..."}
// 用 OIDC provider 的 refresh token 刷新 oidc_access_token，provider 取自登录态 JWT
func (h *AuthHandler) RefreshOIDC(c *gin.Context) {
	provider := c.GetString(middleware.ContextKeyProvider)
	if provider == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.RefreshToken == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "refresh_token required"})
		return
	}
	tokens, err := h.svc.RefreshOIDCToken(c.Request.Context(), provider, body.RefreshToken)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"oidc_access_token":  tokens.AccessToken,
		"oidc_refresh_token": tokens.RefreshToken,
		"expires_in":         tokens.ExpiresIn,
	})
}

// SyncOIDCProfile POST /auth/oidc/sync  body: {"access_token":"..."}
// 使用当前 OIDC access token 读取 UserInfo，供素材上传等按需回填用户 claims。
func (h *AuthHandler) SyncOIDCProfile(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	provider := c.GetString(middleware.ContextKeyProvider)
	if userID == "" || provider == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	var body struct {
		AccessToken string `json:"access_token"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.AccessToken) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "access_token required"})
		return
	}
	user, err := h.svc.SyncOIDCProfile(c.Request.Context(), userID, provider, body.AccessToken)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": err.Error()})
		return
	}
	profile := user.ToPublicProfile()
	profile.IsAdmin = h.svc.IsAdmin(user)
	c.JSON(http.StatusOK, profile)
}

// GetUser GET /auth/user
func (h *AuthHandler) GetUser(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	user, err := h.svc.GetUser(ctx, userID)
	if err != nil {
		if errors.Is(err, database.ErrUserNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "message": "user not found"})
			return
		}
		if errors.Is(err, context.DeadlineExceeded) {
			c.JSON(http.StatusGatewayTimeout, gin.H{"code": http.StatusGatewayTimeout, "message": "user lookup timed out"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	profile := user.ToPublicProfile()
	profile.IsAdmin = h.svc.IsAdmin(user)
	c.JSON(http.StatusOK, profile)
}

// Logout POST /auth/logout
// 第一期 JWT 无状态：服务端不维护黑名单，前端清掉本地 token 即可
// 这里只返回 204，方便后续接入黑名单时升级
func (h *AuthHandler) Logout(c *gin.Context) {
	c.Status(http.StatusNoContent)
}
