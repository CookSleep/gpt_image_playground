package handlers

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
)

type projectImageStoreStub struct {
	image     *models.ProjectImage
	images    []models.ProjectImage
	userID    string
	projectID string
	imageID   string
	data      []byte
	deleted   bool
}

func (s *projectImageStoreStub) SaveImage(_ context.Context, userID string, image models.ProjectImage, data []byte) (*models.ProjectImage, error) {
	s.userID = userID
	s.projectID = image.ProjectID
	s.imageID = image.ImageID
	s.image = &image
	s.data = data
	return &image, nil
}

func (s *projectImageStoreStub) ListImages(_ context.Context, userID, projectID string) ([]models.ProjectImage, error) {
	s.userID = userID
	s.projectID = projectID
	return s.images, nil
}

func (s *projectImageStoreStub) GetImage(_ context.Context, userID, projectID, imageID string) (*models.ProjectImage, []byte, error) {
	s.userID = userID
	s.projectID = projectID
	s.imageID = imageID
	return s.image, s.data, nil
}

func (s *projectImageStoreStub) DeleteImage(_ context.Context, userID, projectID, imageID string) error {
	s.userID = userID
	s.projectID = projectID
	s.imageID = imageID
	s.deleted = true
	return nil
}

func newProjectImageRouter(store projectImageStore) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewProjectImageHandler(store).Register(api)
	return r
}

func newProjectImageUploadRequest(t *testing.T, image []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range map[string]string{
		"image_id": "image-a",
		"task_id":  "task-a",
		"source":   "generated",
		"width":    "1024",
		"height":   "768",
	} {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="image"; filename="image-a.png"`)
	header.Set("Content-Type", "image/png")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(image); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/images", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	return req
}

func TestProjectImageHandlerSave(t *testing.T) {
	data := []byte("generated-image")
	store := &projectImageStoreStub{}
	w := httptest.NewRecorder()
	newProjectImageRouter(store).ServeHTTP(w, newProjectImageUploadRequest(t, data))

	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d body=%s", w.Code, w.Body.String())
	}
	if store.userID != "user-a" || store.projectID != "86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8" || store.imageID != "image-a" {
		t.Fatalf("unexpected image save args: user=%q project=%q image=%q", store.userID, store.projectID, store.imageID)
	}
	if store.image == nil || store.image.TaskID != "task-a" || store.image.Source != "generated" || store.image.MIMEType != "image/png" {
		t.Fatalf("unexpected image metadata: %#v", store.image)
	}
	if store.image.Width == nil || *store.image.Width != 1024 || store.image.Height == nil || *store.image.Height != 768 {
		t.Fatalf("unexpected image dimensions: %#v", store.image)
	}
	if !bytes.Equal(store.data, data) || len(store.image.SHA256) != 64 {
		t.Fatal("image bytes or sha256 was not saved")
	}
}

func TestProjectImageHandlerGet(t *testing.T) {
	data := []byte("generated-image")
	store := &projectImageStoreStub{
		image: &models.ProjectImage{ImageID: "image-a", MIMEType: "image/png", SHA256: "sha256"},
		data:  data,
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/86d80cf2-976f-4b2c-8b2e-64fc0d4e77e8/images/image-a", nil)
	newProjectImageRouter(store).ServeHTTP(w, req)

	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "image/png" || !bytes.Equal(w.Body.Bytes(), data) {
		t.Fatalf("unexpected image response: status=%d type=%q body=%q", w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
	}
}
