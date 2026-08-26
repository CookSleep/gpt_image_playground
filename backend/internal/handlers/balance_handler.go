package handlers

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/services"
)

type balanceService interface {
	Get(ctx context.Context, userID string) (*services.Balance, error)
}

type BalanceHandler struct {
	balance balanceService
}

func NewBalanceHandler(balance balanceService) *BalanceHandler {
	return &BalanceHandler{balance: balance}
}

func (h *BalanceHandler) Register(api *gin.RouterGroup) {
	api.GET("/balance", h.Get)
}

func (h *BalanceHandler) Get(c *gin.Context) {
	userID := c.GetString(middleware.ContextKeyUserID)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "message": "unauthenticated"})
		return
	}
	result, err := h.balance.Get(c.Request.Context(), userID)
	if errors.Is(err, services.ErrBalanceNotConfigured) || errors.Is(err, services.ErrBalanceAccountIDMissing) {
		c.JSON(http.StatusOK, gin.H{"available": false})
		return
	}
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("get balance response")
		c.JSON(http.StatusBadGateway, gin.H{"code": http.StatusBadGateway, "message": "余额接口失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}
