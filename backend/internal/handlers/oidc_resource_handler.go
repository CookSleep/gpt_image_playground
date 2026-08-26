package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/pkg/config"
)

const oidcAccessTokenHeader = "X-OIDC-Access-Token"
const maxOIDCResourceResponseBytes = 4 << 20
const upstreamUnauthorizedStatus = http.StatusFailedDependency
const maxConcurrentAPIKeyModelChecks = 6

type OIDCResourceHandler struct {
	providers imageProviderRegistry
	whitelist config.ModelWhitelistConfig
	client    *http.Client
}

type modelListResponse struct {
	Data   []json.RawMessage `json:"data"`
	Object string            `json:"object,omitempty"`
}

type apiKeyCandidate struct {
	key  string
	item any
}

func NewOIDCResourceHandler(providers imageProviderRegistry, whitelist config.ModelWhitelistConfig) *OIDCResourceHandler {
	return &OIDCResourceHandler{
		providers: providers,
		whitelist: whitelist,
		client:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (h *OIDCResourceHandler) Register(api *gin.RouterGroup) {
	api.GET("/api-keys", h.APIKeys)
	api.GET("/models", h.Models)
}

// APIKeys 使用当前 OIDC access token 代理资源端点，token 不在后台保存。
func (h *OIDCResourceHandler) APIKeys(c *gin.Context) {
	if c.GetString(middleware.ContextKeyUserID) == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	scope := strings.TrimSpace(c.Query("scope"))
	if scope != "image" && scope != "agent" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "scope must be image or agent"})
		return
	}
	token := strings.TrimSpace(c.GetHeader(oidcAccessTokenHeader))
	if token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": oidcAccessTokenHeader + " is required"})
		return
	}
	baseURL, ok := h.providers.ResourceBaseURL(c.GetString(middleware.ContextKeyProvider))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "OIDC provider unavailable"})
		return
	}
	request, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, strings.TrimRight(baseURL, "/")+"/oidc/resource/api-keys?status=active", nil)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": err.Error()})
		return
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", c.Request.UserAgent())

	response, err := h.client.Do(request)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "API Key 上游连接失败: " + err.Error()})
		return
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxOIDCResourceResponseBytes+1))
	if err != nil || len(data) > maxOIDCResourceResponseBytes {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "读取 API Key 上游回包失败"})
		return
	}
	// 避免前端 authFetch 把 Provider 的 401 误判为本项目 JWT 过期。
	if response.StatusCode == http.StatusUnauthorized {
		c.Data(upstreamUnauthorizedStatus, response.Header.Get("Content-Type"), data)
		return
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		c.Data(response.StatusCode, response.Header.Get("Content-Type"), data)
		return
	}
	candidates, err := parseAPIKeyCandidates(data)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "API Key 上游回包格式无效"})
		return
	}
	allowed := h.whitelist.Image
	if scope == "agent" {
		allowed = h.whitelist.Agent
	}
	items, err := h.filterAPIKeys(c.Request.Context(), baseURL, candidates, allowed)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "检查 API Key 模型失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "count": len(items)})
}

// Models 在后台将 API Key 可用模型与对应场景白名单取交集。
func (h *OIDCResourceHandler) Models(c *gin.Context) {
	if c.GetString(middleware.ContextKeyUserID) == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	scope := strings.TrimSpace(c.Query("scope"))
	if scope != "image" && scope != "agent" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "scope must be image or agent"})
		return
	}
	apiKey := strings.TrimSpace(c.GetHeader(compositeAPIKeyHeader))
	if apiKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": compositeAPIKeyHeader + " is required"})
		return
	}
	baseURL, ok := h.providers.ResourceBaseURL(c.GetString(middleware.ContextKeyProvider))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "model provider unavailable"})
		return
	}
	payload, data, status, err := h.fetchModelList(c.Request.Context(), baseURL, apiKey)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": err.Error()})
		return
	}
	if status == http.StatusUnauthorized {
		c.Data(upstreamUnauthorizedStatus, "application/json", data)
		return
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		c.Data(status, "application/json", data)
		return
	}
	allowed := h.whitelist.Image
	if scope == "agent" {
		allowed = h.whitelist.Agent
	}
	if len(allowed) > 0 {
		allowedSet := make(map[string]struct{}, len(allowed))
		for _, model := range allowed {
			allowedSet[model] = struct{}{}
		}
		filtered := make([]json.RawMessage, 0, len(payload.Data))
		for _, raw := range payload.Data {
			var model struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(raw, &model); err != nil {
				continue
			}
			if _, ok := allowedSet[model.ID]; ok {
				filtered = append(filtered, raw)
			}
		}
		payload.Data = filtered
	}
	if payload.Data == nil {
		payload.Data = []json.RawMessage{}
	}
	c.JSON(http.StatusOK, payload)
}

