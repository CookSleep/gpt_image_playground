package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"gpt-image-backend/internal/database"
	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
	"gpt-image-backend/pkg/config"
)

const maxGenerationRequestBytes = 512 << 20
const promptRewriteGuardPrefix = "Use the following text as the complete prompt. Do not rewrite it:"
const generationExecutionTimeout = 15 * time.Minute
const maxGenerationLogResponseBytes = 64 << 10
const cloudflareOriginTimeoutStatus = 524

type generationLogResponseWriter struct {
	gin.ResponseWriter
	body      bytes.Buffer
	truncated bool
}

func (w *generationLogResponseWriter) Write(data []byte) (int, error) {
	remaining := maxGenerationLogResponseBytes - w.body.Len()
	if remaining > 0 {
		captured := len(data)
		if captured > remaining {
			captured = remaining
			w.truncated = true
		}
		_, _ = w.body.Write(data[:captured])
	} else if len(data) > 0 {
		w.truncated = true
	}
	return w.ResponseWriter.Write(data)
}

func (w *generationLogResponseWriter) WriteString(data string) (int, error) {
	return w.Write([]byte(data))
}

func maskGenerationLogSecret(value string) string {
	if value == "" {
		return ""
	}
	if len(value) <= 12 {
		return "***"
	}
	return value[:6] + "..." + value[len(value)-4:]
}

func summarizeGenerationLogString(value string) string {
	if strings.HasPrefix(value, "data:") {
		mediaType := strings.TrimPrefix(strings.SplitN(value, ";", 2)[0], "data:")
		return fmt.Sprintf("[data URL: type=%s length=%d]", mediaType, len(value))
	}
	return fmt.Sprintf("[encoded data: length=%d]", len(value))
}

func sanitizeGenerationLogValue(value any, key string) any {
	lowerKey := strings.ToLower(key)
	switch typed := value.(type) {
	case string:
		if lowerKey == "api_key" || lowerKey == "apikey" || lowerKey == "authorization" {
			return maskGenerationLogSecret(typed)
		}
		if strings.HasPrefix(typed, "data:") || strings.Contains(lowerKey, "b64") || strings.Contains(lowerKey, "base64") {
			return summarizeGenerationLogString(typed)
		}
		return typed
	case []any:
		items := make([]any, len(typed))
		for index, item := range typed {
			items[index] = sanitizeGenerationLogValue(item, key)
		}
		return items
	case map[string]any:
		items := make(map[string]any, len(typed))
		for itemKey, item := range typed {
			items[itemKey] = sanitizeGenerationLogValue(item, itemKey)
		}
		return items
	default:
		return value
	}
}

func generationLogPayload(data []byte, truncated bool) any {
	if truncated {
		return map[string]any{"captured_bytes": len(data), "truncated": true}
	}
	var payload any
	if json.Unmarshal(data, &payload) == nil {
		return sanitizeGenerationLogValue(payload, "")
	}
	text := string(data)
	if len(text) > 4096 {
		text = text[:4096] + "..."
	}
	return text
}

func logGenerationRequest(c *gin.Context, req projectGenerationRequest) {
	data, _ := json.Marshal(req)
	log.Ctx(c.Request.Context()).Info().
		Str("method", c.Request.Method).
		Str("path", c.Request.URL.Path).
		Str("user_id", c.GetString(middleware.ContextKeyUserID)).
		Interface("body", generationLogPayload(data, false)).
		Msg("generation request")
}

func logGenerationUpstreamRequest(ctx context.Context, method, endpoint string, attempt int, body []byte) {
	event := log.Ctx(ctx).Info().
		Str("method", method).
		Str("url", endpoint).
		Int("attempt", attempt)
	if len(body) > 0 {
		event = event.Interface("body", generationLogPayload(body, false))
	}
	event.Msg("generation upstream request")
}

func logGenerationUpstream(ctx context.Context, method, endpoint string, attempt, status int, body []byte, err error) {
	event := log.Ctx(ctx).Info().
		Str("method", method).
		Str("url", endpoint).
		Int("attempt", attempt)
	if status > 0 {
		event = event.Int("status", status)
	}
	if len(body) > 0 {
		event = event.Interface("body", generationLogPayload(body, false))
	}
	if err != nil {
		event = event.Err(err)
	}
	event.Msg("generation upstream response")
}

type projectGenerationStore interface {
	Ensure(ctx context.Context, userID, id, title string) error
	SaveImage(ctx context.Context, userID string, image models.ProjectImage, data []byte) (*models.ProjectImage, error)
	SaveTaskRecord(ctx context.Context, userID, id, title, taskID string, project, task json.RawMessage) (*models.OnlineProject, error)
}

type imageProviderRegistry interface {
	ResourceBaseURL(name string) (string, bool)
}

type ProjectGenerationHandler struct {
	projects  projectGenerationStore
	providers imageProviderRegistry
	client    *http.Client
	upstreams config.UpstreamConfig
}

func NewProjectGenerationHandler(projects projectGenerationStore, providers imageProviderRegistry, upstreams ...config.UpstreamConfig) *ProjectGenerationHandler {
	upstreamConfig := config.DefaultUpstreamConfig()
	if len(upstreams) > 0 {
		upstreamConfig = config.NormalizeUpstreamConfig(upstreams[0])
	}
	return &ProjectGenerationHandler{
		projects:  projects,
		providers: providers,
		client:    &http.Client{Timeout: generationExecutionTimeout},
		upstreams: upstreamConfig,
	}
}

