package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rs/zerolog/log"

	"gpt-image-backend/pkg/config"
)

func TestSetupLoggerWritesToFile(t *testing.T) {
	previous := log.Logger
	t.Cleanup(func() { log.Logger = previous })
	path := filepath.Join(t.TempDir(), "nested", "backend.log")
	closer, err := setupLogger(config.ServerConfig{
		Environment:   "production",
		LogLevel:      "info",
		LogFile:       path,
		LogMaxSizeMB:  1,
		LogMaxBackups: 2,
		LogMaxAgeDays: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	log.Info().Str("request_id", "request-a").Msg("file logging test")
	if err := closer.Close(); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, `"request_id":"request-a"`) || !strings.Contains(text, `"message":"file logging test"`) {
		t.Fatalf("unexpected log content: %s", text)
	}
}
