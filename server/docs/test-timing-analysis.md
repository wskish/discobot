# Go Test Timing Analysis

**Date:** 2026-01-23

## Overall Summary

| Package | Time | Test Count | Avg/Test |
|---------|------|------------|----------|
| **integration** | 128.8s | 135 | ~0.95s |
| **events** | 12.5s | 10 | ~1.25s |
| **service** | 10.6s | 25+ | ~0.4s |
| **ssh** | 6.3s | 13 | ~0.48s |
| **git** | 2.1s | 50+ | ~0.04s |
| **encryption** | 0.006s | 6 | <0.01s |
| **middleware** | 0.007s | - | - |
| **oauth** | 0.009s | - | - |

**Total test time:** ~160s

## Root Cause Analysis

### Integration Tests (128.8s) - 80% of Total Time

Each integration test performs full infrastructure setup:
1. **GORM AutoMigrate** - SQLite database schema creation (~0.5s)
2. **Event poller** - Starts goroutine for event polling
3. **Dispatcher** - Leader election and job processing infrastructure

The database + infrastructure setup costs ~0.6-0.8s per test, which dominates test time.

### Events Tests (12.5s)

Similar pattern - each test creates a fresh database and event broker infrastructure.

### Service Tests (10.6s)

The `TestPerformCommit_*` tests each take 0.6-0.75s due to database setup. Unit tests are fast (<0.01s).

### SSH Tests (6.3s)

- `TestNew_GeneratesHostKey` - 1.44s (crypto key generation)
- `TestServer_RejectsUnknownSession` - 1.33s (server lifecycle)

## Slowest Individual Tests

| Test | Time | Package |
|------|------|---------|
| TestReconcileSandboxes_MultipleSandboxes | 3.58s | integration |
| TestReconcileSandboxes_ReplacesOutdatedImage | 2.48s | integration |
| TestReconcileSessionStates_MarksFailedSandboxAsError | 2.25s | integration |
| TestEvents_SessionCreationEmitsEvents | 2.21s | integration |
| TestSSHServer_Integration_PortForwarding | 1.88s | integration |
| TestProvider_GetReturnsNotFoundAfterExternalContainerDeletion | 1.72s | integration |
| TestSSHServer_Integration_SessionTerminatesOnProcessExit | 1.69s | integration |
| TestReconcileSessionStates_KeepsRunningSessionWithRunningSandbox | 1.59s | integration |
| TestSSHServer_Integration_ConnectToSession | 1.58s | integration |
| TestCreateSession_ViaChat | 1.57s | integration |

## Failed Tests

1. **TestListSessions_IncludesCommitStatus** (`sessions_test.go:527`)
   - Error: `Expected 1 session, got 0`

2. **TestGetTerminalStatus_Running** (`terminal_test.go:53`)
   - Error: `Expected status 'ready', got 'running'`

## Optimization Opportunities

### High Impact

1. **Shared test database** - Use a pre-migrated database template instead of running AutoMigrate per test. Could save ~0.5s × 135 tests = 67s.

2. **Test suite with shared setup** - Group integration tests into suites that share infrastructure:
   ```go
   func TestMain(m *testing.M) {
       // Setup once
       db, broker, dispatcher := setupTestInfra()
       defer cleanup()
       m.Run()
   }
   ```

3. **Mock dispatcher/events for unit-like integration tests** - Many tests don't actually need the full dispatcher running.

### Medium Impact

4. **Parallel test execution within packages** - Use `t.Parallel()` where tests don't share state.

5. **Database connection pooling** - Reuse SQLite connections across tests.

6. **Lazy infrastructure** - Only start dispatcher/poller when the test actually needs them.

### Low Impact

7. **Pre-generate SSH host keys** - Cache test keys instead of generating per test.

8. **Reduce reconciliation test complexity** - The reconcile tests with multiple sandboxes are slowest.

## Recommended Next Steps

1. Fix the 2 failing tests first
2. Implement shared test database (biggest win)
3. Add `t.Parallel()` to independent tests
4. Consider test suite restructuring for integration tests
