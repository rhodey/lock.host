#!/bin/sh
set -e

## all languages allow create child processes
## this program is how lock.host apps can talk to key servers
node /runtime/attest-key-server.js "$@"
