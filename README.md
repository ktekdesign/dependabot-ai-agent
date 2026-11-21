# Dependabot AI Agent

An autonomous, AI-powered security remediation agent for GitHub repositories. It monitors Dependabot alerts, analyzes vulnerabilities, generates structured remediation plans, and provides an isolated execution environment for applying and validating dependency fixes.

> **Development status:** Active development. Core infrastructure for GitHub alert ingestion, persistence, AI analysis, remediation planning, secure archive extraction, and isolated execution is implemented. End-to-end remediation orchestration and automatic pull request publishing are still under development.

## Overview

Dependabot AI Agent aims to automate the remediation lifecycle of dependency vulnerabilities:

1. Collect Dependabot alerts from GitHub repositories.
2. Persist and track alert changes.
3. Queue security analysis jobs.
4. Analyze vulnerabilities using configurable AI providers.
5. Generate structured remediation plans.
6. Prepare an isolated workspace for repository changes.
7. Apply and validate remediation changes.
8. Publish a pull request for human review.

The long-term goal is autonomous remediation across all vulnerability severity levels, including CRITICAL.

Human approval remains required for merging pull requests. The agent will never approve or merge its own pull requests.

## Architecture

The project uses a modular, event-driven architecture built with NestJS and TypeScript.

### Main components

| Component               | Responsibility                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------- |
| GitHub integration      | Authenticate as a GitHub App, discover repositories, and collect Dependabot alerts |
| Synchronization         | Reconcile repository alerts and persist changes                                    |
| PostgreSQL              | Source of truth for alerts, analysis state, and workflow data                      |
| Transactional outbox    | Reliably publish domain events after database transactions                         |
| BullMQ / Redis          | Queue and distribute asynchronous analysis jobs                                    |
| AI provider layer       | Provide a provider-independent interface for LLM integrations                      |
| LangGraph               | Orchestrate security analysis and remediation planning workflows                   |
| PostgreSQL checkpointer | Persist workflow checkpoints and support recovery                                  |
| Remediation workspace   | Create and validate isolated repository workspaces                                 |
| Archive extractor       | Safely validate and extract GitHub repository archives                             |
| Docker executor         | Run allowlisted validation commands in isolated containers                         |

### Technology stack

- Node.js 22
- TypeScript
- NestJS 10
- PostgreSQL 16
- Prisma 6
- Redis 7
- BullMQ 5
- LangGraph.js
- LangChain.js
- Zod 4
- Docker

## AI providers

The AI integration is provider-independent and currently supports:

- OpenAI
- Anthropic
- Google Gemini

Provider selection is controlled through environment variables.

Default models:

| Provider  | Default model              |
| --------- | -------------------------- |
| OpenAI    | `gpt-4.1-mini`             |
| Anthropic | `claude-sonnet-4-20250514` |
| Google    | `gemini-2.5-flash`         |

Each provider can have its own model configuration. The selected provider can also use the generic `AI_MODEL` override.

AI-generated content is treated as untrusted input. Structured outputs are validated before they are used by application workflows.

## Security design

Security is a core architectural requirement.

### AI execution boundaries

- AI-generated plans are validated against strict schemas.
- The model does not receive unrestricted shell execution.
- Validation commands are explicitly allowlisted.
- Repository paths are validated before file operations.
- Credentials and application secrets are not mounted into remediation containers.

### Docker isolation

Remediation commands execute inside constrained Docker containers with:

- Network access disabled.
- Read-only container filesystem.
- Writable repository workspace only.
- Temporary filesystem mounted for `/tmp`.
- Non-root execution using the host process UID/GID.
- Linux capabilities dropped.
- `no-new-privileges` enabled.
- CPU, memory, process-count, and execution-time limits.

### Archive extraction safeguards

GitHub repository archives are validated before extraction.

Current limits include:

| Safeguard                  |  Limit |
| -------------------------- | -----: |
| Compressed archive         | 100 MB |
| Total decompressed archive | 600 MB |
| Expanded regular-file data | 500 MB |
| Archive entries            | 20,000 |
| Directory depth            |     32 |
| Decompression ratio        |  200:1 |
| Metadata entry size        |   1 MB |

Symbolic links, hard links, and unsupported special archive entries are rejected.

### Reliability

- PostgreSQL is the source of truth.
- Transactional outbox delivery uses at-least-once semantics.
- Queue consumers are designed for idempotent processing.
- Database leases protect concurrent processing.
- Analysis state can be recovered after worker interruption.
- LangGraph checkpoints preserve workflow progress.

## Prerequisites

Install the following tools:

- Node.js 22
- npm
- Docker Engine or Docker Desktop
- Git
- A GitHub App
- An API key for at least one supported AI provider

## Getting started

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/dependabot-ai-agent.git
cd dependabot-ai-agent
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy `.env.example` to `.env` and configure your values.

