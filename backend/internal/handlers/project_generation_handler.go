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
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/database"
	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
)

const maxGenerationRequestBytes = 512 << 20
const promptRewriteGuardPrefix = "Use the following text as the complete prompt. Do not rewrite it:"

type projectGenerationStore interface {
	Ensure(ctx context.Context, userID, id, title string) error
	SaveImage(ctx context.Context, userID string, image models.ProjectImage, data []byte) (*models.ProjectImage, error)
}

type imageProviderRegistry interface {
	ResourceBaseURL(name string) (string, bool)
}

type ProjectGenerationHandler struct {
	projects  projectGenerationStore
	providers imageProviderRegistry
	client    *http.Client
}

func NewProjectGenerationHandler(projects projectGenerationStore, providers imageProviderRegistry) *ProjectGenerationHandler {
	return &ProjectGenerationHandler{
		projects:  projects,
		providers: providers,
		client:    &http.Client{Timeout: 15 * time.Minute},
	}
}

func (h *ProjectGenerationHandler) Register(api *gin.RouterGroup) {
	api.POST("/projects/:id/generations", h.Generate)
	api.POST("/images/status", h.Status)
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
	APIKey       string                  `json:"api_key"`
	Model        string                  `json:"model"`
	APIMode      string                  `json:"api_mode"`
	AllowRewrite bool                    `json:"allow_prompt_rewrite"`
	CodexCLI     bool                    `json:"codex_cli"`
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
	Images         []string                `json:"images"`
	ImageIDs       []string                `json:"image_ids"`
	ActualParams   projectGenerationParams `json:"actual_params"`
	RevisedPrompts []string                `json:"revised_prompts"`
}

