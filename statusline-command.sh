#!/usr/bin/env bash
#
# PAI Statusline - Customizable status display for Claude Code
#
# CUSTOMIZATION:
#   - This script sources ${PAI_DIR}/.env for API keys and configuration
#   - Set PAI_SIMPLE_COLORS=1 in settings.json env for basic ANSI colors
#     (fixes display issues on some terminals)
#   - To add features requiring API keys (e.g., quotes), add keys to .env
#   - Comment out any printf lines you don't want displayed
#
# LINES DISPLAYED:
#   1. Greeting: DA name, model, directory
#   2. MCPs: server count, then names that fit the width (rest shown as +N)
#   3. Context: Current session context window usage (K / 200K)
#
# ENVIRONMENT VARIABLES (set in settings.json env section):
#   DA            - Your assistant's name (default: "Assistant")
#   DA_COLOR      - Name color: purple|blue|green|cyan|yellow|red|orange
#   PAI_SIMPLE_COLORS - Set to "1" to use basic terminal colors
#   PAI_NO_EMOJI  - Set to "1" to disable emojis (for terminals that don't render them)
#

# Source .env for API keys and custom configuration
claude_env="${PAI_DIR:-$HOME/.claude}/.env"
[ -f "$claude_env" ] && source "$claude_env"

# Read JSON input from stdin
input=$(cat)

# Get Digital Assistant configuration from environment
DA_NAME="${DA:-Assistant}"  # Assistant name
DA_COLOR="${DA_COLOR:-purple}"  # Color for the assistant name

# Where the status line keeps what it may cache between renders: the usage
# snapshots per provider and the Claude Code version. One knob rather than a
# path repeated six times, so a test (or a second user on the same machine)
# can point the whole lot somewhere private.
pai_cache_dir="${PAI_CACHE_DIR:-/tmp/claude}"

# PAI's per-user namespace dir — see src/config/pai-home.ts (paiHomeDir) for
# the canonical (TypeScript) version of this same resolver; this script
# can't import that module, so the new/old fallback logic is duplicated here.
pai_home_dir="${PAI_HOME:-$HOME/.claude/pai}"

# Resolve a PAI per-user file: the new PAI_HOME path if it exists, else the
# first existing old candidate (args 2+), else the new path. Mirrors
# resolvePaiFile() in src/config/pai-home.ts.
_pai_resolve_file() {
    _new="$1"; shift
    [ -f "$_new" ] && { printf '%s' "$_new"; return; }
    for _old in "$@"; do
        if [ -f "$_old" ]; then
            printf 'pai: %s is at an old location — run `pai config migrate` to move it to %s\n' "$_old" "$_new" >&2
            printf '%s' "$_old"
            return
        fi
    done
    printf '%s' "$_new"
}

# Extract data from JSON input.
#
# `.workspace.current_dir` is the documented field and a full session always
# sends it — but `jq -r` prints the JSON null as the four characters "null"
# when it is absent, and `basename null` is "null", so any payload without a
# workspace block rendered a confident "📁 null". A folder name is never
# unknowable here: the payload also carries the flat `.cwd`, and failing both
# we are running in the directory ourselves. Fall through all three.
current_dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null)
[ -n "$current_dir" ] && [ "$current_dir" != "null" ] || current_dir="${PWD:-}"
model_name=$(echo "$input" | jq -r '.model.display_name // empty' 2>/dev/null)
[ -n "$model_name" ] || model_name="?"
model_id=$(echo "$input" | jq -r '.model.id // .model.display_name // empty' 2>/dev/null)

# Claude Code version. The payload carries `.version` as a plain string, but a
# caller that sends a partial payload (a test harness, an older client) left it
# rendering the literal word "unknown" next to a version that `claude --version`
# would have answered immediately. Ask the binary, and cache the answer for a
# day: it is a ~200MB executable and the status line runs on every keystroke.
cc_version=$(echo "$input" | jq -r '.version // empty' 2>/dev/null)
if [ -z "$cc_version" ]; then
    _ccv_cache="${pai_cache_dir}/cc-version"
    _ccv_age=$(( $(date +%s) - $(stat -f %m "$_ccv_cache" 2>/dev/null || echo 0) ))
    if [ -s "$_ccv_cache" ] && [ "$_ccv_age" -lt 86400 ] 2>/dev/null; then
        read -r cc_version < "$_ccv_cache"
    elif command -v claude >/dev/null 2>&1; then
        # "2.1.267 (Claude Code)" -> "2.1.267"
        cc_version=$(command claude --version 2>/dev/null | awk 'NR==1{print $1}')
        if [ -n "$cc_version" ]; then
            mkdir -p "$pai_cache_dir" 2>/dev/null
            printf '%s\n' "$cc_version" > "$_ccv_cache" 2>/dev/null || true
        fi
    fi
fi
[ -n "$cc_version" ] || cc_version="?"

