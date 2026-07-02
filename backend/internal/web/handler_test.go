package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gin-gonic/gin"
)

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte("<!doctype html><html><head><title>t</title></head><body><div id=\"root\"></div><script type=\"module\" src=\"./assets/app.js\"></script></body></html>")},
		"assets/app.js": &fstest.MapFile{Data: []byte("console.log('app')")},
	}
}

func doRequest(h gin.HandlerFunc, method, path string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.NoRoute(h)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}

// 4.1：给定 env → 注入 HTML 含正确 window.__APP_CONFIG__ 字段值，且脚本先于 </head>
func TestInjectConfigValues(t *testing.T) {
	t.Setenv("DEFAULT_API_URL", "https://example.com/v1")
	t.Setenv("SHOW_DEFAULT_CONFIG_ONLY", "true")
	t.Setenv("AUTH_BACKEND_URL", "https://auth.example.com")

	body := doRequest(NewHandler(testFS()), http.MethodGet, "/settings").Body.String()

	for _, want := range []string{
		"window.__APP_CONFIG__ = ",
		`"DEFAULT_API_URL":"https://example.com/v1"`,
		`"SHOW_DEFAULT_CONFIG_ONLY":"true"`,
		`"AUTH_BACKEND_URL":"https://auth.example.com"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("注入 HTML 缺少 %q，实际：%s", want, body)
		}
	}

	scriptIdx := strings.Index(body, "window.__APP_CONFIG__")
	headIdx := strings.Index(body, "</head>")
	if scriptIdx < 0 || headIdx < 0 || scriptIdx > headIdx {
		t.Fatalf("注入脚本须位于 </head> 之前，script=%d head=%d", scriptIdx, headIdx)
	}
}

// 4.2：代理字段恒为 false，index.html 的 Cache-Control 为 no-cache
func TestProxyFieldsAndCacheHeader(t *testing.T) {
	// 即便设置了代理相关 env，embed 形态也恒为 false
	t.Setenv("ENABLE_API_PROXY", "true")
	t.Setenv("LOCK_API_PROXY", "true")

	w := doRequest(NewHandler(testFS()), http.MethodGet, "/")
	body := w.Body.String()

	if !strings.Contains(body, `"API_PROXY_AVAILABLE":"false"`) {
		t.Fatalf("API_PROXY_AVAILABLE 应恒为 false，实际：%s", body)
	}
	if !strings.Contains(body, `"API_PROXY_LOCKED":"false"`) {
		t.Fatalf("API_PROXY_LOCKED 应恒为 false，实际：%s", body)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("index.html Cache-Control 期望 no-cache，实际 %q", got)
	}
}

// 4.2（续）：静态资源命中并带长缓存
func TestStaticAssetLongCache(t *testing.T) {
	w := doRequest(NewHandler(testFS()), http.MethodGet, "/assets/app.js")
	if w.Code != http.StatusOK {
		t.Fatalf("静态资源应返回 200，实际 %d", w.Code)
	}
	if w.Body.String() != "console.log('app')" {
		t.Fatalf("静态资源内容不符：%s", w.Body.String())
	}
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "max-age=31536000") {
		t.Fatalf("静态资源应带长缓存，实际 Cache-Control=%q", cc)
	}
}

// AUTH_BACKEND_URL 语义：未设置 → 注入 ""（前端默认同源启用登录）
func TestAuthBackendDefaultsToSameOrigin(t *testing.T) {
	if orig, ok := os.LookupEnv("AUTH_BACKEND_URL"); ok {
		os.Unsetenv("AUTH_BACKEND_URL")
		t.Cleanup(func() { os.Setenv("AUTH_BACKEND_URL", orig) })
	}
	body := doRequest(NewHandler(testFS()), http.MethodGet, "/").Body.String()
	if !strings.Contains(body, `"AUTH_BACKEND_URL":""`) {
		t.Fatalf("AUTH_BACKEND_URL 未设置时应注入 \"\"（同源启用），实际：%s", body)
	}
}

// AUTH_BACKEND_URL 语义：空串 → 保留 ""（同源启用）
func TestAuthBackendEmptyKept(t *testing.T) {
	t.Setenv("AUTH_BACKEND_URL", "")
	body := doRequest(NewHandler(testFS()), http.MethodGet, "/").Body.String()
	if !strings.Contains(body, `"AUTH_BACKEND_URL":""`) {
		t.Fatalf("AUTH_BACKEND_URL 为空串时应保留 \"\"，实际：%s", body)
	}
}

// AUTH_BACKEND_URL 语义：disabled → 原样注入，前端据此关闭登录
func TestAuthBackendDisabledKept(t *testing.T) {
	t.Setenv("AUTH_BACKEND_URL", "disabled")
	body := doRequest(NewHandler(testFS()), http.MethodGet, "/").Body.String()
	if !strings.Contains(body, `"AUTH_BACKEND_URL":"disabled"`) {
		t.Fatalf("AUTH_BACKEND_URL=disabled 时应原样注入，实际：%s", body)
	}
}

// 4.3：SPA fallback 返回 index.html，且 /health、/auth/*、/api/v1/* 不被拦截
func TestSPAFallbackDoesNotInterceptAPI(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/health", func(c *gin.Context) { c.String(http.StatusOK, "health-ok") })
	auth := r.Group("/auth")
	auth.GET("/providers", func(c *gin.Context) { c.String(http.StatusOK, "providers-ok") })
	api := r.Group("/api/v1")
	api.GET("/me", func(c *gin.Context) { c.String(http.StatusOK, "me-ok") })
	r.NoRoute(NewHandler(testFS()))

	cases := []struct {
		path       string
		wantBody   string
		wantIsHTML bool
	}{
		{"/health", "health-ok", false},
		{"/auth/providers", "providers-ok", false},
		{"/api/v1/me", "me-ok", false},
		{"/settings", "", true},
		{"/gallery/123", "", true},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%s 期望 200，实际 %d", tc.path, w.Code)
		}
		body := w.Body.String()
		if tc.wantIsHTML {
			if !strings.Contains(body, "<div id=\"root\">") || !strings.Contains(body, "window.__APP_CONFIG__") {
				t.Fatalf("%s 应返回注入后的 index.html，实际：%s", tc.path, body)
			}
			continue
		}
		if body != tc.wantBody {
			t.Fatalf("%s 应由既有 handler 处理，期望 %q 实际 %q", tc.path, tc.wantBody, body)
		}
	}
}
