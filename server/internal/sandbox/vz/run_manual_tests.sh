#!/bin/bash
# Helper script to run VZ image downloader manual tests
# Usage: ./run_manual_tests.sh [test-name]
#
# Examples:
#   ./run_manual_tests.sh                           # Run all manual tests
#   ./run_manual_tests.sh TestImageDownloaderManual # Run specific test
#   ./run_manual_tests.sh TestImageDownloaderInvalidImage # Run error tests

set -e

# Check if running on macOS ARM64
if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "❌ Error: VZ tests can only run on macOS"
    echo "Current platform: $(uname -s)"
    exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
    echo "❌ Error: VZ tests require ARM64 architecture"
    echo "Current architecture: $(uname -m)"
    exit 1
fi

echo "🔍 Running VZ image downloader manual tests..."
echo ""

# Get test name from argument or run all
TEST_NAME="${1:-TestImageDownloader}"

# Set environment variable and run tests
cd "$(dirname "$0")/../../.." || exit 1

echo "📦 Test will download VZ images from registry"
echo "⏱️  This may take several minutes depending on your connection"
echo ""

VZ_MANUAL_TEST=1 go test -v ./internal/sandbox/vz -run "$TEST_NAME"

echo ""
echo "✅ Manual tests completed successfully!"