# Provider detection: which worker provider is this session running on? The
# answer comes from the PAI config, not from model-name prefixes — a session
# belongs to the provider that lists its model id under workers.providers.
# Any [...] suffix (e.g. the [1m] context marker) is stripped on both sides,
# so a session on "glm-5.3[1m]" matches a configured "glm-5.3" and vice versa.
# No config, no jq, unreadable JSON or no match => anthropic, silently.
# PAI_HOME (~/.claude/pai by default — see src/config/pai-home.ts) first;
# else fall back through the pre-2026-09-19 locations in the same order
# paiConfigFilePath() in src/daemon/config.ts does, since a shell script
# can't import that resolver.
pai_home_dir="${PAI_HOME:-$HOME/.claude/pai}"
pai_config="${PAI_CONFIG:-$pai_home_dir/config.json}"
if [ ! -f "$pai_config" ]; then
    if [ -f "$HOME/.claude/pai.json" ]; then
        pai_config="$HOME/.claude/pai.json"
    elif [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/pai/config.json" ]; then
        pai_config="${XDG_CONFIG_HOME:-$HOME/.config}/pai/config.json"
    fi
fi

# Providers moved to $pai_home_dir/workers.yaml (top-level `providers:`; see
# src/workers/config.ts readWorkersSection) on 2026-09-19 — jq never sees the
# YAML directly (no yq on this machine), so a small node script converts it
# via the `yaml` package sitting next to this script's own real location
# (readlink -f "$0": this file is usually reached through a symlink at
# ~/.claude/statusline-command.sh). The conversion is cached under
# pai_cache_dir, the cache kept only while it is newer than workers.yaml's own
# mtime, so node is spawned only when the YAML actually changed. Resolved once
# into $providers_file (holding just the providers object, unwrapped) so both
# this lookup and the usage block below read the same data — never re-derived.
# Any failure (no workers.yaml, no node, parse error) falls back silently to
# the legacy `.workers.providers` of $pai_config, then to anthropic.
providers_file=""
_workers_yaml="${pai_home_dir}/workers.yaml"
if [ -f "$_workers_yaml" ] && command -v node >/dev/null 2>&1; then
    _sl_script="$(readlink -f "$0" 2>/dev/null || echo "$0")"
    _sl_script_dir="$(dirname "$_sl_script")"
    _providers_cache="${pai_cache_dir}/statusline-providers.json"
    _yaml_mtime=$(stat -f %m "$_workers_yaml" 2>/dev/null || echo 0)
    _cache_mtime=$(stat -f %m "$_providers_cache" 2>/dev/null || echo -1)
    if [ ! -s "$_providers_cache" ] || [ "$_cache_mtime" -lt "$_yaml_mtime" ] 2>/dev/null; then
        mkdir -p "$pai_cache_dir" 2>/dev/null
        # umask 077 so the temp file is born 0600 — it must never exist at a
        # world-readable mode even transiently, since providers carry inline
        # `key:` secrets and only the allow-listed fields below leave this
        # subshell.
        (
            umask 077
            NODE_PATH="${_sl_script_dir}/node_modules" node - "$_workers_yaml" \
                > "${_providers_cache}.tmp" 2>/dev/null <<'PAI_YAML_PROVIDERS'
const fs = require("fs");
try {
    const YAML = require("yaml");
    const doc = YAML.parse(fs.readFileSync(process.argv[2], "utf8"));
    const providers = (doc && doc.providers) || {};
    // Allow-list: only what the status line ever reads from a provider.
    // workers.yaml is 0600 because providers carry inline `key:` secrets —
    // this cache must never repeat them (or `env`, `url`, `headers`, …).
    const safe = {};
    for (const [name, p] of Object.entries(providers || {})) {
        safe[name] = {
            models: (p && p.models) || {},
            usage: (p && p.usage) || undefined,
            keyFile: (p && p.keyFile) || undefined,
        };
    }
    process.stdout.write(JSON.stringify(safe));
} catch {
    process.exit(1);
}
PAI_YAML_PROVIDERS
        )
        if [ -s "${_providers_cache}.tmp" ]; then
            mv "${_providers_cache}.tmp" "$_providers_cache"
        else
            rm -f "${_providers_cache}.tmp"
        fi
    fi
    [ -s "$_providers_cache" ] && providers_file="$_providers_cache"
fi
if [ -z "$providers_file" ] && [ -f "$pai_config" ] && command -v jq >/dev/null 2>&1; then
    _providers_legacy="${pai_cache_dir}/statusline-providers-legacy.json"
    mkdir -p "$pai_cache_dir" 2>/dev/null
    # Same allow-list and 0600-from-birth handling as the YAML path above:
    # this legacy config can carry the same inline `key:` secrets.
    if (umask 077; jq -c '(.workers.providers // {}) | with_entries(.value |= {models, usage, keyFile})' "$pai_config" > "${_providers_legacy}.tmp" 2>/dev/null) \
        && [ -s "${_providers_legacy}.tmp" ]; then
        mv "${_providers_legacy}.tmp" "$_providers_legacy"
        providers_file="$_providers_legacy"
    else
        rm -f "${_providers_legacy}.tmp"
    fi
fi

model_base="${model_id%%\[*}"
session_provider=anthropic
if [ -n "$model_base" ] && [ -n "$providers_file" ] && command -v jq >/dev/null 2>&1; then
    _matched_provider=$(jq -r --arg mb "$model_base" '
        (. // {}) | to_entries[] as $p
        | (($p.value.models // {}) | to_entries[]) as $m
        | ($m.value | tostring) as $v
        | select($v == $mb or ($v | split("[")[0]) == $mb)
        | $p.key' "$providers_file" 2>/dev/null | head -1)
    [ -n "$_matched_provider" ] && session_provider="$_matched_provider"
fi

# Get directory name
dir_name=$(basename "$current_dir" 2>/dev/null)
[ -n "$dir_name" ] || dir_name="?"

# Read Whazaa session name from iTerm2 user variable
pai_session_name=""
if [ -n "$ITERM_SESSION_ID" ]; then
    ITERM_UUID="${ITERM_SESSION_ID##*:}"
    pai_session_name=$(osascript << APPLESCRIPT 2>/dev/null
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${ITERM_UUID}" then
          tell aSession
            try
              set v to (variable named "user.paiName")
              if v is missing value then return ""
              return v
            on error
              return ""
            end try
          end tell
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell
APPLESCRIPT
    )
fi

# Defence in depth: if the osascript text differs by version, iTerm2's unset
# variable can still surface as the literal "missing value" — normalise here.
[ "$pai_session_name" = "missing value" ] && pai_session_name=""

# Build session suffix (only if different from dir_name)
session_suffix=""
if [ -n "$pai_session_name" ] && [ "$pai_session_name" != "$dir_name" ]; then
    session_suffix=" • ${pai_session_name}"
fi

# Config directory
claude_dir="${PAI_DIR:-$HOME/.claude}"

# Collect MCP server names from all config sources (settings.json, .mcp.json,
# ~/.claude.json). Only entries that define a server (object with a command,
# type or url field) count: Claude Code also stores per-tool usage stats in
# mcpServers under tool-name keys ("Read", "mcp__pai__memory_search", …), and
# those must never reach the status line. Keys are newline-separated so names
# containing spaces survive.
mcp_names=""

_merge_mcps() {
    local file="$1"
    [ -f "$file" ] || return
    local names
    names=$(jq -r '.mcpServers // {} | to_entries[] | select(((.value | type) == "object") and (.value | (has("command") or has("type") or has("url")))) | .key' "$file" 2>/dev/null)
    [ -n "$names" ] || return
    if [ -n "$mcp_names" ]; then
        mcp_names="${mcp_names}
${names}"
    else
        mcp_names="$names"
    fi
}

# Read from all three MCP config locations
_merge_mcps "$claude_dir/settings.json"    # legacy
_merge_mcps "$claude_dir/.mcp.json"        # project-level
_merge_mcps "$HOME/.claude.json"           # user-level (e.g. Coogle, DEVONthink)

# Deduplicate (case-insensitive — macOS config keys drift in case), first
# spelling wins, order preserved
mcp_list=()
while IFS= read -r mcp_line; do
    mcp_list+=("$mcp_line")
done < <(printf '%s\n' "$mcp_names" | awk 'NF && !seen[tolower($0)]++')

# Extract context window usage from Claude Code's JSON input (no JSONL parsing needed)
context_pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0' 2>/dev/null)
# When the payload omits the window size, derive it from the model id instead
# of assuming 200k for every model: [1m] models carry a 1M window, everything
# else keeps the claude default. This value is persisted below for hooks.
default_context_size=200000
case "$model_id" in
    *"[1m]") default_context_size=1000000 ;;
esac
context_size=$(echo "$input" | jq -r --argjson d "$default_context_size" '.context_window.context_window_size // $d' 2>/dev/null)
context_used_k=$(( (context_pct * context_size / 100) / 1000 ))
context_max_k=$((context_size / 1000))

# Persist the authoritative context reading so hooks (which never receive
# context_window on their own stdin) can read it instead of re-deriving an
# estimate from the transcript. Best-effort only — a failure here must never
# affect the status line itself.
statusline_session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
if [ -n "$statusline_session_id" ]; then
    context_state_file="${TMPDIR:-/tmp}/pai-context-${statusline_session_id}.json"
    jq -n \
        --argjson used_percentage "${context_pct:-0}" \
        --argjson context_window_size "${context_size:-$default_context_size}" \
        --arg session_id "$statusline_session_id" \
        --argjson timestamp "$(date +%s000)" \
        '{used_percentage: $used_percentage, context_window_size: $context_window_size, session_id: $session_id, timestamp: $timestamp}' \
        > "$context_state_file" 2>/dev/null || true
fi

# Tokyo Night Storm Color Scheme
BACKGROUND='\033[48;2;36;40;59m'
BRIGHT_PURPLE='\033[38;2;187;154;247m'
BRIGHT_BLUE='\033[38;2;122;162;247m'
DARK_BLUE='\033[38;2;100;140;200m'
BRIGHT_GREEN='\033[38;2;158;206;106m'
DARK_GREEN='\033[38;2;130;170;90m'
BRIGHT_ORANGE='\033[38;2;255;158;100m'
BRIGHT_RED='\033[38;2;247;118;142m'
BRIGHT_CYAN='\033[38;2;125;207;255m'
BRIGHT_MAGENTA='\033[38;2;187;154;247m'
BRIGHT_YELLOW='\033[38;2;224;175;104m'

# Map DA_COLOR to actual ANSI color code
case "$DA_COLOR" in
    "purple") DA_DISPLAY_COLOR='\033[38;2;147;112;219m' ;;
    "blue") DA_DISPLAY_COLOR="$BRIGHT_BLUE" ;;
    "green") DA_DISPLAY_COLOR="$BRIGHT_GREEN" ;;
    "cyan") DA_DISPLAY_COLOR="$BRIGHT_CYAN" ;;
    "magenta") DA_DISPLAY_COLOR="$BRIGHT_MAGENTA" ;;
    "yellow") DA_DISPLAY_COLOR="$BRIGHT_YELLOW" ;;
    "red") DA_DISPLAY_COLOR="$BRIGHT_RED" ;;
    "orange") DA_DISPLAY_COLOR="$BRIGHT_ORANGE" ;;
    *) DA_DISPLAY_COLOR='\033[38;2;147;112;219m' ;;  # Default to purple
