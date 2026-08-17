package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
)

type projectGenerationStoreStub struct {
	events       []string
	userID       string
	projectID    string
	projectTitle string
	image        models.ProjectImage
	data         []byte
}

func (s *projectGenerationStoreStub) Ensure(_ context.Context, userID, id, title string) error {
	s.events = append(s.events, "ensure")
	s.userID = userID
	s.projectID = id
	s.projectTitle = title
	return nil
}

func (s *projectGenerationStoreStub) SaveImage(_ context.Context, userID string, image models.ProjectImage, data []byte) (*models.ProjectImage, error) {
	s.events = append(s.events, "save")
	s.userID = userID
	s.image = image
	s.data = append([]byte(nil), data...)
	return &image, nil
}

type imageProviderRegistryStub struct {
	baseURL string
}

func (s imageProviderRegistryStub) ResourceBaseURL(name string) (string, bool) {
	return s.baseURL, name == "provider-a"
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func newProjectGenerationRouter(store projectGenerationStore, transport http.RoundTripper) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Set(middleware.ContextKeyProvider, "provider-a")
		c.Next()
	})
	handler := NewProjectGenerationHandler(store, imageProviderRegistryStub{baseURL: "https://provider.example"})
	handler.client = &http.Client{Transport: transport}
	handler.Register(api)
	return r
}

func generationRequestBody(inputImages []string, mask string) io.Reader {
	data, _ := json.Marshal(map[string]any{
		"task_id":       "task-a",
		"project_title": "在线项目",
		"api_key":       "oidc-api-key",
		"model":         "gpt-image-2",
		"request_ids":   []string{"img-request-a"},
		"prompt":        "画一张图",
		"params": map[string]any{
			"size": "1024x1024", "quality": "medium", "output_format": "png", "moderation": "auto", "n": 1,
		},
		"input_images": inputImages,
		"mask":         mask,
	})
	return bytes.NewReader(data)
}

func TestProjectGenerationHandlerGeneratesAndSavesBeforeReturning(t *testing.T) {
	store := &projectGenerationStoreStub{}
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		store.events = append(store.events, "upstream")
		if req.URL.String() != "https://provider.example/v1/images/generations" {
			t.Fatalf("unexpected upstream URL: %s", req.URL)
		}
		if req.Header.Get("Authorization") != "Bearer oidc-api-key" || req.Header.Get("x-client-request-id") != "img-request-a" {
			t.Fatalf("unexpected upstream headers: %#v", req.Header)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{
				"data":[{"b64_json":"AAECAw==","revised_prompt":"rewritten"}],
				"size":"1024x1024","quality":"medium","output_format":"png","n":1
			}`)),
			Request: req,
		}, nil
	})
	r := newProjectGenerationRouter(store, transport)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/generations", generationRequestBody(nil, ""))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if strings.Join(store.events, ",") != "ensure,upstream,save" {
		t.Fatalf("unexpected operation order: %v", store.events)
	}
	if store.userID != "user-a" || store.projectID != "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8" || store.projectTitle != "在线项目" {
		t.Fatalf("unexpected project metadata: user=%q project=%q title=%q", store.userID, store.projectID, store.projectTitle)
	}
	if !bytes.Equal(store.data, []byte{0, 1, 2, 3}) || store.image.TaskID != "task-a" || store.image.Source != "generated" {
		t.Fatalf("unexpected saved image: image=%#v data=%v", store.image, store.data)
	}
	dataURL := "data:image/png;base64,AAECAw=="
	digest := sha256.Sum256([]byte(dataURL))
	expectedID := hex.EncodeToString(digest[:])
	if store.image.ImageID != expectedID || !strings.Contains(w.Body.String(), `"image_ids":["`+expectedID+`"]`) {
		t.Fatalf("unexpected image id: saved=%q body=%s", store.image.ImageID, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"images":["`+dataURL+`"]`) || !strings.Contains(w.Body.String(), `"revised_prompts":["rewritten"]`) {
		t.Fatalf("unexpected response body: %s", w.Body.String())
	}
}

