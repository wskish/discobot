#!/bin/bash
# Initialize /var contents on first boot
# Called after /var is mounted by fstab
set -e

# Check if /var needs initialization (no lib directory = empty/new)
if [ ! -d /var/lib ]; then
    echo "Initializing /var from skeleton..."
    # Copy from the read-only skeleton stored during image build
    cp -a /var.skel/* /var/ 2>/dev/null || true
    echo "/var initialization complete"
else
    echo "/var already initialized"
fi
