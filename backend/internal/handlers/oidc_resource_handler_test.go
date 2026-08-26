package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/pkg/config"
)

func newOIDCResourceRouter(upstream *httptest.Server, whitelist config.ModelWhitelistConfig) *gin.Engine {
	gin.SetMode(gin.TestMode)
	handler := NewOIDCResourceHandler(imageProviderRegistryStub{baseURL: upstream.URL}, whitelist)
	handler.client = upstream.Client()
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Set(middleware.ContextKeyProvider, "provider-a")
		c.Next()
	})
	handler.Register(api)
	return r
}

func TestOIDCResourceHandlerProxiesAPIKeys(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/oidc/resource/api-keys" {
			if r.URL.Query().Get("status") != "active" || r.Header.Get("Authorization") != "Bearer oidc-token" {
				t.Fatalf("unexpected API Key request: url=%s authorization=%q", r.URL.String(), r.Header.Get("Authorization"))
			}
			_, _ = w.Write([]byte(`{"items":[{"api_key":"key-a","name":"生产 Key"}]}`))
			return
		}
		if r.URL.Path == "/v1/models" && r.Header.Get("Authorization") == "Bearer key-a" {
			_, _ = w.Write([]byte(`{"data":[{"id":"model-a"}]}`))
			return
		}
		t.Fatalf("unexpected upstream request: path=%s authorization=%q", r.URL.Path, r.Header.Get("Authorization"))
	}))
	defer upstream.Close()
	r := newOIDCResourceRouter(upstream, config.ModelWhitelistConfig{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/api-keys?scope=image", nil)
	req.Header.Set(oidcAccessTokenHeader, "oidc-token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	var payload struct {
		Items []struct {
			APIKey string `json:"api_key"`
			Name   string `json:"name"`
		} `json:"items"`
		Count int `json:"count"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || payload.Count != 1 || len(payload.Items) != 1 || payload.Items[0].APIKey != "key-a" || payload.Items[0].Name != "生产 Key" {
		t.Fatalf("unexpected response: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestOIDCResourceHandlerRemovesAPIKeysWithoutScopedModels(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/oidc/resource/api-keys" {
			_, _ = w.Write([]byte(`{"items":[{"api_key":"image-key"},{"api_key":"agent-key"},{"api_key":"empty-key"}]}`))
			return
		}
		models := map[string]string{
			"Bearer image-key": `{"data":[{"id":"gpt-image-2"}]}`,
			"Bearer agent-key": `{"data":[{"id":"gpt-5.2"}]}`,
			"Bearer empty-key": `{"data":[]}`,
		}
		body, ok := models[r.Header.Get("Authorization")]
		if r.URL.Path != "/v1/models" || !ok {
			t.Fatalf("unexpected upstream request: path=%s authorization=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(body))
	}))
	defer upstream.Close()
	r := newOIDCResourceRouter(upstream, config.ModelWhitelistConfig{
		Image: []string{"gpt-image-2"},
		Agent: []string{"gpt-5.2"},
	})

	for _, tc := range []struct {
		scope string
		want  string
	}{
		{scope: "image", want: "image-key"},
		{scope: "agent", want: "agent-key"},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/api-keys?scope="+tc.scope, nil)
		req.Header.Set(oidcAccessTokenHeader, "oidc-token")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		var payload struct {
			Items []struct {
				APIKey string `json:"api_key"`
			} `json:"items"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if w.Code != http.StatusOK || len(payload.Items) != 1 || payload.Items[0].APIKey != tc.want {
			t.Fatalf("scope %s: unexpected response: status=%d body=%s", tc.scope, w.Code, w.Body.String())
		}
	}
}

func TestOIDCResourceHandlerFiltersModelsByScope(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer key-a" {
			t.Fatalf("unexpected model request: path=%s authorization=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"gpt-image-2","owned_by":"openai"},{"id":"gpt-5.2"},{"id":"other"}]}`))
	}))
	defer upstream.Close()
	r := newOIDCResourceRouter(upstream, config.ModelWhitelistConfig{
		Image: []string{"gpt-image-2", "missing"},
		Agent: []string{"gpt-5.2"},
	})

	for _, tc := range []struct {
		scope string
		want  string
	}{
		{scope: "image", want: "gpt-image-2"},
		{scope: "agent", want: "gpt-5.2"},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/models?scope="+tc.scope, nil)
		req.Header.Set(compositeAPIKeyHeader, "key-a")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("scope %s: want 200, got %d body=%s", tc.scope, w.Code, w.Body.String())
		}
		var payload struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatalf("scope %s: invalid JSON: %v", tc.scope, err)
		}
		if len(payload.Data) != 1 || payload.Data[0].ID != tc.want {
			t.Fatalf("scope %s: unexpected models: %#v", tc.scope, payload.Data)
		}
	}
}

func TestOIDCResourceHandlerEmptyWhitelistAllowsAllModels(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"model-a"},{"id":"model-b"}]}`))
	}))
	defer upstream.Close()
	r := newOIDCResourceRouter(upstream, config.ModelWhitelistConfig{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/models?scope=image", nil)
	req.Header.Set(compositeAPIKeyHeader, "key-a")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	var payload modelListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || len(payload.Data) != 2 {
		t.Fatalf("unexpected response: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestOIDCResourceHandlerMapsUpstreamUnauthorized(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"token expired"}`))
	}))
	defer upstream.Close()
	r := newOIDCResourceRouter(upstream, config.ModelWhitelistConfig{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/api-keys?scope=image", nil)
	req.Header.Set(oidcAccessTokenHeader, "expired-token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusFailedDependency {
		t.Fatalf("want 424, got %d body=%s", w.Code, w.Body.String())
	}
}
