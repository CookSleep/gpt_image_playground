package handlers

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"gpt-image-backend/internal/middleware"
)

const compositeAPIKeyHeader = "X-Upstream-API-Key"
const maxCompositeResponseBytes = 64 << 20

type CompositeModelHandler struct {
	providers imageProviderRegistry
	client    *http.Client
}

func NewCompositeModelHandler(providers imageProviderRegistry) *CompositeModelHandler {
	return &CompositeModelHandler{
		providers: providers,
		client:    &http.Client{Timeout: 2 * time.Minute},
	}
}

func (h *CompositeModelHandler) Register(api *gin.RouterGroup) {
	api.GET("/model/*path", h.Proxy)
	api.POST("/model/*path", h.Proxy)
}

func escapedCompositePath(value string) (string, bool) {
	parts := strings.Split(strings.Trim(value, "/"), "/")
	if len(parts) == 0 {
		return "", false
	}
	for index, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", false
		}
		parts[index] = url.PathEscape(part)
	}
	return strings.Join(parts, "/"), true
}

// Proxy 只代理单次异步 API 请求，提交、轮询和取结果由前端分别调用。
func (h *CompositeModelHandler) Proxy(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	providerName := c.GetString(middleware.ContextKeyProvider)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	apiKey := strings.TrimSpace(c.GetHeader(compositeAPIKeyHeader))
	if apiKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": compositeAPIKeyHeader + " is required"})
		return
	}
	path, ok := escapedCompositePath(c.Param("path"))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid model path required"})
		return
	}
	baseURL, ok := h.providers.ResourceBaseURL(providerName)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "image provider unavailable"})
		return
	}

	var body []byte
	if c.Request.Body != nil {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxGenerationRequestBytes)
		var err error
		body, err = io.ReadAll(c.Request.Body)
		if err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": http.StatusRequestEntityTooLarge, "message": "request body is too large"})
			return
		}
	}
	endpoint := strings.TrimRight(baseURL, "/") + "/api/v1/model/" + path
	if c.Request.URL.RawQuery != "" {
		endpoint += "?" + c.Request.URL.RawQuery
	}
	log.Info().
		Str("method", c.Request.Method).
		Str("path", c.Request.URL.Path).
		Str("upstream_url", endpoint).
		Str("user_id", userID).
		Interface("body", generationLogPayload(body, len(body) > maxGenerationLogResponseBytes)).
		Msg("composite model proxy request")

	request, err := http.NewRequestWithContext(c.Request.Context(), c.Request.Method, endpoint, bytes.NewReader(body))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": err.Error()})
		return
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Accept", "application/json")
	if contentType := c.GetHeader("Content-Type"); contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}

	response, err := h.client.Do(request)
	if err != nil {
		log.Error().Err(err).Str("method", c.Request.Method).Str("upstream_url", endpoint).Msg("composite model proxy response")
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "Composite 上游连接失败: " + err.Error()})
		return
	}
	defer response.Body.Close()
	responseData, err := io.ReadAll(io.LimitReader(response.Body, maxCompositeResponseBytes+1))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "读取 Composite 上游回包失败"})
		return
	}
	if len(responseData) > maxCompositeResponseBytes {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "Composite 上游回包过大"})
		return
	}
	log.Info().
		Str("method", c.Request.Method).
		Str("upstream_url", endpoint).
		Int("status", response.StatusCode).
		Interface("body", generationLogPayload(responseData, len(responseData) > maxGenerationLogResponseBytes)).
		Msg("composite model proxy response")

	for _, name := range []string{"Content-Type", "Cache-Control", "Retry-After", "X-Request-ID"} {
		if value := response.Header.Get(name); value != "" {
			c.Header(name, value)
		}
	}
	c.Data(response.StatusCode, response.Header.Get("Content-Type"), responseData)
}
