// Code generated from inner_api.proto client contract. DO NOT EDIT.

package innerpb

import (
	"context"

	_ "trpc.group/trpc-go/trpc-go"
	"trpc.group/trpc-go/trpc-go/client"
	"trpc.group/trpc-go/trpc-go/codec"
)

const InnerAPIServiceName = "sub2api.inner.v1.InnerAPI"

type InnerAPIClientProxy interface {
	ListMaterials(ctx context.Context, req *ListMaterialsRequest, opts ...client.Option) (*ListMaterialsResponse, error)
	GetMaterial(ctx context.Context, req *GetMaterialRequest, opts ...client.Option) (*Material, error)
	UploadMaterial(ctx context.Context, req *UploadMaterialRequest, opts ...client.Option) (*UploadMaterialResponse, error)
	AddMaterialByUrl(ctx context.Context, req *AddMaterialByUrlRequest, opts ...client.Option) (*AddMaterialByUrlResponse, error)
	DeleteMaterial(ctx context.Context, req *DeleteMaterialRequest, opts ...client.Option) (*DeleteMaterialResponse, error)
	BatchDeleteMaterials(ctx context.Context, req *BatchDeleteMaterialsRequest, opts ...client.Option) (*BatchDeleteMaterialsResponse, error)
}

type innerAPIClientProxy struct {
	client client.Client
	opts   []client.Option
}

func NewInnerAPIClientProxy(opts ...client.Option) InnerAPIClientProxy {
	return &innerAPIClientProxy{client: client.DefaultClient, opts: opts}
}

func (c *innerAPIClientProxy) ListMaterials(ctx context.Context, req *ListMaterialsRequest, opts ...client.Option) (*ListMaterialsResponse, error) {
	ctx, msg := codec.WithCloneMessage(ctx)
	msg.WithClientRPCName("/sub2api.inner.v1.InnerAPI/ListMaterials")
	msg.WithCalleeServiceName(InnerAPIServiceName)
	msg.WithCalleeApp("sub2api")
	msg.WithCalleeServer("inner")
	msg.WithCalleeService("InnerAPI")
	msg.WithCalleeMethod("ListMaterials")
	msg.WithSerializationType(codec.SerializationTypePB)
	callOptions := append(append([]client.Option{}, c.opts...), opts...)
	response := &ListMaterialsResponse{}
	if err := c.client.Invoke(ctx, req, response, callOptions...); err != nil {
		return nil, err
	}
	codec.PutBackMessage(msg)
	return response, nil
}

func (c *innerAPIClientProxy) GetMaterial(ctx context.Context, req *GetMaterialRequest, opts ...client.Option) (*Material, error) {
	ctx, msg := codec.WithCloneMessage(ctx)
	msg.WithClientRPCName("/sub2api.inner.v1.InnerAPI/GetMaterial")
	msg.WithCalleeServiceName(InnerAPIServiceName)
	msg.WithCalleeApp("sub2api")
	msg.WithCalleeServer("inner")
	msg.WithCalleeService("InnerAPI")
	msg.WithCalleeMethod("GetMaterial")
	msg.WithSerializationType(codec.SerializationTypePB)
	callOptions := append(append([]client.Option{}, c.opts...), opts...)
	response := &Material{}
	if err := c.client.Invoke(ctx, req, response, callOptions...); err != nil {
		return nil, err
	}
	codec.PutBackMessage(msg)
	return response, nil
}

func (c *innerAPIClientProxy) UploadMaterial(ctx context.Context, req *UploadMaterialRequest, opts ...client.Option) (*UploadMaterialResponse, error) {
	ctx, msg := codec.WithCloneMessage(ctx)
	msg.WithClientRPCName("/sub2api.inner.v1.InnerAPI/UploadMaterial")
	msg.WithCalleeServiceName(InnerAPIServiceName)
	msg.WithCalleeApp("sub2api")
	msg.WithCalleeServer("inner")
	msg.WithCalleeService("InnerAPI")
	msg.WithCalleeMethod("UploadMaterial")
	msg.WithSerializationType(codec.SerializationTypePB)

	callOptions := make([]client.Option, 0, len(c.opts)+len(opts))
	callOptions = append(callOptions, c.opts...)
	callOptions = append(callOptions, opts...)
	response := &UploadMaterialResponse{}
	if err := c.client.Invoke(ctx, req, response, callOptions...); err != nil {
		return nil, err
	}
	codec.PutBackMessage(msg)
	return response, nil
}

func (c *innerAPIClientProxy) DeleteMaterial(ctx context.Context, req *DeleteMaterialRequest, opts ...client.Option) (*DeleteMaterialResponse, error) {
	ctx, msg := codec.WithCloneMessage(ctx)
	msg.WithClientRPCName("/sub2api.inner.v1.InnerAPI/DeleteMaterial")
	msg.WithCalleeServiceName(InnerAPIServiceName)
	msg.WithCalleeApp("sub2api")
	msg.WithCalleeServer("inner")
	msg.WithCalleeService("InnerAPI")
	msg.WithCalleeMethod("DeleteMaterial")
	msg.WithSerializationType(codec.SerializationTypePB)
	callOptions := append(append([]client.Option{}, c.opts...), opts...)
	response := &DeleteMaterialResponse{}
	if err := c.client.Invoke(ctx, req, response, callOptions...); err != nil {
		return nil, err
	}
	codec.PutBackMessage(msg)
	return response, nil
}

func (c *innerAPIClientProxy) AddMaterialByUrl(ctx context.Context, req *AddMaterialByUrlRequest, opts ...client.Option) (*AddMaterialByUrlResponse, error) {
	ctx, msg := codec.WithCloneMessage(ctx)
	msg.WithClientRPCName("/sub2api.inner.v1.InnerAPI/AddMaterialByUrl")
	msg.WithCalleeServiceName(InnerAPIServiceName)
	msg.WithCalleeApp("sub2api")
	msg.WithCalleeServer("inner")
	msg.WithCalleeService("InnerAPI")
	msg.WithCalleeMethod("AddMaterialByUrl")
	msg.WithSerializationType(codec.SerializationTypePB)
	callOptions := append(append([]client.Option{}, c.opts...), opts...)
	response := &AddMaterialByUrlResponse{}
	if err := c.client.Invoke(ctx, req, response, callOptions...); err != nil {
		return nil, err
	}
	codec.PutBackMessage(msg)
	return response, nil
}

func (c *innerAPIClientProxy) BatchDeleteMaterials(ctx context.Context, req *BatchDeleteMaterialsRequest, opts ...client.Option) (*BatchDeleteMaterialsResponse, error) {
	ctx, msg := codec.WithCloneMessage(ctx)
	msg.WithClientRPCName("/sub2api.inner.v1.InnerAPI/BatchDeleteMaterials")
	msg.WithCalleeServiceName(InnerAPIServiceName)
	msg.WithCalleeApp("sub2api")
	msg.WithCalleeServer("inner")
	msg.WithCalleeService("InnerAPI")
	msg.WithCalleeMethod("BatchDeleteMaterials")
	msg.WithSerializationType(codec.SerializationTypePB)
	callOptions := append(append([]client.Option{}, c.opts...), opts...)
	response := &BatchDeleteMaterialsResponse{}
	if err := c.client.Invoke(ctx, req, response, callOptions...); err != nil {
		return nil, err
	}
	codec.PutBackMessage(msg)
	return response, nil
}
