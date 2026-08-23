package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
)

type projectTaskStoreStub struct {
	projectID string
	taskID    string
	title     string
	task      json.RawMessage
}

func (s *projectTaskStoreStub) SaveTaskRecord(_ context.Context, _ string, id, title, taskID string, _ json.RawMessage, task json.RawMessage) (*models.OnlineProject, error) {
	s.projectID = id
	s.taskID = taskID
	s.title = title
	s.task = task
	return &models.OnlineProject{ID: id, Title: title}, nil
}

func (s *projectTaskStoreStub) DeleteTaskRecord(_ context.Context, _ string, id, taskID string) (*models.OnlineProject, error) {
	s.projectID = id
	s.taskID = taskID
	return &models.OnlineProject{ID: id}, nil
}

func newProjectTaskRouter(store projectTaskStore) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectTaskHandler(store).Register(api)
	return r
}

func TestProjectTaskHandlerSave(t *testing.T) {
	store := &projectTaskStoreStub{}
	body := []byte(`{
		"project_title":"项目 A",
		"project":{"id":"86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8","title":"项目 A"},
		"task":{"id":"task-a","status":"done"}
	}`)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/tasks/task-a", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	newProjectTaskRouter(store).ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if store.projectID != "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8" || store.taskID != "task-a" || store.title != "项目 A" || !bytes.Contains(store.task, []byte(`"status":"done"`)) {
		t.Fatal("task record was not saved")
	}
}

func TestProjectTaskHandlerRejectsMismatchedTaskID(t *testing.T) {
	store := &projectTaskStoreStub{}
	body := []byte(`{
		"project_title":"项目 A",
		"project":{"id":"86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8"},
		"task":{"id":"task-b"}
	}`)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/tasks/task-a", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	newProjectTaskRouter(store).ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%s", w.Code, w.Body.String())
	}
}
