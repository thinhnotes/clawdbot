# Azure DevOps Provider Setup

This guide covers setting up the Pipeline skill with Azure DevOps as your CI/CD provider.

## Prerequisites

- An Azure DevOps account (cloud or on-premises)
- A project with pipeline(s) you want to manage
- Admin or Build Administrator permissions on the project

## Quick Setup

1. Create a Personal Access Token (PAT) with required permissions
2. Configure the pipeline plugin with your organization and project
3. (Optional) Set up webhooks for real-time updates
4. Test the connection by listing pipelines

## Configuration

Add the following to your Clawdbot configuration:

```yaml
plugins:
  entries:
    pipeline:
      enabled: true
      config:
        provider: "azure-devops"

        azureDevops:
          organization: "myorg"           # Your organization name
          project: "myproject"            # Your project name
          pat: "${AZURE_DEVOPS_PAT}"      # Personal Access Token
          apiVersion: "7.0"               # API version (default: 7.0)
          # baseUrl: "https://dev.azure.com"  # For on-premises installations
```

### Environment Variables

You can use environment variables for sensitive values:

| Variable | Description |
|----------|-------------|
| `AZURE_DEVOPS_PAT` | Personal Access Token |
| `AZURE_DEVOPS_ORG` | Organization name (optional) |
| `AZURE_DEVOPS_PROJECT` | Project name (optional) |

## Creating a Personal Access Token (PAT)

### Step 1: Access Token Settings

1. Sign in to Azure DevOps (`https://dev.azure.com/{yourorganization}`)
2. Click your profile icon in the top right
3. Select **Personal access tokens**
4. Click **New Token**

### Step 2: Configure Token Permissions

Set the following scopes:

| Scope | Permission | Required For |
|-------|------------|--------------|
| **Build** | Read & Execute | Triggering pipelines, viewing status |
| **Release** | Read, write, & execute | Approval gates on release pipelines |
| **Environment** | Read & Manage | Environment approval gates (YAML pipelines) |
| **Code** | Read | Webhook validation (optional) |

**Minimum required scopes:**
- `Build` → `Read & Execute`
- `Release` → `Read, Write, & Execute` (for classic release pipelines with approvals)

**Additional scopes for full functionality:**
- `Environment` → `Read & Manage` (for YAML pipeline environment approvals)

### Step 3: Set Expiration

- Choose an appropriate expiration date
- Recommended: 1 year for personal use, shorter for automation
- Set a reminder to rotate the token before expiration

### Step 4: Save Token

1. Click **Create**
2. **Copy the token immediately** - it won't be shown again
3. Store securely in environment variable or secrets manager

## Pipeline YAML with Approval Gates

To use approval gates with Azure DevOps YAML pipelines, you need to configure **Environments** with approval checks.

### Step 1: Create an Environment

1. Go to **Pipelines** → **Environments**
2. Click **New environment**
3. Name it (e.g., `production`, `staging`)
4. Choose **None** for resource type

### Step 2: Add Approval Check

1. Open the environment you created
2. Click the **⋮** menu → **Approvals and checks**
3. Click **+** → **Approvals**
4. Add approvers (users or groups)
5. Configure options:
   - **Minimum number of approvers**: How many must approve
   - **Allow approvers to approve their own runs**: Yes/No
   - **Timeout**: How long to wait before auto-rejecting

### Step 3: Reference Environment in Pipeline YAML

```yaml
trigger:
  - main

stages:
  - stage: Build
    displayName: 'Build'
    jobs:
      - job: BuildJob
        pool:
          vmImage: 'ubuntu-latest'
        steps:
          - script: echo "Building..."

  - stage: Deploy
    displayName: 'Deploy to Production'
    dependsOn: Build
    jobs:
      - deployment: DeployJob
        environment: 'production'  # References the environment with approvals
        pool:
          vmImage: 'ubuntu-latest'
        strategy:
          runOnce:
            deploy:
              steps:
                - script: echo "Deploying..."
```

### Multi-Stage Pipeline Example