esac

# Line-specific colors
LINE1_PRIMARY="$BRIGHT_PURPLE"
LINE1_ACCENT='\033[38;2;160;130;210m'
MODEL_PURPLE='\033[38;2;138;99;210m'

LINE2_PRIMARY="$DARK_BLUE"
LINE2_ACCENT='\033[38;2;110;150;210m'

LINE3_PRIMARY="$DARK_GREEN"
LINE3_ACCENT='\033[38;2;140;180;100m'
COST_COLOR="$LINE3_ACCENT"
TOKENS_COLOR='\033[38;2;169;177;214m'

SEPARATOR_COLOR='\033[38;2;140;152;180m'
DIR_COLOR='\033[38;2;135;206;250m'

# MCP colors
MCP_DAEMON="$BRIGHT_BLUE"
MCP_STRIPE="$LINE2_ACCENT"
MCP_DEFAULT="$LINE2_PRIMARY"

# Reset includes explicit background clear for terminal compatibility
RESET='\033[0m\033[49m'

# Emoji definitions - can be disabled with PAI_NO_EMOJI=1
if [ "${PAI_NO_EMOJI:-0}" = "1" ]; then
    EMOJI_WAVE=">"
    EMOJI_BRAIN="*"
    EMOJI_FOLDER="@"
    EMOJI_PLUG="+"
    EMOJI_BOOK="#"
    EMOJI_GEM="$"
else
    EMOJI_WAVE="👋"
    EMOJI_BRAIN="🧠"
    EMOJI_FOLDER="📁"
    EMOJI_PLUG="🔌"
    EMOJI_BOOK="📚"
    EMOJI_GEM="💎"
fi

# Simple colors mode - set PAI_SIMPLE_COLORS=1 if you have terminal display issues
if [ "${PAI_SIMPLE_COLORS:-0}" = "1" ]; then
    # Use basic ANSI colors instead of 24-bit RGB for terminal compatibility
    BRIGHT_PURPLE='\033[35m'
    BRIGHT_BLUE='\033[34m'
    DARK_BLUE='\033[34m'
    BRIGHT_GREEN='\033[32m'
    DARK_GREEN='\033[32m'
    BRIGHT_ORANGE='\033[33m'
    BRIGHT_RED='\033[31m'
    BRIGHT_CYAN='\033[36m'
    BRIGHT_MAGENTA='\033[35m'
    BRIGHT_YELLOW='\033[33m'
    # Override derived colors
    DA_DISPLAY_COLOR='\033[35m'
    LINE1_PRIMARY='\033[35m'
    LINE1_ACCENT='\033[35m'
    MODEL_PURPLE='\033[35m'
    LINE2_PRIMARY='\033[34m'
    LINE2_ACCENT='\033[34m'
    LINE3_PRIMARY='\033[32m'
    LINE3_ACCENT='\033[32m'
    COST_COLOR='\033[32m'
    TOKENS_COLOR='\033[37m'
    SEPARATOR_COLOR='\033[37m'
    DIR_COLOR='\033[36m'
    MCP_DAEMON='\033[34m'
    MCP_STRIPE='\033[34m'
    MCP_DEFAULT='\033[34m'