func (h *ProjectGenerationHandler) Register(api *gin.RouterGroup) {
	api.POST("/projects/:id/generations", h.Generate)
	api.POST("/projects/:id/edits", h.Generate)
	api.POST("/agent/responses", h.AgentResponses)
	api.POST("/images/status", h.Status)
}

// AgentResponses POST /api/v1/agent/responses，代理 Agent 的完整 Responses 请求。
// Agent 会自行处理多轮工具调用，因此这里仅负责固定 provider 的请求转发和响应透传。
func (h *ProjectGenerationHandler) AgentResponses(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	providerName := c.GetString(middleware.ContextKeyProvider)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxGenerationRequestBytes)
	var rawEnvelope map[string]json.RawMessage
	if err := c.ShouldBindJSON(&rawEnvelope); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid Agent responses request required"})
		return
	}
	var apiKey string
	if err := json.Unmarshal(rawEnvelope["api_key"], &apiKey); err != nil {
		apiKey = ""
	}
	if strings.TrimSpace(apiKey) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "api_key is required"})
		return
	}
	body := rawEnvelope["body"]
	if len(body) == 0 {
		body = rawEnvelope["request"]
	}
	if len(body) == 0 {
		delete(rawEnvelope, "api_key")
		body, _ = json.Marshal(rawEnvelope)
	}
	if len(body) == 0 || !json.Valid(body) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid Responses body required"})
		return
	}
	var bodyObject map[string]any
	if err := json.Unmarshal(body, &bodyObject); err != nil || bodyObject == nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "Responses body must be a JSON object"})
		return
	}
	if model, ok := bodyObject["model"].(string); !ok || strings.TrimSpace(model) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "Responses model is required"})
		return
	}

	baseURL, ok := h.providers.ResourceBaseURL(providerName)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "Agent provider unavailable"})
		return
	}
	endpoint := config.JoinUpstreamURL(config.ResolveUpstreamBaseURL(h.upstreams.ImageAPI.BaseURL, baseURL), config.ImageResponsesPath)
	log.Ctx(c.Request.Context()).Info().
		Str("method", c.Request.Method).
		Str("path", c.Request.URL.Path).
		Str("upstream_url", endpoint).
		Str("user_id", userID).
		Interface("body", generationLogPayload(body, false)).
		Msg("agent responses proxy request")

	request, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "create Agent upstream request failed"})
		return
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", c.GetHeader("Accept"))
	request.Header.Set("User-Agent", c.Request.UserAgent())
	if request.Header.Get("Accept") == "" {
		request.Header.Set("Accept", "application/json")
	}
	if clientRequestID := c.GetHeader("x-client-request-id"); clientRequestID != "" {
		request.Header.Set("x-client-request-id", clientRequestID)
	}
	middleware.SetRequestIDHeader(request)
	response, err := h.client.Do(request)
	if err != nil {
		log.Ctx(c.Request.Context()).Error().Err(err).Str("upstream_url", endpoint).Msg("agent responses proxy response")
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "Agent 上游连接失败: " + err.Error()})
		return
	}
	defer response.Body.Close()
	for _, name := range []string{"Content-Type", "Cache-Control", "Retry-After", "X-Request-ID"} {
		if value := response.Header.Get(name); value != "" {
			c.Header(name, value)
		}
	}
	c.Status(response.StatusCode)
	buffer := make([]byte, 32<<10)
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			if _, writeErr := c.Writer.Write(buffer[:count]); writeErr != nil {
				return
			}
			if flusher, ok := c.Writer.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				log.Ctx(c.Request.Context()).Warn().Err(readErr).Str("upstream_url", endpoint).Msg("read Agent upstream response failed")
			}
			break
		}
	}
}

type imageStatusRequest struct {
	APIKey     string   `json:"api_key"`
	RequestIDs []string `json:"request_ids"`
}

type projectGenerationParams struct {
	Size              string `json:"size"`
	Quality           string `json:"quality"`
	OutputFormat      string `json:"output_format"`
	OutputCompression *int   `json:"output_compression"`
	Moderation        string `json:"moderation"`
	N                 int    `json:"n"`
}

type projectGenerationRequest struct {
	TaskID       string                  `json:"task_id"`
	ProjectTitle string                  `json:"project_title"`
	Project      json.RawMessage         `json:"project"`
	Task         json.RawMessage         `json:"task"`
	APIKey       string                  `json:"api_key"`
	Provider     string                  `json:"provider"`
	Model        string                  `json:"model"`
	APIMode      string                  `json:"api_mode"`
	AllowRewrite bool                    `json:"allow_prompt_rewrite"`
	RequestIDs   []string                `json:"request_ids"`
	Prompt       string                  `json:"prompt"`
	Params       projectGenerationParams `json:"params"`
	InputImages  []string                `json:"input_images"`
	Mask         string                  `json:"mask"`
}

type upstreamImageItem struct {
	B64JSON       string `json:"b64_json"`
	URL           string `json:"url"`
	RevisedPrompt string `json:"revised_prompt"`
}

