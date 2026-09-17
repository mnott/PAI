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

# Extract data from JSON input
current_dir=$(echo "$input" | jq -r '.workspace.current_dir')
model_name=$(echo "$input" | jq -r '.model.display_name')
model_id=$(echo "$input" | jq -r '.model.id // .model.display_name // empty')
cc_version=$(echo "$input" | jq -r '.version // "unknown"')

# Provider detection: strip any [...] suffix (e.g. the [1m] context marker)
# so "glm-5.3[1m]" is recognized as a glm model. glm sessions read their plan
# usage from Z.ai, everything else keeps the Anthropic OAuth path.
model_base="${model_id%%\[*}"
is_glm=0
case "$model_base" in
    [Gg][Ll][Mm]*) is_glm=1 ;;
esac

# Get directory name
dir_name=$(basename "$current_dir")

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
              return (variable named "user.paiName")
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


# Usage suffix: provider-aware. glm sessions read the Z.ai plan quota
# (5-hour + weekly credit windows), everything else keeps the Anthropic
# OAuth path (5-hour + 1d pace + 7-day). Both cache for usage_cache_ttl.
usage_cache="/tmp/claude/statusline-usage-cache.json"
zai_cache="/tmp/claude/statusline-zai-cache.json"
usage_cache_ttl=60  # seconds
usage_suffix=""

# Color based on utilization: green < 50%, yellow 50-75%, red > 75%
_usage_color() {
    local pct=$1
    if [ "$pct" -gt 75 ] 2>/dev/null; then echo "$BRIGHT_RED"
    elif [ "$pct" -gt 50 ] 2>/dev/null; then echo "$BRIGHT_YELLOW"
    else echo "$BRIGHT_GREEN"; fi
}

_fetch_usage() {
    # Try to get OAuth token from macOS Keychain
    local token=""
    token=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
    [ -z "$token" ] && return

    mkdir -p /tmp/claude
    local response
    response=$(curl -sf --max-time 3 \
        -H "Authorization: Bearer $token" \
        -H "anthropic-beta: oauth-2025-04-20" \
        "https://api.anthropic.com/api/oauth/usage" 2>/dev/null)
    [ -n "$response" ] && echo "$response" > "$usage_cache"
}

# Use cache if fresh, otherwise fetch in background (Anthropic plan only)
if [ "$is_glm" -eq 0 ]; then
    if [ -f "$usage_cache" ]; then
        cache_age=$(( $(date +%s) - $(stat -f %m "$usage_cache" 2>/dev/null || echo 0) ))
        if [ "$cache_age" -gt "$usage_cache_ttl" ]; then
            _fetch_usage &
        fi
    else
        _fetch_usage &
    fi
fi

