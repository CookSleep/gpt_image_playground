package services

import (
	"context"
	"errors"
	"strings"
	"time"

	trpc "trpc.group/trpc-go/trpc-go"
	"trpc.group/trpc-go/trpc-go/client"

	"gpt-image-backend/internal/models"
	"gpt-image-backend/internal/rpc/innerpb"
	"gpt-image-backend/pkg/config"
)

var ErrMaterialUploadNotConfigured = errors.New("inner API material upload is not configured")
var ErrMaterialAccountIDMissing = errors.New("current user has no material account id")

const innerAPIMaxFrameSize = 64 << 20

type materialUserStore interface {
	FindByID(ctx context.Context, id string) (*models.User, error)
}

type innerMaterialClient interface {
	ListMaterials(ctx context.Context, req *innerpb.ListMaterialsRequest, opts ...client.Option) (*innerpb.ListMaterialsResponse, error)
	GetMaterial(ctx context.Context, req *innerpb.GetMaterialRequest, opts ...client.Option) (*innerpb.Material, error)
	UploadMaterial(ctx context.Context, req *innerpb.UploadMaterialRequest, opts ...client.Option) (*innerpb.UploadMaterialResponse, error)
	DeleteMaterial(ctx context.Context, req *innerpb.DeleteMaterialRequest, opts ...client.Option) (*innerpb.DeleteMaterialResponse, error)
	BatchDeleteMaterials(ctx context.Context, req *innerpb.BatchDeleteMaterialsRequest, opts ...client.Option) (*innerpb.BatchDeleteMaterialsResponse, error)
}

type MaterialUpload struct {
	ID          string
	URL         string
	FileName    string
	ContentType string
	SizeBytes   int64
}

type MaterialItem struct {
	ID          string `json:"id"`
	AccountID   string `json:"account_id"`
	FileName    string `json:"file_name"`
	URL         string `json:"url"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	Kind        string `json:"kind"`
	Source      string `json:"source"`
	CreatedAt   string `json:"created_at"`
}

type MaterialList struct {
	Items    []*MaterialItem `json:"items"`
	Total    int64           `json:"total"`
	Page     int32           `json:"page"`
	PageSize int32           `json:"page_size"`
}

type MaterialBatchDelete struct {
	DeletedIDs   []string `json:"deleted_ids"`
	DeletedCount int32    `json:"deleted_count"`
}

type MaterialService struct {
	users    materialUserStore
	client   innerMaterialClient
	appToken string
}

func NewMaterialService(users materialUserStore, cfg config.InnerAPIConfig) *MaterialService {
	service := &MaterialService{users: users}
	if !cfg.Enabled() {
		return service
	}
	if trpc.DefaultMaxFrameSize < innerAPIMaxFrameSize {
		trpc.DefaultMaxFrameSize = innerAPIMaxFrameSize
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

func materialAccountID(user *models.User) string {
	return models.ExtractAccountID(user.RawClaims)
}

func (s *MaterialService) accountID(ctx context.Context, userID string) (string, error) {
	if s.client == nil || s.appToken == "" {
		return "", ErrMaterialUploadNotConfigured
	}
	user, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return "", err
	}
	accountID := materialAccountID(user)
	if accountID == "" {
		return "", ErrMaterialAccountIDMissing
	}
	return accountID, nil
}

func materialItem(value *innerpb.Material) *MaterialItem {
	if value == nil {
		return nil
	}
	return &MaterialItem{
		ID: value.GetId(), AccountID: value.GetAccountId(), FileName: value.GetFileName(), URL: value.GetUrl(),
		ContentType: value.GetContentType(), SizeBytes: value.GetSizeBytes(), Kind: value.GetKind(),
		Source: value.GetSource(), CreatedAt: value.GetCreatedAt(),
	}
}

func (s *MaterialService) List(ctx context.Context, userID, kind, keyword string, page, pageSize int32) (*MaterialList, error) {
	accountID, err := s.accountID(ctx, userID)
	if err != nil {
		return nil, err
	}
	response, err := s.client.ListMaterials(ctx, &innerpb.ListMaterialsRequest{
		AccountId: accountID, Kind: kind, Keyword: keyword, Page: page, PageSize: pageSize,
	}, client.WithMetaData("app-token", []byte(s.appToken)))
	if err != nil {
		return nil, err
	}
	items := make([]*MaterialItem, 0, len(response.GetItems()))
	for _, item := range response.GetItems() {
		items = append(items, materialItem(item))
	}
	return &MaterialList{Items: items, Total: response.GetTotal(), Page: response.GetPage(), PageSize: response.GetPageSize()}, nil
}

func (s *MaterialService) Get(ctx context.Context, userID, id string) (*MaterialItem, error) {
	accountID, err := s.accountID(ctx, userID)
	if err != nil {
		return nil, err
	}
	response, err := s.client.GetMaterial(ctx, &innerpb.GetMaterialRequest{AccountId: accountID, Id: id}, client.WithMetaData("app-token", []byte(s.appToken)))
	if err != nil {
		return nil, err
	}
	return materialItem(response), nil
}

func (s *MaterialService) Delete(ctx context.Context, userID, id string) error {
	accountID, err := s.accountID(ctx, userID)
	if err != nil {
		return err
	}
	_, err = s.client.DeleteMaterial(ctx, &innerpb.DeleteMaterialRequest{AccountId: accountID, Id: id}, client.WithMetaData("app-token", []byte(s.appToken)))
	return err
}

func (s *MaterialService) BatchDelete(ctx context.Context, userID string, ids []string) (*MaterialBatchDelete, error) {
	accountID, err := s.accountID(ctx, userID)
	if err != nil {
		return nil, err
	}
	response, err := s.client.BatchDeleteMaterials(ctx, &innerpb.BatchDeleteMaterialsRequest{
		AccountId: accountID,
		Ids:       ids,
	}, client.WithMetaData("app-token", []byte(s.appToken)))
	if err != nil {
		return nil, err
	}
	return &MaterialBatchDelete{
		DeletedIDs:   append([]string{}, response.GetDeletedIds()...),
		DeletedCount: response.GetDeletedCount(),
	}, nil
}

func (s *MaterialService) Upload(ctx context.Context, userID, fileName, contentType string, data []byte) (*MaterialUpload, error) {
	accountID, err := s.accountID(ctx, userID)
	if err != nil {
		return nil, err
	}
	response, err := s.client.UploadMaterial(ctx, &innerpb.UploadMaterialRequest{
		AccountId:   accountID,
		FileName:    fileName,
		ContentType: contentType,
		Data:        data,
	}, client.WithMetaData("app-token", []byte(s.appToken)))
	if err != nil {
		return nil, err
	}
	url := strings.TrimSpace(response.GetFileUrl())
	if url == "" && response.GetMaterial() != nil {
		url = strings.TrimSpace(response.GetMaterial().GetUrl())
	}
	if url == "" {
		return nil, errors.New("inner API material upload returned no file_url")
	}
	material := response.GetMaterial()
	result := &MaterialUpload{URL: url, FileName: fileName, ContentType: contentType, SizeBytes: int64(len(data))}
	if material != nil {
		result.ID = material.GetId()
		result.FileName = material.GetFileName()
		result.ContentType = material.GetContentType()
		result.SizeBytes = material.GetSizeBytes()
	}
	return result, nil
}
