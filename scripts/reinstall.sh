#!/usr/bin/env bash
# Reinstall the plugin from this working copy, so the desktop app and the CLI
# both run what is on disk. Run it after a change, before trying it out;
# already-open sessions keep the old code until they are restarted.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin="usage@usage-band"
marketplace="usage-band"

# Remove only what is there: a missing plugin is fine, a failed removal is not.
if claude plugin list | grep -qF "$plugin"; then
  claude plugin uninstall "$plugin"
fi
if claude plugin marketplace list | grep -qE "^[[:space:]]*(❯[[:space:]]*)?${marketplace}[[:space:]]*$"; then
  claude plugin marketplace remove "$marketplace"
fi

claude plugin marketplace add "$root"
claude plugin install "$plugin"

version="$(jq -r .version "$root/.claude-plugin/plugin.json")"
echo "installed ${plugin} ${version} from ${root}"