fi

# Format the MCP segment (see the render block below)
# Terminal width for line truncation
# Claude Code's statusline subprocess can't detect resize (stty returns stale values).
# To set your width:  echo 105 > ~/.claude/.statusline_width
# Default 80 is safe for any terminal; set higher (e.g., 105) for wide screens.
term_width=80
[ -f "${claude_dir}/.statusline_width" ] && read -r term_width < "${claude_dir}/.statusline_width" 2>/dev/null
[ "$term_width" -gt 0 ] 2>/dev/null || term_width=80
mcp_prefix_width=10  # visual width of "🔌 MCPs: " (emoji=2 + space + "MCPs: " = 10)

# Display-name mapping for known servers
_mcp_display_name() {
    case "$1" in
        "daemon") echo "Daemon" ;;
        "stripe") echo "Stripe" ;;
        "httpx") echo "HTTPx" ;;
        "brightdata") echo "BrightData" ;;
        "naabu") echo "Naabu" ;;
        "apify") echo "Apify" ;;
        "content") echo "Content" ;;
        "Ref") echo "Ref" ;;
        "pai") echo "PAI" ;;
        "playwright") echo "PW" ;;
        "macos_automator") echo "macOS" ;;
        "claude_ai_Gmail") echo "Gmail" ;;
        "claude_ai_Google_Calendar") echo "GCal" ;;
        # capitalize without bash-4 ${n^} so /bin/bash 3.2 renders names too
        *) local n="$1"
           printf '%s%s' "$(printf '%s' "$n" | cut -c1 | tr '[:lower:]' '[:upper:]')" "$(printf '%s' "$n" | cut -c2-)" ;;
    esac
}

_mcp_formatted() {
    local display_name="$1"
    case "$display_name" in
        "Daemon") printf "${MCP_DAEMON}%s${RESET}" "$display_name" ;;
        "Stripe") printf "${MCP_STRIPE}%s${RESET}" "$display_name" ;;
        *) printf "${MCP_DEFAULT}%s${RESET}" "$display_name" ;;
    esac
}

