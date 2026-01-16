---
name: azuredevops
description: "Interact with Azure DevOps using the `az devops` and `az pipelines` CLI. Trigger builds, monitor pipeline status, and manage Azure DevOps resources."
---

# Azure DevOps Skill

Use the `az devops` and `az pipelines` CLI to interact with Azure DevOps. Always specify `--organization` and `--project` when not using defaults.

## Prerequisites

### Authentication Setup

Login to Azure CLI and configure DevOps defaults:
```bash
# Login to Azure
az login

# Install Azure DevOps extension (if not installed)
az extension add --name azure-devops

# Configure default organization and project
az devops configure --defaults organization=https://dev.azure.com/YOUR_ORG project=YOUR_PROJECT
```

Verify authentication:
```bash
az devops user show --organization https://dev.azure.com/YOUR_ORG
```

## Pipelines

### Trigger a Pipeline Run

Start a pipeline by name or ID:
```bash
# By pipeline name
az pipelines run --name "Build-Deploy-Pipeline" --organization https://dev.azure.com/myorg --project MyProject

# By pipeline ID
az pipelines run --id 42 --organization https://dev.azure.com/myorg --project MyProject

# With branch and variables
az pipelines run --name "Build-Pipeline" --branch refs/heads/main --variables version=1.2.3 deploy=true
```

### Check Pipeline/Build Status

Get status of a specific run:
```bash
# By run ID
az pipelines runs show --id 12345 --organization https://dev.azure.com/myorg --project MyProject

# Get only status field using --query
az pipelines runs show --id 12345 --query "status" --output tsv

# Get status and result
az pipelines runs show --id 12345 --query "{status:status, result:result}" --output json
```

### List Recent Builds

List pipeline runs with filtering:
```bash
# List recent runs for all pipelines
az pipelines runs list --organization https://dev.azure.com/myorg --project MyProject --top 10

# Filter by pipeline name
az pipelines runs list --pipeline-ids 42 --top 5

# Filter by status
az pipelines runs list --status completed --top 10

# Filter by result
az pipelines runs list --result succeeded --top 10

# Filter by branch
az pipelines runs list --branch refs/heads/main --top 10
```

### Get Pipeline Definition

View pipeline configuration:
```bash
# List all pipelines
az pipelines list --organization https://dev.azure.com/myorg --project MyProject

# Get specific pipeline details
az pipelines show --name "Build-Pipeline" --organization https://dev.azure.com/myorg --project MyProject
```

## JSON Output and Queries

### Structured Output

Most commands support `--output json` for structured output:
```bash
az pipelines runs list --top 5 --output json
```

### JMESPath Queries with --query

Extract specific fields using `--query`:
```bash
# Get run IDs and statuses
az pipelines runs list --top 5 --query "[].{id:id, status:status, result:result}" --output table

# Get the latest run ID
az pipelines runs list --top 1 --query "[0].id" --output tsv

# Check if a run succeeded
az pipelines runs show --id 12345 --query "result=='succeeded'" --output tsv

# Get build name and finish time
az pipelines runs show --id 12345 --query "{name:name, finished:finishTime, result:result}"
```

### Parse JSON in Scripts

```bash
# Store run ID from triggered pipeline
RUN_ID=$(az pipelines run --name "Build-Pipeline" --query "id" --output tsv)
echo "Started run: $RUN_ID"

# Poll for completion
while true; do
  STATUS=$(az pipelines runs show --id $RUN_ID --query "status" --output tsv)
  if [[ "$STATUS" == "completed" ]]; then
    RESULT=$(az pipelines runs show --id $RUN_ID --query "result" --output tsv)
    echo "Build $RESULT"
    break
  fi
  echo "Status: $STATUS"
  sleep 30
done
```

## Build Logs

### View Build Logs

```bash
# Get logs for a run (downloads to current directory)
az pipelines runs show --id 12345 --open

# Get timeline with step details
az devops invoke --area build --resource timeline --route-parameters project=MyProject buildId=12345 --output json
```

## Artifacts

### List Build Artifacts

```bash
# List artifacts for a build
az pipelines runs artifact list --run-id 12345 --organization https://dev.azure.com/myorg --project MyProject
```

### Download Artifacts

```bash
# Download a specific artifact
az pipelines runs artifact download --run-id 12345 --artifact-name drop --path ./artifacts
```

## Common Patterns

### Wait for Build Completion

```bash
# Trigger and wait for completion
RUN_ID=$(az pipelines run --name "Build-Pipeline" --query "id" --output tsv)
echo "Triggered run: $RUN_ID"

while true; do
  STATUS=$(az pipelines runs show --id $RUN_ID --query "status" --output tsv)
  echo "Current status: $STATUS"

  if [[ "$STATUS" == "completed" ]]; then
    RESULT=$(az pipelines runs show --id $RUN_ID --query "result" --output tsv)
    echo "Build completed with result: $RESULT"
    break
  elif [[ "$STATUS" == "canceling" || "$STATUS" == "notStarted" && $RETRIES -gt 20 ]]; then
    echo "Build stuck or canceling"
    exit 1
  fi

  sleep 30
done
```

### Get Failed Stage Details

```bash
# Get stages with their status
az pipelines runs show --id 12345 --query "stages[].{name:name, state:state, result:result}" --output table
```

## Run Status Values

| Status | Description |
| --- | --- |
| `notStarted` | Run is queued but not yet started |
| `inProgress` | Run is currently executing |
| `completed` | Run has finished (check `result` for outcome) |
| `canceling` | Run is being cancelled |
| `postponed` | Run is postponed |

## Run Result Values

| Result | Description |
| --- | --- |
| `succeeded` | Build completed successfully |
| `failed` | Build failed |
| `canceled` | Build was cancelled |
| `partiallySucceeded` | Build succeeded with warnings |

## Tips

- Always use `--output tsv` when capturing single values in scripts
- Use `--query` to reduce output and extract specific fields
- Set defaults with `az devops configure --defaults` to avoid repetition
- Use `--debug` flag to troubleshoot authentication issues
