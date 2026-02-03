# Manual Test Scripts

These are manual test scripts for interactive testing and debugging of the Claude SDK client. Unlike automated integration tests, these scripts provide detailed logging and are useful for troubleshooting.

## Prerequisites

- Claude CLI binary installed and on PATH (or set `CLAUDE_CLI_PATH`)
- `ANTHROPIC_API_KEY` environment variable (for tests that call the API)

## Running Tests

```bash
# Run from agent-api directory
cd /home/discobot/workspace/agent-api

# CLI discovery test (no API key needed)
./node_modules/.bin/tsx test/manual/cli-discovery.test.ts
# Or with pnpm:
pnpm exec tsx test/manual/cli-discovery.test.ts

# Tool execution test (requires API key)
ANTHROPIC_API_KEY=xxx ./node_modules/.bin/tsx test/manual/tool-execution.test.ts

# Multiple tools test (requires API key)
ANTHROPIC_API_KEY=xxx ./node_modules/.bin/tsx test/manual/multiple-tools.test.ts
```

## Test Descriptions

### `cli-discovery.test.ts`

Tests Claude CLI binary discovery without making API calls.

**What it tests:**
- CLI discovery from `CLAUDE_CLI_PATH` environment variable
- CLI discovery from system PATH
- CLI discovery from common locations
- Error handling when CLI not found

**When to use:**
- Verifying Claude CLI is installed correctly
- Debugging CLI path issues
- Testing in new environments

### `tool-execution.test.ts`

Tests tool execution with detailed logging of chunks and state transitions.

**What it tests:**
- Tool input capture (tool-input-start, tool-input-available)
- Tool output capture (tool-output-available)
- Complete tool execution lifecycle
- Bash tool specifically

**When to use:**
- Debugging tool execution issues
- Verifying tool I/O is captured correctly
- Inspecting chunk sequences and timing

### `multiple-tools.test.ts`

Tests multiple tool types to verify generic output handling.

**What it tests:**
- Bash tool (stdout/stderr structure)
- Read tool (file/content structure)
- Generic tool_response capture
- Output structure inspection

**When to use:**
- Verifying new tool types work correctly
- Debugging tool-specific output issues
- Validating generic output handling

## Comparison with Integration Tests

| Aspect | Manual Tests | Integration Tests |
|--------|-------------|-------------------|
| **Purpose** | Interactive debugging | Automated validation |
| **Output** | Detailed logging | Pass/fail only |
| **When to run** | During development | CI/CD pipeline |
| **API calls** | Yes | Yes |
| **Speed** | Slower (verbose) | Faster (minimal output) |

## Adding New Manual Tests

When adding new manual test scripts:

1. Create file in `test/manual/` with `.test.ts` extension
2. Add detailed console logging for debugging
3. Document what the test covers in this README
4. Include usage instructions with environment variables

## Notes

- These tests are not run automatically by `pnpm test`
- They require the `ANTHROPIC_API_KEY` environment variable (except CLI discovery)
- Output is intentionally verbose for debugging purposes
- Tests may take 1-2 minutes due to API calls