# Build the MCP segment: "N: name1, name2, … +K" — total server count first,
# then as many display names as fit the width (hard cap regardless of width),
# the rest collapsed into "+K". Always a single line: what doesn't fit is
# counted, never printed.
mcp_total=${#mcp_list[@]}
mcp_line1=""

if [ "$mcp_total" -eq 0 ]; then
    mcp_line1="none"
else
    mcp_max_names=6
    # Width budget for the name list: terminal minus prefix, minus the leading
    # "N: " and a reserve for the trailing " +K" overflow marker
    mcp_budget=$(( term_width - mcp_prefix_width - ${#mcp_total} - 2 - 6 ))
    [ "$mcp_budget" -lt 12 ] && mcp_budget=12
    mcp_width=0
    mcp_shown=0
    mcp_overflow=0
    for mcp in "${mcp_list[@]}"; do
        dn=$(_mcp_display_name "$mcp")
        w_add=${#dn}
        [ "$mcp_shown" -gt 0 ] && w_add=$(( w_add + 2 ))  # ", " separator
        if [ "$mcp_shown" -ge "$mcp_max_names" ] || [ $(( mcp_width + w_add )) -gt "$mcp_budget" ]; then
            mcp_overflow=$(( mcp_overflow + 1 ))
            continue
        fi
        fm=$(_mcp_formatted "$dn")
        if [ "$mcp_shown" -eq 0 ]; then
            mcp_line1="${mcp_total}${SEPARATOR_COLOR}: ${RESET}${fm}"
            mcp_width=${#mcp_total}
        else
            mcp_line1="${mcp_line1}${SEPARATOR_COLOR}, ${fm}"
            mcp_width=$(( mcp_width + 2 ))
        fi
        mcp_width=$(( mcp_width + ${#dn} ))
        mcp_shown=$(( mcp_shown + 1 ))
    done
    if [ "$mcp_shown" -eq 0 ]; then
        # Even the first name exceeds the budget — truncate that one name
        dn=$(_mcp_display_name "${mcp_list[0]}")
        avail=$(( mcp_budget - 1 ))
        [ "$avail" -lt 3 ] && avail=3
        dn="${dn:0:$((avail - 1))}…"
        mcp_line1="${mcp_total}${SEPARATOR_COLOR}: ${RESET}$(_mcp_formatted "$dn")"
        mcp_overflow=$(( mcp_total - 1 ))
    fi
    [ "$mcp_overflow" -gt 0 ] && mcp_line1="${mcp_line1}${SEPARATOR_COLOR} +${RESET}${LINE2_ACCENT}${mcp_overflow}${RESET}"
fi

# Output the statusline
# LINE 1 - Greeting (adaptive: drop CC version when narrow, shorten further if very narrow)
line1_full="${EMOJI_WAVE} ${DA_DISPLAY_COLOR}${DA_NAME}${RESET} ${MODEL_PURPLE}CC ${cc_version}${RESET}${LINE1_PRIMARY} ${MODEL_PURPLE}${EMOJI_BRAIN} ${model_name}${RESET}${LINE1_PRIMARY} in ${DIR_COLOR}${EMOJI_FOLDER} ${dir_name}${BRIGHT_CYAN}${session_suffix}${RESET}"
line1_medium="${EMOJI_WAVE} ${DA_DISPLAY_COLOR}${DA_NAME}${RESET} ${MODEL_PURPLE}${EMOJI_BRAIN} ${model_name}${RESET}${LINE1_PRIMARY} in ${DIR_COLOR}${EMOJI_FOLDER} ${dir_name}${BRIGHT_CYAN}${session_suffix}${RESET}"
line1_short="${EMOJI_WAVE} ${MODEL_PURPLE}${EMOJI_BRAIN} ${model_name}${RESET}${LINE1_PRIMARY} ${DIR_COLOR}${EMOJI_FOLDER} ${dir_name}${BRIGHT_CYAN}${session_suffix}${RESET}"

# Pick line 1 format based on width (plain-text lengths: full~85, medium~45, short~25)
if [ $term_width -ge 90 ]; then
    printf "${line1_full}\n"
elif [ $term_width -ge 50 ]; then
    printf "${line1_medium}\n"
else
    printf "${line1_short}\n"
fi

# LINE 2 - MCPs (single line, capped by width; overflow shown as +N)
printf "${LINE2_PRIMARY}${EMOJI_PLUG} MCPs${RESET}${LINE2_PRIMARY}${SEPARATOR_COLOR}: ${RESET}${mcp_line1}${RESET}\n"


# Usage suffix: provider-aware. Every non-anthropic provider is rendered from
# its own `usage` block in the PAI config (see docs/provider-abstraction.md) —
# endpoint, auth header and per-window jq expressions are config, not code.
#
# The anthropic numbers come from Claude Code itself. Its status line payload
# carries a `rate_limits` object built from the same internal reading that
# /usage renders:
#
#     "rate_limits": {
#       "five_hour": { "used_percentage": 9, "resets_at": 1789810200 },
#       "seven_day": { "used_percentage": 2, "resets_at": 1790402400 }
#     }
#
# `used_percentage` is already 0-100 (used, not remaining) and `resets_at` is
# Unix epoch SECONDS. It is live, free and needs no credential.
#
# The OAuth usage endpoint below stays only as a fallback for payloads that
# carry no rate_limits (it reports `utilization` on the same 0-100 scale but
# `resets_at` as an ISO-8601 UTC string, so the two are parsed differently).
# That endpoint needs an OAuth token out of the Keychain, and when the token
# goes away the fetch fails silently and leaves whatever it cached last. A
# cache with no expiry is not a reading, it is a photograph: this one sat at
# "7d: 97%" for a day and a half after the window had already reset to 2%, and
# that number is not decoration — it is written to advisor-mode.json and
# injected into every session as an instruction about how much work to do. So
# the fallback is refused once it is older than usage_cache_max_age, and any
# window whose resets_at has already passed is dropped. What neither source can
# answer renders "?", which is the honest reading.
usage_cache="${pai_cache_dir}/statusline-usage-cache.json"
usage_cache_ttl=60       # refetch the fallback after this many seconds
usage_cache_max_age=300  # refuse to render from the fallback past this age
usage_suffix=""

# Color based on utilization: green < 50%, orange 50-75%, red > 75%.
# An unknown percentage is neither good nor bad news — render it neutral.
_usage_color() {
    local pct=$1
    if [ -z "$pct" ]; then echo "$LINE3_ACCENT"
    elif [ "$pct" -gt 75 ] 2>/dev/null; then echo "$BRIGHT_RED"
    elif [ "$pct" -gt 50 ] 2>/dev/null; then echo "$BRIGHT_ORANGE"
    else echo "$BRIGHT_GREEN"; fi
}

_fetch_usage() {
    # Try to get OAuth token from macOS Keychain
    local token=""
    # More than one keychain item can carry this service name: the real one is
    # stored under the login user account, and a stub with empty tokens has
    # been seen under acct "unknown". Without -a the first match wins, so ask
    # for the user item first and only then fall back to an unqualified read.
    local raw
    raw=$(security find-generic-password -s "Claude Code-credentials" -a "$(id -un)" -w 2>/dev/null)
    token=$(printf '%s' "$raw" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
    if [ -z "$token" ]; then
        raw=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
        token=$(printf '%s' "$raw" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
    fi

    mkdir -p "$pai_cache_dir"
    if [ -z "$token" ]; then
        echo "no usable OAuth token in keychain item Claude Code-credentials" > "$usage_cache.error"
        return
    fi
    # Per-process temp file: several renders may fetch at once.
    local tmp="$usage_cache.tmp.$$" http
    http=$(curl -s --max-time 3 -o "$tmp" -w '%{http_code}' \
        -H "Authorization: Bearer $token" \
        -H "anthropic-beta: oauth-2025-04-20" \
        "https://api.anthropic.com/api/oauth/usage" 2>/dev/null)
    if [ "$http" = "200" ] && [ -s "$tmp" ]; then
        mv -f "$tmp" "$usage_cache"
        rm -f "$usage_cache.error"
    else
        echo "usage fetch failed: http ${http:-timeout}" > "$usage_cache.error"
        rm -f "$tmp"
    fi
}

# Resolve the anthropic windows — skipped on non-anthropic sessions so
# Anthropic-plan numbers (usage line AND the advisor-mode budget file)
# never leak into a glm or kimi statusline. A worker running on another
# provider spends another budget; counting it here would be the same lie in
# the other direction.
five_hour_int=""
seven_day_int=""
five_reset_epoch=0
seven_reset_epoch=0
usage_source=""

# Source 1 (authoritative): rate_limits on stdin, straight from Claude Code.
if [ "$session_provider" = "anthropic" ]; then
    _rl=$(echo "$input" | jq -r '
        [ (.rate_limits.five_hour.used_percentage // ""),
          (.rate_limits.five_hour.resets_at      // ""),
          (.rate_limits.seven_day.used_percentage // ""),
          (.rate_limits.seven_day.resets_at       // "") ] | @tsv' 2>/dev/null)
    _p5=$(printf '%s' "$_rl" | cut -f1)
    _r5=$(printf '%s' "$_rl" | cut -f2)
    _p7=$(printf '%s' "$_rl" | cut -f3)
    _r7=$(printf '%s' "$_rl" | cut -f4)
    if [ -n "$_p5" ] || [ -n "$_p7" ]; then
        usage_source="payload"
        [ -n "$_p5" ] && five_hour_int=$(printf "%.0f" "$_p5" 2>/dev/null || echo "")
        [ -n "$_p7" ] && seven_day_int=$(printf "%.0f" "$_p7" 2>/dev/null || echo "")
        # resets_at is epoch seconds here, not an ISO string.
        case "$_r5" in ''|*[!0-9.]*) ;; *) five_reset_epoch="${_r5%%.*}" ;; esac
        case "$_r7" in ''|*[!0-9.]*) ;; *) seven_reset_epoch="${_r7%%.*}" ;; esac
    fi
fi

# Refresh the fallback in the background, but only when the payload did not
# already answer — a keychain lookup plus an HTTPS round trip on every render
# buys nothing when the live numbers arrived on stdin.
if [ "$session_provider" = "anthropic" ] && [ -z "$usage_source" ]; then
    if [ -f "$usage_cache" ]; then
        cache_age=$(( $(date +%s) - $(stat -f %m "$usage_cache" 2>/dev/null || echo 0) ))
        [ "$cache_age" -gt "$usage_cache_ttl" ] && _fetch_usage &
    else
        _fetch_usage &
    fi
fi

# Source 2 (fallback): the OAuth endpoint cache, and only while it is fresh.
if [ "$session_provider" = "anthropic" ] && [ -z "$usage_source" ] && [ -f "$usage_cache" ]; then
    _usage_cache_age=$(( $(date +%s) - $(stat -f %m "$usage_cache" 2>/dev/null || echo 0) ))
    if [ "$_usage_cache_age" -le "$usage_cache_max_age" ] 2>/dev/null; then
        usage_source="oauth"
        five_hour=$(jq -r '.five_hour.utilization // empty' "$usage_cache" 2>/dev/null)
        seven_day=$(jq -r '.seven_day.utilization // empty' "$usage_cache" 2>/dev/null)
        five_reset=$(jq -r '.five_hour.resets_at // empty' "$usage_cache" 2>/dev/null)
        seven_reset=$(jq -r '.seven_day.resets_at // empty' "$usage_cache" 2>/dev/null)
        [ -n "$five_hour" ] && five_hour_int=$(printf "%.0f" "$five_hour" 2>/dev/null || echo "")
        [ -n "$seven_day" ] && seven_day_int=$(printf "%.0f" "$seven_day" 2>/dev/null || echo "")
        # The endpoint states these in UTC ("...T06:00:00+00:00"). Parsing
        # without -u reads 06:00 UTC as 06:00 local and prints a reset time out
        # by the offset — two hours here, long enough to plan around and be
        # wrong. Parse as UTC to get the epoch; render local further down.
        if [ -n "$five_reset" ]; then
            five_reset_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "$(echo "$five_reset" | cut -c1-19)" "+%s" 2>/dev/null || date -d "$five_reset" "+%s" 2>/dev/null || echo 0)
        fi
        if [ -n "$seven_reset" ]; then
            seven_reset_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "$(echo "$seven_reset" | cut -c1-19)" "+%s" 2>/dev/null || date -d "$seven_reset" "+%s" 2>/dev/null || echo 0)
        fi
    fi
fi

# A window whose reset has already passed describes a window that no longer
# exists. Its percentage belongs to a period that has been and gone, so it is
# dropped rather than carried forward — a spent budget rendered as the current
# one is exactly the failure this whole block exists to avoid.
if [ "$session_provider" = "anthropic" ]; then
    _now_epoch=$(date +%s)
    if [ "$five_reset_epoch" -gt 0 ] 2>/dev/null && [ "$five_reset_epoch" -le "$_now_epoch" ] 2>/dev/null; then
        five_hour_int=""; five_reset_epoch=0
    fi
    if [ "$seven_reset_epoch" -gt 0 ] 2>/dev/null && [ "$seven_reset_epoch" -le "$_now_epoch" ] 2>/dev/null; then
        seven_day_int=""; seven_reset_epoch=0
    fi
fi

# Rendered even when both windows are unknown: "5h: ? │ 7d: ?" says the
# instrument is blind, where dropping the section altogether would read as
# "this session is not on the anthropic plan".
if [ "$session_provider" = "anthropic" ]; then
    # Format reset times in local time
    five_reset_fmt=""
    seven_reset_fmt=""
    [ "$five_reset_epoch" -gt 0 ] 2>/dev/null && five_reset_fmt=$(date -r "$five_reset_epoch" "+%H:%M" 2>/dev/null || echo "")
    [ "$seven_reset_epoch" -gt 0 ] 2>/dev/null && seven_reset_fmt=$(date -r "$seven_reset_epoch" "+%a %H:%M" 2>/dev/null || echo "")

    five_color=$(_usage_color "$five_hour_int")
    seven_color=$(_usage_color "$seven_day_int")

    # Budget pace indicator for 7-day window
    # Compare actual usage vs linear expected usage based on elapsed time
    pace_dot=""
    if [ "$seven_reset_epoch" -gt 0 ] 2>/dev/null && [ -n "$seven_day_int" ]; then
        now_epoch=$(date +%s)
        window_secs=$((7 * 86400))
        remaining_secs=$((seven_reset_epoch - now_epoch))
        [ "$remaining_secs" -lt 0 ] && remaining_secs=0
        elapsed_secs=$((window_secs - remaining_secs))
        # Daily pace: actual spend/day vs dynamic budget
        # Budget = remaining capacity / remaining days (not static 100/7)
        elapsed_days_x10=$((elapsed_secs * 10 / 86400))
        # A per-day rate divided by a fraction of a day is not a rate, it is an
        # extrapolation from noise: an hour into a fresh window the old clamp to
        # 0.1 days turned 2% spent into "20% per day" and painted the pace red.
        # Below half a day there is nothing to pace against yet — say nothing.
        if [ "$elapsed_days_x10" -ge 5 ]; then
            spend_per_day=$((seven_day_int * 10 / elapsed_days_x10))
            remaining_days_x10=$((remaining_secs * 10 / 86400))
            [ "$remaining_days_x10" -lt 1 ] && remaining_days_x10=1
            remaining_budget=$((100 - seven_day_int))
            budget_per_day=$((remaining_budget * 10 / remaining_days_x10))
            # Color: green = under budget, orange = near budget, red = over budget
            overspend=$((spend_per_day - budget_per_day))
            if [ "$overspend" -le -3 ] 2>/dev/null; then
                pace_color="$BRIGHT_GREEN"           # well under budget
            elif [ "$overspend" -le 2 ] 2>/dev/null; then
                pace_color="$BRIGHT_ORANGE"          # near budget
            else
                pace_color="$BRIGHT_RED"             # over budget
            fi
            pace_dot="${pace_color}${spend_per_day}%% / ${budget_per_day}%%${RESET}"
        fi
    fi

    # Write weekly budget to advisor-mode.json for the whisper hook.
    # Preserve existing mode if manually set — only update weeklyBudgetPercent.
    #
    # `asOf` is the epoch second the percentage was read. The consumer refuses a
    # percentage without one, or one that has gone stale: this file is the input
    # to an instruction injected on every prompt ("weekly budget at N% — do as
    # little as possible"), so a number that stopped being refreshed must stop
    # being obeyed rather than quietly harden into a permanent constraint.
    # Nothing is written at all while the percentage is unknown.
    _advisor_file=$(_pai_resolve_file "${pai_home_dir}/advisor-mode.json" "${HOME}/.claude/advisor-mode.json")
    mkdir -p "$(dirname "$_advisor_file")" 2>/dev/null
    _existing_mode="auto"
    _existing_force=""
    if [ -f "$_advisor_file" ]; then
        _existing_mode=$(jq -r '.mode // "auto"' "$_advisor_file" 2>/dev/null)
        _existing_force=$(jq -r '.forceModel // empty' "$_advisor_file" 2>/dev/null)
    fi
    case "$_existing_mode" in
        normal|conservative|strict|critical|auto) ;;
        *) _existing_mode="auto" ;;
    esac
    if [ -n "$seven_day_int" ]; then
        if [ -n "$_existing_force" ]; then
            printf '{"weeklyBudgetPercent":%d,"asOf":%d,"mode":"%s","forceModel":"%s"}\n' "$seven_day_int" "$(date +%s)" "$_existing_mode" "$_existing_force" > "$_advisor_file" 2>/dev/null
        else
            printf '{"weeklyBudgetPercent":%d,"asOf":%d,"mode":"%s"}\n' "$seven_day_int" "$(date +%s)" "$_existing_mode" > "$_advisor_file" 2>/dev/null
        fi
    fi

    # Build usage suffix: 5h: 8% → 00:59 │ 1d: ● 29% / 36% │ 7d: 91% → Fr. 08:00
    # A window we could not read renders "?" — a gauge that admits it cannot
    # tell beats one reading 0% while the tank drains. The advisor mode word is
    # deliberately not rendered here; the whisper hook is where it acts.
    five_label="5h: ${five_hour_int:-?}%%"
    [ -n "$five_reset_fmt" ] && five_label="${five_label} → ${five_reset_fmt}"
    seven_label="7d: "
    seven_label="${seven_label}${seven_day_int:-?}%%"
    [ -n "$seven_reset_fmt" ] && seven_label="${seven_label} → ${seven_reset_fmt}"

    usage_suffix=" ${SEPARATOR_COLOR}│${RESET} ${five_color}${five_label}${RESET}"
    [ -n "$pace_dot" ] && usage_suffix="${usage_suffix} ${SEPARATOR_COLOR}│${RESET} ${LINE3_PRIMARY}1d:${RESET} ${pace_dot}"
    usage_suffix="${usage_suffix} ${SEPARATOR_COLOR}│${RESET} ${seven_color}${seven_label}${RESET}"
fi

# Plan quota for a configured (non-anthropic) provider, driven entirely by
# its `usage` block: a JSON GET endpoint plus one jq expression per window.
# Fetches in the background into a per-provider cache, exactly as the OAuth
# path above does, and never blocks the status line on the network.
#
# Args: url, auth-header template, key file, cache path, probe expression.
# The probe is the first window's percent expression: a provider that answers
# HTTP 200 with an empty body (a rejected key often does) would otherwise be
# cached as a valid "no windows" reading, so a response that yields no number
# for it is dropped rather than stored.
_fetch_provider_usage() {
    local url="$1" auth="$2" keyfile="$3" cache="$4" probe="$5"
    local key=""
    if [ -n "$keyfile" ] && [ -f "$keyfile" ]; then
        key=$(tr -d '[:space:]' < "$keyfile")
    fi
    [ -n "$key" ] || return
    # "Authorization: Bearer" (has a space) → "Authorization: Bearer <key>";
    # a single token like "x-api-key" → "x-api-key: <key>".
    local header
    if [ "${auth#* }" != "$auth" ]; then
        header="${auth} ${key}"
    else
        header="${auth}: ${key}"
    fi
    mkdir -p "$pai_cache_dir"
    local response
    response=$(curl -sf --max-time 3 \
        -H "$header" \
        -H "Accept: application/json" \
        "$url" 2>/dev/null)
    [ -n "$response" ] || return
    if [ -n "$probe" ]; then
        printf '%s' "$response" | jq -e "($probe) | numbers" >/dev/null 2>&1 || return
    fi
    printf '%s' "$response" > "$cache"
}

# Usage rendering for a configured provider. anthropic has already been
# rendered from the OAuth cache above; everything else is rendered here from
# its usage block, or shows "<provider> usage n/a" when it has none.
if [ "$session_provider" != "anthropic" ]; then
    provider_usage=""
    provider_keyfile=""
    if [ -n "$providers_file" ] && command -v jq >/dev/null 2>&1; then
        provider_usage=$(jq -c --arg p "$session_provider" '.[$p].usage // empty' "$providers_file" 2>/dev/null)
        provider_keyfile=$(jq -r --arg p "$session_provider" '.[$p].keyFile // empty' "$providers_file" 2>/dev/null)
        case "$provider_keyfile" in "~/"*) provider_keyfile="$HOME/${provider_keyfile#\~/}" ;; esac
    fi

    if [ -n "$provider_usage" ]; then
        usage_label=$(printf '%s' "$provider_usage" | jq -r --arg p "$session_provider" '.label // $p')
        usage_url=$(printf '%s' "$provider_usage" | jq -r '.url // empty')
        usage_auth=$(printf '%s' "$provider_usage" | jq -r '.authHeader // "Authorization: Bearer"')
        usage_ttl=$(printf '%s' "$provider_usage" | jq -r '.ttlSeconds // empty')
        [ "$usage_ttl" -gt 0 ] 2>/dev/null || usage_ttl="$usage_cache_ttl"
        provider_cache="${pai_cache_dir}/statusline-usage-${session_provider}.json"
        usage_probe=$(printf '%s' "$provider_usage" | jq -r '.windows[0].percent // empty')

        # Use cache if fresh, otherwise refresh in the background
        if [ -n "$usage_url" ]; then
            if [ -f "$provider_cache" ]; then
                cache_age=$(( $(date +%s) - $(stat -f %m "$provider_cache" 2>/dev/null || echo 0) ))
                if [ "$cache_age" -gt "$usage_ttl" ]; then
                    _fetch_provider_usage "$usage_url" "$usage_auth" "$provider_keyfile" "$provider_cache" "$usage_probe" &
                fi
            else
                _fetch_provider_usage "$usage_url" "$usage_auth" "$provider_keyfile" "$provider_cache" "$usage_probe" &
            fi
        fi

        provider_suffix=""
        if [ -f "$provider_cache" ]; then
            window_count=$(printf '%s' "$provider_usage" | jq -r '.windows | length' 2>/dev/null || echo 0)
            window_i=0
            while [ "$window_i" -lt "$window_count" ] 2>/dev/null; do
                w_name=$(printf '%s' "$provider_usage" | jq -r --argjson i "$window_i" '.windows[$i].name // empty')
                w_pct_expr=$(printf '%s' "$provider_usage" | jq -r --argjson i "$window_i" '.windows[$i].percent // empty')
                w_reset_expr=$(printf '%s' "$provider_usage" | jq -r --argjson i "$window_i" '.windows[$i].resetAt // empty')
                w_reset_unit=$(printf '%s' "$provider_usage" | jq -r --argjson i "$window_i" '.windows[$i].resetUnit // "ms"')
                window_i=$(( window_i + 1 ))

                w_pct=""
                [ -n "$w_pct_expr" ] && w_pct=$(jq -r "($w_pct_expr) // empty" "$provider_cache" 2>/dev/null | head -1)
                [ -n "$w_pct" ] && [ "$w_pct" != "null" ] || continue
                w_pct_int=$(printf "%.0f" "$w_pct" 2>/dev/null || echo "?")

                w_reset_fmt=""
                if [ -n "$w_reset_expr" ]; then
                    w_reset=$(jq -r "($w_reset_expr) // empty" "$provider_cache" 2>/dev/null | head -1)
                    w_epoch=0
                    case "$w_reset_unit" in
                        iso)
                            [ -n "$w_reset" ] && w_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "$(printf '%s' "$w_reset" | cut -c1-19)" "+%s" 2>/dev/null || date -d "$w_reset" "+%s" 2>/dev/null || echo 0)
                            ;;
                        s)
                            case "$w_reset" in ''|*[!0-9.]*) ;; *) w_epoch="${w_reset%%.*}" ;; esac
                            ;;
                        *)
                            # epoch milliseconds (the default); date -r wants seconds
                            case "$w_reset" in ''|*[!0-9.]*) ;; *) w_epoch=$(( ${w_reset%%.*} / 1000 )) ;; esac
                            ;;
                    esac
                    if [ "$w_epoch" -gt 0 ] 2>/dev/null; then
                        # Within the next 24h the weekday carries no information;
                        # beyond it, the bare time would be ambiguous.
                        if [ $(( w_epoch - $(date +%s) )) -lt 86400 ]; then
                            w_reset_fmt=$(date -r "$w_epoch" "+%H:%M" 2>/dev/null || echo "")
                        else
                            w_reset_fmt=$(date -r "$w_epoch" "+%a %H:%M" 2>/dev/null || echo "")
                        fi
                    fi
                fi

                w_label="${usage_label} ${w_name}: ${w_pct_int}%%"
                [ -n "$w_reset_fmt" ] && w_label="${w_label} → ${w_reset_fmt}"
                provider_suffix="${provider_suffix} ${SEPARATOR_COLOR}│${RESET} $(_usage_color "$w_pct_int")${w_label}${RESET}"
            done
        fi

        if [ -n "$provider_suffix" ]; then
            usage_suffix="$provider_suffix"
        else
            # No key, timeout, non-200 or an unusable response — show the
            # marker instead of silently falling back to Anthropic numbers.
            usage_suffix=" ${SEPARATOR_COLOR}│${RESET} ${LINE3_ACCENT}${usage_label} usage ?${RESET}"
        fi
    else
        # A provider without a usage block has no quota endpoint to read.
        usage_suffix=" ${SEPARATOR_COLOR}│${RESET} ${LINE3_ACCENT}${session_provider} usage n/a${RESET}"
    fi
