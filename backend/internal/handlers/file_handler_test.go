package handlers

import (
	"bytes"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/pkg/config"
)

func newFileAPIRouter(transport http.RoundTripper, cfg config.FileAPIConfig) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Set(middleware.ContextKeyProvider, "provider-a")
		c.Next()
	})
	handler := NewFileAPIHandler(imageProviderRegistryStub{baseURL: "https://provider.example"}, cfg)
	handler.client = &http.Client{Transport: transport}
	handler.Register(api)
	return r
}

func TestFileAPIHandlerUploadsWithConfiguredDeveloperKey(t *testing.T) {
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodPost || req.URL.String() != "https://provider.example/api/v1/file/" {
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL)
		}
		if req.Header.Get("Authorization") != "Bearer dev_secret" {
			t.Fatalf("unexpected authorization: %q", req.Header.Get("Authorization"))
		}
		if req.ContentLength <= 0 {
			t.Fatalf("upstream request must preserve content length, got %d", req.ContentLength)
		}
		_, params, err := mime.ParseMediaType(req.Header.Get("Content-Type"))
		if err != nil {
			t.Fatal(err)
		}
		part, err := multipart.NewReader(req.Body, params["boundary"]).NextPart()
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(part)
		if part.FormName() != "file" || part.FileName() != "reference.png" || string(data) != "image-data" {
			t.Fatalf("unexpected multipart file: field=%q name=%q data=%q", part.FormName(), part.FileName(), data)
		}
		return &http.Response{
			StatusCode: http.StatusCreated,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"code":0,"data":{"url":"https://files.example/reference.png","size":10,"content_type":"image/png"}}`)),
			Request:    req,
		}, nil
	})
	r := newFileAPIRouter(transport, config.FileAPIConfig{DeveloperKey: " dev_secret ", TimeoutSeconds: 30})
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", "reference.png")
	_, _ = part.Write([]byte("image-data"))
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/files", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusCreated || !bytes.Contains(w.Body.Bytes(), []byte(`"url":"https://files.example/reference.png"`)) {
		t.Fatalf("unexpected response: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestFileAPIHandlerDeletesTemporaryFile(t *testing.T) {
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		data, _ := io.ReadAll(req.Body)
		if req.Method != http.MethodDelete || req.URL.String() != "https://provider.example/api/v1/file/" || string(data) != `{"url":"https://files.example/reference.png"}` {
			t.Fatalf("unexpected request: %s %s body=%s", req.Method, req.URL, data)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"code":0,"data":{"deleted":true}}`)), Request: req}, nil
	})
	r := newFileAPIRouter(transport, config.FileAPIConfig{DeveloperKey: "dev_secret", TimeoutSeconds: 30})
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/files", strings.NewReader(`{"url":"https://files.example/reference.png"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK || w.Body.String() != `{"code":0,"data":{"deleted":true}}` {
		t.Fatalf("unexpected response: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestFileAPIHandlerRequiresDeveloperKeyConfiguration(t *testing.T) {
	r := newFileAPIRouter(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		t.Fatalf("upstream must not be called: %s", req.URL)
		return nil, nil
	}), config.FileAPIConfig{TimeoutSeconds: 30})
	body := strings.NewReader("discard this upload body")
	req := httptest.NewRequest(http.MethodPost, "/api/v1/files", body)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d body=%s", w.Code, w.Body.String())
	}
	if body.Len() != 0 {
		t.Fatalf("request body was not fully consumed: %d bytes remain", body.Len())
	}
	if w.Header().Get("Connection") != "" {
		t.Fatalf("connection should remain reusable, got Connection: %q", w.Header().Get("Connection"))
	}
}
