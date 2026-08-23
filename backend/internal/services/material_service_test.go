package services

import (
	"context"
	"testing"

	"trpc.group/trpc-go/trpc-go/client"

	"gpt-image-backend/internal/models"
	"gpt-image-backend/internal/rpc/innerpb"
)

type materialUserStoreStub struct {
	user *models.User
}

func (s materialUserStoreStub) FindByID(_ context.Context, _ string) (*models.User, error) {
	return s.user, nil
}

type innerMaterialClientStub struct {
	request            *innerpb.UploadMaterialRequest
	renameRequest      *innerpb.RenameMaterialRequest
	deleteRequest      *innerpb.DeleteMaterialRequest
	batchDeleteRequest *innerpb.BatchDeleteMaterialsRequest
	metadata           map[string][]byte
}

func (s *innerMaterialClientStub) ListMaterials(_ context.Context, _ *innerpb.ListMaterialsRequest, _ ...client.Option) (*innerpb.ListMaterialsResponse, error) {
	return &innerpb.ListMaterialsResponse{}, nil
}

func (s *innerMaterialClientStub) GetMaterial(_ context.Context, _ *innerpb.GetMaterialRequest, _ ...client.Option) (*innerpb.Material, error) {
	return &innerpb.Material{}, nil
}

func (s *innerMaterialClientStub) UploadMaterial(_ context.Context, req *innerpb.UploadMaterialRequest, opts ...client.Option) (*innerpb.UploadMaterialResponse, error) {
	s.request = req
	options := &client.Options{}
	for _, option := range opts {
		option(options)
	}
	s.metadata = options.MetaData
	return &innerpb.UploadMaterialResponse{
		FileUrl:  "https://materials.example/reference.png",
		Material: &innerpb.Material{Id: "mat_public_42", FileName: "reference.png", ContentType: "image/png", SizeBytes: 3},
	}, nil
}

func (s *innerMaterialClientStub) RenameMaterial(_ context.Context, req *innerpb.RenameMaterialRequest, opts ...client.Option) (*innerpb.Material, error) {
	s.renameRequest = req
	options := &client.Options{}
	for _, option := range opts {
		option(options)
	}
	s.metadata = options.MetaData
	return &innerpb.Material{Id: req.GetId(), AccountId: req.GetAccountId(), FileName: req.GetFileName()}, nil
}

func (s *innerMaterialClientStub) DeleteMaterial(_ context.Context, req *innerpb.DeleteMaterialRequest, _ ...client.Option) (*innerpb.DeleteMaterialResponse, error) {
	s.deleteRequest = req
	return &innerpb.DeleteMaterialResponse{Id: req.GetId(), Deleted: true}, nil
}

func (s *innerMaterialClientStub) BatchDeleteMaterials(_ context.Context, req *innerpb.BatchDeleteMaterialsRequest, opts ...client.Option) (*innerpb.BatchDeleteMaterialsResponse, error) {
	s.batchDeleteRequest = req
	options := &client.Options{}
	for _, option := range opts {
		option(options)
	}
	s.metadata = options.MetaData
	return &innerpb.BatchDeleteMaterialsResponse{DeletedIds: req.GetIds(), DeletedCount: int32(len(req.GetIds()))}, nil
}

