package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
)

type projectStoreStub struct {
	project  *models.OnlineProject
	projects []models.OnlineProject
	userID   string
	id       string
	title    string
	archive  []byte
	sha256   string
	canvas   json.RawMessage
	viewport json.RawMessage
	deleted  bool
}

func (s *projectStoreStub) Save(_ context.Context, userID, id, title string, archive []byte, sha256 string) (*models.OnlineProject, error) {
	s.userID = userID
	s.id = id
	s.title = title
	s.archive = archive
	s.sha256 = sha256
	return s.project, nil
}

func (s *projectStoreStub) SaveCanvas(_ context.Context, userID, id string, canvas json.RawMessage) (*models.OnlineProject, error) {
	s.userID = userID
	s.id = id
	s.canvas = canvas
	return s.project, nil
}

func (s *projectStoreStub) SaveCanvasViewport(_ context.Context, userID, id string, viewport json.RawMessage) (*models.OnlineProject, error) {
	s.userID = userID
	s.id = id
	s.viewport = viewport
	return s.project, nil
}

func (s *projectStoreStub) GetCanvas(_ context.Context, userID, id string) (*models.OnlineProject, json.RawMessage, error) {
	s.userID = userID
	s.id = id
	return s.project, s.canvas, nil
}

func (s *projectStoreStub) List(_ context.Context, userID string) ([]models.OnlineProject, error) {
	s.userID = userID
	return s.projects, nil
}

func (s *projectStoreStub) Get(_ context.Context, userID, id string) (*models.OnlineProject, []byte, error) {
	s.userID = userID
	s.id = id
	return s.project, s.archive, nil
}

func (s *projectStoreStub) Rename(_ context.Context, userID, id, title string) (*models.OnlineProject, error) {
	s.userID = userID
	s.id = id
	s.title = title
	return s.project, nil
}

func (s *projectStoreStub) Delete(_ context.Context, userID, id string) error {
	s.userID = userID
	s.id = id
	s.deleted = true
	return nil
}

func newProjectUploadRequest(t *testing.T, archive []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("id", "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("title", "本地数据"); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("archive", "project.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(archive); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	return req
}

func TestProjectHandlerSave(t *testing.T) {
	gin.SetMode(gin.TestMode)
	project := &models.OnlineProject{ID: "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8", Title: "本地数据", ArchiveSize: 8}
	store := &projectStoreStub{project: project}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectHandler(store).Register(api)

	req := newProjectUploadRequest(t, []byte("PK\x03\x04data"))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d body=%s", w.Code, w.Body.String())
	}
	if store.userID != "user-a" || store.id != project.ID || store.title != "本地数据" {
		t.Fatalf("unexpected save args: user=%q id=%q title=%q", store.userID, store.id, store.title)
	}
	if !bytes.Equal(store.archive, []byte("PK\x03\x04data")) || len(store.sha256) != 64 {
		t.Fatal("archive or sha256 was not saved")
	}
}

func TestProjectHandlerSaveCanvas(t *testing.T) {
	gin.SetMode(gin.TestMode)
	project := &models.OnlineProject{ID: "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8", Title: "项目 A"}
	store := &projectStoreStub{project: project}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectHandler(store).Register(api)

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/canvas", bytes.NewBufferString(`{"canvas":{"version":1,"viewport":{"x":1,"y":2,"scale":1},"items":{}}}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK || store.userID != "user-a" || store.id != project.ID || string(store.canvas) != `{"version":1,"viewport":{"x":1,"y":2,"scale":1},"items":{}}` {
		t.Fatalf("unexpected canvas save: status=%d user=%q id=%q canvas=%s", w.Code, store.userID, store.id, store.canvas)
	}
}

func TestProjectHandlerSaveCanvasViewport(t *testing.T) {
	gin.SetMode(gin.TestMode)
	project := &models.OnlineProject{ID: "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8", Title: "项目 A"}
	store := &projectStoreStub{project: project}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectHandler(store).Register(api)

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/canvas/viewport", bytes.NewBufferString(`{"viewport":{"x":12,"y":8,"scale":1.25}}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK || store.userID != "user-a" || store.id != project.ID || string(store.viewport) != `{"x":12,"y":8,"scale":1.25}` {
		t.Fatalf("unexpected canvas viewport save: status=%d user=%q id=%q viewport=%s", w.Code, store.userID, store.id, store.viewport)
	}
}

func TestProjectHandlerGetCanvas(t *testing.T) {
	gin.SetMode(gin.TestMode)
	project := &models.OnlineProject{ID: "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8", Title: "项目 A"}
	store := &projectStoreStub{project: project, canvas: json.RawMessage(`{"version":1,"viewport":{"x":4,"y":8,"scale":1},"items":{}}`)}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectHandler(store).Register(api)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/canvas", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK || store.userID != "user-a" || store.id != project.ID || w.Body.String() != `{"canvas":{"version":1,"viewport":{"x":4,"y":8,"scale":1},"items":{}}}` {
		t.Fatalf("unexpected canvas response: status=%d user=%q id=%q body=%s", w.Code, store.userID, store.id, w.Body.String())
	}
}

func TestProjectHandlerList(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store := &projectStoreStub{projects: []models.OnlineProject{{ID: "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8", Title: "项目 A"}}}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectHandler(store).Register(api)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if store.userID != "user-a" || !bytes.Contains(w.Body.Bytes(), []byte(`"title":"项目 A"`)) {
		t.Fatalf("unexpected list response: user=%q body=%s", store.userID, w.Body.String())
	}
}

func TestProjectHandlerGet(t *testing.T) {
	gin.SetMode(gin.TestMode)
	project := &models.OnlineProject{ID: "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8", Title: "项目 A", ArchiveSHA256: "sha256"}
	store := &projectStoreStub{project: project, archive: []byte("PK\x03\x04data")}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectHandler(store).Register(api)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("want ZIP 200, got %d content-type=%q", w.Code, w.Header().Get("Content-Type"))
	}
	if store.userID != "user-a" || store.id != project.ID || !bytes.Equal(w.Body.Bytes(), store.archive) {
		t.Fatal("unexpected project archive response")
	}
}

func TestProjectHandlerRejectsNonZip(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store := &projectStoreStub{}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectHandler(store).Register(api)

	req := newProjectUploadRequest(t, []byte("not-a-zip"))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestProjectHandlerRename(t *testing.T) {
	gin.SetMode(gin.TestMode)
	project := &models.OnlineProject{ID: "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8", Title: "新项目名", ArchiveSize: 8}
	store := &projectStoreStub{project: project}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectHandler(store).Register(api)

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8", bytes.NewBufferString(`{"title":"新项目名"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if store.userID != "user-a" || store.id != project.ID || store.title != project.Title {
		t.Fatalf("unexpected rename args: user=%q id=%q title=%q", store.userID, store.id, store.title)
	}
}

func TestProjectHandlerDelete(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store := &projectStoreStub{}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectHandler(store).Register(api)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent || !store.deleted {
		t.Fatalf("want 204 and deleted, got %d deleted=%t", w.Code, store.deleted)
	}
}
