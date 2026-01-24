# Go Test Timing Analysis

**Date:** 2026-01-24 (Updated with optimizations)

## Overall Summary

### Before Optimization (2026-01-23)

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

### After Optimization (2026-01-24)

| Package | Time | Improvement |
|---------|------|-------------|
| **integration** | 46.5s | **64% faster** |
| **events** | 11.8s | 6% faster |
| **service** | 10.1s | 5% faster |
| **ssh** | 3.3s | **47% faster** |
| **git** | 1.7s | 18% faster |
| **encryption** | 0.003s | - |
| **middleware** | 0.007s | - |
| **oauth** | 0.009s | - |

**Total test time:** ~73s (**54% faster**)

### With `-short` Flag (Quick Feedback)

| Package | Time | Tests Skipped |
|---------|------|---------------|
| **integration** | 28s | 14 slow tests |
| **ssh** | ~2s | - |

**Quick test time:** ~40s (skips 14 slowest tests)

## Optimizations Implemented

### 1. Shared Test Database Template (High Impact)

- Created a pre-migrated SQLite database template in `TestMain`
- Each test copies the template instead of running `AutoMigrate` (~0.5s savings per test)
- Saved ~67 seconds across 135 integration tests
- Implementation: `main_test.go` creates template, `testutil.go` copies it

### 2. Parallel Test Execution (Medium Impact)

- Added `t.Parallel()` to 60+ independent tests
- Tests now run concurrently, utilizing multiple CPU cores
- Most effective for integration tests with I/O-bound operations
- Implementation: Added `t.Parallel()` as first line in test functions

### 3. Pre-generated SSH Host Key (Low-Medium Impact)

- SSH tests now share a pre-generated RSA 4096-bit host key
- Key generation (~1.4s) happens once in `TestMain` instead of per-test
- Saved ~3 seconds total for SSH tests
- Implementation: `ssh/main_test.go` with `getSharedTestKeyPath()`

### 4. Test Fixes

Fixed 2 failing tests:
- `TestListSessions_IncludesCommitStatus`: Added `?includeClosed=true` parameter
- `TestGetTerminalStatus_Running`: Fixed expected status from "ready" to "running"

## Root Cause Analysis (Reference)

### Integration Tests - Why They Were Slow

Each integration test performed full infrastructure setup:
1. **GORM AutoMigrate** - SQLite database schema creation (~0.5s)
2. **Event poller** - Starts goroutine for event polling
3. **Dispatcher** - Leader election and job processing infrastructure

The database + infrastructure setup cost ~0.6-0.8s per test.

### SSH Tests - Why They Were Slow

- Each test generated a new RSA 4096-bit host key (~1.4s for crypto)
- Server lifecycle tests waited for connections and timeouts

## Further Optimization Opportunities

### Not Implemented (Diminishing Returns)

1. **Database connection pooling** - Already fast with template copy
2. **Lazy infrastructure** - Would require significant refactoring
3. **Reduce reconciliation test complexity** - Tests are testing real scenarios

## Running Test Groups

### Quick Feedback (Skip Slow Tests)

```bash
go test -short ./...                    # Skip 14 slowest tests (~40s)
go test -short ./internal/integration/  # Integration only, fast (~28s)
```

### Full Test Suite

```bash
go test ./...                           # All tests (~73s)
go test -count=1 ./...                  # Without cache
```

### By Category (Using -run)

```bash
go test -run API ./...                  # API endpoint tests
go test -run SSH ./...                  # SSH-related tests
go test -run Commit ./...               # Commit-related tests
go test -run Reconcile ./...            # Sandbox reconciliation tests
go test -run Unit ./...                 # Unit tests only
```

### By Package

```bash
go test ./internal/integration/...      # Integration tests only
go test ./internal/ssh/...              # SSH tests only
go test ./internal/service/...          # Service layer tests
go test ./internal/git/...              # Git provider tests
```

### PostgreSQL Testing

```bash
TEST_POSTGRES=1 go test ./internal/integration/...  # Use PostgreSQL container
```

## Potential Future Improvements

1. **Use ed25519 instead of RSA** for SSH keys (much faster generation)
2. **Mock database for pure unit tests** that don't need real SQL
3. **Split integration tests** into separate packages for parallel package execution