```yaml
trigger:
  branches:
    include:
      - main
      - release/*

parameters:
  - name: deployEnvironment
    displayName: 'Deploy Environment'
    type: string
    default: 'staging'
    values:
      - staging
      - production

stages:
  - stage: Build
    displayName: 'Build & Test'
    jobs:
      - job: Build
        pool:
          vmImage: 'ubuntu-latest'
        steps:
          - task: NodeTool@0
            inputs:
              versionSpec: '18.x'
          - script: npm ci
          - script: npm run build
          - script: npm test
          - publish: $(Build.ArtifactStagingDirectory)
            artifact: drop

  - stage: DeployStaging
    displayName: 'Deploy to Staging'
    dependsOn: Build
    condition: succeeded()
    jobs:
      - deployment: DeployStagingJob
        environment: 'staging'  # No approval gate
        pool:
          vmImage: 'ubuntu-latest'
        strategy:
          runOnce:
            deploy:
              steps:
                - script: echo "Deploying to staging..."

  - stage: DeployProduction
    displayName: 'Deploy to Production'
    dependsOn: DeployStaging
    condition: and(succeeded(), eq('${{ parameters.deployEnvironment }}', 'production'))
    jobs:
      - deployment: DeployProdJob
        environment: 'production'  # Has approval gate
        pool:
          vmImage: 'ubuntu-latest'
        strategy:
          runOnce:
            deploy:
              steps:
                - script: echo "Deploying to production..."
```

## Webhook Configuration (Optional)

Webhooks provide real-time updates instead of polling. This is optional but recommended for faster notifications.

### Step 1: Configure Clawdbot Webhook Server

Enable the webhook server in your configuration:

```yaml
plugins:
  entries:
    pipeline:
      config:
        webhook:
          enabled: true
          port: 3335
          bind: "0.0.0.0"       # For external access
          path: "/pipeline/webhook"
          secret: "${WEBHOOK_SECRET}"  # For signature verification
```

### Step 2: Create Service Hook in Azure DevOps

1. Go to **Project Settings** → **Service hooks**
2. Click **+** to create a subscription
3. Select **Web Hooks** as the service
4. Configure triggers:

**For build updates:**
- Event: **Build completed**
- Filter by pipeline if needed

**For stage status updates:**
- Event: **Release deployment approval pending**
- Event: **Release deployment completed**

5. Configure action:
   - URL: `https://your-server:3335/pipeline/webhook`
   - Resource version: Latest
   - Messages to send: All
   - Resource details to send: All

### Step 3: Set Webhook Secret

For security, configure a secret for signature verification:

```yaml
webhook:
  secret: "${WEBHOOK_SECRET}"
```

Azure DevOps signs webhook payloads. The plugin verifies the signature using this secret.

## Classic Release Pipeline Approvals

For classic (non-YAML) release pipelines, approvals are configured in the pipeline editor:

1. Open your release pipeline
2. Click the stage you want to add approvals to
3. Click the **Pre-deployment conditions** icon (lightning bolt)
4. Enable **Pre-deployment approvals**
5. Add approvers and configure options

The Pipeline skill handles both YAML environment approvals and classic release approvals.

## API Endpoints Used

The Azure DevOps provider uses these REST API endpoints:

| Operation | API Endpoint |
|-----------|--------------|
| List pipelines | `GET /_apis/pipelines` |
| Trigger pipeline | `POST /_apis/pipelines/{id}/runs` |
| Get run status | `GET /_apis/pipelines/{id}/runs/{runId}` |
| Get build logs | `GET /_apis/build/builds/{buildId}/logs` |
| List approvals | `GET /_apis/release/approvals` |
| Update approval | `PATCH /_apis/release/approvals/{approvalId}` |
| Cancel build | `PATCH /_apis/build/builds/{buildId}` |

API version: `7.0` (configurable via `apiVersion` setting)

## On-Premises Azure DevOps Server

For Azure DevOps Server (on-premises), specify your server URL:

```yaml
azureDevops:
  baseUrl: "https://tfs.mycompany.com/tfs/DefaultCollection"
  organization: ""  # Leave empty for on-prem
  project: "MyProject"
  pat: "${AZURE_DEVOPS_PAT}"
  apiVersion: "6.0"  # Match your server version
```

