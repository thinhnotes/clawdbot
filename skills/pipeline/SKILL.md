---
name: pipeline
description: Manage CI/CD pipelines with multi-stage builds and approval gates. Trigger pipelines, monitor status, approve/reject stages, fetch logs, and get notifications via Discord, Slack, Telegram, or macOS.
metadata: {"clawdbot":{"emoji":"🚀","skillKey":"pipeline","requires":{"config":["plugins.entries.pipeline.enabled"]}}}
---

# Pipeline Skill

Manage CI/CD pipelines with multi-stage builds and manual approval gates. Supports Azure DevOps, GitHub Actions, and GitLab CI providers.

## Overview

The `pipeline` tool lets you:
- Trigger pipeline runs from any supported provider
- Monitor real-time status of builds and stages
- Approve or reject pending approval gates
- Fetch build logs for debugging
- View pipeline history and pending approvals
- Receive notifications via Discord, Slack, Telegram, or macOS

## Inputs to collect

- `pipeline`: Pipeline name or ID to trigger/query
- `runId`: Pipeline run ID for status checks, logs, or cancellation
- `approvalId`: Approval ID for approve/reject actions
- `branch`: Optional branch to build (defaults to configured default)
- `parameters`: Optional key-value parameters for pipeline runs

## CLI

```bash
# Trigger a pipeline
clawdbot pipeline trigger build-and-deploy --branch main

# Check pipeline status
clawdbot pipeline status <runId>

# Approve a pending stage
clawdbot pipeline approve <approvalId> --comment "LGTM"

# Reject a pending stage
clawdbot pipeline reject <approvalId> --comment "Tests failing"

# Get build logs
clawdbot pipeline logs <runId> --stage deploy

# View pipeline history
clawdbot pipeline history --pipeline build-and-deploy --limit 10

# List available pipelines
clawdbot pipeline list

# List pending approvals
clawdbot pipeline pending

# Cancel a running pipeline
clawdbot pipeline cancel <runId>
```

All commands support `--json` for structured output.

## Actions

### Trigger a pipeline

Start a new pipeline run.

```json
{
  "action": "trigger",
  "pipeline": "build-and-deploy",
  "branch": "main",
  "parameters": {
    "environment": "staging",
    "skipTests": "false"
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Pipeline \"build-and-deploy\" triggered successfully",
  "runId": "run-abc123",
  "providerRunId": "12345",
  "webUrl": "https://dev.azure.com/org/project/_build/results?buildId=12345",
  "state": "queued",
  "pipelineName": "build-and-deploy",
  "branch": "main",
  "stages": [
    { "name": "Build", "state": "pending", "hasApprovalGate": false },
    { "name": "Deploy", "state": "pending", "hasApprovalGate": true }
  ]
}
```

### Check pipeline status

Get current status of a pipeline run.

```json
{
  "action": "status",
  "runId": "run-abc123",
  "refresh": true
}
```

**Response:**
```json
{
  "found": true,
  "id": "run-abc123",
  "providerRunId": "12345",
  "state": "waiting_for_approval",
  "result": null,
  "pipelineId": "build-and-deploy",
  "pipelineName": "Build and Deploy",
  "sourceBranch": "main",
  "webUrl": "https://dev.azure.com/org/project/_build/results?buildId=12345",
  "triggeredBy": "user@example.com",
  "queuedAt": "2026-01-15T10:00:00Z",
  "startedAt": "2026-01-15T10:00:15Z",
  "stages": [
    { "id": "stage-1", "name": "Build", "state": "succeeded", "result": "succeeded" },
    { "id": "stage-2", "name": "Deploy", "state": "waiting_for_approval", "hasApprovalGate": true }
  ]
}
```

### Approve a stage

Approve a pending approval gate.

```json
{
  "action": "approve",
  "approvalId": "appr-xyz789",
  "comment": "Reviewed and approved for production"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Approval \"appr-xyz789\" approved successfully",
  "approvalId": "appr-xyz789",
  "decision": "approved",
  "runId": "run-abc123",
  "stageId": "stage-2"
}
```

### Reject a stage

Reject a pending approval gate.

```json
{
  "action": "reject",
  "approvalId": "appr-xyz789",
  "comment": "Failing integration tests - needs fix"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Approval \"appr-xyz789\" rejected",
  "approvalId": "appr-xyz789",
  "decision": "rejected",
  "runId": "run-abc123",
  "stageId": "stage-2"
}
```

### Get build logs

Fetch logs from a pipeline run or specific stage.

```json
{
  "action": "logs",
  "runId": "run-abc123",
  "stage": "Build"
}
```

**Response:**
```json
{
  "runId": "run-abc123",
  "stageId": "stage-1",
  "totalLines": 245,
  "logs": [
    "2026-01-15T10:00:20Z Starting build...",
    "2026-01-15T10:00:21Z Installing dependencies...",
    "..."
  ],
  "truncated": true
}
```

