## Context

The app stores image tasks in IndexedDB and restores them during `initStore`. fal.ai tasks already have queue recovery, and custom async providers already have task ID polling. Non-fal OpenAI-compatible image requests without a custom async task are currently marked as interrupted on restart.

The image status API supports tracking `/v1/images/generations`, `/v1/images/edits`, and `/v1/responses` image-generation requests when the client sends `x-client-request-id`. The query endpoint accepts up to 100 IDs per request and returns status records plus `not_found` IDs.

## Goals / Non-Goals

**Goals:**
- Track supported non-fal image requests with high-entropy client request IDs.
- Recover tracked tasks after refresh, request interruption, or browser restart.
- Support both single-request and locally split multi-request tasks.
- Query image status in batches of at most 100 IDs and poll every 5 seconds until terminal state or timeout.

**Non-Goals:**
- Replacing fal.ai queue recovery or custom provider polling.
- Adding status tracking for arbitrary custom provider endpoints.
- Changing task UI beyond existing running, done, and error states.

## Decisions

1. Store request IDs as an array on `TaskRecord`.

   A single local task can map to one real HTTP request, one request with multiple outputs, or many locally split requests. An array keeps the model simple and handles all cases without a second table.

2. Generate IDs at the real request boundary.

   Each actual `POST` to `/images/generations`, `/images/edits`, or `/responses` gets one unique ID. The API helper reports IDs back through a callback so the store can persist them immediately.

3. Recover via one shared status polling path.

   `initStore` will not mark tracked non-fal tasks as interrupted. Instead it schedules status recovery. The recovery path collects request IDs, queries `/images/status/` in chunks of 100, and reschedules after 5 seconds when records remain pending.

4. Treat task timeout as the final bound for missing or pending records.

   Missing records can happen before the backend creates a status row or after expiration. The app will keep polling until the task timeout is exceeded, then mark the task failed with a clear recovery timeout or missing-status message.

5. Prefer `cos_urls` over `urls` for recovered output images.

   The status API exposes both upstream and COS URLs. COS URLs are the final managed output when available, so recovery downloads those first and falls back to upstream URLs.

## Risks / Trade-offs

- Status records are not scoped by API key → use high-entropy IDs and never reuse them.
- A split multi-request task can partially succeed → preserve existing `outputErrors` behavior and complete the task when at least one image recovers.
- URL download can fail due to CORS or expiry → reuse existing URL-to-data-URL error handling and surface the task error.
- Large task sets can exceed query limits → chunk all status queries at 100 IDs.
