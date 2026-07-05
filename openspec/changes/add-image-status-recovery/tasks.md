## 1. Request Tracking

- [x] 1.1 Add task fields and API callback types for persisted image status request IDs
- [x] 1.2 Generate high-entropy request IDs for supported Images API and Responses API image requests
- [x] 1.3 Send `x-client-request-id` headers and persist IDs through the store callback

## 2. Status Querying

- [x] 2.1 Add image status query helpers for `/v1/images/status/`
- [x] 2.2 Enforce the 100-ID query limit by chunking status requests
- [x] 2.3 Parse success, failure, pending, and missing status records

## 3. Task Recovery

- [x] 3.1 Preserve tracked non-fal running tasks during startup instead of marking them interrupted
- [x] 3.2 Poll tracked tasks every 5 seconds until terminal state or timeout
- [x] 3.3 Recover succeeded images from `cos_urls` or `urls` and update task output state
- [x] 3.4 Record partial failures and fail fully failed or timed-out tasks

## 4. Verification

- [x] 4.1 Add focused unit tests for request header tracking and status query chunking
- [x] 4.2 Add focused store tests for startup recovery and failure handling
- [x] 4.3 Run build and relevant tests
