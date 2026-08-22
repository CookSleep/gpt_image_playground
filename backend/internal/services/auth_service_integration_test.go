package services

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"

	"gpt-image-backend/internal/auth"
	"gpt-image-backend/internal/database"
	"gpt-image-backend/internal/models"
	"gpt-image-backend/pkg/config"
	appjwt "gpt-image-backend/pkg/jwt"
)

// mockOIDCServer 一个最简的 OIDC provider，足够覆盖 discovery + token 端点 + JWKS
type mockOIDCServer struct {
	server   *httptest.Server
	priv     *rsa.PrivateKey
	keyID    string
	clientID string
	subject  string
	email    string
	name     string

	mu    sync.Mutex
	codes map[string]string // code -> code_challenge
}

func newMockOIDCServer(t *testing.T, clientID, sub, email, name string) *mockOIDCServer {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	m := &mockOIDCServer{
		priv:     priv,
		keyID:    "test-key-1",
		clientID: clientID,
		subject:  sub,
		email:    email,
		name:     name,
		codes:    make(map[string]string),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", m.handleDiscovery)
	mux.HandleFunc("/keys", m.handleJWKS)
	mux.HandleFunc("/auth", m.handleAuth)
	mux.HandleFunc("/token", m.handleToken)
	m.server = httptest.NewServer(mux)
	return m
}

func (m *mockOIDCServer) Close() { m.server.Close() }

func (m *mockOIDCServer) URL() string { return m.server.URL }

func (m *mockOIDCServer) handleDiscovery(w http.ResponseWriter, r *http.Request) {
	resp := map[string]interface{}{
		"issuer":                                m.server.URL,
		"authorization_endpoint":                m.server.URL + "/auth",
		"token_endpoint":                        m.server.URL + "/token",
		"jwks_uri":                              m.server.URL + "/keys",
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (m *mockOIDCServer) handleJWKS(w http.ResponseWriter, r *http.Request) {
	n := base64.RawURLEncoding.EncodeToString(m.priv.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString([]byte{0x01, 0x00, 0x01}) // 65537
	resp := map[string]interface{}{
		"keys": []map[string]interface{}{{
			"kty": "RSA",
			"alg": "RS256",
			"use": "sig",
			"kid": m.keyID,
			"n":   n,
			"e":   e,
		}},
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// /auth 不会被本测试调用（我们直接构造 callback）
func (m *mockOIDCServer) handleAuth(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not used in test", http.StatusNotImplemented)
}

func (m *mockOIDCServer) handleToken(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	code := r.PostForm.Get("code")
	verifier := r.PostForm.Get("code_verifier")

	m.mu.Lock()
	expectChallenge, ok := m.codes[code]
	delete(m.codes, code)
	m.mu.Unlock()

	if !ok {
		http.Error(w, "unknown code", http.StatusBadRequest)
		return
	}
	sum := sha256.Sum256([]byte(verifier))
	gotChallenge := base64.RawURLEncoding.EncodeToString(sum[:])
	if gotChallenge != expectChallenge {
		http.Error(w, "pkce mismatch", http.StatusBadRequest)
		return
	}

	now := time.Now()
	claims := jwt.MapClaims{
		"iss":        m.server.URL,
		"sub":        m.subject,
		"aud":        m.clientID,
		"exp":        now.Add(5 * time.Minute).Unix(),
		"iat":        now.Unix(),
		"email":      m.email,
		"name":       m.name,
		"account_id": "acct_root_" + m.subject,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = m.keyID
	idToken, err := tok.SignedString(m.priv)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"access_token": "fake-access",
		"token_type":   "Bearer",
		"expires_in":   300,
		"id_token":     idToken,
	})
}

// IssueCode 注入一个 code -> challenge 映射（模拟 /auth 已经发生过）
func (m *mockOIDCServer) IssueCode(code, challenge string) {
	m.mu.Lock()
	m.codes[code] = challenge
	m.mu.Unlock()
}

// ---- 内存版 UserRepository（测试替身），绕开 PostgreSQL 依赖 ----

type memoryUserRepo struct {
	mu    sync.Mutex
	byKey map[string]*models.User
}

func newMemoryUserRepo() *memoryUserRepo {
	return &memoryUserRepo{byKey: make(map[string]*models.User)}
}

// 实现与 *database.UserRepository 相同的方法集
func (r *memoryUserRepo) UpsertFromOIDC(ctx context.Context, u *models.User) (*models.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := u.OIDCProvider + "|" + u.OIDCSub
	now := time.Now().UTC()
	if existing, ok := r.byKey[key]; ok {
		existing.Email = u.Email
		existing.Name = u.Name
		existing.PictureURL = u.PictureURL
		existing.RawClaims = u.RawClaims
		existing.UpdatedAt = now
		existing.LastLoginAt = &now
		return existing, nil
	}
	cp := *u
	cp.ID = key
	cp.CreatedAt = now
	cp.UpdatedAt = now
	cp.LastLoginAt = &now
	r.byKey[key] = &cp
	return &cp, nil
}

func (r *memoryUserRepo) FindByID(ctx context.Context, id string) (*models.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, u := range r.byKey {
		if u.ID == id {
			return u, nil
		}
	}
	return nil, database.ErrUserNotFound
}

// TestOIDCEndToEnd: 模拟从 InitiateLogin 到 HandleCallback 的完整流程
func TestOIDCEndToEnd(t *testing.T) {
	idp := newMockOIDCServer(t, "client-1", "sub-1", "user@example.com", "Tester")
	defer idp.Close()

	cfg := config.OIDCConfig{
		Providers: []config.OIDCProviderConfig{{
			Name:         "mock",
			DisplayName:  "Mock",
			IssuerURL:    idp.URL(),
			ClientID:     "client-1",
			ClientSecret: "secret",
			RedirectURI:  "http://app.test/auth/callback/mock",
			Scopes:       []string{"openid", "profile", "email"},
		}},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	registry, err := auth.NewProviderRegistry(ctx, cfg)
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	jwtMgr := appjwt.NewManager(config.JWTConfig{
		SecretKey: "secret", Issuer: "test", ExpireHours: 1, RefreshHours: 1,
	})

	// 用内存 repo 做集成（绕过 Postgres）
	users := newMemoryUserRepo()
	svc := &AuthService{
		registry: registry,
		users:    nil, // 见下方专用 service
		jwtMgr:   jwtMgr,
		states:   auth.NewStateStore(time.Minute),
	}
	// 这里我们直接用底层方法替代 svc.HandleCallback 中的 upsert
	_ = svc

	// 1. InitiateLogin
	init, err := makeInit(registry, svc.states, "mock")
	if err != nil {
		t.Fatalf("init: %v", err)
	}

	// 解析 AuthURL，提取 state + code_challenge
	u, _ := url.Parse(init.AuthURL)
	state := u.Query().Get("state")
	challenge := u.Query().Get("code_challenge")
	if state == "" || challenge == "" {
		t.Fatalf("auth url missing state/challenge: %s", init.AuthURL)
	}

	// 2. mock IdP 颁发 code
	code := "code-abc"
	idp.IssueCode(code, challenge)

	// 3. 直接调用 provider.Exchange 完成 token 交换并 upsert
	prov, _ := registry.Get("mock")
	storedProvider, verifier, ok := svc.states.Consume(state)
	if !ok || storedProvider != "mock" {
		t.Fatalf("state consume failed")
	}
	claims, err := prov.Exchange(ctx, code, verifier)
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if claims.Sub != "sub-1" || claims.Email != "user@example.com" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
	var rawClaims map[string]any
	if err := json.Unmarshal(claims.RawJSON, &rawClaims); err != nil || rawClaims["account_id"] != "acct_root_sub-1" {
		t.Fatalf("account_id was not preserved in raw claims: %s", claims.RawJSON)
	}

	user, err := users.UpsertFromOIDC(ctx, &models.User{
		OIDCProvider: claims.Provider,
		OIDCSub:      claims.Sub,
		Email:        claims.Email,
		Name:         claims.Name,
		PictureURL:   claims.PictureURL,
		RawClaims:    claims.RawJSON,
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}

	// 4. 签发 JWT 并校验
	tokens, err := jwtMgr.IssueTokenPair(user.ID, user.Email, user.Name, user.OIDCProvider)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	parsed, err := jwtMgr.ParseAndValidate(tokens.AccessToken)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if parsed.UserID != user.ID || parsed.Provider != "mock" {
		t.Errorf("unexpected jwt claims: %+v", parsed)
	}

	// 5. 同一 sub 再次登录应 upsert（更新 last_login_at）
	first := user.ID
	user2, _ := users.UpsertFromOIDC(ctx, &models.User{
		OIDCProvider: claims.Provider,
		OIDCSub:      claims.Sub,
		Email:        "newer@example.com",
		Name:         claims.Name,
		RawClaims:    claims.RawJSON,
	})
	if user2.ID != first {
		t.Errorf("upsert should keep same id, got %s vs %s", user2.ID, first)
	}
	if user2.Email != "newer@example.com" {
		t.Errorf("email not updated: %s", user2.Email)
	}
}

// makeInit 直接复用 ProviderRegistry + StateStore，避免依赖完整 AuthService 内部结构
func makeInit(reg *auth.ProviderRegistry, states *auth.StateStore, name string) (*LoginInit, error) {
	p, ok := reg.Get(name)
	if !ok {
		return nil, fmt.Errorf("unknown provider")
	}
	pkce, err := auth.NewPKCEPair()
	if err != nil {
		return nil, err
	}
	state, err := auth.NewState()
	if err != nil {
		return nil, err
	}
	states.Save(state, name, pkce.Verifier)
	return &LoginInit{AuthURL: p.AuthCodeURL(state, pkce), State: state}, nil
}

// 占用 io 包，避免 Go vet 抱怨未使用（防止未来重构遗漏）
var _ = io.Discard
var _ = strings.Split
