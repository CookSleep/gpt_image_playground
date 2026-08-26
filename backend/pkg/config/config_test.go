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

	if !reflect.DeepEqual(cfg.ModelWhitelist.Image, []string{"gpt-image-2", "fal-ai/flux/dev"}) {
		t.Fatalf("unexpected image whitelist: %#v", cfg.ModelWhitelist.Image)
	}
	if !reflect.DeepEqual(cfg.ModelWhitelist.Agent, []string{"gpt-5.2"}) {
		t.Fatalf("unexpected agent whitelist: %#v", cfg.ModelWhitelist.Agent)
	}
}
