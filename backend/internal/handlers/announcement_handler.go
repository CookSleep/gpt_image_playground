package handlers

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/database"
	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/models"
)

type announcementStore interface {
	List(context.Context) ([]models.Announcement, error)
	GetActive(context.Context, time.Time) (*models.Announcement, error)
	Create(context.Context, models.Announcement) (*models.Announcement, error)
	Update(context.Context, string, models.Announcement) (*models.Announcement, error)
	Delete(context.Context, string) error
}

type AnnouncementHandler struct {
	store   announcementStore
	isAdmin func(context.Context, string) (bool, error)
}

func NewAnnouncementHandler(store announcementStore, isAdmin func(context.Context, string) (bool, error)) *AnnouncementHandler {
	return &AnnouncementHandler{store: store, isAdmin: isAdmin}
}

func (h *AnnouncementHandler) Register(api *gin.RouterGroup) {
	api.GET("/announcements/active", h.GetActive)
	api.GET("/announcements/history", h.ListHistory)
	api.GET("/admin/announcements", h.List)
	api.POST("/admin/announcements", h.Create)
	api.PATCH("/admin/announcements/:id", h.Update)
	api.DELETE("/admin/announcements/:id", h.Delete)
}

func (h *AnnouncementHandler) ListHistory(c *gin.Context) {
	items, err := h.store.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	now := time.Now().UTC()
	visible := make([]models.Announcement, 0, len(items))
	for _, item := range items {
		if item.Status == "draft" || item.StartsAt != nil && item.StartsAt.After(now) {
			continue
		}
		visible = append(visible, item)
	}
	c.JSON(http.StatusOK, gin.H{"announcements": visible})
}

func (h *AnnouncementHandler) GetActive(c *gin.Context) {
	item, err := h.store.GetActive(c.Request.Context(), time.Now().UTC())
	if errors.Is(err, database.ErrAnnouncementNotFound) {
		c.Status(http.StatusNoContent)
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, item)
}

func (h *AnnouncementHandler) List(c *gin.Context) {
	if !h.requireAdmin(c) {
		return
	}
	items, err := h.store.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"announcements": items})
}

type announcementRequest struct {
	Title        string     `json:"title"`
	Content      string     `json:"content"`
	Status       string     `json:"status"`
	Notification string     `json:"notification"`
	StartsAt     *time.Time `json:"starts_at"`
	EndsAt       *time.Time `json:"ends_at"`
}

func (h *AnnouncementHandler) Create(c *gin.Context) {
	if !h.requireAdmin(c) {
		return
	}
	var req announcementRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		h.invalid(c, "valid announcement required")
		return
	}
	input, ok := normalizeAnnouncementRequest(req)
	if !ok {
		h.invalid(c, "content, status, notification and date range are invalid")
		return
	}
	item, err := h.store.Create(c.Request.Context(), input)
	if err != nil {
		h.writeStoreError(c, err)
		return
	}
	c.JSON(http.StatusCreated, item)
}

func (h *AnnouncementHandler) Update(c *gin.Context) {
	if !h.requireAdmin(c) {
		return
	}
	var req announcementRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		h.invalid(c, "valid announcement required")
		return
	}
	input, ok := normalizeAnnouncementRequest(req)
	if !ok {
		h.invalid(c, "content, status, notification and date range are invalid")
		return
	}
	item, err := h.store.Update(c.Request.Context(), strings.TrimSpace(c.Param("id")), input)
	if err != nil {
		h.writeStoreError(c, err)
		return
	}
	c.JSON(http.StatusOK, item)
}

func (h *AnnouncementHandler) Delete(c *gin.Context) {
	if !h.requireAdmin(c) {
		return
	}
	if err := h.store.Delete(c.Request.Context(), strings.TrimSpace(c.Param("id"))); err != nil {
		h.writeStoreError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *AnnouncementHandler) requireAdmin(c *gin.Context) bool {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return false
	}
	ok, err := h.isAdmin(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
		return false
	}
	if !ok {
		c.JSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "message": "admin access required"})
		return false
	}
	return true
}

func (h *AnnouncementHandler) invalid(c *gin.Context, message string) {
	c.JSON(http.StatusBadRequest, gin.H{"code": http.StatusBadRequest, "message": message})
}

func (h *AnnouncementHandler) writeStoreError(c *gin.Context, err error) {
	if errors.Is(err, database.ErrAnnouncementNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"code": http.StatusNotFound, "message": err.Error()})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"code": http.StatusInternalServerError, "message": err.Error()})
}

func normalizeAnnouncementRequest(req announcementRequest) (models.Announcement, bool) {
	status := strings.ToLower(strings.TrimSpace(req.Status))
	notification := strings.ToLower(strings.TrimSpace(req.Notification))
	if strings.TrimSpace(req.Content) == "" || (status != "draft" && status != "published" && status != "archived") || (notification != "silent" && notification != "modal") {
		return models.Announcement{}, false
	}
	if req.StartsAt != nil && req.EndsAt != nil && !req.EndsAt.After(*req.StartsAt) {
		return models.Announcement{}, false
	}
	return models.Announcement{
		Title: strings.TrimSpace(req.Title), Content: req.Content, Status: status,
		Notification: notification, StartsAt: req.StartsAt, EndsAt: req.EndsAt,
	}, true
}
