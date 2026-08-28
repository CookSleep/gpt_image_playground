package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/pkg/config"
)

func TestSetupLoggerWritesColorlessConsoleFormatToFile(t *testing.T) {
	previous := log.Logger
	t.Cleanup(func() { log.Logger = previous })
	path := filepath.Join(t.TempDir(), "nested", "backend.log")
	closer, err := setupLogger(config.LogConfig{
		Level:      "info",
		File:       path,
		MaxSizeMB:  1,
		MaxBackups: 2,
		MaxAgeDays: 1,
	}, "development")
	if err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.Use(middleware.RequestID(), requestLoggerMiddleware())
	r.GET("/test", func(c *gin.Context) {
		log.Ctx(c.Request.Context()).Info().Msg("request handled")
		c.Status(http.StatusNoContent)
	})
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set(middleware.RequestIDHeader, "request-a")
	r.ServeHTTP(httptest.NewRecorder(), req)
	if err := closer.Close(); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "\x1b[") {
		t.Fatalf("log file contains ANSI color codes: %q", text)
	}
	if strings.HasPrefix(strings.TrimSpace(text), "{") {
		t.Fatalf("log file unexpectedly contains JSON: %q", text)
	}
	if !strings.Contains(text, "INF") || !strings.Contains(text, "request handled") || !strings.Contains(text, "Request") {
		t.Fatalf("unexpected log content: %s", text)
	}
	if strings.Count(text, "request_id=request-a") != 2 {
		t.Fatalf("business and access logs must contain the same request ID: %s", text)
	}
	if !strings.Contains(text, "path=/test") {
		t.Fatalf("unexpected log content: %s", text)
	}
}
