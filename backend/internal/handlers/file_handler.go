package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/pkg/config"
)

const maxFileProxyRequestBytes = (512 << 20) + (1 << 20)
const maxFileProxyDeleteBytes = 1 << 20
const maxFileProxyResponseBytes = 1 << 20

type FileAPIHandler struct {
	providers imageProviderRegistry
	cfg       config.FileAPIConfig
	upstream  config.FileAPIUpstreamConfig
	client    *http.Client
}

func NewFileAPIHandler(providers imageProviderRegistry, cfg config.FileAPIConfig, upstreams ...config.FileAPIUpstreamConfig) *FileAPIHandler {
	upstream := config.DefaultUpstreamConfig().FileAPI
	if len(upstreams) > 0 {
		upstream = config.NormalizeUpstreamConfig(config.UpstreamConfig{FileAPI: upstreams[0]}).FileAPI
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = 32
	transport.MaxIdleConnsPerHost = 8
	transport.IdleConnTimeout = 90 * time.Second
	transport.ExpectContinueTimeout = time.Second
	return &FileAPIHandler{
		providers: providers,
		cfg:       cfg,
		upstream:  upstream,
		client: &http.Client{
			Transport: transport,
			Timeout:   time.Duration(cfg.TimeoutSeconds) * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (h *FileAPIHandler) Register(api *gin.RouterGroup) {
	api.POST("/files", h.Proxy)
	api.DELETE("/files", h.Proxy)
}

type fileUploadResult struct {
	URL string
}

// Upload 将项目图片上传到 File API，避免把项目图片写入全局素材库。
func (h *FileAPIHandler) Upload(ctx context.Context, provider, fileName, contentType string, data []byte) (*fileUploadResult, error) {
	if !h.cfg.Enabled() {
		return nil, errors.New("File API developer key is not configured")
	}
	baseURL, ok := h.providers.ResourceBaseURL(provider)
	if !ok {
		return nil, errors.New("file provider unavailable")
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		return nil, fmt.Errorf("create File API upload: %w", err)
	}
	if _, err := part.Write(data); err != nil {
		return nil, fmt.Errorf("write File API upload: %w", err)
	}
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("close File API upload: %w", err)
	}

	endpoint := config.JoinUpstreamURL(config.ResolveUpstreamBaseURL(h.upstream.BaseURL, baseURL), config.FileAPIPath)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return nil, fmt.Errorf("create File API request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(h.cfg.DeveloperKey))
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.ContentLength = int64(body.Len())

	response, err := h.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("File API upload request: %w", err)
	}
	defer response.Body.Close()
	responseData, err := io.ReadAll(io.LimitReader(response.Body, maxFileProxyResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read File API upload response: %w", err)
	}
	if len(responseData) > maxFileProxyResponseBytes {
		return nil, errors.New("File API upload response is too large")
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("File API upload failed: HTTP %d", response.StatusCode)
	}
	var payload struct {
		Data struct {
			URL     string `json:"url"`
			FileURL string `json:"file_url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(responseData, &payload); err != nil {
		return nil, fmt.Errorf("decode File API upload response: %w", err)
	}
	url := strings.TrimSpace(payload.Data.URL)
	if url == "" {
		url = strings.TrimSpace(payload.Data.FileURL)
	}
	if url == "" {
		return nil, errors.New("File API upload returned no file URL")
	}
	return &fileUploadResult{URL: url}, nil
}

// Proxy 在服务端注入开发者密钥，浏览器不会接触 File API 凭证。
func (h *FileAPIHandler) Proxy(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	if !h.cfg.Enabled() {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxFileProxyRequestBytes)
		discardedBytes, err := io.Copy(io.Discard, c.Request.Body)
		if err != nil {
			log.Ctx(c.Request.Context()).Warn().
				Err(err).
				Int64("discarded_body_bytes", discardedBytes).
				Str("user_id", userID).
				Str("provider", c.GetString(middleware.ContextKeyProvider)).
				Msg("File API request body discard failed")
			c.Header("Connection", "close")
		}
		log.Ctx(c.Request.Context()).Warn().
			Int64("discarded_body_bytes", discardedBytes).
			Str("user_id", userID).
			Str("provider", c.GetString(middleware.ContextKeyProvider)).
			Msg("File API request rejected: developer key is not configured")
		c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "message": "File API developer key is not configured"})
		return
	}
	baseURL, ok := h.providers.ResourceBaseURL(c.GetString(middleware.ContextKeyProvider))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "file provider unavailable"})
		return
	}

	contentType := c.GetHeader("Content-Type")
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || (c.Request.Method == http.MethodPost && mediaType != "multipart/form-data") || (c.Request.Method == http.MethodDelete && mediaType != "application/json") {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid File API content type required"})
		return
	}
	maxBytes := int64(maxFileProxyDeleteBytes)
	if c.Request.Method == http.MethodPost {
		maxBytes = maxFileProxyRequestBytes
	}
	if c.Request.ContentLength > maxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": http.StatusRequestEntityTooLarge, "message": "file request is too large"})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
	endpoint := config.JoinUpstreamURL(config.ResolveUpstreamBaseURL(h.upstream.BaseURL, baseURL), config.FileAPIPath)
	request, err := http.NewRequestWithContext(c.Request.Context(), c.Request.Method, endpoint, c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": err.Error()})
		return
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(h.cfg.DeveloperKey))
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", contentType)
	middleware.SetRequestIDHeader(request)
	request.ContentLength = c.Request.ContentLength

	response, err := h.client.Do(request)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": http.StatusRequestEntityTooLarge, "message": "file request is too large"})
			return
		}
		log.Ctx(c.Request.Context()).Error().Err(err).Str("method", c.Request.Method).Str("upstream_url", endpoint).Str("user_id", userID).Msg("File API proxy response")
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "File API 上游连接失败: " + err.Error()})
		return
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxFileProxyResponseBytes+1))
	if err != nil || len(data) > maxFileProxyResponseBytes {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "读取 File API 上游回包失败"})
		return
	}
	if retryAfter := response.Header.Get("Retry-After"); retryAfter != "" {
		c.Header("Retry-After", retryAfter)
	}
	c.Data(response.StatusCode, response.Header.Get("Content-Type"), data)
}