type upstreamImageResponse struct {
	Data              []upstreamImageItem `json:"data"`
	Size              string              `json:"size"`
	Quality           string              `json:"quality"`
	OutputFormat      string              `json:"output_format"`
	OutputCompression *int                `json:"output_compression"`
	Moderation        string              `json:"moderation"`
	N                 int                 `json:"n"`
}

type projectGenerationResponse struct {
	Images           []string                  `json:"images"`
	ImageIDs         []string                  `json:"image_ids"`
	ActualParams     projectGenerationParams   `json:"actual_params"`
	ActualParamsList []projectGenerationParams `json:"actual_params_list,omitempty"`
	RevisedPrompts   []string                  `json:"revised_prompts"`
	TaskRecordQueued bool                      `json:"task_record_queued"`
}

func validateProjectGenerationRequest(req projectGenerationRequest) error {
	if !projectImageIDPattern.MatchString(req.TaskID) {
		return errors.New("valid task id required")
	}
	if strings.TrimSpace(req.ProjectTitle) == "" || utf8.RuneCountInString(req.ProjectTitle) > 120 {
		return errors.New("project title must be 1-120 characters")
	}
	if (len(req.Project) == 0) != (len(req.Task) == 0) {
		return errors.New("project and task records must be provided together")
	}
	if len(req.Task) > 0 && (rawRecordID(req.Project) == "" || rawRecordID(req.Task) != req.TaskID) {
		return errors.New("valid project and task records required")
	}
	if strings.TrimSpace(req.APIKey) == "" || strings.TrimSpace(req.Model) == "" || strings.TrimSpace(req.Prompt) == "" {
		return errors.New("api_key, model and prompt are required")
	}
	if req.APIMode != "images" && req.APIMode != "responses" {
		return errors.New("unsupported api mode")
	}
	if req.Provider != "openai" {
		return errors.New("unsupported image provider")
	}
	if len(req.RequestIDs) == 0 || len(req.RequestIDs) > 10 {
		return errors.New("request_ids must contain 1-10 ids")
	}
	for _, requestID := range req.RequestIDs {
		if !projectImageIDPattern.MatchString(requestID) {
			return errors.New("invalid request id")
		}
	}
	if req.Params.N < 1 || req.Params.N > 10 {
		return errors.New("n must be between 1 and 10")
	}
	if req.Params.OutputFormat != "png" && req.Params.OutputFormat != "jpeg" && req.Params.OutputFormat != "webp" {
		return errors.New("unsupported output format")
	}
	return nil
}

func buildGenerationTaskRecord(req projectGenerationRequest, result *projectGenerationResponse, status int, message string, finishedAt time.Time) (json.RawMessage, error) {
	var task map[string]any
	if err := json.Unmarshal(req.Task, &task); err != nil {
		return nil, fmt.Errorf("decode generation task record: %w", err)
	}
	task["imageStatusRequestIds"] = req.RequestIDs
	task["falRecoverable"] = false
	task["customRecoverable"] = false
	task["compositeRecoverable"] = false

	if status == http.StatusAccepted && result == nil {
		task["status"] = "running"
		task["error"] = nil
		task["imageStatusRecoverable"] = true
		task["finishedAt"] = nil
		task["elapsed"] = nil
		return json.Marshal(task)
	}
	if status == cloudflareOriginTimeoutStatus {
		task["status"] = "running"
		task["error"] = nil
		task["imageStatusRecoverable"] = true
		task["finishedAt"] = nil
		task["elapsed"] = nil
		return json.Marshal(task)
	}

	finishedAtMillis := finishedAt.UnixMilli()
	task["finishedAt"] = finishedAtMillis
	if createdAt, ok := task["createdAt"].(float64); ok {
		task["elapsed"] = max(0, finishedAtMillis-int64(createdAt))
	}
	task["imageStatusRecoverable"] = false

	if status < http.StatusOK || status >= http.StatusMultipleChoices || result == nil {
		task["status"] = "error"
		task["error"] = message
		return json.Marshal(task)
	}

	task["outputImages"] = result.ImageIDs
	task["actualParams"] = result.ActualParams
	actualParamsByImage := make(map[string]projectGenerationParams, len(result.ImageIDs))
	for index, imageID := range result.ImageIDs {
		params := result.ActualParams
		if index < len(result.ActualParamsList) {
			params = result.ActualParamsList[index]
		}
		actualParamsByImage[imageID] = params
	}
	task["actualParamsByImage"] = actualParamsByImage
	revisedPromptByImage := make(map[string]string, len(result.ImageIDs))
	for index, imageID := range result.ImageIDs {
		if index < len(result.RevisedPrompts) && strings.TrimSpace(result.RevisedPrompts[index]) != "" {
			revisedPromptByImage[imageID] = result.RevisedPrompts[index]
		}
	}
	if len(revisedPromptByImage) > 0 {
		task["revisedPromptByImage"] = revisedPromptByImage
	} else {
		delete(task, "revisedPromptByImage")
	}
	task["status"] = "done"
	task["error"] = nil
	return json.Marshal(task)
}

func (h *ProjectGenerationHandler) saveGenerationTaskRecord(ctx context.Context, userID, projectID string, req projectGenerationRequest, result *projectGenerationResponse, status int, message string) error {
	task, err := buildGenerationTaskRecord(req, result, status, message, time.Now())
	if err != nil {
		return err
	}
	project := append(json.RawMessage(nil), req.Project...)
	_, err = h.projects.SaveTaskRecord(ctx, userID, projectID, strings.TrimSpace(req.ProjectTitle), req.TaskID, project, task)
	return err
}

