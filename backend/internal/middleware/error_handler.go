package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
)

// ErrorResponse 错误响应结构体
type ErrorResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Details string `json:"details,omitempty"`
}

// ErrorHandler 错误处理中间件
func ErrorHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()

		if len(c.Errors) == 0 {
			return
		}
		err := c.Errors.Last()

		log.Ctx(c.Request.Context()).Error().
			Err(err.Err).
			Str("path", c.Request.URL.Path).
			Str("method", c.Request.Method).
			Int("status", c.Writer.Status()).
			Msg("request error")

		statusCode := c.Writer.Status()
		if statusCode == http.StatusOK {
			statusCode = http.StatusInternalServerError
		}

		// 如果响应体已经写过，则不要再次写入
		if c.Writer.Written() {
			return
		}
		c.JSON(statusCode, ErrorResponse{
			Code:    statusCode,
			Message: getErrorMessage(statusCode),
			Details: err.Error(),
		})
	}
}

// getErrorMessage 根据HTTP状态码获取错误消息
func getErrorMessage(statusCode int) string {
	switch statusCode {
	case http.StatusBadRequest:
		return "Bad request"
	case http.StatusUnauthorized:
		return "Unauthorized"
	case http.StatusForbidden:
		return "Forbidden"
	case http.StatusNotFound:
		return "Not found"
	case http.StatusInternalServerError:
		return "Internal server error"
	case http.StatusServiceUnavailable:
		return "Service unavailable"
	default:
		return "An error occurred"
	}
}

// RecoveryMiddleware 恢复中间件，防止panic导致服务崩溃
func RecoveryMiddleware() gin.HandlerFunc {
	return gin.CustomRecovery(func(c *gin.Context, recovered interface{}) {
		log.Ctx(c.Request.Context()).Error().
			Interface("panic", recovered).
			Str("path", c.Request.URL.Path).
			Str("method", c.Request.Method).
			Msg("panic recovered")

		c.AbortWithStatusJSON(http.StatusInternalServerError, ErrorResponse{
			Code:    http.StatusInternalServerError,
			Message: "Internal server error",
			Details: "The server encountered an unexpected condition",
		})
	})
}
