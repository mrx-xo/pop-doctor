#!/bin/sh
# Starts the Pop Doctor relay on Linux and macOS. In a terminal:  sh start-pop-doctor-relay.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is not installed, or not on the PATH."
    echo "Get it from https://nodejs.org or your package manager (version 18 or newer), then start this again."
    exit 1
fi
node pop-doctor-relay.mjs "$@"
echo
echo "The relay stopped."
