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
#   2. MCPs: Active MCP servers (wraps on narrow terminals)
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
cc_version=$(echo "$input" | jq -r '.version // "unknown"')

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

# Count MCPs from all config sources (settings.json, .mcp.json, ~/.claude.json)
mcp_names_raw=""
mcps_count=0

# Helper: merge MCP names from a jq-compatible JSON file
_merge_mcps() {
    local file="$1"
    [ -f "$file" ] || return
    local data
    data=$(jq -r '.mcpServers | keys | join(" "), length' "$file" 2>/dev/null)
    [ -n "$data" ] && [ "$data" != "null" ] || return
    local names count
    names=$(echo "$data" | head -1)
    count=$(echo "$data" | tail -1)
    [ -n "$names" ] || return
    if [ -n "$mcp_names_raw" ]; then
        mcp_names_raw="$mcp_names_raw $names"
    else
        mcp_names_raw="$names"
    fi
    mcps_count=$((mcps_count + count))
}

# Read from all three MCP config locations
_merge_mcps "$claude_dir/settings.json"    # legacy
_merge_mcps "$claude_dir/.mcp.json"        # project-level
_merge_mcps "$HOME/.claude.json"           # user-level (e.g. Coogle, DEVONthink)

# Deduplicate MCP names (preserving order)
if [ -n "$mcp_names_raw" ]; then
    mcp_names_raw=$(echo "$mcp_names_raw" | tr ' ' '\n' | awk '!seen[$0]++' | tr '\n' ' ' | sed 's/ $//')
    mcps_count=$(echo "$mcp_names_raw" | wc -w | tr -d ' ')
fi

# Extract context window usage from Claude Code's JSON input (no JSONL parsing needed)
context_pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0' 2>/dev/null)
context_size=$(echo "$input" | jq -r '.context_window.context_window_size // 200000' 2>/dev/null)
context_used_k=$(( (context_pct * context_size / 100) / 1000 ))
context_max_k=$((context_size / 1000))

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

# Format MCP names with terminal-width-aware wrapping
# Debug: log available width info (remove after testing)
# Terminal width for line truncation
# Claude Code's statusline subprocess can't detect resize (stty returns stale values).
# To set your width:  echo 105 > ~/.claude/.statusline_width
# Default 80 is safe for any terminal; set higher (e.g., 105) for wide screens.
term_width=80
[ -f "${claude_dir}/.statusline_width" ] && read -r term_width < "${claude_dir}/.statusline_width" 2>/dev/null
[ "$term_width" -gt 0 ] 2>/dev/null || term_width=80
mcp_prefix_width=10  # visual width of "🔌 MCPs: " (emoji=2 + space + "MCPs: " = 10)

# Build MCP output — proactively split into two lines when there are many MCPs.
# No width detection needed: if total display chars > 60, split at the midpoint.
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
        *) local n="$1"; echo "${n^}" ;;
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

# Collect all display names and calculate total width
mcp_display_names=()
mcp_formatted_strs=()
total_display_width=$mcp_prefix_width  # start with "🔌 MCPs: " prefix
total_mcps=0

for mcp in $mcp_names_raw; do
    dn=$(_mcp_display_name "$mcp")
    fm=$(_mcp_formatted "$dn")
    mcp_display_names+=("$dn")
    mcp_formatted_strs+=("$fm")
    if [ $total_mcps -gt 0 ]; then
        total_display_width=$((total_display_width + 2))  # ", "
    fi
    total_display_width=$((total_display_width + ${#dn}))
    total_mcps=$((total_mcps + 1))
done

# Decide: one line or two lines?
# If total display width > 60 chars, split at the midpoint
mcp_line1=""
mcp_line2=""

if [ $total_mcps -eq 0 ]; then
    mcp_line1="none"
elif [ $total_display_width -le $term_width ]; then
    # Single line — everything fits
    for ((i=0; i<total_mcps; i++)); do
        if [ $i -eq 0 ]; then
            mcp_line1="${mcp_formatted_strs[$i]}"
        else
            mcp_line1="${mcp_line1}${SEPARATOR_COLOR}, ${mcp_formatted_strs[$i]}"
        fi
    done
else
    # Two lines — split at midpoint
    split_at=$(( (total_mcps + 1) / 2 ))
    for ((i=0; i<split_at; i++)); do
        if [ $i -eq 0 ]; then
            mcp_line1="${mcp_formatted_strs[$i]}"
        else
            mcp_line1="${mcp_line1}${SEPARATOR_COLOR}, ${mcp_formatted_strs[$i]}"
        fi
    done
    for ((i=split_at; i<total_mcps; i++)); do
        if [ $i -eq $split_at ]; then
            mcp_line2="${mcp_formatted_strs[$i]}"
        else
            mcp_line2="${mcp_line2}${SEPARATOR_COLOR}, ${mcp_formatted_strs[$i]}"
        fi
    done
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

# LINE 2 - MCPs (with optional wrap to second line)
printf "${LINE2_PRIMARY}${EMOJI_PLUG} MCPs${RESET}${LINE2_PRIMARY}${SEPARATOR_COLOR}: ${RESET}${mcp_line1}${RESET}\n"
if [ -n "$mcp_line2" ]; then
    # Continuation line — indent to align with MCP names after "🔌 MCPs: "
    printf "${LINE2_PRIMARY}          ${RESET}${mcp_line2}${RESET}\n"
fi


# Fetch OAuth usage (5-hour current + 7-day weekly) with caching
usage_cache="/tmp/claude/statusline-usage-cache.json"
usage_cache_ttl=60  # seconds
usage_suffix=""

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

# Use cache if fresh, otherwise fetch in background
if [ -f "$usage_cache" ]; then
    cache_age=$(( $(date +%s) - $(stat -f %m "$usage_cache" 2>/dev/null || echo 0) ))
    if [ "$cache_age" -gt "$usage_cache_ttl" ]; then
        _fetch_usage &
    fi
else
    _fetch_usage &
fi

# Read cached usage data
if [ -f "$usage_cache" ]; then
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
        five_reset_fmt=$(date -jf "%Y-%m-%dT%H:%M:%S" "$(echo "$five_reset" | cut -c1-19)" "+%H:%M" 2>/dev/null || date -d "$five_reset" "+%H:%M" 2>/dev/null || echo "")
    fi
    if [ -n "$seven_reset" ]; then
        seven_reset_fmt=$(date -jf "%Y-%m-%dT%H:%M:%S" "$(echo "$seven_reset" | cut -c1-19)" "+%a %H:%M" 2>/dev/null || date -d "$seven_reset" "+%a %H:%M" 2>/dev/null || echo "")
        seven_reset_epoch=$(date -jf "%Y-%m-%dT%H:%M:%S" "$(echo "$seven_reset" | cut -c1-19)" "+%s" 2>/dev/null || date -d "$seven_reset" "+%s" 2>/dev/null || echo 0)
    fi

    # Color based on utilization: green < 50%, yellow 50-75%, red > 75%
    _usage_color() {
        local pct=$1
        if [ "$pct" -gt 75 ] 2>/dev/null; then echo "$BRIGHT_RED"
        elif [ "$pct" -gt 50 ] 2>/dev/null; then echo "$BRIGHT_YELLOW"
        else echo "$BRIGHT_GREEN"; fi
    }

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
ac_suffix=" ${ac_color}(${ac_remaining}%%)${RESET}"

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
