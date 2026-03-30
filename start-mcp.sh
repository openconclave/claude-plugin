#!/bin/bash
# Find OpenConclave installation
OC_DIR="${OPENCONCLAVE_DIR:-$HOME/.openconclave-app}"
if [ ! -d "$OC_DIR" ]; then
  echo "OpenConclave not installed. Run: curl -fsSL https://openconclave.com/install.sh | bash" >&2
  exit 1
fi
exec bun run "$OC_DIR/packages/server/src/mcp/server.ts"
