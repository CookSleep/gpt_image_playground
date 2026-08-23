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
	"gpt-image-backend/internal/services"
)

type materialUploadServiceStub struct {
	userID      string
	fileName    string
	contentType string
	data        []byte
	renamedID   string
	renamedName string
	deletedID   string
	deletedIDs  []string
}

func (s *materialUploadServiceStub) List(_ context.Context, _ string, _ string, _ string, _ int32, _ int32) (*services.MaterialList, error) {
	return &services.MaterialList{}, nil
}

func (s *materialUploadServiceStub) Get(_ context.Context, _, _ string) (*services.MaterialItem, error) {
	return &services.MaterialItem{}, nil
}

func (s *materialUploadServiceStub) Rename(_ context.Context, _, id, fileName string) (*services.MaterialItem, error) {
	s.renamedID = id
	s.renamedName = fileName
	return &services.MaterialItem{ID: id, FileName: fileName}, nil
}

func (s *materialUploadServiceStub) Delete(_ context.Context, _, id string) error {
	s.deletedID = id
	return nil
}

func (s *materialUploadServiceStub) BatchDelete(_ context.Context, _ string, ids []string) (*services.MaterialBatchDelete, error) {
	s.deletedIDs = append([]string(nil), ids...)
	return &services.MaterialBatchDelete{DeletedIDs: ids, DeletedCount: int32(len(ids))}, nil
}

func TestMaterialHandlerDeletesByOpaquePublicID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := &materialUploadServiceStub{}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewMaterialHandler(service).Register(api)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/materials/mat_public_A1b2", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if service.deletedID != "mat_public_A1b2" {
		t.Fatalf("unexpected material id: %q", service.deletedID)
	}
	if !bytes.Contains(w.Body.Bytes(), []byte(`"id":"mat_public_A1b2"`)) {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
}

func TestMaterialHandlerRenamesByOpaquePublicID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := &materialUploadServiceStub{}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewMaterialHandler(service).Register(api)

	body, _ := json.Marshal(map[string]string{"file_name": " 新名称.png "})
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/materials/mat_public_A1b2", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if service.renamedID != "mat_public_A1b2" || service.renamedName != "新名称.png" {
		t.Fatalf("unexpected rename: id=%q name=%q", service.renamedID, service.renamedName)
	}
	if !bytes.Contains(w.Body.Bytes(), []byte(`"file_name":"新名称.png"`)) {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
}

func TestMaterialHandlerBatchDeletesOpaquePublicIDs(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := &materialUploadServiceStub{}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewMaterialHandler(service).Register(api)

	body, _ := json.Marshal(map[string]any{"ids": []string{"mat_public_A", "mat_public_B"}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/materials/batch-delete", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	if len(service.deletedIDs) != 2 || service.deletedIDs[0] != "mat_public_A" || service.deletedIDs[1] != "mat_public_B" {
		t.Fatalf("unexpected material ids: %#v", service.deletedIDs)
	}
	if !bytes.Contains(w.Body.Bytes(), []byte(`"deleted_count":2`)) {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
}

func (s *materialUploadServiceStub) Upload(_ context.Context, userID, fileName, contentType string, data []byte) (*services.MaterialUpload, error) {
	s.userID = userID
	s.fileName = fileName
	s.contentType = contentType
	s.data = append([]byte(nil), data...)
	return &services.MaterialUpload{
		ID: "mat_public_7", URL: "https://materials.example/reference.png", FileName: fileName,
		ContentType: contentType, SizeBytes: int64(len(data)),
	}, nil
}

func TestMaterialHandlerUploadsImage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	service := &materialUploadServiceStub{}
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewMaterialHandler(service).Register(api)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "reference.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("\x89PNG\r\n\x1a\nimage"))
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/materials", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d body=%s", w.Code, w.Body.String())
	}
	if service.userID != "user-a" || service.fileName != "reference.png" || service.contentType != "image/png" {
		t.Fatalf("unexpected upload: user=%q file=%q type=%q", service.userID, service.fileName, service.contentType)
	}
	if !bytes.Equal(service.data, []byte("\x89PNG\r\n\x1a\nimage")) {
		t.Fatalf("unexpected data: %v", service.data)
	}
	if !bytes.Contains(w.Body.Bytes(), []byte(`"file_url":"https://materials.example/reference.png"`)) {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
}
