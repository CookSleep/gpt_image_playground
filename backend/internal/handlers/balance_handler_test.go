package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/services"
)

type balanceServiceStub struct {
	userID string
	result *services.Balance
	err    error
}

func (s *balanceServiceStub) Get(_ context.Context, userID string) (*services.Balance, error) {
	s.userID = userID
	return s.result, s.err
}

func newBalanceHandlerRouter(service balanceService) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api := r.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextKeyUserID, "user-a")
		c.Next()
	})
	NewBalanceHandler(service).Register(api)
	return r
}

func TestBalanceHandlerReturnsInnerAPIBalance(t *testing.T) {
	service := &balanceServiceStub{result: &services.Balance{Available: true, Balance: "12.50", BalanceSource: "account"}}
	r := newBalanceHandlerRouter(service)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/balance", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK || service.userID != "user-a" || w.Body.String() != `{"available":true,"balance":"12.50","balance_source":"account"}` {
		t.Fatalf("unexpected response: status=%d body=%s user=%s", w.Code, w.Body.String(), service.userID)
	}
}

func TestBalanceHandlerHidesUnavailableBalance(t *testing.T) {
	for _, err := range []error{services.ErrBalanceNotConfigured, services.ErrBalanceAccountIDMissing} {
		service := &balanceServiceStub{err: err}
		r := newBalanceHandlerRouter(service)
		req := httptest.NewRequest(http.MethodGet, "/api/v1/balance", nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK || w.Body.String() != `{"available":false}` {
			t.Fatalf("error %v: status=%d body=%s", err, w.Code, w.Body.String())
		}
	}
}
