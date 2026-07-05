## Why

Image generation can continue on the server after the browser request is interrupted or the page refreshes. The app currently marks most non-fal running image tasks as interrupted on restart, even when the backend exposes a durable short-lived status record keyed by `x-client-request-id`.

## What Changes

- Generate a high-entropy `x-client-request-id` for tracked non-fal image requests.
- Send the request ID on supported image producers: `/v1/images/generations`, `/v1/images/edits`, and `/v1/responses` requests that use image generation.
- Persist request IDs with the local task record so refresh recovery can query task status.
- Query `/v1/images/status/` in batches of at most 100 IDs and poll every 5 seconds while statuses remain pending.
- Recover completed images from `cos_urls` or `urls`, and update local task status to done, partial error, failed, or timed out.

## Capabilities

### New Capabilities
- `image-status-recovery`: Tracks image requests with client request IDs and recovers non-fal image tasks after refresh or request interruption.

### Modified Capabilities

## Impact

- Affected code: image API request helpers, task record type, task persistence/recovery in `src/store.ts`, and focused tests.
- Affected API: uses `x-client-request-id` request headers and `GET /v1/images/status/`.
- No new runtime dependencies.
