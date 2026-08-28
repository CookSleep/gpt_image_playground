package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestApplyDefaultsNormalizesModelWhitelist(t *testing.T) {
	cfg := Config{
		ModelWhitelist: ModelWhitelistConfig{
			Image: []string{" gpt-image-2 ", "", "gpt-image-2", "fal-ai/flux/dev"},
			Agent: []string{" gpt-5.2 ", "gpt-5.2"},
		},
	}

	cfg.applyDefaults()

	if cfg.Log.Level != "info" || cfg.Log.MaxSizeMB != 100 || cfg.Log.MaxBackups != 10 || cfg.Log.MaxAgeDays != 30 {
		t.Fatalf("unexpected log defaults: %#v", cfg.Log)
	}
	if !reflect.DeepEqual(cfg.ModelWhitelist.Image, []string{"gpt-image-2", "fal-ai/flux/dev"}) {
		t.Fatalf("unexpected image whitelist: %#v", cfg.ModelWhitelist.Image)
	}
	if !reflect.DeepEqual(cfg.ModelWhitelist.Agent, []string{"gpt-5.2"}) {
		t.Fatalf("unexpected agent whitelist: %#v", cfg.ModelWhitelist.Agent)
	}
}

func TestValidateRejectsInvalidLogRotation(t *testing.T) {
	cfg := Config{
		Database: DatabaseConfig{Host: "localhost", User: "postgres", Name: "app"},
		JWT:      JWTConfig{SecretKey: "secret"},
	}
	cfg.applyDefaults()
	cfg.Log.MaxSizeMB = -1

	if err := cfg.Validate(); err == nil || err.Error() != "log rotation values must be positive" {
		t.Fatalf("unexpected validation result: %v", err)
	}
}

func TestLoadConfigMigratesLegacyServerLogSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	data := []byte(`
server:
  log_level: debug
  log_file: /tmp/legacy.log
  log_max_size_mb: 20
  log_max_backups: 3
  log_max_age_days: 7
log:
  level: warn
database:
  host: localhost
  user: postgres
  name: app
jwt:
  secret_key: secret
`)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Log.Level != "warn" || cfg.Log.File != "/tmp/legacy.log" || cfg.Log.MaxSizeMB != 20 || cfg.Log.MaxBackups != 3 || cfg.Log.MaxAgeDays != 7 {
		t.Fatalf("unexpected migrated log config: %#v", cfg.Log)
	}
}
