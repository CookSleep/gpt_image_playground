package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/database"
	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
)

const maxProjectArchiveBytes = 512 << 20

var projectUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type projectStore interface {
	Save(ctx context.Context, userID, id, title string, archive []byte, sha256 string) (*models.OnlineProject, error)
	SaveCanvas(ctx context.Context, userID, id string, canvas json.RawMessage) (*models.OnlineProject, error)
	SaveCanvasViewport(ctx context.Context, userID, id string, viewport json.RawMessage) (*models.OnlineProject, error)
	GetCanvas(ctx context.Context, userID, id string) (*models.OnlineProject, json.RawMessage, error)
	List(ctx context.Context, userID string) ([]models.OnlineProject, error)
	Get(ctx context.Context, userID, id string) (*models.OnlineProject, []byte, error)
	Rename(ctx context.Context, userID, id, title string) (*models.OnlineProject, error)
	Delete(ctx context.Context, userID, id string) error
}

// ProjectHandler 处理在线项目归档接口。
type ProjectHandler struct {
	projects projectStore
}

func NewProjectHandler(projects projectStore) *ProjectHandler {
	return &ProjectHandler{projects: projects}
}

func (h *ProjectHandler) Register(api *gin.RouterGroup) {
	api.GET("/projects", h.List)
	api.GET("/projects/:id", h.Get)
	api.GET("/projects/:id/canvas", h.GetCanvas)
	api.POST("/projects", h.Save)
	api.PATCH("/projects/:id", h.Rename)
	api.PATCH("/projects/:id/canvas", h.SaveCanvas)
	api.PATCH("/projects/:id/canvas/viewport", h.SaveCanvasViewport)
	api.DELETE("/projects/:id", h.Delete)
}

type saveProjectCanvasRequest struct {
	Canvas json.RawMessage `json:"canvas"`
}

type saveProjectCanvasViewportRequest struct {
	Viewport json.RawMessage `json:"viewport"`
}

type projectCanvasResponse struct {
	Canvas json.RawMessage `json:"canvas"`
}

// GetCanvas GET /api/v1/projects/:id/canvas，只读取项目归档中的画布状态。
func (h *ProjectHandler) GetCanvas(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}

	id := strings.TrimSpace(c.Param("id"))
	if !projectUUIDPattern.MatchString(id) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project id required"})
		return
	}
	_, canvas, err := h.projects.GetCanvas(c.Request.Context(), userID, id)
	if errors.Is(err, database.ErrProjectNotFound) || errors.Is(err, database.ErrProjectCanvasNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "message": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, projectCanvasResponse{Canvas: canvas})
}

// SaveCanvas PATCH /api/v1/projects/:id/canvas，只更新项目归档中的画布状态。
func (h *ProjectHandler) SaveCanvas(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}

	id := strings.TrimSpace(c.Param("id"))
	if !projectUUIDPattern.MatchString(id) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project id required"})
		return
	}
	var req saveProjectCanvasRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Canvas) == 0 || string(req.Canvas) == "null" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid canvas required"})
		return
	}
	var canvas map[string]any
	if err := json.Unmarshal(req.Canvas, &canvas); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid canvas required"})
		return
	}

	project, err := h.projects.SaveCanvas(c.Request.Context(), userID, id, req.Canvas)
	if errors.Is(err, database.ErrProjectNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "message": err.Error()})
		return
	}
	if errors.Is(err, database.ErrProjectForbidden) {
		c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "message": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, project)
}

