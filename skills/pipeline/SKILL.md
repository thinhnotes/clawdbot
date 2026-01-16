---
name: pipeline
description: "Manage multi-stage build pipelines with approval gates. Use `/approve`, `/reject`, and `/pipeline-status` commands to control pipeline execution and approvals."
---

# Pipeline Skill

Manage multi-stage build pipelines with approval gates between stages. Pipelines can integrate with Azure DevOps builds and require manual approval before advancing to subsequent stages.

## Commands

### /approve

Approve a pipeline stage that is awaiting approval. After approval, the pipeline advances to the next stage.

```
/approve <pipeline-id> <stage-id> [comment]
```

**Arguments:**
- `pipeline-id` - The ID or name of the pipeline (required)
- `stage-id` - The ID or name of the stage to approve (required)
- `comment` - Optional comment explaining the approval decision

**Examples:**
```bash
# Approve by IDs
/approve abc123 build

# Approve using names (quote names with spaces)
/approve "My Pipeline" "Build Stage"

# Approve with a comment
/approve abc123 build "Looks good, all tests passing"
```

**Notes:**
- The stage must be in `awaiting_approval` status
- You must have approval permissions for the stage
- After approval, the pipeline will advance to the next stage automatically

---

### /reject

Reject a pipeline stage that is awaiting approval. Rejection stops the pipeline from advancing.

```
/reject <pipeline-id> <stage-id> [reason]
```

**Arguments:**
- `pipeline-id` - The ID or name of the pipeline (required)
- `stage-id` - The ID or name of the stage to reject (required)
- `reason` - Optional reason explaining the rejection

**Examples:**
```bash
# Reject by IDs
/reject abc123 build

# Reject using names
/reject "My Pipeline" "Build Stage"

# Reject with a reason
/reject abc123 build "Tests are failing, needs investigation"
```

**Notes:**
- The stage must be in `awaiting_approval` status
- You must have approval/rejection permissions for the stage
- After rejection, the pipeline may be paused or marked as failed depending on configuration

---

### /pipeline-status

View pipeline status and progress. Shows all pipelines when no ID is provided, or detailed status for a specific pipeline.

```
/pipeline-status [pipeline-id]
```

**Aliases:** `/ps`

**Arguments:**
- `pipeline-id` - Optional pipeline ID or name for detailed status

**Examples:**
```bash
# List all pipelines
/pipeline-status

# Short alias to list all pipelines
/ps

# Detailed status for a specific pipeline
/pipeline-status abc123

# Detailed status by name
/pipeline-status "My Pipeline"
```

**List View Shows:**
- Pipeline name, status, and progress
- Current stage name and status
- Number of pending approvals
- Pipeline ID and creation time

**Detailed View Shows:**
- Pipeline status and description
- All stages with their current status and timing
- Stage approval requirements (marked with lock icon)
- Current stage indicator
- Pending approvals with approve/reject command suggestions
- Recent approval history
- Pipeline creation and update timestamps

---

## Common Workflows

### Typical Approval Workflow

1. **Check pending approvals:**
   ```
   /pipeline-status
   ```

2. **View detailed status for a pipeline with pending approval:**
   ```
   /pipeline-status abc123
   ```

3. **Approve or reject the stage:**
   ```
   # If the build looks good
   /approve abc123 build "Verified in staging"

   # If issues were found
   /reject abc123 build "Integration tests failing"
   ```

### Monitoring Pipeline Progress

Use `/pipeline-status` or `/ps` to get an overview:
```
/ps
```

The status view uses emojis to indicate state at a glance:
- `⏳` - Pending
- `🔄` - Running
- `🔔` - Awaiting Approval
- `✅` - Approved/Completed
- `❌` - Rejected/Failed
- `⏸️` - Paused
- `🚫` - Cancelled

### Quick Response to Notifications

When you receive an approval notification, it includes the commands to use:
```
Stage "Build" in pipeline "Deploy to Prod" is awaiting approval.
Use: /approve abc123 build
 or: /reject abc123 build [reason]
```

---

## Pipeline Stage States

Stages progress through the following states:

| Status | Description |
| --- | --- |
| `pending` | Stage has not started yet |
| `running` | Stage is currently executing |
| `awaiting_approval` | Stage completed and waiting for approval |
| `approved` | Stage was approved, advancing to next stage |
| `rejected` | Stage was rejected |
| `completed` | Stage finished successfully |
| `failed` | Stage failed during execution |

---

## Permissions

- Users must be authorized to view pipeline status
- Approval/rejection requires specific permissions:
  - Stage-level `approvers` list (if configured)
  - Global approver list (if configured)
  - General authorization (if no specific lists)

---

## Integration with Azure DevOps

Pipelines can include stages that trigger Azure DevOps builds. When a stage executes:

1. The Azure DevOps pipeline is triggered
2. The stage status shows `running` while the build executes
3. On completion, if approval is required, status changes to `awaiting_approval`
4. After approval, the next stage is triggered

See the `azuredevops` skill for details on Azure DevOps CLI usage.

---

## Tips

- Use pipeline/stage names instead of IDs for easier commands
- Names with spaces must be quoted: `"My Pipeline"`
- The `/ps` alias is quicker than `/pipeline-status`
- Include comments/reasons for audit trail and team communication
- Check pending approvals regularly with `/ps`
