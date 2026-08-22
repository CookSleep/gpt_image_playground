package handlers

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/middleware"
)

func newCompositeModelRouter(transport http.RoundTripper, authenticated bool) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		if authenticated {
			c.Set(middleware.ContextKeyUserID, "user-a")
			c.Set(middleware.ContextKeyProvider, "provider-a")
		}
		c.Next()
	})
	handler := NewCompositeModelHandler(imageProviderRegistryStub{baseURL: "https://provider.example"})
	handler.client = &http.Client{Transport: transport}
	handler.Register(api)
	return r
}

func TestCompositeModelHandlerForwardsAsyncRequests(t *testing.T) {
	requestCount := 0
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		requestCount++
		if req.Header.Get("Authorization") != "Bearer composite-key" {
			t.Fatalf("unexpected authorization: %q", req.Header.Get("Authorization"))
		}
		if requestCount == 1 {
			if req.Method != http.MethodPost || req.URL.String() != "https://provider.example/api/v1/model/openai/gpt-image-2" {
				t.Fatalf("unexpected submit request: %s %s", req.Method, req.URL)
			}
			body, _ := io.ReadAll(req.Body)
			if string(body) != `{"prompt":"画图"}` {
				t.Fatalf("unexpected body: %s", body)
			}
			return &http.Response{StatusCode: http.StatusAccepted, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"request_id":"request-1"}`)), Request: req}, nil
		}
		if req.Method != http.MethodGet || req.URL.String() != "https://provider.example/api/v1/model/openai/gpt-image-2/requests/request-1/status?verbose=true" {
			t.Fatalf("unexpected status request: %s %s", req.Method, req.URL)
		}
		return &http.Response{StatusCode: http.StatusBadRequest, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"message":"invalid request"}`)), Request: req}, nil
	})
	r := newCompositeModelRouter(transport, true)

	submit := httptest.NewRequest(http.MethodPost, "/api/v1/model/openai/gpt-image-2", strings.NewReader(`{"prompt":"画图"}`))
	submit.Header.Set(compositeAPIKeyHeader, "composite-key")
	submit.Header.Set("Content-Type", "application/json")
	submitResponse := httptest.NewRecorder()
	r.ServeHTTP(submitResponse, submit)
	if submitResponse.Code != http.StatusAccepted || submitResponse.Body.String() != `{"request_id":"request-1"}` {
		t.Fatalf("unexpected submit response: status=%d body=%s", submitResponse.Code, submitResponse.Body.String())
	}

	status := httptest.NewRequest(http.MethodGet, "/api/v1/model/openai/gpt-image-2/requests/request-1/status?verbose=true", nil)
	status.Header.Set(compositeAPIKeyHeader, "composite-key")
	statusResponse := httptest.NewRecorder()
	r.ServeHTTP(statusResponse, status)
	if statusResponse.Code != http.StatusBadRequest || statusResponse.Body.String() != `{"message":"invalid request"}` {
		t.Fatalf("unexpected status response: status=%d body=%s", statusResponse.Code, statusResponse.Body.String())
	}
}

func TestCompositeModelHandlerRequiresAuthentication(t *testing.T) {
	r := newCompositeModelRouter(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		t.Fatalf("upstream must not be called: %s", req.URL)
		return nil, nil
	}), false)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/model/openai/gpt-image-2/requests/request-1/status", nil)
	req.Header.Set(compositeAPIKeyHeader, "composite-key")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d body=%s", w.Code, w.Body.String())
	}
}