// SaveCanvasViewport PATCH /api/v1/projects/:id/canvas/viewport，只更新画布视口。
func (h *ProjectHandler) SaveCanvasViewport(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}

	id := strings.TrimSpace(c.Param("id"))
	if !projectUUIDPattern.MatchString(id) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project id required"})
		return
	}
	var req saveProjectCanvasViewportRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Viewport) == 0 || string(req.Viewport) == "null" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid viewport required"})
		return
	}
	var viewport map[string]any
	if err := json.Unmarshal(req.Viewport, &viewport); err != nil || viewport == nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid viewport required"})
		return
	}
	for _, key := range []string{"x", "y", "scale"} {
		value, ok := viewport[key].(float64)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) || (key == "scale" && value <= 0) {
			c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid viewport required"})
			return
		}
	}

	project, err := h.projects.SaveCanvasViewport(c.Request.Context(), userID, id, req.Viewport)
	if errors.Is(err, database.ErrProjectNotFound) || errors.Is(err, database.ErrProjectCanvasNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "message": err.Error()})
		return
	}
	if errors.Is(err, database.ErrProjectForbidden) {
		c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "message": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, project)
}

// List GET /api/v1/projects，返回当前用户的项目元数据。
func (h *ProjectHandler) List(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}

	projects, err := h.projects.List(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, projects)
}

// Get GET /api/v1/projects/:id，返回项目 ZIP 归档。
func (h *ProjectHandler) Get(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}

	id := strings.TrimSpace(c.Param("id"))
	if !projectUUIDPattern.MatchString(id) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project id required"})
		return
	}
	project, archive, err := h.projects.Get(c.Request.Context(), userID, id)
	if errors.Is(err, database.ErrProjectNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "message": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.Header("ETag", `"`+project.ArchiveSHA256+`"`)
	c.Header("Content-Disposition", `attachment; filename="`+project.ID+`.zip"`)
	c.Data(http.StatusOK, "application/zip", archive)
}

type renameProjectRequest struct {
	Title string `json:"title"`
}

// Rename PATCH /api/v1/projects/:id，只修改项目名称。
func (h *ProjectHandler) Rename(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}

	id := strings.TrimSpace(c.Param("id"))
	var req renameProjectRequest
	if !projectUUIDPattern.MatchString(id) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project id required"})
		return
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid request body required"})
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" || utf8.RuneCountInString(req.Title) > 120 {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "project title must be 1-120 characters"})
		return
	}

	project, err := h.projects.Rename(c.Request.Context(), userID, id, req.Title)
	if errors.Is(err, database.ErrProjectForbidden) {
		c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "message": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, project)
}

// Delete DELETE /api/v1/projects/:id，删除当前用户的项目。
func (h *ProjectHandler) Delete(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}

	id := strings.TrimSpace(c.Param("id"))
	if !projectUUIDPattern.MatchString(id) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project id required"})
		return
	}
	err := h.projects.Delete(c.Request.Context(), userID, id)
	if errors.Is(err, database.ErrProjectNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "message": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

// Save POST /api/v1/projects，接收 multipart 项目 ZIP。
func (h *ProjectHandler) Save(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}

	id := strings.TrimSpace(c.PostForm("id"))
	title := strings.TrimSpace(c.PostForm("title"))
	if !projectUUIDPattern.MatchString(id) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project id required"})
		return
	}
	if title == "" || utf8.RuneCountInString(title) > 120 {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "project title must be 1-120 characters"})
		return
	}

	header, err := c.FormFile("archive")
	if err != nil || header.Size <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "project archive required"})
		return
	}
	if header.Size > maxProjectArchiveBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": http.StatusRequestEntityTooLarge, "message": "project archive exceeds 512 MiB"})
		return
	}

	file, err := header.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "open project archive failed"})
		return
	}
	defer file.Close()
	archive, err := io.ReadAll(io.LimitReader(file, maxProjectArchiveBytes+1))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "read project archive failed"})
		return
	}
	if len(archive) > maxProjectArchiveBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": http.StatusRequestEntityTooLarge, "message": "project archive exceeds 512 MiB"})
		return
	}
	if len(archive) < 4 || string(archive[:4]) != "PK\x03\x04" {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "project archive must be a ZIP file"})
		return
	}

	digest := sha256.Sum256(archive)
	project, err := h.projects.Save(c.Request.Context(), userID, id, title, archive, hex.EncodeToString(digest[:]))
	if errors.Is(err, database.ErrProjectForbidden) {
		c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "message": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, project)
}