func (h *ProjectGenerationHandler) saveGenerationTaskRecordAsync(requestCtx context.Context, userID, projectID string, req projectGenerationRequest, result *projectGenerationResponse, status int, message string) {
	ctx := context.WithoutCancel(requestCtx)
	go func() {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := h.saveGenerationTaskRecord(ctx, userID, projectID, req, result, status, message); err != nil {
			log.Ctx(ctx).Error().Err(err).Str("project_id", projectID).Str("task_id", req.TaskID).Msg("save generation task record failed")
		}
	}()
}

func (h *ProjectGenerationHandler) codexCLIEnabled(req projectGenerationRequest) bool {
	return req.Provider == "openai" && h.upstreams.ImageAPI.CodexCLI
}

func validateImageStatusRequest(req imageStatusRequest) error {
	if strings.TrimSpace(req.APIKey) == "" {
		return errors.New("api_key is required")
	}
	if len(req.RequestIDs) == 0 || len(req.RequestIDs) > 100 {
		return errors.New("request_ids must contain 1-100 ids")
	}
	for _, requestID := range req.RequestIDs {
		if !projectImageIDPattern.MatchString(requestID) {
			return errors.New("invalid request id")
		}
	}
	return nil
}

func appendGenerationFields(writer *multipart.Writer, req projectGenerationRequest, codexCLI bool) error {
	fields := map[string]string{
		"model":         req.Model,
		"prompt":        req.Prompt,
		"size":          req.Params.Size,
		"output_format": req.Params.OutputFormat,
		"moderation":    req.Params.Moderation,
		"n":             strconv.Itoa(req.Params.N),
	}
	if codexCLI {
		delete(fields, "n")
	} else {
		fields["quality"] = req.Params.Quality
	}
	if req.Params.OutputCompression != nil {
		fields["output_compression"] = strconv.Itoa(*req.Params.OutputCompression)
	}
	for key, value := range fields {
		if value != "" {
			if err := writer.WriteField(key, value); err != nil {
				return err
			}
		}
	}
	return nil
}

func decodeImageDataURL(value string) (string, []byte, error) {
	header, payload, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:image/") || !strings.Contains(header, ";base64") {
		return "", nil, errors.New("valid base64 image data URL required")
	}
	mimeType := strings.TrimPrefix(strings.SplitN(header, ";", 2)[0], "data:")
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(payload))
	if err != nil || len(data) == 0 {
		return "", nil, errors.New("decode image data URL failed")
	}
	return mimeType, data, nil
}

func appendGenerationImage(writer *multipart.Writer, field, filename, value string) error {
	mimeType, data, err := decodeImageDataURL(value)
	if err != nil {
		return err
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, field, filename))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	_, err = part.Write(data)
	return err
}

