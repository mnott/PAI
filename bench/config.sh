# write_bench_config <provider> <dest>: render the private bench config from the template.
# Called per series AND per task: a task worker may rewrite PAI_CONFIG_FILE through the config store
# (fault 2026-11-25 series cg-off signal-2: task 3 rewrote the shared file, workers.enabled:false killed tasks 4-5).
# BENCH = this dir (set by lib.sh when sourced there; evalset.sh sets it itself).
BENCH=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
write_bench_config() {
  # NOTE: one `local` per assignment — bash >=5.3 evaluates them left to right, so
  # `local dest=$2 tmp="$dest.new"` in a single statement sees the shadowed empty dest.
  local provider=$1
  local dest=$2
  [ -n "$provider" ] && [ -n "$dest" ] || { echo "write_bench_config: provider and dest required" >&2; return 1; }
  local tmp="$dest.new"
  sed "s/__PROVIDER__/$provider/g" "$BENCH/config-eval.template.yaml" > "$tmp" && mv -f "$tmp" "$dest"
}
