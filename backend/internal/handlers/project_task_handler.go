package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/database"
	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
)

const maxProjectTaskRecordBytes = 8 << 20

type projectTaskStore interface {
	SaveTaskRecord(ctx context.Context, userID, id, title, taskID string, project, task json.RawMessage) (*models.OnlineProject, error)
	DeleteTaskRecord(ctx context.Context, userID, id, taskID string) (*models.OnlineProject, error)
}

type ProjectTaskHandler struct {
	projects projectTaskStore
}

func NewProjectTaskHandler(projects projectTaskStore) *ProjectTaskHandler {
	return &ProjectTaskHandler{projects: projects}
}

func (h *ProjectTaskHandler) Register(api *gin.RouterGroup) {
	api.PUT("/projects/:id/tasks/:taskId", h.Save)
	api.DELETE("/projects/:id/tasks/:taskId", h.Delete)
}

type saveProjectTaskRequest struct {
	ProjectTitle string          `json:"project_title"`
	Project      json.RawMessage `json:"project"`
	Task         json.RawMessage `json:"task"`
}

func rawRecordID(raw json.RawMessage) string {
	var record struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &record) != nil {
		return ""
	}
	return strings.TrimSpace(record.ID)
}

// Save PUT /api/v1/projects/:id/tasks/:taskId，直接更新归档中的单条任务。
func (h *ProjectTaskHandler) Save(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	projectID := strings.TrimSpace(c.Param("id"))
	taskID := strings.TrimSpace(c.Param("taskId"))
	if !projectUUIDPattern.MatchString(projectID) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project id required"})
		return
	}
	if !projectImageIDPattern.MatchString(taskID) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid task id required"})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxProjectTaskRecordBytes)
	var req saveProjectTaskRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid task record required"})
		return
	}
	req.ProjectTitle = strings.TrimSpace(req.ProjectTitle)
	if req.ProjectTitle == "" || utf8.RuneCountInString(req.ProjectTitle) > 120 {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "project title must be 1-120 characters"})
		return
	}
	if rawRecordID(req.Project) != projectID || rawRecordID(req.Task) != taskID {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "project or task record id mismatch"})
		return
	}

	project, err := h.projects.SaveTaskRecord(c.Request.Context(), userID, projectID, req.ProjectTitle, taskID, req.Project, req.Task)
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

// Delete DELETE /api/v1/projects/:id/tasks/:taskId，删除归档中的单条任务。
func (h *ProjectTaskHandler) Delete(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	projectID := strings.TrimSpace(c.Param("id"))
	taskID := strings.TrimSpace(c.Param("taskId"))
	if !projectUUIDPattern.MatchString(projectID) || !projectImageIDPattern.MatchString(taskID) {
		c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": "valid project and task ids required"})
		return
	}

	project, err := h.projects.DeleteTaskRecord(c.Request.Context(), userID, projectID, taskID)
	if errors.Is(err, database.ErrProjectNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "message": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, project)
}