# Read cached usage data — skipped on glm sessions so Anthropic-plan numbers
# (usage line AND the advisor-mode budget file) never leak into a glm statusline
if [ "$is_glm" -eq 0 ] && [ -f "$usage_cache" ]; then
    five_hour=$(jq -r '.five_hour.utilization // 0' "$usage_cache" 2>/dev/null)
    seven_day=$(jq -r '.seven_day.utilization // 0' "$usage_cache" 2>/dev/null)
    five_reset=$(jq -r '.five_hour.resets_at // empty' "$usage_cache" 2>/dev/null)
    seven_reset=$(jq -r '.seven_day.resets_at // empty' "$usage_cache" 2>/dev/null)

    # Round to integers
    five_hour_int=$(printf "%.0f" "$five_hour" 2>/dev/null || echo 0)
    seven_day_int=$(printf "%.0f" "$seven_day" 2>/dev/null || echo 0)

    # Format reset times as HH:MM (local time)
    five_reset_fmt=""
    seven_reset_fmt=""
    seven_reset_epoch=0
    if [ -n "$five_reset" ]; then
        # The API states these in UTC ("...T06:00:00+00:00"). Parsing without -u
        # reads 06:00 UTC as 06:00 local and prints a reset time that is out by
        # the offset — two hours here, which is long enough to plan around and
        # be wrong. Parse as UTC to get the epoch, then let date render it in
        # local time, which is the only form worth showing a person.
        five_reset_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "$(echo "$five_reset" | cut -c1-19)" "+%s" 2>/dev/null || date -d "$five_reset" "+%s" 2>/dev/null || echo 0)
        five_reset_fmt=$([ "$five_reset_epoch" -gt 0 ] 2>/dev/null && date -r "$five_reset_epoch" "+%H:%M" 2>/dev/null || echo "")
    fi
    if [ -n "$seven_reset" ]; then
        seven_reset_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "$(echo "$seven_reset" | cut -c1-19)" "+%s" 2>/dev/null || date -d "$seven_reset" "+%s" 2>/dev/null || echo 0)
        seven_reset_fmt=$([ "$seven_reset_epoch" -gt 0 ] 2>/dev/null && date -r "$seven_reset_epoch" "+%a %H:%M" 2>/dev/null || echo "")
    fi

    five_color=$(_usage_color "$five_hour_int")
    seven_color=$(_usage_color "$seven_day_int")

    # Budget pace indicator for 7-day window
    # Compare actual usage vs linear expected usage based on elapsed time
    pace_dot=""
    if [ "$seven_reset_epoch" -gt 0 ] 2>/dev/null; then
        now_epoch=$(date +%s)
        window_secs=$((7 * 86400))
        remaining_secs=$((seven_reset_epoch - now_epoch))
        [ "$remaining_secs" -lt 0 ] && remaining_secs=0
        elapsed_secs=$((window_secs - remaining_secs))
        # Expected usage if spending linearly: elapsed/total * 100
        expected_pct=$(( elapsed_secs * 100 / window_secs ))
        # Daily pace: actual spend/day vs dynamic budget
        # Budget = remaining capacity / remaining days (not static 100/7)
        elapsed_days_x10=$((elapsed_secs * 10 / 86400))
        [ "$elapsed_days_x10" -lt 1 ] && elapsed_days_x10=1
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

    # Write weekly budget to advisor-mode.json for the whisper hook
    # Preserve existing mode if manually set — only update weeklyBudgetPercent
    _advisor_file="${HOME}/.claude/advisor-mode.json"
    if [ -n "$seven_day_int" ] 2>/dev/null; then
        _existing_mode="auto"
        _existing_force=""
        if [ -f "$_advisor_file" ]; then
            _existing_mode=$(jq -r '.mode // "auto"' "$_advisor_file" 2>/dev/null)
            _existing_force=$(jq -r '.forceModel // empty' "$_advisor_file" 2>/dev/null)
        fi
        if [ -n "$_existing_force" ]; then
            printf '{"weeklyBudgetPercent":%d,"mode":"%s","forceModel":"%s"}\n' "$seven_day_int" "$_existing_mode" "$_existing_force" > "$_advisor_file" 2>/dev/null
        else
            printf '{"weeklyBudgetPercent":%d,"mode":"%s"}\n' "$seven_day_int" "$_existing_mode" > "$_advisor_file" 2>/dev/null
        fi
    fi

    # Compute advisor mode label (mirrors thresholds in whisper-rules.ts)
    # If mode is manually set (not "auto"), show that instead of auto-calculated
    advisor_label=""
    advisor_label_color=""
    _display_mode="$_existing_mode"
    if [ "$_display_mode" = "auto" ]; then
        if [ "$seven_day_int" -ge 92 ] 2>/dev/null; then
            _display_mode="critical"
        elif [ "$seven_day_int" -ge 80 ] 2>/dev/null; then
            _display_mode="strict"
        elif [ "$seven_day_int" -ge 60 ] 2>/dev/null; then
            _display_mode="conservative"
        fi
    fi
    case "$_display_mode" in
        "critical") advisor_label="critical"; advisor_label_color="$BRIGHT_RED" ;;
        "strict") advisor_label="strict"; advisor_label_color="$BRIGHT_ORANGE" ;;
        "conservative") advisor_label="conserve"; advisor_label_color="$BRIGHT_YELLOW" ;;
        "normal") advisor_label="normal"; advisor_label_color="$BRIGHT_GREEN" ;;
    esac
    # Mark forced modes with a pin symbol so user knows it's not auto
    if [ "$_existing_mode" != "auto" ] && [ -n "$advisor_label" ]; then
        advisor_label="📌${advisor_label}"
    fi

    # Build usage suffix: 5h: 8% → 00:59 │ 1d: ● 29% / 36% │ 7d: ⚡strict 91% → Fr. 08:00
    five_label="5h: ${five_hour_int}%%"
    [ -n "$five_reset_fmt" ] && five_label="${five_label} → ${five_reset_fmt}"
    seven_label="7d: "
    [ -n "$advisor_label" ] && seven_label="${seven_label}${advisor_label_color}${advisor_label}${RESET} "
    seven_label="${seven_label}${seven_day_int}%%"
    [ -n "$seven_reset_fmt" ] && seven_label="${seven_label} → ${seven_reset_fmt}"

    usage_suffix=" ${SEPARATOR_COLOR}│${RESET} ${five_color}${five_label}${RESET}"
    [ -n "$pace_dot" ] && usage_suffix="${usage_suffix} ${SEPARATOR_COLOR}│${RESET} ${LINE3_PRIMARY}1d:${RESET} ${pace_dot}"
    usage_suffix="${usage_suffix} ${SEPARATOR_COLOR}│${RESET} ${seven_color}${seven_label}${RESET}"
fi

