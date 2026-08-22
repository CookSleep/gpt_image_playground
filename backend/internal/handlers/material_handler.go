package handlers

import (
	"context"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/services"
)

const maxMaterialImageBytes = 50 << 20
const maxBatchDeleteMaterials = 100

type materialUploadService interface {
	List(ctx context.Context, userID, kind, keyword string, page, pageSize int32) (*services.MaterialList, error)
	Get(ctx context.Context, userID, id string) (*services.MaterialItem, error)
	Upload(ctx context.Context, userID, fileName, contentType string, data []byte) (*services.MaterialUpload, error)
	Delete(ctx context.Context, userID, id string) error
	BatchDelete(ctx context.Context, userID string, ids []string) (*services.MaterialBatchDelete, error)
}

type MaterialHandler struct {
	materials materialUploadService
}

func NewMaterialHandler(materials materialUploadService) *MaterialHandler {
	return &MaterialHandler{materials: materials}
}

func (h *MaterialHandler) Register(api *gin.RouterGroup) {
	api.GET("/materials", h.List)
	api.POST("/materials", h.Upload)
	api.POST("/materials/batch-delete", h.BatchDelete)
	api.GET("/materials/:id", h.Get)
	api.DELETE("/materials/:id", h.Delete)
}

func (h *MaterialHandler) List(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	page, pageSize, err := materialPageQuery(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
	result, err := h.materials.List(c.Request.Context(), userID, strings.TrimSpace(c.Query("kind")), strings.TrimSpace(c.Query("keyword")), page, pageSize)
	if err != nil {
		h.writeServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *MaterialHandler) Get(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	id, err := materialIDParam(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
	result, err := h.materials.Get(c.Request.Context(), userID, id)
	if err != nil {
		h.writeServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *MaterialHandler) Delete(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	id, err := materialIDParam(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
	if err := h.materials.Delete(c.Request.Context(), userID, id); err != nil {
		h.writeServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id, "deleted": true})
}

func (h *MaterialHandler) BatchDelete(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	var request struct {
		IDs []string `json:"ids"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "material ids are required"})
		return
	}
	if len(request.IDs) == 0 || len(request.IDs) > maxBatchDeleteMaterials {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "material ids must contain between 1 and 100 items"})
		return
	}
	ids := make([]string, len(request.IDs))
	for index, id := range request.IDs {
		ids[index] = strings.TrimSpace(id)
		if ids[index] == "" {
			c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "material id is required"})
			return
		}
	}
	result, err := h.materials.BatchDelete(c.Request.Context(), userID, ids)
	if err != nil {
		h.writeServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

func materialPageQuery(c *gin.Context) (int32, int32, error) {
	page, pageSize := int64(1), int64(50)
	var err error
	if value := strings.TrimSpace(c.Query("page")); value != "" {
		page, err = strconv.ParseInt(value, 10, 32)
		if err != nil || page < 1 {
			return 0, 0, errors.New("page must be a positive integer")
		}
	}
	if value := strings.TrimSpace(c.Query("page_size")); value != "" {
		pageSize, err = strconv.ParseInt(value, 10, 32)
		if err != nil || pageSize < 1 || pageSize > 100 {
			return 0, 0, errors.New("page_size must be between 1 and 100")
		}
	}
	return int32(page), int32(pageSize), nil
}

func materialIDParam(c *gin.Context) (string, error) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		return "", errors.New("material id is required")
	}
	return id, nil
}

func (h *MaterialHandler) writeServiceError(c *gin.Context, err error) {
	if errors.Is(err, services.ErrMaterialUploadNotConfigured) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "message": err.Error()})
		return
	}
	if errors.Is(err, services.ErrMaterialAccountIDMissing) {
		c.JSON(http.StatusConflict, gin.H{"code": "account_id_required", "message": err.Error()})
		return
	}
	log.Error().Err(err).Str("user_id", c.GetString(middleware.ContextKeyUserID)).Msg("material management response")
	c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "素材接口失败: " + err.Error()})
}

func (h *MaterialHandler) Upload(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMaterialImageBytes+(1<<20))
	fileHeader, err := c.FormFile("file")
	if err != nil || fileHeader.Size <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "material file required"})
		return
	}
	if fileHeader.Size > maxMaterialImageBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": http.StatusRequestEntityTooLarge, "message": "material file exceeds 50 MiB"})
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "open material file failed"})
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxMaterialImageBytes+1))
	if err != nil || len(data) > maxMaterialImageBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": http.StatusRequestEntityTooLarge, "message": "read material file failed"})
		return
	}
	contentType := strings.TrimSpace(fileHeader.Header.Get("Content-Type"))
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = http.DetectContentType(data)
	}
	if !strings.HasPrefix(contentType, "image/") {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "material file must be an image"})
		return
	}
	fileName := filepath.Base(strings.TrimSpace(fileHeader.Filename))
	if fileName == "." || fileName == "" || len(fileName) > 255 {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid material file name required"})
		return
	}
	log.Info().Str("user_id", userID).Str("file_name", fileName).Str("content_type", contentType).Int("size_bytes", len(data)).Msg("material upload request")
	result, err := h.materials.Upload(c.Request.Context(), userID, fileName, contentType, data)
	if errors.Is(err, services.ErrMaterialUploadNotConfigured) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "message": err.Error()})
		return
	}
	if errors.Is(err, services.ErrMaterialAccountIDMissing) {
		c.JSON(http.StatusConflict, gin.H{"code": "account_id_required", "message": err.Error()})
		return
	}
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("material upload response")
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "素材上传失败: " + err.Error()})
		return
	}
	log.Info().Str("user_id", userID).Str("material_id", result.ID).Str("url", result.URL).Msg("material upload response")
	c.JSON(http.StatusCreated, gin.H{
		"id": result.ID, "file_url": result.URL, "file_name": result.FileName,
		"content_type": result.ContentType, "size_bytes": result.SizeBytes,
	})
}
