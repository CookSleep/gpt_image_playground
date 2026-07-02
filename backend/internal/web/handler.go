package web

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

const headCloseTag = "</head>"

// appConfig 对应前端 window.__APP_CONFIG__。字段均为字符串，前端经 getRuntimeConfig 读取
// （布尔语义由前端做 === 'true' 比较）。
// AUTH_BACKEND_URL 语义：未设置/空串 → 同源启用登录（默认）；"disabled" → 关闭登录；
// URL → 跨域调用指定后端（纯静态前端 + 远程后端）。该键始终注入，故用普通字符串。
type appConfig struct {
	DefaultAPIURL          string `json:"DEFAULT_API_URL"`
	APIProxyAvailable      string `json:"API_PROXY_AVAILABLE"`
	APIProxyLocked         string `json:"API_PROXY_LOCKED"`
	DockerDeployment       string `json:"DOCKER_DEPLOYMENT"`
	DockerLegacyAPIURLUsed string `json:"DOCKER_LEGACY_API_URL_USED"`
	ShowDefaultConfigOnly  string `json:"SHOW_DEFAULT_CONFIG_ONLY"`
	AuthBackendURL         string `json:"AUTH_BACKEND_URL"`
}

// Handler 是基于嵌入 FS 的 SPA fallback 处理器，供 main.go 挂到 r.NoRoute。
func Handler(c *gin.Context) {
	serve(c, DistFS)
}

// NewHandler 基于给定 FS 构造 SPA fallback 处理器（便于测试注入自定义 FS）。
func NewHandler(dist fs.FS) gin.HandlerFunc {
	return func(c *gin.Context) { serve(c, dist) }
}

func serve(c *gin.Context, dist fs.FS) {
	if dist == nil {
		c.Status(http.StatusNotFound)
		return
	}

	// 静态资源：命中嵌入 FS 中的真实文件则带长缓存返回
	reqPath := strings.TrimPrefix(c.Request.URL.Path, "/")
	if reqPath != "" && reqPath != "index.html" && fs.ValidPath(reqPath) {
		if data, err := fs.ReadFile(dist, reqPath); err == nil {
			c.Header("Cache-Control", "public, max-age=31536000, immutable")
			c.Data(http.StatusOK, contentType(reqPath, data), data)
			return
		}
	}

	// 其余路径：SPA fallback，返回注入运行时配置后的 index.html
	html, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	c.Header("Cache-Control", "no-cache")
	c.Data(http.StatusOK, "text/html; charset=utf-8", injectConfig(html))
}

// injectConfig 在 </head> 前插入 window.__APP_CONFIG__ 内联脚本，使其早于前端入口 module 执行。
func injectConfig(html []byte) []byte {
	script := []byte("<script>window.__APP_CONFIG__ = " + configJSON() + ";</script>")
	idx := bytes.Index(html, []byte(headCloseTag))
	if idx < 0 {
		return append(script, html...)
	}
	out := make([]byte, 0, len(html)+len(script))
	out = append(out, html[:idx]...)
	out = append(out, script...)
	out = append(out, html[idx:]...)
	return out
}

func configJSON() string {
	cfg := appConfig{
		DefaultAPIURL: os.Getenv("DEFAULT_API_URL"),
		// embed 形态不提供同源代理，代理相关字段恒为 false
		APIProxyAvailable:      "false",
		APIProxyLocked:         "false",
		DockerDeployment:       os.Getenv("DOCKER_DEPLOYMENT"),
		DockerLegacyAPIURLUsed: os.Getenv("DOCKER_LEGACY_API_URL_USED"),
		ShowDefaultConfigOnly:  os.Getenv("SHOW_DEFAULT_CONFIG_ONLY"),
		// 未设置 → "" → 前端默认同源启用登录；"disabled" 关闭；URL 走跨域后端
		AuthBackendURL: os.Getenv("AUTH_BACKEND_URL"),
	}
	// 默认开启 HTML 转义（<、>、& 转义为 \u003c 等），避免字符串中含 </script> 破坏标签
	b, _ := json.Marshal(cfg)
	return string(b)
}

func contentType(name string, data []byte) string {
	if ct := mime.TypeByExtension(filepath.Ext(name)); ct != "" {
		return ct
	}
	return http.DetectContentType(data)
}
