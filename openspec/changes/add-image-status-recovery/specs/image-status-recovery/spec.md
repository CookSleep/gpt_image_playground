## ADDED Requirements

### Requirement: Track supported image requests
The system SHALL generate a globally unique `x-client-request-id` for each supported non-fal image request and persist the ID with the local task before or when the request is sent.

#### Scenario: Tracking Images API generation
- **WHEN** a non-fal task sends `POST /v1/images/generations`
- **THEN** the request MUST include `x-client-request-id`
- **AND** the local task MUST persist that request ID

#### Scenario: Tracking Images API edit
- **WHEN** a non-fal task sends `POST /v1/images/edits`
- **THEN** the request MUST include `x-client-request-id`
- **AND** the local task MUST persist that request ID

#### Scenario: Tracking Responses image generation
- **WHEN** a non-fal task sends `POST /v1/responses` with an `image_generation` tool request
- **THEN** the request MUST include `x-client-request-id`
- **AND** the local task MUST persist that request ID

### Requirement: Recover tracked tasks after restart
The system SHALL query tracked non-fal image tasks during startup instead of immediately marking them interrupted.

#### Scenario: Startup schedules tracked task recovery
- **WHEN** the app loads a running non-fal task with persisted image status request IDs
- **THEN** the task MUST remain recoverable
- **AND** the app MUST query `/v1/images/status/` for the persisted IDs

#### Scenario: Startup still interrupts untracked tasks
- **WHEN** the app loads a running non-fal task without image status request IDs and without a custom async task ID
- **THEN** the task MUST be marked interrupted using the existing interrupted-task behavior

### Requirement: Query image status in bounded batches
The system SHALL query image status with at most 100 request IDs per HTTP request.

#### Scenario: More than one hundred IDs
- **WHEN** a recovery poll needs to query more than 100 request IDs
- **THEN** the app MUST split the query into multiple `/v1/images/status/` requests
- **AND** each request MUST include no more than 100 IDs

#### Scenario: Pending records remain
- **WHEN** any tracked request ID is `accepted`, `running`, `upstream_done`, `cos_uploading`, or missing before timeout
- **THEN** the app MUST poll again after 5 seconds

### Requirement: Complete or fail recovered tasks from status records
The system SHALL update local task state from terminal image status records.

#### Scenario: Successful status recovery
- **WHEN** every tracked request ID needed for a task has status `succeeded`
- **THEN** the app MUST download recovered images from `cos_urls` when present or `urls` otherwise
- **AND** the task MUST be marked `done` with recovered output images

#### Scenario: Partial recovery
- **WHEN** at least one tracked request ID succeeds and at least one tracked request ID fails or times out
- **THEN** the task MUST be marked `done`
- **AND** failed request slots MUST be recorded in `outputErrors`

#### Scenario: Failed recovery
- **WHEN** all tracked request IDs fail or time out
- **THEN** the task MUST be marked `error`
- **AND** the task error MUST describe the image status failure