fi

# LINE 3 - Context meter + usage limits
# Auto-compact remaining: how much context left until compaction triggers
ac_threshold="${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:-80}"
ac_remaining=$((ac_threshold - context_pct))
[ "$ac_remaining" -lt 0 ] && ac_remaining=0
# Color the remaining %: red ≤5, yellow ≤15, green otherwise
if [ "$ac_remaining" -le 5 ] 2>/dev/null; then
    ac_color="$BRIGHT_RED"
elif [ "$ac_remaining" -le 15 ] 2>/dev/null; then
    ac_color="$BRIGHT_YELLOW"
else
    ac_color="$BRIGHT_GREEN"
fi
ac_suffix=" ${ac_color}(${ac_remaining}%% left)${RESET}"

if [ "$context_pct" -gt 0 ] 2>/dev/null; then
    # Color based on usage: green < 50%, yellow 50-75%, red > 75%
    if [ $context_pct -gt 75 ]; then
        ctx_color="$BRIGHT_RED"
    elif [ $context_pct -gt 50 ]; then
        ctx_color="$BRIGHT_YELLOW"
    else
        ctx_color="$BRIGHT_GREEN"
    fi

    printf "${LINE3_PRIMARY}${EMOJI_GEM} Context${RESET}${LINE3_PRIMARY}${SEPARATOR_COLOR}: ${RESET}${ctx_color}${context_used_k}K${RESET}${LINE3_PRIMARY} / ${context_max_k}K${ac_suffix}${usage_suffix}${RESET}\n"
