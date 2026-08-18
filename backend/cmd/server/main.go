package main

import (
	"context"
	"flag"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-contrib/cors"
	ginlogger "github.com/gin-contrib/logger"
	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"gpt-image-backend/internal/auth"
	"gpt-image-backend/internal/database"
	"gpt-image-backend/internal/handlers"
	"gpt-image-backend/internal/middleware"
	"gpt-image-backend/internal/services"
	"gpt-image-backend/internal/web"
	"gpt-image-backend/pkg/config"
	appjwt "gpt-image-backend/pkg/jwt"
)

const (
	deletedProjectRetention       = 7 * 24 * time.Hour
	deletedProjectCleanupInterval = time.Hour
)

func startDeletedProjectCleanup(ctx context.Context, repo *database.ProjectRepository) {
	cleanup := func() {
		cleanupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		count, err := repo.PurgeDeleted(cleanupCtx, time.Now().Add(-deletedProjectRetention))
		if err != nil {
			log.Error().Err(err).Msg("purge deleted projects failed")
			return
		}
		if count > 0 {
			log.Info().Int64("count", count).Msg("purged deleted projects")
		}
	}

	go func() {
		cleanup()
		ticker := time.NewTicker(deletedProjectCleanupInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				cleanup()
			case <-ctx.Done():
				return
			}
		}
	}()
}

func main() {
	configPath := flag.String("config", "", "path to config.yaml (overrides BACKEND_CONFIG_PATH)")
	flag.Parse()

	// 1. 加载配置
	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		log.Fatal().Err(err).Msg("load config failed")
	}

	// 2. 初始化日志（zerolog；gin-contrib/logger 直接用全局 logger）
	setupLogger(cfg.Server.LogLevel, cfg.Server.Environment)

	// 3. 初始化数据库
	db, err := database.Open(cfg.Database)
	if err != nil {
		log.Fatal().Err(err).Msg("open database failed")
	}
	defer db.Close()

	migCtx, migCancel := context.WithTimeout(context.Background(), 30*time.Second)
	if err := db.Migrate(migCtx); err != nil {
		migCancel()
		log.Fatal().Err(err).Msg("run migrations failed")
	}
	migCancel()

	// 4. 初始化 OIDC providers（discovery 在这里发生）
	oidcCtx, oidcCancel := context.WithTimeout(context.Background(), 15*time.Second)
	registry, err := auth.NewProviderRegistry(oidcCtx, cfg.OIDC)
	oidcCancel()
	if err != nil {
		log.Fatal().Err(err).Msg("init oidc providers failed")
	}

	// 5. JWT manager / repo / service
	jwtMgr := appjwt.NewManager(cfg.JWT)
	userRepo := database.NewUserRepository(db)
	projectRepo := database.NewProjectRepository(db)
	cleanupCtx, cleanupCancel := context.WithCancel(context.Background())
	defer cleanupCancel()
	startDeletedProjectCleanup(cleanupCtx, projectRepo)
	authSvc := services.NewAuthService(registry, userRepo, jwtMgr, cfg.Admin)

	// 6. gin 引擎
	if cfg.Server.Environment == "production" {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(middleware.RecoveryMiddleware())
	r.Use(ginlogger.SetLogger())
	r.Use(buildCORS(cfg.Server.CORSOrigins))
	r.Use(securityHeaders(cfg.Server.Environment))
	r.Use(middleware.ErrorHandler())

	// 7. 路由
	authMW := middleware.AuthMiddleware(jwtMgr)
	handlers.NewHealthHandler(db).Register(r)
	handlers.NewAuthHandler(authSvc, cfg.Server).Register(r, authMW)

	// 受保护的示例 API：作为强制登录的占位
	api := r.Group("/api/v1", authMW)
	api.GET("/me", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"user_id":  c.GetString(middleware.ContextKeyUserID),
			"provider": c.GetString(middleware.ContextKeyProvider),
		})
	})
	handlers.NewProjectHandler(projectRepo).Register(api)
	handlers.NewProjectImageHandler(projectRepo).Register(api)
	handlers.NewProjectGenerationHandler(projectRepo, registry).Register(api)

	// 前端 SPA fallback：所有 API 路由之后挂载，仅接管未匹配路由。
	// 带 -tags embed 构建时服务嵌入的前端产物并注入运行时配置；否则为空 FS（本地开发交给 vite）。
	r.NoRoute(web.Handler)

	// 8. 启动 HTTP 服务（带优雅关停）
	srv := &http.Server{
		Addr:              cfg.Server.Address(),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info().
			Str("addr", srv.Addr).
			Str("env", cfg.Server.Environment).
			Msg("server starting")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server failed")
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Info().Msg("shutting down")
	cleanupCancel()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("graceful shutdown failed")
	}
}

// setupLogger 配置 zerolog 全局 logger，gin-contrib/logger 会复用
func setupLogger(level, env string) {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	lvl, err := zerolog.ParseLevel(level)
	if err != nil || lvl == zerolog.NoLevel {
		lvl = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(lvl)

	if env != "production" {
		log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stdout})
	}
}

// buildCORS 任务 6.4：CORS 中间件
func buildCORS(origins []string) gin.HandlerFunc {
	if len(origins) == 0 {
		// 未配置跨源白名单：不启用 CORS（同源调用本就不受限制）。
		// 单镜像形态前端与后端同源，无需 CORS；此处直接放行，避免 cors.New 因空白名单 panic。
		return func(c *gin.Context) { c.Next() }
	}
	return cors.New(cors.Config{
		AllowOrigins:     origins,
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization", "Accept"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	})
}

// securityHeaders 任务 6.5：通用安全响应头
// 注意：HTTPS 重定向交给 nginx 做，这里只补 HSTS、X-Frame-Options 等
func securityHeaders(env string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Referrer-Policy", "no-referrer")
		if env == "production" {
			c.Header("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		c.Next()
	}
}