func parseAPIKeyCandidates(data []byte) ([]apiKeyCandidate, error) {
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	payload := raw
	if inner, ok := raw["data"].(map[string]any); ok {
		payload = inner
	}
	var candidate any
	for _, field := range []string{"sub2api_apikeys", "sub2api:apikeys", "sub2api_api_keys", "apikeys", "api_keys", "keys", "items", "list", "data"} {
		if payload[field] != nil {
			candidate = payload[field]
			break
		}
	}
	if candidate == nil {
		return []apiKeyCandidate{}, nil
	}
	list, ok := candidate.([]any)
	if !ok {
		return nil, fmt.Errorf("API Key list is not an array")
	}
	result := make([]apiKeyCandidate, 0, len(list))
	for _, item := range list {
		if key, ok := item.(string); ok {
			if key != "" {
				result = append(result, apiKeyCandidate{key: key, item: item})
			}
			continue
		}
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		for _, field := range []string{"key", "api_key", "apikey", "sub2api_apikey", "sub2api:apikey", "secret", "token", "value", "id"} {
			key, ok := object[field].(string)
			if ok && key != "" {
				result = append(result, apiKeyCandidate{key: key, item: item})
				break
			}
		}
	}
	return result, nil
}

func (h *OIDCResourceHandler) filterAPIKeys(ctx context.Context, baseURL string, candidates []apiKeyCandidate, allowed []string) ([]any, error) {
	if len(candidates) == 0 {
		return []any{}, nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	available := make([]bool, len(candidates))
	semaphore := make(chan struct{}, maxConcurrentAPIKeyModelChecks)
	var wg sync.WaitGroup
	var firstErr error
	var errOnce sync.Once
	for index, candidate := range candidates {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				return
			}
			payload, _, status, err := h.fetchModelList(ctx, baseURL, candidate.key)
			if status == http.StatusUnauthorized || status == http.StatusForbidden {
				return
			}
			if err != nil || status < http.StatusOK || status >= http.StatusMultipleChoices {
				if err == nil {
					err = fmt.Errorf("upstream returned %d", status)
				}
				errOnce.Do(func() {
					firstErr = err
					cancel()
				})
				return
			}
			available[index] = hasAllowedModel(payload.Data, allowed)
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	items := make([]any, 0, len(candidates))
	for index, candidate := range candidates {
		if available[index] {
			items = append(items, candidate.item)
		}
	}
	return items, nil
}

func (h *OIDCResourceHandler) fetchModelList(ctx context.Context, baseURL, apiKey string) (modelListResponse, []byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/v1/models", nil)
	if err != nil {
		return modelListResponse{}, nil, 0, err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Accept", "application/json")
	response, err := h.client.Do(request)
	if err != nil {
		return modelListResponse{}, nil, 0, fmt.Errorf("模型上游连接失败: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxOIDCResourceResponseBytes+1))
	if err != nil || len(data) > maxOIDCResourceResponseBytes {
		return modelListResponse{}, nil, response.StatusCode, fmt.Errorf("读取模型上游回包失败")
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return modelListResponse{}, data, response.StatusCode, nil
	}
	var payload modelListResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return modelListResponse{}, data, response.StatusCode, fmt.Errorf("模型上游回包格式无效")
	}
	return payload, data, response.StatusCode, nil
}

func hasAllowedModel(models []json.RawMessage, allowed []string) bool {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, model := range allowed {
		allowedSet[model] = struct{}{}
	}
	for _, raw := range models {
		var model struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &model); err != nil || model.ID == "" {
			continue
		}
		if len(allowedSet) == 0 {
			return true
		}
		if _, ok := allowedSet[model.ID]; ok {
			return true
		}
	}
	return false
}