func createUpstreamGenerationRequest(ctx context.Context, baseURL, userAgent string, req projectGenerationRequest, upstreams ...config.UpstreamConfig) (*http.Request, error) {
	upstreamConfig := config.DefaultUpstreamConfig()
	if len(upstreams) > 0 {
		upstreamConfig = config.NormalizeUpstreamConfig(upstreams[0])
	}
	codexCLI := req.Provider == "openai" && upstreamConfig.ImageAPI.CodexCLI
	path := config.ImageGenerationsPath
	var body io.Reader
	contentType := "application/json"
	if len(req.InputImages) == 0 {
		payload := map[string]any{
			"model": req.Model, "prompt": req.Prompt, "size": req.Params.Size,
			"output_format": req.Params.OutputFormat, "moderation": req.Params.Moderation,
		}
		if !codexCLI {
			payload["quality"] = req.Params.Quality
			payload["n"] = req.Params.N
		}
		if req.Params.OutputCompression != nil {
			payload["output_compression"] = *req.Params.OutputCompression
		}
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(data)
	} else {
		path = config.ImageEditsPath
		var data bytes.Buffer
		writer := multipart.NewWriter(&data)
		if err := appendGenerationFields(writer, req, codexCLI); err != nil {
			return nil, err
		}
		for index, image := range req.InputImages {
			if err := appendGenerationImage(writer, "image[]", fmt.Sprintf("input-%d.png", index+1), image); err != nil {
				return nil, err
			}
		}
		if req.Mask != "" {
			if err := appendGenerationImage(writer, "mask", "mask.png", req.Mask); err != nil {
				return nil, err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		body = &data
		contentType = writer.FormDataContentType()
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.JoinUpstreamURL(config.ResolveUpstreamBaseURL(upstreamConfig.ImageAPI.BaseURL, baseURL), path), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+req.APIKey)
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("x-client-request-id", req.RequestIDs[0])
	middleware.SetRequestIDHeader(request)
	return request, nil
}

type codexImageRequestResult struct {
	responseData []byte
	statusCode   int
	err          error
}

func (h *ProjectGenerationHandler) generateCodexImages(c *gin.Context, userID, projectID, baseURL string, req projectGenerationRequest) *projectGenerationResponse {
	requestCount := req.Params.N
	results := make([]codexImageRequestResult, requestCount)
	ctx := c.Request.Context()
	userAgent := c.Request.UserAgent()
	var waitGroup sync.WaitGroup
	waitGroup.Add(requestCount)
	for index := 0; index < requestCount; index++ {
		index := index
		go func() {
			defer waitGroup.Done()
			request := req
			request.Params.N = 1
			request.RequestIDs = []string{req.RequestIDs[index]}
			upstreamRequest, err := createUpstreamGenerationRequest(ctx, baseURL, userAgent, request, h.upstreams)
			if err != nil {
				results[index].err = err
				return
			}
			logGenerationUpstreamRequest(ctx, upstreamRequest.Method, upstreamRequest.URL.String(), 1, nil)
			upstreamResponse, err := h.client.Do(upstreamRequest)
			if err != nil {
				logGenerationUpstream(ctx, upstreamRequest.Method, upstreamRequest.URL.String(), 1, 0, nil, err)
				results[index].err = err
				return
			}
			responseData, readErr := io.ReadAll(upstreamResponse.Body)
			upstreamResponse.Body.Close()
			logGenerationUpstream(ctx, upstreamRequest.Method, upstreamRequest.URL.String(), 1, upstreamResponse.StatusCode, responseData, readErr)
			results[index] = codexImageRequestResult{responseData: responseData, statusCode: upstreamResponse.StatusCode, err: readErr}
		}()
	}
	waitGroup.Wait()

	items := make([]upstreamImageItem, 0, requestCount)
	actualParams := req.Params
	for index, result := range results {
		if result.err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "上游连接中断: " + result.err.Error()})
			return nil
		}
		if result.statusCode < http.StatusOK || result.statusCode >= http.StatusMultipleChoices {
			c.Data(result.statusCode, "application/json", result.responseData)
			return nil
		}
		var upstream upstreamImageResponse
		if err := json.Unmarshal(result.responseData, &upstream); err != nil || len(upstream.Data) == 0 {
			c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": fmt.Sprintf("上游第 %d 个请求没有返回图片", index+1)})
			return nil
		}
		if index == 0 {
			actualParams = upstreamParams(req.Params, upstream)
		}
		items = append(items, upstream.Data...)
	}

	result := projectGenerationResponse{
		Images:           make([]string, 0, len(items)),
		ImageIDs:         make([]string, 0, len(items)),
		ActualParamsList: make([]projectGenerationParams, 0, len(items)),
		RevisedPrompts:   make([]string, 0, len(items)),
		ActualParams:     actualParams,
		TaskRecordQueued: len(req.Task) > 0,
	}
	result.ActualParams.N = len(items)
	mimeTypes := map[string]string{"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}
	mimeType := mimeTypes[actualParams.OutputFormat]
	width, height := dimensionsFromSize(actualParams.Size)
	for _, item := range items {
		dataURL, imageID, err := h.saveGeneratedImage(ctx, userID, projectID, req.TaskID, mimeType, width, height, item)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
			return nil
		}
		result.Images = append(result.Images, dataURL)
		result.ImageIDs = append(result.ImageIDs, imageID)
		params := actualParams
		params.N = 1
		result.ActualParamsList = append(result.ActualParamsList, params)
		result.RevisedPrompts = append(result.RevisedPrompts, item.RevisedPrompt)
	}
	c.JSON(http.StatusOK, result)
	return &result
}

func upstreamParams(params projectGenerationParams, upstream upstreamImageResponse) projectGenerationParams {
	actual := params
	if upstream.Size != "" {
		actual.Size = upstream.Size
	}
	if upstream.Quality != "" {
		actual.Quality = upstream.Quality
	}
	if upstream.OutputFormat != "" {
		actual.OutputFormat = upstream.OutputFormat
	}
	if upstream.OutputCompression != nil {
		actual.OutputCompression = upstream.OutputCompression
	}
	if upstream.Moderation != "" {
		actual.Moderation = upstream.Moderation
	}
	return actual
}

func readGenerationImage(ctx context.Context, client *http.Client, item upstreamImageItem, mimeType string) (string, []byte, error) {
	if item.B64JSON != "" {
		payload := strings.TrimSpace(item.B64JSON)
		if strings.HasPrefix(payload, "data:") {
			actualMIME, data, err := decodeImageDataURL(payload)
			if err != nil {
				return "", nil, err
			}
			return "data:" + actualMIME + ";base64," + base64.StdEncoding.EncodeToString(data), data, nil
		}
		data, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			return "", nil, err
		}
		return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data), data, nil
	}
	if item.URL == "" {
		return "", nil, errors.New("upstream image data missing")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, item.URL, nil)
	if err != nil {
		return "", nil, err
	}
	resp, err := client.Do(request)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return "", nil, fmt.Errorf("download upstream image: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxProjectImageBytes+1))
	if err != nil {
		return "", nil, err
	}
	if len(data) > maxProjectImageBytes {
		return "", nil, errors.New("upstream image exceeds 64 MiB")
	}
	actualMIME := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if !strings.HasPrefix(actualMIME, "image/") {
		actualMIME = mimeType
	}
	return "data:" + actualMIME + ";base64," + base64.StdEncoding.EncodeToString(data), data, nil
}

type upstreamResponsesOutput struct {
	Type              string          `json:"type"`
	Result            json.RawMessage `json:"result"`
	Size              string          `json:"size"`
	Quality           string          `json:"quality"`
	OutputFormat      string          `json:"output_format"`
	OutputCompression *int            `json:"output_compression"`
	Moderation        string          `json:"moderation"`
	RevisedPrompt     string          `json:"revised_prompt"`
}

