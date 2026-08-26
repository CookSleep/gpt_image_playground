package services

import (
	"context"
	"testing"

	"trpc.group/trpc-go/trpc-go/client"

	"gpt-image-backend/internal/models"
	"gpt-image-backend/internal/rpc/innerpb"
)

type balanceUserStoreStub struct {
	user *models.User
}

func (s balanceUserStoreStub) FindByID(_ context.Context, _ string) (*models.User, error) {
	return s.user, nil
}

type innerBalanceClientStub struct {
	request  *innerpb.GetBalanceRequest
	metadata map[string][]byte
}

func (s *innerBalanceClientStub) GetBalance(_ context.Context, req *innerpb.GetBalanceRequest, opts ...client.Option) (*innerpb.GetBalanceResponse, error) {
	s.request = req
	options := &client.Options{}
	for _, option := range opts {
		option(options)
	}
	s.metadata = options.MetaData
	return &innerpb.GetBalanceResponse{
		Balance: "12.50", PayerAccountId: "acct_payer", BalanceSource: "organization",
		OrganizationId: 42, AuthzGeneration: 7,
	}, nil
}

func TestBalanceServiceGetsInnerAPIBalanceForAccount(t *testing.T) {
	innerClient := &innerBalanceClientStub{}
	service := &BalanceService{
		users:  balanceUserStoreStub{user: &models.User{RawClaims: []byte(`{"account_id":"acct_root_abc123"}`)}},
		client: innerClient, appToken: "inner-token",
	}

	result, err := service.Get(context.Background(), "user-a")
	if err != nil {
		t.Fatal(err)
	}
	if innerClient.request.GetAccountId() != "acct_root_abc123" || string(innerClient.metadata["app-token"]) != "inner-token" {
		t.Fatalf("unexpected request: %#v metadata=%v", innerClient.request, innerClient.metadata)
	}
	if !result.Available || result.Balance != "12.50" || result.PayerAccountID != "acct_payer" || result.OrganizationID != 42 {
		t.Fatalf("unexpected balance: %#v", result)
	}
}

func TestBalanceServiceAllowsUnavailableBalance(t *testing.T) {
	service := &BalanceService{users: balanceUserStoreStub{user: &models.User{}}}
	if _, err := service.Get(context.Background(), "user-a"); err != ErrBalanceNotConfigured {
		t.Fatalf("unexpected unconfigured error: %v", err)
	}

	service.client = &innerBalanceClientStub{}
	service.appToken = "inner-token"
	if _, err := service.Get(context.Background(), "user-a"); err != ErrBalanceAccountIDMissing {
		t.Fatalf("unexpected account error: %v", err)
	}
}