func TestMaterialServiceUploadsForOIDCAccount(t *testing.T) {
	innerClient := &innerMaterialClientStub{}
	service := &MaterialService{
		users: materialUserStoreStub{user: &models.User{
			OIDCSub:   "fallback-account",
			RawClaims: []byte(`{"account_id":"acct_root_abc123"}`),
		}},
		client: innerClient, appToken: "inner-token",
	}
	result, err := service.Upload(context.Background(), "user-a", "reference.png", "image/png", []byte{1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	if innerClient.request.GetAccountId() != "acct_root_abc123" || innerClient.request.GetFileName() != "reference.png" {
		t.Fatalf("unexpected upload request: %#v", innerClient.request)
	}
	if len(innerClient.request.GetData()) != 3 || string(innerClient.metadata["app-token"]) != "inner-token" {
		t.Fatalf("unexpected upload data/metadata: data=%v metadata=%v", innerClient.request.GetData(), innerClient.metadata)
	}
	if result.ID != "mat_public_42" || result.URL != "https://materials.example/reference.png" {
		t.Fatalf("unexpected upload result: %#v", result)
	}
}

func TestMaterialServiceRequiresConfiguration(t *testing.T) {
	service := &MaterialService{users: materialUserStoreStub{user: &models.User{OIDCSub: "account-a"}}}
	if _, err := service.Upload(context.Background(), "user-a", "reference.png", "image/png", []byte{1}); err != ErrMaterialUploadNotConfigured {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMaterialServiceDoesNotUseOIDCSubjectAsAccountID(t *testing.T) {
	service := &MaterialService{
		users:  materialUserStoreStub{user: &models.User{OIDCSub: "oidc-sub-only"}},
		client: &innerMaterialClientStub{}, appToken: "inner-token",
	}
	if _, err := service.Upload(context.Background(), "user-a", "reference.png", "image/png", []byte{1}); err != ErrMaterialAccountIDMissing {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMaterialServiceDeletesByOpaquePublicID(t *testing.T) {
	innerClient := &innerMaterialClientStub{}
	service := &MaterialService{
		users: materialUserStoreStub{user: &models.User{
			RawClaims: []byte(`{"account_id":"acct_root_abc123"}`),
		}},
		client: innerClient, appToken: "inner-token",
	}
	if err := service.Delete(context.Background(), "user-a", "mat_public_A1b2"); err != nil {
		t.Fatal(err)
	}
	if innerClient.deleteRequest.GetAccountId() != "acct_root_abc123" || innerClient.deleteRequest.GetId() != "mat_public_A1b2" {
		t.Fatalf("unexpected delete request: %#v", innerClient.deleteRequest)
	}
}

func TestMaterialServiceRenamesForOIDCAccount(t *testing.T) {
	innerClient := &innerMaterialClientStub{}
	service := &MaterialService{
		users: materialUserStoreStub{user: &models.User{
			RawClaims: []byte(`{"account_id":"acct_root_abc123"}`),
		}},
		client: innerClient, appToken: "inner-token",
	}
	result, err := service.Rename(context.Background(), "user-a", "mat_public_A1b2", "新名称.png")
	if err != nil {
		t.Fatal(err)
	}
	if innerClient.renameRequest.GetAccountId() != "acct_root_abc123" || innerClient.renameRequest.GetId() != "mat_public_A1b2" || innerClient.renameRequest.GetFileName() != "新名称.png" {
		t.Fatalf("unexpected rename request: %#v", innerClient.renameRequest)
	}
	if result.FileName != "新名称.png" || string(innerClient.metadata["app-token"]) != "inner-token" {
		t.Fatalf("unexpected rename result: %#v metadata=%v", result, innerClient.metadata)
	}
}

func TestMaterialServiceBatchDeletesForOIDCAccount(t *testing.T) {
	innerClient := &innerMaterialClientStub{}
	service := &MaterialService{
		users: materialUserStoreStub{user: &models.User{
			RawClaims: []byte(`{"account_id":"acct_root_abc123"}`),
		}},
		client: innerClient, appToken: "inner-token",
	}
	result, err := service.BatchDelete(context.Background(), "user-a", []string{"mat_public_A", "mat_public_B"})
	if err != nil {
		t.Fatal(err)
	}
	if innerClient.batchDeleteRequest.GetAccountId() != "acct_root_abc123" || len(innerClient.batchDeleteRequest.GetIds()) != 2 {
		t.Fatalf("unexpected batch delete request: %#v", innerClient.batchDeleteRequest)
	}
	if result.DeletedCount != 2 || len(result.DeletedIDs) != 2 || string(innerClient.metadata["app-token"]) != "inner-token" {
		t.Fatalf("unexpected batch delete result: %#v metadata=%v", result, innerClient.metadata)
	}
}