type upstreamResponsesResponse struct {
	Output []upstreamResponsesOutput `json:"output"`
}

func createUpstreamResponsesRequest(ctx context.Context, baseURL, userAgent string, req projectGenerationRequest, requestID string, upstreams ...config.UpstreamConfig) (*http.Request, error) {
	upstreamConfig := config.DefaultUpstreamConfig()
	if len(upstreams) > 0 {
		upstreamConfig = config.NormalizeUpstreamConfig(upstreams[0])
	}
	action := "generate"
	if len(req.InputImages) > 0 {
		action = "edit"
	}
	tool := map[string]any{
		"type":          "image_generation",
		"action":        action,
		"size":          req.Params.Size,
		"output_format": req.Params.OutputFormat,
		"moderation":    req.Params.Moderation,
	}
	tool["quality"] = req.Params.Quality
	if req.Params.OutputFormat != "png" && req.Params.OutputCompression != nil {
		tool["output_compression"] = *req.Params.OutputCompression
	}
	if req.Mask != "" {
		tool["input_image_mask"] = map[string]string{"image_url": req.Mask}
	}
	prompt := req.Prompt
	if !req.AllowRewrite {
		prompt = promptRewriteGuardPrefix + "\n" + prompt
	}
	var input any = prompt
	if len(req.InputImages) > 0 {
		content := []map[string]string{{"type": "input_text", "text": prompt}}
		for _, image := range req.InputImages {
			content = append(content, map[string]string{"type": "input_image", "image_url": image})
		}
		input = []any{map[string]any{"role": "user", "content": content}}
	}
	payload, err := json.Marshal(map[string]any{
		"model": req.Model, "input": input, "tools": []any{tool}, "tool_choice": "required",
	})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.JoinUpstreamURL(config.ResolveUpstreamBaseURL(upstreamConfig.ImageAPI.BaseURL, baseURL), config.ImageResponsesPath), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+req.APIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("x-client-request-id", requestID)
	middleware.SetRequestIDHeader(request)
	return request, nil
}

