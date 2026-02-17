#!/bin/bash
# Container entrypoint that captures Docker environment variables before exec'ing systemd.
#
# Docker sets environment variables on PID 1, but systemd doesn't propagate its own
# environment to child services. This script persists the environment to a file that
# systemd services can read via EnvironmentFile=.
set -e

ENV_DIR="/run/discobot"
mkdir -p "$ENV_DIR"

# Write all environment variables to a file for systemd services.
# Uses null-delimited /proc/1/environ format parsed into KEY=VALUE lines,
# which is more robust than `env` for values containing newlines.
env > "$ENV_DIR/container-env"

# Exec systemd as PID 1
exec /sbin/init
