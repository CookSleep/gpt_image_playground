package models

import "testing"

func TestExtractAccountID(t *testing.T) {
	for _, test := range []struct {
		name   string
		claims string
		want   string
	}{
		{name: "standard", claims: `{"account_id":"acct-a"}`, want: "acct-a"},
		{name: "namespaced", claims: `{"sub2api:account_id":"acct-b"}`, want: "acct-b"},
		{name: "camel case", claims: `{"accountId":"acct-c"}`, want: "acct-c"},
		{name: "no oidc fallback", claims: `{"sub":"oidc-sub"}`, want: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := ExtractAccountID([]byte(test.claims)); got != test.want {
				t.Fatalf("ExtractAccountID() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestToPublicProfileIncludesAccountID(t *testing.T) {
	profile := (&User{ID: "user-a", RawClaims: []byte(`{"account_id":"acct-a"}`)}).ToPublicProfile()
	if profile.AccountID != "acct-a" {
		t.Fatalf("account_id = %q, want acct-a", profile.AccountID)
	}
}