func validateProjectGenerationRequest(req projectGenerationRequest) error {
	if !projectImageIDPattern.MatchString(req.TaskID) {
		return errors.New("valid task id required")
	}
	if strings.TrimSpace(req.ProjectTitle) == "" || utf8.RuneCountInString(req.ProjectTitle) > 120 {
		return errors.New("project title must be 1-120 characters")
	}
	if strings.TrimSpace(req.APIKey) == "" || strings.TrimSpace(req.Model) == "" || strings.TrimSpace(req.Prompt) == "" {
		return errors.New("api_key, model and prompt are required")
	}
	if req.APIMode != "images" && req.APIMode != "responses" {
		return errors.New("unsupported api mode")
	}
	if len(req.RequestIDs) == 0 || len(req.RequestIDs) > 10 {
		return errors.New("request_ids must contain 1-10 ids")
	}
	for _, requestID := range req.RequestIDs {
		if !projectImageIDPattern.MatchString(requestID) {
			return errors.New("invalid request id")
		}
	}
	if req.APIMode == "responses" && len(req.RequestIDs) < req.Params.N {
		return errors.New("responses mode requires one request id per image")
	}
	if req.Params.N < 1 || req.Params.N > 10 {
		return errors.New("n must be between 1 and 10")
	}
	if req.Params.OutputFormat != "png" && req.Params.OutputFormat != "jpeg" && req.Params.OutputFormat != "webp" {
		return errors.New("unsupported output format")
	}
	return nil
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

func appendGenerationFields(writer *multipart.Writer, req projectGenerationRequest) error {
	fields := map[string]string{
		"model":         req.Model,
		"prompt":        req.Prompt,
		"size":          req.Params.Size,
		"quality":       req.Params.Quality,
		"output_format": req.Params.OutputFormat,
		"moderation":    req.Params.Moderation,
		"n":             strconv.Itoa(req.Params.N),
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

func createUpstreamGenerationRequest(ctx context.Context, baseURL string, req projectGenerationRequest) (*http.Request, error) {
	path := "/v1/images/generations"
	var body io.Reader
	contentType := "application/json"
	if len(req.InputImages) == 0 {
		payload := map[string]any{
			"model": req.Model, "prompt": req.Prompt, "size": req.Params.Size, "quality": req.Params.Quality,
			"output_format": req.Params.OutputFormat, "moderation": req.Params.Moderation, "n": req.Params.N,
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
		path = "/v1/images/edits"
		var data bytes.Buffer
		writer := multipart.NewWriter(&data)
		if err := appendGenerationFields(writer, req); err != nil {
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

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+req.APIKey)
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("x-client-request-id", req.RequestIDs[0])
	return request, nil
}

func readGenerationImage(client *http.Client, item upstreamImageItem, mimeType string) (string, []byte, error) {
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
	resp, err := client.Get(item.URL)
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

func createUpstreamResponsesRequest(ctx context.Context, baseURL string, req projectGenerationRequest, requestID string) (*http.Request, error) {
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
	if !req.CodexCLI {
		tool["quality"] = req.Params.Quality
	}
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
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v1/responses", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+req.APIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("x-client-request-id", requestID)
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
	dataURL, data, err := readGenerationImage(h.client, item, mimeType)
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

func (h *ProjectGenerationHandler) generateResponses(c *gin.Context, userID, projectID, baseURL string, req projectGenerationRequest) {
	items := make([]struct {
		image  upstreamImageItem
		params projectGenerationParams
	}, 0, req.Params.N)
	for index := 0; index < req.Params.N; index++ {
		requestID := req.RequestIDs[index]
		upstreamRequest, err := createUpstreamResponsesRequest(c.Request.Context(), baseURL, req, requestID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
			return
		}
		upstreamResponse, err := h.client.Do(upstreamRequest)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "上游连接中断: " + err.Error()})
			return
		}
		responseData, readErr := io.ReadAll(upstreamResponse.Body)
		upstreamResponse.Body.Close()
		if readErr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "read image provider response failed"})
			return
		}
		if upstreamResponse.StatusCode < http.StatusOK || upstreamResponse.StatusCode >= http.StatusMultipleChoices {
			c.Data(upstreamResponse.StatusCode, "application/json", responseData)
			return
		}
		var upstream upstreamResponsesResponse
		if json.Unmarshal(responseData, &upstream) != nil {
			c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "invalid responses API payload"})
			return
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
	}
	if len(items) == 0 {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "responses API returned no images"})
		return
	}
	result := projectGenerationResponse{
		Images: make([]string, 0, len(items)), ImageIDs: make([]string, 0, len(items)),
		RevisedPrompts: make([]string, 0, len(items)), ActualParams: items[0].params,
	}
	result.ActualParams.N = len(items)
	mimeTypes := map[string]string{"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}
	for _, item := range items {
		mimeType := mimeTypes[item.params.OutputFormat]
		width, height := dimensionsFromSize(item.params.Size)
		dataURL, imageID, err := h.saveGeneratedImage(c.Request.Context(), userID, projectID, req.TaskID, mimeType, width, height, item.image)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
			return
		}
		result.Images = append(result.Images, dataURL)
		result.ImageIDs = append(result.ImageIDs, imageID)
		result.RevisedPrompts = append(result.RevisedPrompts, item.image.RevisedPrompt)
	}
	c.JSON(http.StatusOK, result)
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
	endpoint, err := url.Parse(strings.TrimRight(baseURL, "/") + "/v1/images/status/")
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

// Generate POST /api/v1/projects/:id/generations，由后端生成并先落库再返回。
func (h *ProjectGenerationHandler) Generate(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	providerName := c.GetString(middleware.ContextKeyProvider)
	projectID := strings.TrimSpace(c.Param("id"))
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
	if len(req.RequestIDs) == 0 {
		req.RequestIDs = []string{req.TaskID}
	}
	if err := validateProjectGenerationRequest(req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
	baseURL, ok := h.providers.ResourceBaseURL(providerName)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "image provider unavailable"})
		return
	}
	if err := h.projects.Ensure(c.Request.Context(), userID, projectID, strings.TrimSpace(req.ProjectTitle)); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, database.ErrProjectForbidden) {
			status = http.StatusForbidden
		}
		c.JSON(status, gin.H{"code": status, "message": err.Error()})
		return
	}
	if req.APIMode == "responses" {
		h.generateResponses(c, userID, projectID, baseURL, req)
		return
	}
	upstreamRequest, err := createUpstreamGenerationRequest(c.Request.Context(), baseURL, req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
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
		Images:         make([]string, 0, len(upstream.Data)),
		ImageIDs:       make([]string, 0, len(upstream.Data)),
		RevisedPrompts: make([]string, 0, len(upstream.Data)),
		ActualParams:   req.Params,
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
		result.RevisedPrompts = append(result.RevisedPrompts, item.RevisedPrompt)
	}
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