# Z.ai plan quota (glm sessions). The monitor endpoint exposes two credit
# windows: limits[] number==5 is the 5-hour window, number==1 the weekly one
# (nextResetTime in epoch ms) — no 1d window exists on this plan, so none is
# rendered. PAI_ZAI_QUOTA_URL overrides the endpoint (kill switch / testing).
_fetch_zai_usage() {
    local key="${ZAI_API_KEY:-}"
    if [ -z "$key" ] && [ -f "$HOME/.config/zai/api_key" ]; then
        key=$(tr -d '[:space:]' < "$HOME/.config/zai/api_key")
    fi
    [ -n "$key" ] || return
    mkdir -p /tmp/claude
    local response
    response=$(curl -sf --max-time 3 \
        -H "Authorization: Bearer $key" \
        -H "Accept: application/json" \
        "${PAI_ZAI_QUOTA_URL:-https://api.z.ai/api/monitor/usage/quota/limit}" 2>/dev/null)
    # A bad key returns HTTP 200 with empty limits — only cache responses
    # that actually carry quota windows, so a broken fetch is never cached.
    if [ -n "$response" ] && echo "$response" | jq -e '.data.limits | length > 0' >/dev/null 2>&1; then
        echo "$response" > "$zai_cache"
    fi
}

if [ "$is_glm" -eq 1 ]; then
    # Use cache if fresh, otherwise fetch in background
    if [ -f "$zai_cache" ]; then
        cache_age=$(( $(date +%s) - $(stat -f %m "$zai_cache" 2>/dev/null || echo 0) ))
        if [ "$cache_age" -gt "$usage_cache_ttl" ]; then
            _fetch_zai_usage &
        fi
    else
        _fetch_zai_usage &
    fi

    zai_five_pct=""
    zai_seven_pct=""
    zai_five_reset_ms=""
    zai_seven_reset_ms=""
    if [ -f "$zai_cache" ]; then
        zai_five_pct=$(jq -r '.data.limits[]? | select(.number == 5) | .percentage' "$zai_cache" 2>/dev/null | head -1)
        zai_seven_pct=$(jq -r '.data.limits[]? | select(.number == 1) | .percentage' "$zai_cache" 2>/dev/null | head -1)
        zai_five_reset_ms=$(jq -r '.data.limits[]? | select(.number == 5) | .nextResetTime' "$zai_cache" 2>/dev/null | head -1)
        zai_seven_reset_ms=$(jq -r '.data.limits[]? | select(.number == 1) | .nextResetTime' "$zai_cache" 2>/dev/null | head -1)
    fi

    if [ -n "$zai_five_pct" ] && [ "$zai_five_pct" != "null" ]; then
        zai_five_int=$(printf "%.0f" "$zai_five_pct" 2>/dev/null || echo "?")
        zai_five_reset_fmt=""
        if [ -n "$zai_five_reset_ms" ] && [ "$zai_five_reset_ms" != "null" ]; then
            # nextResetTime is epoch milliseconds; date -r wants seconds
            zai_five_epoch=$(( zai_five_reset_ms / 1000 ))
            [ "$zai_five_epoch" -gt 0 ] 2>/dev/null && zai_five_reset_fmt=$(date -r "$zai_five_epoch" "+%H:%M" 2>/dev/null || echo "")
        fi
        zai_five_label="zai 5h: ${zai_five_int}%%"
        [ -n "$zai_five_reset_fmt" ] && zai_five_label="${zai_five_label} → ${zai_five_reset_fmt}"
        usage_suffix=" ${SEPARATOR_COLOR}│${RESET} $(_usage_color "$zai_five_int")${zai_five_label}${RESET}"
        if [ -n "$zai_seven_pct" ] && [ "$zai_seven_pct" != "null" ]; then
            zai_seven_int=$(printf "%.0f" "$zai_seven_pct" 2>/dev/null || echo "?")
            zai_seven_reset_fmt=""
            if [ -n "$zai_seven_reset_ms" ] && [ "$zai_seven_reset_ms" != "null" ]; then
                zai_seven_epoch=$(( zai_seven_reset_ms / 1000 ))
                [ "$zai_seven_epoch" -gt 0 ] 2>/dev/null && zai_seven_reset_fmt=$(date -r "$zai_seven_epoch" "+%a %H:%M" 2>/dev/null || echo "")
            fi
            zai_seven_label="7d: ${zai_seven_int}%%"
            [ -n "$zai_seven_reset_fmt" ] && zai_seven_label="${zai_seven_label} → ${zai_seven_reset_fmt}"
            usage_suffix="${usage_suffix} ${SEPARATOR_COLOR}│${RESET} $(_usage_color "$zai_seven_int")${zai_seven_label}${RESET}"
        fi
    else
        # No key, timeout, non-200 or empty limits — show the marker instead
        # of silently falling back to Anthropic-plan numbers.
        usage_suffix=" ${SEPARATOR_COLOR}│${RESET} ${LINE3_ACCENT}zai 5h: ?${RESET}"
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