```env
# Application
NODE_ENV=development

# PostgreSQL
POSTGRES_PASSWORD=replace_with_a_strong_password
DATABASE_URL=postgresql://dependabot:replace_with_a_strong_password@localhost:5432/dependabot_agent
DIRECT_URL=postgresql://dependabot:replace_with_a_strong_password@localhost:5432/dependabot_agent
SHADOW_DATABASE_URL=postgresql://dependabot:replace_with_a_strong_password@localhost:5432/dependabot_shadow

# Test database
TEST_DATABASE_URL=postgresql://dependabot:replace_with_a_strong_password@localhost:5432/dependabot_agent_test

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=replace_with_another_strong_password

# GitHub App
GITHUB_APP_ID=your_github_app_id
GITHUB_INSTALLATION_ID=your_github_installation_id
GITHUB_PRIVATE_KEY_PATH=/absolute/path/to/your/private-key.pem

# AI provider
AI_PROVIDER=openai
AI_TEMPERATURE=0.2

OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=

# Optional model overrides
# AI_MODEL=
# OPENAI_MODEL=
# ANTHROPIC_MODEL=
# GOOGLE_MODEL=

# Optional worker configuration
OUTBOX_POLL_INTERVAL_MS=5000
ANALYSIS_RECOVERY_INTERVAL_MS=15000

# Optional remediation configuration
REMEDIATION_WORKSPACE_ROOT=
REMEDIATION_DOCKER_IMAGE=dependabot-remediation-node:22
REMEDIATION_EXECUTION_TIMEOUT_MS=600000
REMEDIATION_DOCKER_CONTROL_TIMEOUT_MS=15000
REMEDIATION_MAX_OUTPUT_LENGTH=65536
REMEDIATION_MEMORY=1g
REMEDIATION_MEMORY_SWAP=1g
REMEDIATION_CPUS=1
REMEDIATION_PIDS_LIMIT=128
REMEDIATION_TMP_SIZE_MB=128
```

Replace all example credentials and paths with your own values. Never commit `.env`, private keys, or API credentials.

The PostgreSQL and Redis services use the `POSTGRES_PASSWORD` and `REDIS_PASSWORD` variables from the environment.

### 4. Start infrastructure

```bash
docker compose up -d
```

Check service status:

```bash
docker compose ps
```

### 5. Apply database migrations

```bash
npx prisma migrate deploy
```

Ensure the database URLs and migration environment are configured correctly before running migrations.

### 6. Build the remediation Docker image

```bash
docker build -f Dockerfile.remediation -t dependabot-remediation-node:22 .
```

### 7. Build the application

```bash
npm run build
```

### 8. Synchronize GitHub repositories and alerts

```bash
npm run sync:github
```

This command builds the application and runs the GitHub synchronization script.

## Development commands

| Command                   | Description                                |
| ------------------------- | ------------------------------------------ |
| `npm run start`           | Start the application                      |
| `npm run start:dev`       | Start in watch mode                        |
| `npm run build`           | Build the application                      |
| `npm test -- --runInBand` | Run unit tests located in `src/`           |
| `npm run test:cov`        | Run tests with coverage                    |
| `npm run test:e2e`        | Run integration tests located in `test/`   |
| `npm run lint`            | Run ESLint with automatic fixes            |
| `npm run format`          | Format TypeScript source and test files    |
| `npm run sync:github`     | Synchronize GitHub repositories and alerts |

Docker integration tests can be enabled with:

```bash
RUN_DOCKER_INTEGRATION=true npm test -- --runInBand
```

## GitHub App permissions

The current integration uses a GitHub App with read-only access to:

- Dependabot alerts
- Repository metadata

Additional permissions will be required as the project evolves:

- Repository contents: read access for archive and file retrieval.
- Repository contents: write access for remediation commits.
- Pull requests: read and write access for pull request publishing.

Grant only the permissions required by each implementation stage.

## Project roadmap

- [x] GitHub App authentication
- [x] Repository discovery and Dependabot alert collection
- [x] Alert persistence and reconciliation
- [x] Transactional outbox
- [x] BullMQ asynchronous processing
- [x] AI provider abstraction
- [x] LangGraph security analysis workflow
- [x] Structured remediation plan generation
- [x] Remediation risk policy
- [x] PostgreSQL workflow checkpointing
- [x] Secure archive validation and extraction
- [x] Docker-based isolated execution infrastructure
- [ ] Complete end-to-end remediation orchestration
- [ ] Apply validated dependency changes
- [ ] Automated remediation validation pipeline
- [ ] GitHub pull request publishing
- [ ] Production deployment and operational observability

## Contributing

Contributions, bug reports, and architectural discussions are welcome.

Before submitting changes:

1. Build the project.
2. Run the relevant test suites.
3. Verify that no credentials or private keys are included.
4. Review changes for security and isolation regressions.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
