package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"gpt-image-backend/internal/database"
	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
	"gpt-image-backend/internal/services"
)

const maxProjectImageBytes = 64 << 20

var projectImageIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,200}$`)

type projectImageStore interface {
	SaveImage(ctx context.Context, userID string, image models.ProjectImage, data []byte) (*models.ProjectImage, error)
	ListImages(ctx context.Context, userID, projectID string) ([]models.ProjectImage, error)
	DeleteImage(ctx context.Context, userID, projectID, imageID string) error
}

type projectImageLegacyStore interface {
	GetImage(ctx context.Context, userID, projectID, imageID string) (*models.ProjectImage, []byte, error)
	MigrateImageURL(ctx context.Context, userID, projectID, imageID, imageURL string) error
}

type projectImageUploader interface {
	Upload(ctx context.Context, userID, fileName, contentType string, data []byte) (*services.MaterialUpload, error)
}

// ProjectImageHandler 处理在线项目图片接口。
type ProjectImageHandler struct {
	images   projectImageStore
	uploader projectImageUploader
}

func NewProjectImageHandler(images projectImageStore, uploader ...projectImageUploader) *ProjectImageHandler {
	h := &ProjectImageHandler{images: images}
	if len(uploader) > 0 {
		h.uploader = uploader[0]
	}
	return h
}

func (h *ProjectImageHandler) Register(api *gin.RouterGroup) {
	api.GET("/projects/:id/images", h.List)
	api.GET("/projects/:id/images/:imageId", h.Get)
	api.POST("/projects/:id/images", h.Save)
	api.DELETE("/projects/:id/images/:imageId", h.Delete)
}

// Get GET /api/v1/projects/:id/images/:imageId，兼容旧版图片二进制读取。
func (h *ProjectImageHandler) Get(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	projectID, imageID, ok := projectImageRequestIDs(c)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	if !ok {
		return
	}
	legacyStore, ok := h.images.(projectImageLegacyStore)
	if !ok {
		c.JSON(http.StatusNotImplemented, gin.H{"code": http.StatusNotImplemented, "message": "legacy project image storage unavailable"})
		return
	}
	image, data, err := legacyStore.GetImage(c.Request.Context(), userID, projectID, imageID)
	if errors.Is(err, database.ErrProjectNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "message": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	if len(data) > 0 && strings.TrimSpace(image.ImageURL) == "" && h.uploader != nil {
		fileName := filepath.Base(image.ImageID) + mimeExtension(image.MIMEType)
		result, uploadErr := h.uploader.Upload(c.Request.Context(), userID, fileName, image.MIMEType, data)
		if uploadErr == nil && result != nil && strings.TrimSpace(result.URL) != "" {
			imageURL := strings.TrimSpace(result.URL)
			if migrateErr := legacyStore.MigrateImageURL(c.Request.Context(), userID, projectID, imageID, imageURL); migrateErr == nil {
				c.Header("X-Project-Image-URL", imageURL)
				log.Ctx(c.Request.Context()).Info().Str("project_id", projectID).Str("image_id", imageID).Msg("project image URL migration completed")
			} else {
				log.Ctx(c.Request.Context()).Warn().Err(migrateErr).Str("project_id", projectID).Str("image_id", imageID).Msg("project image URL migration failed")
			}
		} else if uploadErr != nil {
			log.Ctx(c.Request.Context()).Warn().Err(uploadErr).Str("project_id", projectID).Str("image_id", imageID).Msg("project image upload migration failed")
		}
	}
	if image.ImageURL != "" && len(data) == 0 {
		c.Redirect(http.StatusFound, image.ImageURL)
		return
	}
	c.Header("ETag", `"`+image.SHA256+`"`)
	c.Data(http.StatusOK, image.MIMEType, data)
}

func mimeExtension(mimeType string) string {
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	default:
		return ".png"
	}
}

func projectImageRequestIDs(c *gin.Context) (string, string, bool) {
	projectID := strings.TrimSpace(c.Param("id"))
	imageID := strings.TrimSpace(c.Param("imageId"))
	if !projectUUIDPattern.MatchString(projectID) || (imageID != "" && !projectImageIDPattern.MatchString(imageID)) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project and image ids required"})
		return "", "", false
	}
	return projectID, imageID, true
}

// List GET /api/v1/projects/:id/images，返回图片元数据列表。
func (h *ProjectImageHandler) List(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	projectID, _, ok := projectImageRequestIDs(c)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	if !ok {
		return
	}
	images, err := h.images.ListImages(c.Request.Context(), userID, projectID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, images)
}

func parseImageDimension(value string) (*int, error) {
	if value == "" {
		return nil, nil
	}
	dimension, err := strconv.Atoi(value)
	if err != nil || dimension <= 0 || dimension > 100000 {
		return nil, errors.New("invalid image dimension")
	}
	return &dimension, nil
}

// Save POST /api/v1/projects/:id/images，生成完成时立即保存单张图片。
func (h *ProjectImageHandler) Save(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	projectID, _, ok := projectImageRequestIDs(c)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	if !ok {
		return
	}
	imageID := strings.TrimSpace(c.PostForm("image_id"))
	taskID := strings.TrimSpace(c.PostForm("task_id"))
	source := strings.TrimSpace(c.PostForm("source"))
	if !projectImageIDPattern.MatchString(imageID) || (taskID != "" && !projectImageIDPattern.MatchString(taskID)) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid image and task ids required"})
		return
	}
	if source != "" && source != "upload" && source != "generated" && source != "mask" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid image source required"})
		return
	}
	width, err := parseImageDimension(strings.TrimSpace(c.PostForm("width")))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
	height, err := parseImageDimension(strings.TrimSpace(c.PostForm("height")))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": err.Error()})
		return
	}
	header, err := c.FormFile("image")
	if err != nil || header.Size <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "project image required"})
		return
	}
	if header.Size > maxProjectImageBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": http.StatusRequestEntityTooLarge, "message": "project image exceeds 64 MiB"})
		return
	}
	file, err := header.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "open project image failed"})
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxProjectImageBytes+1))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "read project image failed"})
		return
	}
	if len(data) > maxProjectImageBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": http.StatusRequestEntityTooLarge, "message": "project image exceeds 64 MiB"})
		return
	}
	mimeType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	if !strings.HasPrefix(mimeType, "image/") {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "uploaded file must be an image"})
		return
	}
	digest := sha256.Sum256(data)
	image, err := h.images.SaveImage(c.Request.Context(), userID, models.ProjectImage{
		ProjectID: projectID,
		ImageID:   imageID,
		TaskID:    taskID,
		Source:    source,
		MIMEType:  mimeType,
		Width:     width,
		Height:    height,
		SHA256:    hex.EncodeToString(digest[:]),
	}, data)
	if errors.Is(err, database.ErrProjectNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "message": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, image)
}

// Delete DELETE /api/v1/projects/:id/images/:imageId，删除不再被项目引用的图片。
func (h *ProjectImageHandler) Delete(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	projectID, imageID, ok := projectImageRequestIDs(c)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	if !ok {
		return
	}
	err := h.images.DeleteImage(c.Request.Context(), userID, projectID, imageID)
	if errors.Is(err, database.ErrProjectNotFound) {
		c.Status(http.StatusNoContent)
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}