**Note:** On-premises installations may have different API versions. Check your server documentation for the supported API version.

## Troubleshooting

### Authentication Errors

**Error:** `401 Unauthorized`

**Solutions:**
1. Verify PAT has not expired
2. Ensure PAT has required scopes (Build: Read & Execute)
3. Check organization and project names are correct
4. For on-premises, verify the base URL includes the collection

**Error:** `403 Forbidden`

**Solutions:**
1. Verify your user has Build Administrator or Contributor permissions
2. Check PAT scopes include `Release: Read, Write & Execute` for approvals
3. For environment approvals, ensure `Environment: Read & Manage` scope

### Pipeline Not Found

**Error:** `404 Pipeline not found`

**Solutions:**
1. Verify the pipeline ID or name is correct
2. Check you're looking at the correct project
3. Ensure the pipeline exists and is not deleted
4. For YAML pipelines, ensure the pipeline has been run at least once

### Approval Issues

**Error:** `Cannot approve: Approval not found`

**Solutions:**
1. The approval may have already been processed
2. The approval may have timed out
3. Check the approval ID is correct
4. Verify you have permission to approve (if approver restrictions are configured)

**Error:** `Cannot approve: User not authorized`

**Solutions:**
1. Your PAT user must be in the list of authorized approvers
2. For environment approvals, check the environment's approval configuration
3. Ensure the approver hasn't been removed from the project

### Webhook Issues

**Error:** `Webhook signature verification failed`

**Solutions:**
1. Verify the webhook secret matches in both Azure DevOps and Clawdbot config
2. Ensure the raw body is used for signature verification
3. Check for proxy or load balancer modifications to the request

**Error:** `No webhook events received`

**Solutions:**
1. Verify the webhook URL is accessible from Azure DevOps
2. Check firewall rules allow incoming connections
3. Verify the service hook is enabled and triggered on the correct events
4. Check Azure DevOps service hook logs for delivery errors

### Rate Limiting

**Error:** `429 Too Many Requests`

**Solutions:**
1. Reduce polling frequency in configuration:
   ```yaml
   polling:
     intervalMs: 30000  # Increase from default 15000
   ```
2. Use webhooks instead of polling for real-time updates
3. If using multiple projects, consider separate PATs per project

### Connection Timeouts

**Error:** `ETIMEDOUT` or `Request timeout`

**Solutions:**
1. Check network connectivity to Azure DevOps
2. For on-premises, verify VPN or network access
3. Increase request timeout in configuration:
   ```yaml
   azureDevops:
     requestTimeoutMs: 60000  # Default: 30000
   ```

## Common Issues Reference

| Issue | Symptom | Resolution |
|-------|---------|------------|
| PAT expired | 401 on all requests | Generate new PAT |
| Wrong scope | 403 on specific operations | Add required scope to PAT |
| Project typo | 404 Not Found | Verify project name in Azure DevOps |
| No approvals pending | Empty approval list | Trigger a pipeline with approval gates first |
| Stale status | Old status despite completion | Enable polling or webhooks |
| Concurrent runs | Multiple runs in progress | Use run locks or queue settings |

## Security Best Practices

1. **Rotate PATs regularly** - Set calendar reminders for token expiration
2. **Use minimum required scopes** - Don't grant more permissions than needed
3. **Store PATs in secrets manager** - Never commit tokens to source control
4. **Use environment variables** - Reference secrets via `${VARIABLE}` syntax
5. **Enable webhook signature verification** - Prevent unauthorized webhook calls
6. **Audit access** - Review who has access to pipelines and approvals

## Related Documentation

- [Azure DevOps REST API Reference](https://docs.microsoft.com/en-us/rest/api/azure/devops/)
- [Personal Access Tokens](https://docs.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)
- [YAML Pipeline Environments](https://docs.microsoft.com/en-us/azure/devops/pipelines/process/environments)
- [Release Approvals](https://docs.microsoft.com/en-us/azure/devops/pipelines/release/approvals/approvals)
- [Service Hooks](https://docs.microsoft.com/en-us/azure/devops/service-hooks/overview)
