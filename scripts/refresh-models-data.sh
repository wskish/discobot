#!/bin/bash

# Refresh models.dev data - downloads the latest API data for provider information
# Usage: ./scripts/refresh-models-data.sh
# Or via npm: npm run refresh-models
#
# Note: Provider logos are loaded directly from https://models.dev/logos/ CDN

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
API_OUTPUT="$PROJECT_DIR/server/static/models-dev-api.json"

echo "Refreshing models.dev data..."

# Download api.json to server/static/models-dev-api.json
echo "Downloading models.dev API data..."
curl -s "https://models.dev/api.json" | jq --sort-keys '.' > "$API_OUTPUT"
echo "  Saved models-dev-api.json ($(wc -c < "$API_OUTPUT" | tr -d ' ') bytes)"

# Show summary
echo ""
echo "Summary:"
echo "  API data: $API_OUTPUT"
echo "  Providers: $(cat "$API_OUTPUT" | jq 'keys | length')"