### View pipeline history

Get recent pipeline runs with optional filtering.

```json
{
  "action": "history",
  "pipeline": "build-and-deploy",
  "limit": 10,
  "state": "failed"
}
```

**Response:**
```json
{
  "runs": [
    {
      "id": "run-abc123",
      "providerRunId": "12345",
      "state": "failed",
      "result": "failed",
      "pipelineId": "build-and-deploy",
      "pipelineName": "Build and Deploy",
      "sourceBranch": "feature/new-feature",
      "webUrl": "https://...",
      "queuedAt": "2026-01-15T09:00:00Z",
      "finishedAt": "2026-01-15T09:15:00Z",
      "durationMs": 900000
    }
  ],
  "totalCount": 15,
  "hasMore": true
}
```

### List pipelines

List all available pipelines from the provider.

```json
{
  "action": "list"
}
```

**Response:**
```json
{
  "pipelines": [
    {
      "id": "build-and-deploy",
      "name": "Build and Deploy",
      "path": "\\Pipelines\\Production",
      "defaultBranch": "main",
      "webUrl": "https://..."
    },
    {
      "id": "ci",
      "name": "CI Pipeline",
      "path": "\\Pipelines\\CI",
      "defaultBranch": "main"
    }
  ],
  "count": 2
}
```

### List pending approvals

Get all pending approval requests.

```json
{
  "action": "pending"
}
```

**Response:**
```json
{
  "message": "2 pending approval(s)",
  "approvals": [
    {
      "id": "appr-xyz789",
      "runId": "run-abc123",
      "stageId": "stage-2",
      "stageName": "Deploy to Production",
      "pipelineName": "Build and Deploy",
      "createdAt": "2026-01-15T10:05:00Z",
      "expiresAt": "2026-01-15T11:05:00Z",
      "approvers": ["user@example.com"],
      "instructions": "Review deployment changes before approving"
    }
  ],
  "count": 2
}
```

### Cancel a pipeline

Cancel a running pipeline.

```json
{
  "action": "cancel",
  "runId": "run-abc123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Pipeline run \"run-abc123\" cancelled",
  "runId": "run-abc123"
}
```

## Pipeline States

| State | Description |
|-------|-------------|
| `queued` | Pipeline is queued, waiting to start |
| `running` | Pipeline is actively executing |
| `waiting_for_approval` | Pipeline paused at an approval gate |
| `succeeded` | Pipeline completed successfully |
| `failed` | Pipeline failed |
| `cancelled` | Pipeline was cancelled |

## Notifications

Configure notifications in `plugins.entries.pipeline.config.notifications`:

### Discord
```yaml
notifications:
  discord:
    enabled: true
    webhookUrl: "https://discord.com/api/webhooks/..."
    username: "Pipeline Bot"
```

### Slack
```yaml
notifications:
  slack:
    enabled: true
    webhookUrl: "https://hooks.slack.com/services/..."
    channel: "#deployments"
    iconEmoji: ":rocket:"
```

### Telegram
```yaml
notifications:
  telegram:
    enabled: true
    botToken: "123456:ABC..."
    chatId: "-1001234567890"
```

### macOS
```yaml
notifications:
  macos:
    enabled: true
    sound: true
    soundName: "Glass"
```

### Notification options
- `onlyOnFailure`: Only send notifications when pipelines fail
- `includeStageNotifications`: Include stage-level notifications (more verbose)
- `suppressedTypes`: List of notification types to suppress

## Configuration

Configuration lives under `plugins.entries.pipeline.config`:

```yaml
plugins:
  entries:
    pipeline:
      enabled: true
      config:
        provider: "azure-devops"  # or github-actions, gitlab-ci, mock
        defaultPipeline: "build-and-deploy"
        defaultBranch: "main"

        # Provider-specific settings
        azureDevops:
          organization: "myorg"
          project: "myproject"
          pat: "${AZURE_DEVOPS_PAT}"

        # Approval settings
        approval:
          defaultTimeoutMs: 3600000  # 1 hour
          requireRejectComment: true
          autoRejectOnTimeout: false

        # Polling (for status updates without webhooks)
        polling:
          enabled: true
          intervalMs: 15000
          fastIntervalMs: 5000

        # Storage
        store:
          type: "memory"  # or "file"
          maxHistorySize: 100
```

## Provider setup

See provider-specific documentation:
- [Azure DevOps Setup](./references/azure-devops.md)

## Ideas to try

- Trigger a deploy pipeline after PR merge: "trigger the production deploy for main branch"
- Check why a build failed: "show me the logs for the failing Build stage"
- Approve a staging deployment: "approve the pending deploy to staging"
- Monitor pipeline health: "show me failed pipelines from this week"
- Cancel a stuck build: "cancel the currently running CI pipeline"
- Check what's blocking: "list all pending approvals"
