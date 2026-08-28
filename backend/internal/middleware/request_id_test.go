package middleware

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func TestRequestIDUsesHeaderAndAddsLoggerField(t *testing.T) {
	gin.SetMode(gin.TestMode)
	previous := log.Logger
	t.Cleanup(func() { log.Logger = previous })
	var output bytes.Buffer
	log.Logger = zerolog.New(&output)

	r := gin.New()
	r.Use(RequestID())
	r.GET("/test", func(c *gin.Context) {
		log.Ctx(c.Request.Context()).Info().Msg("request handled")
		upstream := httptest.NewRequest(http.MethodGet, "https://provider.example/test", nil).WithContext(c.Request.Context())
		SetRequestIDHeader(upstream)
		c.Header("X-Upstream-Request-ID", upstream.Header.Get(RequestIDHeader))
		c.Status(http.StatusNoContent)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set(RequestIDHeader, "request-a")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, req)

	if response.Header().Get(RequestIDHeader) != "request-a" {
		t.Fatalf("unexpected response request ID: %q", response.Header().Get(RequestIDHeader))
	}
	if response.Header().Get("X-Upstream-Request-ID") != "request-a" {
		t.Fatalf("unexpected upstream request ID: %q", response.Header().Get("X-Upstream-Request-ID"))
	}
	if text := output.String(); !strings.Contains(text, `"request_id":"request-a"`) || !strings.Contains(text, `"message":"request handled"`) {
		t.Fatalf("unexpected log output: %s", text)
	}
}

func TestRequestIDGeneratesID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestID())
	r.GET("/test", func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})

	response := httptest.NewRecorder()
	r.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/test", nil))

	requestID := response.Header().Get(RequestIDHeader)
	if len(requestID) != 32 {
		t.Fatalf("unexpected generated request ID: %q", requestID)
	}
	if requestID != strings.ToLower(requestID) {
		t.Fatalf("generated request ID must be lowercase: %q", requestID)
	}
}
