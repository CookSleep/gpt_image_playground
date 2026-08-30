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
	"time"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
	"gpt-image-backend/pkg/config"
)

type projectGenerationStoreStub struct {
	events       []string
	userID       string
	projectID    string
	projectTitle string
	image        models.ProjectImage
	data         []byte
	taskRecords  chan savedGenerationTaskRecord
}

type savedGenerationTaskRecord struct {
	userID       string
	projectID    string
	projectTitle string
	taskID       string
	project      json.RawMessage
	task         json.RawMessage
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

func (s *projectGenerationStoreStub) SaveTaskRecord(_ context.Context, userID, id, title, taskID string, project, task json.RawMessage) (*models.OnlineProject, error) {
	if s.taskRecords != nil {
		s.taskRecords <- savedGenerationTaskRecord{
			userID: userID, projectID: id, projectTitle: title, taskID: taskID,
			project: append(json.RawMessage(nil), project...), task: append(json.RawMessage(nil), task...),
		}
	}
	return &models.OnlineProject{}, nil
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
	projectID := "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8"
	data, _ := json.Marshal(map[string]any{
		"task_id":       "task-a",
		"project_title": "在线项目",
		"project": map[string]any{
			"id": projectID, "title": "在线项目", "storage": "online", "remoteId": projectID,
		},
		"task": map[string]any{
			"id": "task-a", "projectId": projectID, "prompt": "画一张图",
			"params":        map[string]any{"size": "1024x1024", "quality": "medium", "output_format": "png", "moderation": "auto", "n": 1},
			"inputImageIds": []string{}, "outputImages": []string{}, "status": "running",
			"error": nil, "createdAt": 1000, "finishedAt": nil, "elapsed": nil,
		},
		"api_key":     "oidc-api-key",
		"model":       "gpt-image-2",
		"request_ids": []string{"img-request-a"},
		"prompt":      "画一张图",
		"params": map[string]any{
			"size": "1024x1024", "quality": "medium", "output_format": "png", "moderation": "auto", "n": 1,
		},
		"input_images": inputImages,
		"mask":         mask,
	})
	return bytes.NewReader(data)
}

func TestCreateUpstreamGenerationRequestUsesConfiguredCodexCLIForOpenAI(t *testing.T) {
	req := projectGenerationRequest{
		Provider:   "openai",
		Model:      "gpt-image-2",
		Prompt:     "画一张图",
		RequestIDs: []string{"request-a"},
		Params: projectGenerationParams{
			Size: "1024x1024", Quality: "medium", OutputFormat: "png", Moderation: "auto", N: 2,
		},
	}
	upstreamRequest, err := createUpstreamGenerationRequest(context.Background(), "https://provider.example", "test", req, config.UpstreamConfig{
		ImageAPI: config.ImageAPIUpstreamConfig{CodexCLI: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(upstreamRequest.Body)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload["n"]; ok {
		t.Fatalf("codex CLI config should omit n: %#v", payload)
	}
	if _, ok := payload["quality"]; ok {
		t.Fatalf("codex CLI config should omit quality: %#v", payload)
	}
	req.Provider = "other"
	standardRequest, err := createUpstreamGenerationRequest(context.Background(), "https://provider.example", "test", req, config.UpstreamConfig{
		ImageAPI: config.ImageAPIUpstreamConfig{CodexCLI: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	standardBody, err := io.ReadAll(standardRequest.Body)
	if err != nil {
		t.Fatal(err)
	}
	var standardPayload map[string]any
	if err := json.Unmarshal(standardBody, &standardPayload); err != nil {
		t.Fatal(err)
	}
	if standardPayload["n"] != float64(2) || standardPayload["quality"] != "medium" {
		t.Fatalf("codex CLI config must be scoped to OpenAI: %#v", standardPayload)
	}
}

func TestSanitizeGenerationLogValueRedactsSecretsAndImageData(t *testing.T) {
	value := sanitizeGenerationLogValue(map[string]any{
		"api_key": "composite-secret-key",
		"image":   "data:image/png;base64,AAECAw==",
		"result":  map[string]any{"b64_json": "AAECAw=="},
	}, "").(map[string]any)

	if value["api_key"] != "compos...-key" {
		t.Fatalf("api key was not masked: %#v", value["api_key"])
	}
	if strings.Contains(value["image"].(string), "AAECAw==") || strings.Contains(value["result"].(map[string]any)["b64_json"].(string), "AAECAw==") {
		t.Fatalf("image data leaked into log value: %#v", value)
	}
}

func TestBuildGenerationTaskRecordStoresFailure(t *testing.T) {
	req := projectGenerationRequest{
		TaskID:     "task-a",
		Task:       json.RawMessage(`{"id":"task-a","status":"running","error":null,"createdAt":1000,"finishedAt":null,"elapsed":null}`),
		RequestIDs: []string{"request-a"},
	}
	record, err := buildGenerationTaskRecord(req, nil, http.StatusBadGateway, "provider failed", time.UnixMilli(2500))
	if err != nil {
		t.Fatal(err)
	}
	var task map[string]any
	if err := json.Unmarshal(record, &task); err != nil {
		t.Fatal(err)
	}
	if task["status"] != "error" || task["error"] != "provider failed" || task["elapsed"] != float64(1500) {
		t.Fatalf("unexpected failure task: %s", record)
	}
}

func TestBuildGenerationTaskRecordStoresRecoverableRunningTask(t *testing.T) {
	req := projectGenerationRequest{
		TaskID:     "task-a",
		Task:       json.RawMessage(`{"id":"task-a","status":"running","error":null,"createdAt":1000,"finishedAt":null,"elapsed":null}`),
		RequestIDs: []string{"request-a"},
	}
	record, err := buildGenerationTaskRecord(req, nil, http.StatusAccepted, "", time.UnixMilli(2500))
	if err != nil {
		t.Fatal(err)
	}
	var task map[string]any
	if err := json.Unmarshal(record, &task); err != nil {
		t.Fatal(err)
	}
	if task["status"] != "running" || task["error"] != nil || task["imageStatusRecoverable"] != true || task["finishedAt"] != nil {
		t.Fatalf("unexpected running task: %s", record)
	}
}

func TestBuildGenerationTaskRecordStoresCloudflareTimeoutAsRecoverable(t *testing.T) {
	req := projectGenerationRequest{
		TaskID:     "task-a",
		Task:       json.RawMessage(`{"id":"task-a","status":"running","error":null,"createdAt":1000,"finishedAt":null,"elapsed":null}`),
		RequestIDs: []string{"request-a"},
	}
	record, err := buildGenerationTaskRecord(req, nil, cloudflareOriginTimeoutStatus, "origin response timeout", time.UnixMilli(125000))
	if err != nil {
		t.Fatal(err)
	}
	var task map[string]any
	if err := json.Unmarshal(record, &task); err != nil {
		t.Fatal(err)
	}
	if task["status"] != "running" || task["error"] != nil || task["imageStatusRecoverable"] != true || task["finishedAt"] != nil {
		t.Fatalf("unexpected Cloudflare timeout task: %s", record)
	}
}

func TestProjectGenerationHandlerGeneratesAndSavesBeforeReturning(t *testing.T) {
	store := &projectGenerationStoreStub{taskRecords: make(chan savedGenerationTaskRecord, 2)}
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		store.events = append(store.events, "upstream")
		if req.URL.String() != "https://provider.example/v1/images/generations" {
			t.Fatalf("unexpected upstream URL: %s", req.URL)
		}
		if req.Header.Get("Authorization") != "Bearer oidc-api-key" || req.Header.Get("x-client-request-id") != "img-request-a" {
			t.Fatalf("unexpected upstream headers: %#v", req.Header)
		}
		if req.UserAgent() != "gpt-image-playground-browser/1.0" {
			t.Fatalf("unexpected upstream user agent: %q", req.UserAgent())
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
	req.Header.Set("User-Agent", "gpt-image-playground-browser/1.0")
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
	select {
	case saved := <-store.taskRecords:
		var runningTask map[string]any
		if err := json.Unmarshal(saved.task, &runningTask); err != nil {
			t.Fatal(err)
		}
		if runningTask["status"] != "running" || runningTask["imageStatusRecoverable"] != true {
			t.Fatalf("unexpected initial task: %s", saved.task)
		}
	case <-time.After(time.Second):
		t.Fatal("initial generation task record was not saved")
	}
	select {
	case saved := <-store.taskRecords:
		if saved.userID != "user-a" || saved.projectID != "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8" || saved.projectTitle != "在线项目" || saved.taskID != "task-a" {
			t.Fatalf("unexpected task metadata: %#v", saved)
		}
		var task map[string]any
		if err := json.Unmarshal(saved.task, &task); err != nil {
			t.Fatal(err)
		}
		outputImages, _ := task["outputImages"].([]any)
		actualParamsByImage, _ := task["actualParamsByImage"].(map[string]any)
		revisedPromptByImage, _ := task["revisedPromptByImage"].(map[string]any)
		if task["status"] != "done" || task["error"] != nil || len(outputImages) != 1 || outputImages[0] != expectedID {
			t.Fatalf("unexpected saved task: %s", saved.task)
		}
		if actualParamsByImage[expectedID] == nil || revisedPromptByImage[expectedID] != "rewritten" {
			t.Fatalf("missing per-image generation metadata: %s", saved.task)
		}
	case <-time.After(time.Second):
		t.Fatal("generation task record was not saved asynchronously")
	}
}

func TestProjectGenerationHandlerContinuesAfterClientCancellation(t *testing.T) {
	store := &projectGenerationStoreStub{taskRecords: make(chan savedGenerationTaskRecord, 2)}
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if err := req.Context().Err(); err != nil {
			t.Fatalf("upstream request was canceled with client: %v", err)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"data":[{"b64_json":"AAECAw=="}]}`)),
			Request:    req,
		}, nil
	})
	r := newProjectGenerationRouter(store, transport)
	requestCtx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/generations", generationRequestBody(nil, "")).WithContext(requestCtx)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	select {
	case saved := <-store.taskRecords:
		var task map[string]any
		if err := json.Unmarshal(saved.task, &task); err != nil {
			t.Fatal(err)
		}
		if task["status"] != "running" {
			t.Fatalf("unexpected initial task status: %s", saved.task)
		}
	case <-time.After(time.Second):
		t.Fatal("initial task record was not saved")
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

func TestProjectGenerationHandlerRejectsCompositeProvider(t *testing.T) {
	store := &projectGenerationStoreStub{}
	r := newProjectGenerationRouter(store, roundTripFunc(func(req *http.Request) (*http.Response, error) {
		t.Fatalf("upstream must not be called: %s", req.URL)
		return nil, nil
	}))
	body, _ := io.ReadAll(generationRequestBody(nil, ""))
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	payload["provider"] = "composite"
	body, _ = json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/generations", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "unsupported image provider") {
		t.Fatalf("unexpected response: status=%d body=%s", w.Code, w.Body.String())
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
		if req.UserAgent() != "gpt-image-playground-browser/1.0" {
			t.Fatalf("unexpected upstream user agent: %q", req.UserAgent())
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
	payload["request_ids"] = []string{"img-request-a", "img-request-b"}
	payload["params"].(map[string]any)["n"] = 2
	body, _ = json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/generations", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "gpt-image-playground-browser/1.0")
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

func TestProjectGenerationHandlerProxiesAgentResponsesStream(t *testing.T) {
	store := &projectGenerationStoreStub{}
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != "https://provider.example/v1/responses" {
			t.Fatalf("unexpected upstream URL: %s", req.URL)
		}
		if req.Header.Get("Authorization") != "Bearer agent-api-key" {
			t.Fatalf("unexpected upstream authorization: %q", req.Header.Get("Authorization"))
		}
		body, _ := io.ReadAll(req.Body)
		var payload map[string]any
		if json.Unmarshal(body, &payload) != nil || payload["api_key"] != nil || payload["model"] != "gpt-5.5" || payload["input"] != "hello" || payload["stream"] != true {
			t.Fatalf("unexpected upstream body: %s", body)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader("data: {\"type\":\"response.completed\"}\n\n")),
		}, nil
	})
	r := newProjectGenerationRouter(store, transport)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/responses", strings.NewReader(`{"api_key":"agent-api-key","model":"gpt-5.5","input":"hello","stream":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Client-Request-ID", "agent-request-a")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if w.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("unexpected response content type: %q", w.Header().Get("Content-Type"))
	}
	if w.Body.String() != "data: {\"type\":\"response.completed\"}\n\n" {
		t.Fatalf("unexpected response body: %q", w.Body.String())
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
		if req.UserAgent() != "gpt-image-playground-browser/1.0" {
			t.Fatalf("unexpected upstream user agent: %q", req.UserAgent())
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
	req.Header.Set("User-Agent", "gpt-image-playground-browser/1.0")
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
