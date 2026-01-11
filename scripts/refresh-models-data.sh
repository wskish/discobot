#!/bin/bash

# Refresh models.dev data - downloads the latest API data and provider logos
# Usage: ./scripts/refresh-models-data.sh
# Or via npm: npm run refresh-models

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_DIR/public/data/models-dev"
LOGOS_DIR="$DATA_DIR/logos"

echo "Refreshing models.dev data..."

# Create directories if they don't exist
mkdir -p "$LOGOS_DIR"

# Download api.json
echo "Downloading api.json..."
curl -s "https://models.dev/api.json" -o "$DATA_DIR/api.json"
echo "  Saved api.json ($(wc -c < "$DATA_DIR/api.json" | tr -d ' ') bytes)"

# Extract provider IDs and download logos
echo "Downloading provider logos..."
PROVIDERS=$(cat "$DATA_DIR/api.json" | jq -r 'keys[]')
TOTAL=$(echo "$PROVIDERS" | wc -l | tr -d ' ')
COUNT=0

for provider in $PROVIDERS; do
    COUNT=$((COUNT + 1))
    # Download logo (silently, don't fail on 404)
    if curl -sf "https://models.dev/logos/${provider}.svg" -o "$LOGOS_DIR/${provider}.svg" 2>/dev/null; then
        printf "\r  Downloaded %d/%d logos" "$COUNT" "$TOTAL"
    else
        printf "\r  Downloaded %d/%d logos (missing: %s)" "$COUNT" "$TOTAL" "$provider"
    fi
done

echo ""
echo "Done! Downloaded $COUNT provider logos."

# Show summary
echo ""
echo "Summary:"
echo "  API data: $DATA_DIR/api.json"
echo "  Logos: $LOGOS_DIR/"
echo "  Providers: $(cat "$DATA_DIR/api.json" | jq 'keys | length')"
