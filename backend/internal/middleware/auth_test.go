package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/pkg/config"
	appjwt "gpt-image-backend/pkg/jwt"
)

func newTestEngine(mw gin.HandlerFunc) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/protected", mw, func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"user_id": c.GetString(ContextKeyUserID),
		})
	})
	return r
}

func TestAuthMiddleware(t *testing.T) {
	mgr := appjwt.NewManager(config.JWTConfig{
		SecretKey:    "secret",
		Issuer:       "test",
		ExpireHours:  1,
		RefreshHours: 1,
	})
	r := newTestEngine(AuthMiddleware(mgr))

	// 1. 无 token：401
	{
		req := httptest.NewRequest(http.MethodGet, "/protected", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("no token: want 401, got %d", w.Code)
		}
		if got := w.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("no token: Cache-Control want no-store, got %q", got)
		}
	}

	// 2. 错误 token：401
	{
		req := httptest.NewRequest(http.MethodGet, "/protected", nil)
		req.Header.Set("Authorization", "Bearer not-a-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("bad token: want 401, got %d", w.Code)
		}
	}

	// 3. refresh token 不允许用作访问：401
	{
		tokens, err := mgr.IssueTokenPair("u-1", "u@e", "U", "p")
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodGet, "/protected", nil)
		req.Header.Set("Authorization", "Bearer "+tokens.RefreshToken)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("refresh token: want 401, got %d", w.Code)
		}
	}

	// 4. 合法 access token：200
	{
		tokens, _ := mgr.IssueTokenPair("u-2", "", "", "p")
		req := httptest.NewRequest(http.MethodGet, "/protected", nil)
		req.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("access token: want 200, got %d body=%s", w.Code, w.Body.String())
		}
		if got := w.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("access token: Cache-Control want no-store, got %q", got)
		}
	}
}
