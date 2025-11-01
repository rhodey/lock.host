#!/bin/sh
set -e

# for tests
chown -f root /tmp/write || true

node host.js "$@"
