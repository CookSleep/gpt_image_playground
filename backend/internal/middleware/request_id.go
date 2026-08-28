package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
)

const (
	ContextKeyRequestID = "request.id"
	RequestIDHeader     = "X-Request-ID"
)

var requestIDFallback atomic.Uint64

type requestIDContextKey struct{}

// RequestID 为每个 HTTP 请求绑定同一个 request_id，并通过响应头返回给调用方。
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := strings.TrimSpace(c.GetHeader(RequestIDHeader))
		if len(requestID) > 128 {
			requestID = ""
		}
		if requestID == "" {
			var value [16]byte
			if _, err := rand.Read(value[:]); err == nil {
				requestID = hex.EncodeToString(value[:])
			} else {
				requestID = fmt.Sprintf("%x-%x", time.Now().UnixNano(), requestIDFallback.Add(1))
			}
		}

		requestLogger := log.With().Str("request_id", requestID).Logger()
		c.Set(ContextKeyRequestID, requestID)
		c.Header(RequestIDHeader, requestID)
		ctx := context.WithValue(c.Request.Context(), requestIDContextKey{}, requestID)
		c.Request = c.Request.WithContext(requestLogger.WithContext(ctx))
		c.Next()
	}
}

func RequestIDFromContext(ctx context.Context) string {
	requestID, _ := ctx.Value(requestIDContextKey{}).(string)
	return requestID
}

func SetRequestIDHeader(request *http.Request) {
	if requestID := RequestIDFromContext(request.Context()); requestID != "" {
		request.Header.Set(RequestIDHeader, requestID)
	}
}