func decodeResponsesImageResult(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) == nil && strings.TrimSpace(value) != "" {
		return value
	}
	var result struct {
		B64JSON string `json:"b64_json"`
		Base64  string `json:"base64"`
		Image   string `json:"image"`
		Data    string `json:"data"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return ""
	}
	for _, candidate := range []string{result.B64JSON, result.Base64, result.Image, result.Data} {
		if strings.TrimSpace(candidate) != "" {
			return candidate
		}
	}
	return ""
}

func (h *ProjectGenerationHandler) saveGeneratedImage(ctx context.Context, userID, projectID, taskID, mimeType string, width, height *int, item upstreamImageItem) (string, string, error) {
	dataURL, data, err := readGenerationImage(ctx, h.client, item, mimeType)
	if err != nil {
		return "", "", err
	}
	idDigest := sha256.Sum256([]byte(dataURL))
	imageDigest := sha256.Sum256(data)
	imageID := hex.EncodeToString(idDigest[:])
	if _, err := h.projects.SaveImage(ctx, userID, models.ProjectImage{
		ProjectID: projectID, ImageID: imageID, TaskID: taskID, Source: "generated",
		MIMEType: mimeType, Width: width, Height: height, SHA256: hex.EncodeToString(imageDigest[:]),
	}, data); err != nil {
		return "", "", err
	}
	return dataURL, imageID, nil
}

func (h *ProjectGenerationHandler) generateResponses(c *gin.Context, userID, projectID, baseURL string, req projectGenerationRequest) *projectGenerationResponse {
	items := make([]struct {
		image  upstreamImageItem
		params projectGenerationParams
	}, 0, 1)
	requestID := req.RequestIDs[0]
	upstreamRequest, err := createUpstreamResponsesRequest(c.Request.Context(), baseURL, c.Request.UserAgent(), req, requestID, h.upstreams)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return nil
	}
	logGenerationUpstreamRequest(c.Request.Context(), upstreamRequest.Method, upstreamRequest.URL.String(), 1, nil)
	upstreamResponse, err := h.client.Do(upstreamRequest)
	if err != nil {
		logGenerationUpstream(c.Request.Context(), upstreamRequest.Method, upstreamRequest.URL.String(), 1, 0, nil, err)
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "上游连接中断: " + err.Error()})
		return nil
	}
	responseData, readErr := io.ReadAll(upstreamResponse.Body)
	upstreamResponse.Body.Close()
	logGenerationUpstream(c.Request.Context(), upstreamRequest.Method, upstreamRequest.URL.String(), 1, upstreamResponse.StatusCode, responseData, readErr)
	if readErr != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "read image provider response failed"})
		return nil
	}
	if upstreamResponse.StatusCode < http.StatusOK || upstreamResponse.StatusCode >= http.StatusMultipleChoices {
		c.Data(upstreamResponse.StatusCode, "application/json", responseData)
		return nil
	}
	var upstream upstreamResponsesResponse
	if json.Unmarshal(responseData, &upstream) != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "invalid responses API payload"})
		return nil
	}
	for _, output := range upstream.Output {
		if output.Type != "image_generation_call" {
			continue
		}
		b64 := decodeResponsesImageResult(output.Result)
		if b64 == "" {
			continue
		}
		params := req.Params
		params.N = 1
		if output.Size != "" {
			params.Size = output.Size
		}
		if output.Quality != "" {
			params.Quality = output.Quality
		}
		if output.OutputFormat != "" {
			params.OutputFormat = output.OutputFormat
		}
		if output.OutputCompression != nil {
			params.OutputCompression = output.OutputCompression
		}
		if output.Moderation != "" {
			params.Moderation = output.Moderation
		}
		items = append(items, struct {
			image  upstreamImageItem
			params projectGenerationParams
		}{image: upstreamImageItem{B64JSON: b64, RevisedPrompt: output.RevisedPrompt}, params: params})
	}
	if len(items) == 0 {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "responses API returned no images"})
		return nil
	}
	result := projectGenerationResponse{
		Images: make([]string, 0, len(items)), ImageIDs: make([]string, 0, len(items)),
		ActualParamsList: make([]projectGenerationParams, 0, len(items)),
		RevisedPrompts:   make([]string, 0, len(items)), ActualParams: items[0].params,
		TaskRecordQueued: len(req.Task) > 0,
	}
	result.ActualParams.N = len(items)
	mimeTypes := map[string]string{"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}
	for _, item := range items {
		mimeType := mimeTypes[item.params.OutputFormat]
		width, height := dimensionsFromSize(item.params.Size)
		dataURL, imageID, err := h.saveGeneratedImage(c.Request.Context(), userID, projectID, req.TaskID, mimeType, width, height, item.image)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
			return nil
		}
		result.Images = append(result.Images, dataURL)
		result.ImageIDs = append(result.ImageIDs, imageID)
		result.ActualParamsList = append(result.ActualParamsList, item.params)
		result.RevisedPrompts = append(result.RevisedPrompts, item.image.RevisedPrompt)
	}
	c.JSON(http.StatusOK, result)
	return &result
}

// Status POST /api/v1/images/status，保持前端原有恢复时机，仅代理状态查询。
func (h *ProjectGenerationHandler) Status(c *gin.Context) {
	providerName := c.GetString(middleware.ContextKeyProvider)
	if c.GetString(middleware.ContextKeyUserID) == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	var req imageStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid image status request required"})
		return
	}
	if err := validateImageStatusRequest(req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
	baseURL, ok := h.providers.ResourceBaseURL(providerName)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "image provider unavailable"})
		return
	}
	endpoint, err := url.Parse(config.JoinUpstreamURL(config.ResolveUpstreamBaseURL(h.upstreams.ImageAPI.BaseURL, baseURL), config.ImageStatusPath))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "invalid image provider URL"})
		return
	}
	query := endpoint.Query()
	query.Set("request_ids", strings.Join(req.RequestIDs, ","))
	endpoint.RawQuery = query.Encode()
	upstreamRequest, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, endpoint.String(), nil)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "create image status request failed"})
		return
	}
	upstreamRequest.Header.Set("Authorization", "Bearer "+req.APIKey)
	upstreamRequest.Header.Set("Accept", "application/json")
	upstreamRequest.Header.Set("User-Agent", c.Request.UserAgent())
	middleware.SetRequestIDHeader(upstreamRequest)
	upstreamResponse, err := h.client.Do(upstreamRequest)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "上游连接中断: " + err.Error()})
		return
	}
	defer upstreamResponse.Body.Close()
	responseData, err := io.ReadAll(upstreamResponse.Body)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "read image provider response failed"})
		return
	}
	contentType := upstreamResponse.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}
	c.Data(upstreamResponse.StatusCode, contentType, responseData)
}

// Generate POST /api/v1/projects/:id/generations 或 /edits，由后端生成并先落库再返回。
func (h *ProjectGenerationHandler) Generate(c *gin.Context) {
	responseWriter := &generationLogResponseWriter{ResponseWriter: c.Writer}
	c.Writer = responseWriter
	var recordReq *projectGenerationRequest
	var recordResult *projectGenerationResponse
	var userID string
	var projectID string
	defer func() {
		log.Ctx(c.Request.Context()).Info().
			Str("method", c.Request.Method).
			Str("path", c.Request.URL.Path).
			Int("status", c.Writer.Status()).
			Interface("body", generationLogPayload(responseWriter.body.Bytes(), responseWriter.truncated)).
			Msg("generation response")
		if recordReq == nil {
			return
		}
		message := http.StatusText(c.Writer.Status())
		var payload struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(responseWriter.body.Bytes(), &payload) == nil && strings.TrimSpace(payload.Message) != "" {
			message = payload.Message
		}
		h.saveGenerationTaskRecordAsync(c.Request.Context(), userID, projectID, *recordReq, recordResult, c.Writer.Status(), message)
	}()

	userID = c.GetString(middleware.ContextKeyUserID)
	providerName := c.GetString(middleware.ContextKeyProvider)
	projectID = strings.TrimSpace(c.Param("id"))
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	if !projectUUIDPattern.MatchString(projectID) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project id required"})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxGenerationRequestBytes)
	var req projectGenerationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid generation request required"})
		return
	}
	if req.APIMode == "" {
		req.APIMode = "images"
	}
	if req.Provider == "" {
		req.Provider = "openai"
	}
	if len(req.RequestIDs) == 0 {
		req.RequestIDs = []string{req.TaskID}
	}
	logGenerationRequest(c, req)
	if err := validateProjectGenerationRequest(req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
	multiRequestMode := h.codexCLIEnabled(req)
	if multiRequestMode && len(req.RequestIDs) < req.Params.N {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "multi-request mode requires one request id per image"})
		return
	}
	if !multiRequestMode && len(req.RequestIDs) > 1 {
		req.RequestIDs = req.RequestIDs[:1]
	}
	if len(req.Project) > 0 && rawRecordID(req.Project) != projectID {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "project record id mismatch"})
		return
	}
	baseURL, ok := h.providers.ResourceBaseURL(providerName)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "image provider unavailable"})
		return
	}
	generationCtx := c.Request.Context()
	if len(req.Task) > 0 {
		// 在线项目请求需在浏览器断开后继续执行，结果由状态接口和任务归档恢复。
		var cancel context.CancelFunc
		generationCtx, cancel = context.WithTimeout(context.WithoutCancel(generationCtx), generationExecutionTimeout)
		defer cancel()
		c.Request = c.Request.WithContext(generationCtx)
	}
	if err := h.projects.Ensure(c.Request.Context(), userID, projectID, strings.TrimSpace(req.ProjectTitle)); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, database.ErrProjectForbidden) {
			status = http.StatusForbidden
		}
		c.JSON(status, gin.H{"code": status, "message": err.Error()})
		return
	}
	if len(req.Task) > 0 {
		recordReq = &req
		if err := h.saveGenerationTaskRecord(generationCtx, userID, projectID, req, nil, http.StatusAccepted, ""); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": "save generation task record failed"})
			return
		}
	}
	if req.APIMode == "responses" {
		recordResult = h.generateResponses(c, userID, projectID, baseURL, req)
		return
	}
	if h.codexCLIEnabled(req) && req.Params.N > 1 {
		recordResult = h.generateCodexImages(c, userID, projectID, baseURL, req)
		return
	}
	upstreamRequest, err := createUpstreamGenerationRequest(c.Request.Context(), baseURL, c.Request.UserAgent(), req, h.upstreams)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
	logGenerationUpstreamRequest(c.Request.Context(), upstreamRequest.Method, upstreamRequest.URL.String(), 1, nil)
	upstreamResponse, err := h.client.Do(upstreamRequest)
	if err != nil {
		logGenerationUpstream(c.Request.Context(), upstreamRequest.Method, upstreamRequest.URL.String(), 1, 0, nil, err)
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "上游连接中断: " + err.Error()})
		return
	}
	defer upstreamResponse.Body.Close()
	responseData, err := io.ReadAll(upstreamResponse.Body)
	logGenerationUpstream(c.Request.Context(), upstreamRequest.Method, upstreamRequest.URL.String(), 1, upstreamResponse.StatusCode, responseData, err)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "read image provider response failed"})
		return
	}
	if upstreamResponse.StatusCode < http.StatusOK || upstreamResponse.StatusCode >= http.StatusMultipleChoices {
		c.Data(upstreamResponse.StatusCode, "application/json", responseData)
		return
	}
	var upstream upstreamImageResponse
	if err := json.Unmarshal(responseData, &upstream); err != nil || len(upstream.Data) == 0 {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "image provider returned no images"})
		return
	}
	mimeTypes := map[string]string{"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}
	mimeType := mimeTypes[req.Params.OutputFormat]
	result := projectGenerationResponse{
		Images:           make([]string, 0, len(upstream.Data)),
		ImageIDs:         make([]string, 0, len(upstream.Data)),
		ActualParamsList: make([]projectGenerationParams, 0, len(upstream.Data)),
		RevisedPrompts:   make([]string, 0, len(upstream.Data)),
		ActualParams:     req.Params,
		TaskRecordQueued: len(req.Task) > 0,
	}
	if upstream.Size != "" {
		result.ActualParams.Size = upstream.Size
	}
	if upstream.Quality != "" {
		result.ActualParams.Quality = upstream.Quality
	}
	if upstream.OutputFormat != "" {
		result.ActualParams.OutputFormat = upstream.OutputFormat
	}
	if upstream.OutputCompression != nil {
		result.ActualParams.OutputCompression = upstream.OutputCompression
	}
	if upstream.Moderation != "" {
		result.ActualParams.Moderation = upstream.Moderation
	}
	result.ActualParams.N = len(upstream.Data)
	width, height := dimensionsFromSize(result.ActualParams.Size)
	for _, item := range upstream.Data {
		dataURL, imageID, err := h.saveGeneratedImage(c.Request.Context(), userID, projectID, req.TaskID, mimeType, width, height, item)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
			return
		}
		result.Images = append(result.Images, dataURL)
		result.ImageIDs = append(result.ImageIDs, imageID)
		result.ActualParamsList = append(result.ActualParamsList, result.ActualParams)
		result.RevisedPrompts = append(result.RevisedPrompts, item.RevisedPrompt)
	}
	recordResult = &result
	c.JSON(http.StatusOK, result)
}

func dimensionsFromSize(size string) (*int, *int) {
	parts := strings.Split(size, "x")
	if len(parts) != 2 {
		return nil, nil
	}
	width, widthErr := strconv.Atoi(parts[0])
	height, heightErr := strconv.Atoi(parts[1])
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 {
		return nil, nil
	}
	return &width, &height
}
