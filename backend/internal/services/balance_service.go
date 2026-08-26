package services

import (
	"context"
	"errors"
	"strings"
	"time"

	"trpc.group/trpc-go/trpc-go/client"

	"gpt-image-backend/internal/models"
	"gpt-image-backend/internal/rpc/innerpb"
	"gpt-image-backend/pkg/config"
)

var ErrBalanceNotConfigured = errors.New("inner API balance is not configured")
var ErrBalanceAccountIDMissing = errors.New("current user has no balance account id")

type balanceUserStore interface {
	FindByID(ctx context.Context, id string) (*models.User, error)
}

type innerBalanceClient interface {
	GetBalance(ctx context.Context, req *innerpb.GetBalanceRequest, opts ...client.Option) (*innerpb.GetBalanceResponse, error)
}

type Balance struct {
	Available       bool   `json:"available"`
	Balance         string `json:"balance"`
	PayerAccountID  string `json:"payer_account_id,omitempty"`
	BalanceSource   string `json:"balance_source,omitempty"`
	OrganizationID  int64  `json:"organization_id,omitempty"`
	AuthzGeneration int64  `json:"authz_generation,omitempty"`
}

type BalanceService struct {
	users    balanceUserStore
	client   innerBalanceClient
	appToken string
}

func NewBalanceService(users balanceUserStore, cfg config.InnerAPIConfig) *BalanceService {
	service := &BalanceService{users: users}
	if !cfg.Enabled() {
		return service
	}
	service.client = innerpb.NewInnerAPIClientProxy(
		client.WithTarget(strings.TrimSpace(cfg.Target)),
		client.WithNetwork("tcp"),
		client.WithProtocol("trpc"),
		client.WithTimeout(time.Duration(cfg.TimeoutSeconds)*time.Second),
	)
	service.appToken = strings.TrimSpace(cfg.AppToken)
	return service
}

func (s *BalanceService) Get(ctx context.Context, userID string) (*Balance, error) {
	if s.client == nil || s.appToken == "" {
		return nil, ErrBalanceNotConfigured
	}
	user, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	accountID := models.ExtractAccountID(user.RawClaims)
	if accountID == "" {
		return nil, ErrBalanceAccountIDMissing
	}
	response, err := s.client.GetBalance(ctx, &innerpb.GetBalanceRequest{AccountId: accountID}, client.WithMetaData("app-token", []byte(s.appToken)))
	if err != nil {
		return nil, err
	}
	return &Balance{
		Available:       true,
		Balance:         response.GetBalance(),
		PayerAccountID:  response.GetPayerAccountId(),
		BalanceSource:   response.GetBalanceSource(),
		OrganizationID:  response.GetOrganizationId(),
		AuthzGeneration: response.GetAuthzGeneration(),
	}, nil
}