func TestProjectGenerationHandlerUsesMultipartEdits(t *testing.T) {
	store := &projectGenerationStoreStub{}
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		store.events = append(store.events, "upstream")
		if req.URL.Path != "/v1/images/edits" {
			t.Fatalf("unexpected upstream path: %s", req.URL.Path)
		}
		if err := req.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		if req.FormValue("model") != "gpt-image-2" || req.FormValue("prompt") != "画一张图" {
			t.Fatalf("unexpected multipart fields: %#v", req.MultipartForm.Value)
		}
		if len(req.MultipartForm.File["image[]"]) != 1 || len(req.MultipartForm.File["mask"]) != 1 {
			t.Fatalf("unexpected multipart files: %#v", req.MultipartForm.File)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"data":[{"b64_json":"AAECAw=="}]}`)),
			Request:    req,
		}, nil
	})
	r := newProjectGenerationRouter(store, transport)
	image := "data:image/png;base64,AAECAw=="
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/edits", generationRequestBody([]string{image}, image))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if strings.Join(store.events, ",") != "ensure,upstream,save" {
		t.Fatalf("unexpected operation order: %v", store.events)
	}
}

func TestProjectGenerationHandlerUsesResponsesAPIAndSavesImage(t *testing.T) {
	store := &projectGenerationStoreStub{}
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		store.events = append(store.events, "upstream")
		if req.URL.String() != "https://provider.example/v1/responses" {
			t.Fatalf("unexpected upstream URL: %s", req.URL)
		}
		if req.Header.Get("x-client-request-id") != "img-request-a" {
			t.Fatalf("unexpected request id: %q", req.Header.Get("x-client-request-id"))
		}
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		tools, ok := body["tools"].([]any)
		if !ok || len(tools) != 1 {
			t.Fatalf("unexpected tools: %#v", body["tools"])
		}
		tool, ok := tools[0].(map[string]any)
		if !ok || tool["type"] != "image_generation" || tool["action"] != "generate" {
			t.Fatalf("unexpected image tool: %#v", tools[0])
		}
		if body["input"] != promptRewriteGuardPrefix+"\n画一张图" {
			t.Fatalf("unexpected input: %#v", body["input"])
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{
				"output":[{
					"type":"image_generation_call",
					"result":{"b64_json":"AAECAw=="},
					"revised_prompt":"rewritten",
					"size":"1024x1024"
				}]
			}`)),
			Request: req,
		}, nil
	})
	r := newProjectGenerationRouter(store, transport)
	body, _ := io.ReadAll(generationRequestBody(nil, ""))
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	payload["api_mode"] = "responses"
	body, _ = json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/generations", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if strings.Join(store.events, ",") != "ensure,upstream,save" {
		t.Fatalf("unexpected operation order: %v", store.events)
	}
	if !bytes.Equal(store.data, []byte{0, 1, 2, 3}) || !strings.Contains(w.Body.String(), `"images":["data:image/png;base64,AAECAw=="]`) {
		t.Fatalf("responses image was not saved before returning: data=%v body=%s", store.data, w.Body.String())
	}
}

func TestProjectGenerationHandlerProxiesImageStatus(t *testing.T) {
	store := &projectGenerationStoreStub{}
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodGet || req.URL.Path != "/v1/images/status/" {
			t.Fatalf("unexpected upstream request: %s %s", req.Method, req.URL)
		}
		if req.URL.Query().Get("request_ids") != "img-request-a,img-request-b" {
			t.Fatalf("unexpected request ids: %q", req.URL.Query().Get("request_ids"))
		}
		if req.Header.Get("Authorization") != "Bearer oidc-api-key" {
			t.Fatalf("unexpected authorization: %q", req.Header.Get("Authorization"))
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"data":[{"request_id":"img-request-a","status":"running"}],"not_found":["img-request-b"]}`)),
			Request:    req,
		}, nil
	})
	r := newProjectGenerationRouter(store, transport)
	body := strings.NewReader(`{"api_key":"oidc-api-key","request_ids":["img-request-a","img-request-b"]}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/images/status", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if w.Body.String() != `{"data":[{"request_id":"img-request-a","status":"running"}],"not_found":["img-request-b"]}` {
		t.Fatalf("unexpected response body: %s", w.Body.String())
	}
	if len(store.events) != 0 {
		t.Fatalf("status proxy must not write project data: %v", store.events)
	}
}
