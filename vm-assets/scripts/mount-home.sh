#!/bin/bash
# Mount host home directory via VirtioFS at the path specified in kernel cmdline.
# Reads discobot.homedir=<path> from /proc/cmdline.
set -e

# Parse discobot.homedir= from kernel command line
HOMEDIR=""
for param in $(cat /proc/cmdline); do
    case "$param" in
        discobot.homedir=*)
            HOMEDIR="${param#discobot.homedir=}"
            ;;
    esac
done

if [ -z "$HOMEDIR" ]; then
    echo "No discobot.homedir= found in kernel cmdline, skipping VirtioFS mount"
    exit 0
fi

echo "Mounting host home directory at $HOMEDIR (read-only via VirtioFS)"

# The root filesystem is read-only (squashfs). On macOS the home directory
# is typically /Users/<name> which won't exist in the Linux guest.
#
# We mount a tmpfs over the first existing parent (e.g. /Users) so we can
# create the full mount point path, then mount VirtioFS on top.
if ! mkdir -p "$HOMEDIR" 2>/dev/null; then
    # Find the deepest existing ancestor directory
    PARENT="$HOMEDIR"
    while [ ! -d "$PARENT" ]; do
        PARENT="$(dirname "$PARENT")"
    done

    echo "Root is read-only, mounting tmpfs at $PARENT"
    mount -t tmpfs -o size=1M tmpfs "$PARENT"
    mkdir -p "$HOMEDIR"
fi

mount -t virtiofs home "$HOMEDIR" -o ro
echo "VirtioFS mount complete: $HOMEDIR"
