package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	appjwt "gpt-image-backend/pkg/jwt"
)

// ContextKey gin context 中存放认证信息的 key
const (
	ContextKeyUserID   = "auth.user_id"
	ContextKeyClaims   = "auth.claims"
	ContextKeyProvider = "auth.provider"
)

// AuthMiddleware 校验 Authorization: Bearer <token>，校验通过后把 claims 放进 context
func AuthMiddleware(mgr *appjwt.Manager) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")

		token := extractBearerToken(c)
		if token == "" {
			abortJSON(c, http.StatusUnauthorized, "missing bearer token")
			return
		}
		claims, err := mgr.ParseAndValidate(token)
		if err != nil {
			abortJSON(c, http.StatusUnauthorized, "invalid token: "+err.Error())
			return
		}
		if claims.Type != "access" {
			abortJSON(c, http.StatusUnauthorized, "wrong token type")
			return
		}
		c.Set(ContextKeyUserID, claims.UserID)
		c.Set(ContextKeyClaims, claims)
		c.Set(ContextKeyProvider, claims.Provider)
		c.Next()
	}
}

func extractBearerToken(c *gin.Context) string {
	auth := c.GetHeader("Authorization")
	if auth == "" {
		return ""
	}
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

func abortJSON(c *gin.Context, status int, msg string) {
	c.AbortWithStatusJSON(status, gin.H{
		"code":    status,
		"message": msg,
	})
}
