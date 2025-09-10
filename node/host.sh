#!/bin/sh
set -e

# for testing
chown -f root /tmp/write || true

# start
node host.js "$@"
