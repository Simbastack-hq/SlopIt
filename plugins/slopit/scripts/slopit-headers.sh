#!/bin/sh
# Claude Code headersHelper for the SlopIt MCP server.
# Prints the bearer header from $SLOPIT_API_KEY, else from ~/.config/slopit/api-key.
# With no key it prints {}: the server still connects, and `signup` works without one.
key="${SLOPIT_API_KEY:-}"
file="$HOME/.config/slopit/api-key"
if [ -z "$key" ] && [ -r "$file" ]; then
  key=$(tr -d ' \r\n' < "$file")
fi
case "$key" in
  '' | *[!A-Za-z0-9_-]*) printf '{}\n' ;;
  *) printf '{"Authorization":"Bearer %s"}\n' "$key" ;;
esac