else
    printf "${LINE3_PRIMARY}${EMOJI_GEM} Context${RESET}${LINE3_PRIMARY}${SEPARATOR_COLOR}: ${RESET}${LINE3_ACCENT}...${ac_suffix}${usage_suffix}${RESET}\n"
fi

# Line 4: workers launched from this session (running ones with their current
# step, plus today's finished count). Empty when this session has none.
# Prefers the standalone built script (plain node, no CLI startup); falls back
# to the pai CLI.
# PAI_QUIET_NOTICES=1: this call's stderr already goes to /dev/null below, but
# set it anyway so a caller of worker-status-line.mjs outside this script
# stays quiet too.
export PAI_QUIET_NOTICES=1
worker_status_cmd=""
if [ -x "${claude_dir}/worker-status-line.mjs" ]; then
    worker_status_cmd="${claude_dir}/worker-status-line.mjs"
elif command -v pai >/dev/null 2>&1; then
    worker_status_cmd="pai worker status-line"
fi
if [ -n "$worker_status_cmd" ]; then
    # third arg: this session's claude id — lets the worker line claim workers
    # spawned from this session's Bash tool, which carry no terminal identity
    worker_line="$("$worker_status_cmd" "${ITERM_SESSION_ID:-}" "${PWD:-}" "${statusline_session_id:-}" 2>/dev/null)"
    if [ -n "$worker_line" ]; then
        printf "${LINE3_PRIMARY}🐝 ${RESET}${LINE3_ACCENT}%s${RESET}\n" "$worker_line"
    fi
fi
