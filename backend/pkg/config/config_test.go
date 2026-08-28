package config

import (
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

	if cfg.Server.LogMaxSizeMB != 100 || cfg.Server.LogMaxBackups != 10 || cfg.Server.LogMaxAgeDays != 30 {
		t.Fatalf("unexpected log rotation defaults: %#v", cfg.Server)
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
	cfg.Server.LogMaxSizeMB = -1

	if err := cfg.Validate(); err == nil || err.Error() != "server log rotation values must be positive" {
		t.Fatalf("unexpected validation result: %v", err)
	}
}
