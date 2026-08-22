package services

import (
	"encoding/json"
	"testing"
)

func TestMergeOIDCClaimsPreservesExistingCustomClaims(t *testing.T) {
	merged := mergeOIDCClaims(
		[]byte(`{"sub":"user-1","account_id":"acct-1","sub2api:apikey":"key-1"}`),
		[]byte(`{"sub":"user-1","email":"user@example.com"}`),
	)

	var claims map[string]interface{}
	if err := json.Unmarshal(merged, &claims); err != nil {
		t.Fatalf("decode merged claims: %v", err)
	}
	if claims["account_id"] != "acct-1" {
		t.Fatalf("account_id = %v, want acct-1", claims["account_id"])
	}
	if claims["sub2api:apikey"] != "key-1" {
		t.Fatalf("custom claim = %v, want key-1", claims["sub2api:apikey"])
	}
	if claims["email"] != "user@example.com" {
		t.Fatalf("email = %v, want user@example.com", claims["email"])
	}
}
