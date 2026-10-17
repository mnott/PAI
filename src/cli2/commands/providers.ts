/**
 * Providers: `pai providers` lists, `pai providers use NAME` switches the
 * active one. Reads and writes go through src/workers (readWorkersSection,
 * useProvider) — the same code `pai worker providers` uses.
 */

import { ANTHROPIC_NATIVE, nativeAnthropicProvider, readWorkersSection, type WorkersConfig } from "../../workers/config.js";
import type { BudgetReading } from "../../workers/budget.js";
import { readBudget } from "../lib/health.js";
import { useProvider } from "../../workers/providers.js";
import { CliError, OPT, type CommandDef } from "../define.js";
import { colorEnabled, makeStyle, renderTable, type Style } from "../help.js";

export interface ProviderRow {
  name: string;
  model: string;
  fastModel: string | null;
  active: boolean;
  available: boolean;
  /** Percent of quota used in the fullest window; null = unknown. */
  budgetPercent: number | null;
  note: string;
}

/** Pure: workers config + budget readings -> display rows. */
export function providerRows(
  workers: Pick<WorkersConfig, "providers" | "active" | "nativeModels">,
  budget: Record<string, BudgetReading | undefined>
): ProviderRow[] {
  const active = workers.active ?? ANTHROPIC_NATIVE;
  const native = nativeAnthropicProvider(workers.nativeModels);
  const entries: Array<[string, { enabled: boolean; models: { default: string; fast?: string }; note?: string }]> = [
    [ANTHROPIC_NATIVE, native],
    ...Object.entries(workers.providers),
  ];
  return entries.map(([name, p]) => ({
    name,
    model: p.models.default,
    fastModel: p.models.fast ?? null,
    active: name === active,
    available: p.enabled,
    budgetPercent: budget[name]?.percent ?? null,
    note: p.note ?? "",
  }));
}

function budgetCell(r: ProviderRow, st: Style): string {
  if (!r.available) return st.dim("disabled");
  if (r.budgetPercent === null) return st.dim("unknown");
  const t = `${Math.round(r.budgetPercent)}% used`;
  return r.budgetPercent >= 95 ? st.red(t) : r.budgetPercent >= 80 ? st.yellow(t) : st.green(t);
}

export function providersTable(rows: ProviderRow[], st: Style): string {
  return renderTable(
    ["", "Provider", "Model", "Fast model", "Budget"],
    rows.map((r) => [
      r.active ? st.green("●") : " ",
      r.active ? st.bold(r.name) : r.available ? r.name : st.dim(r.name),
      r.model,
      r.fastModel ?? st.dim("—"),
      budgetCell(r, st),
    ]),
    st
  );
}

function load(): WorkersConfig {
  try {
    return readWorkersSection().workers;
  } catch (e) {
    throw new CliError(
      `cannot read the provider configuration: ${e instanceof Error ? e.message : String(e)}`,
      "pai worker config check"
    );
  }
}

const useCommand: CommandDef = {
  name: "use",
  summary: "Make a provider the active one",
  description:
    "The active provider is where `pai new` starts and where new workers go by default. Classes pinned to a provider are re-pointed.",
  args: [{ name: "NAME", required: true, summary: "Provider name from `pai providers`" }],
  options: [{ ...OPT.dryRun }],
  examples: ["pai providers use glm", "pai providers use anthropic"],
  seeAlso: ["pai providers", "pai new"],
  run(ctx) {
    const name = ctx.args.NAME as string;
    const workers = load();
    const rows = providerRows(workers, {});
    const row = rows.find((r) => r.name === name);
    if (!row || !row.available) {
      const ok = rows.filter((r) => r.available).map((r) => r.name);
      throw new CliError(
        `provider "${name}" is ${row ? "disabled" : "not configured"}. Available: ${ok.join(", ")}`,
        `pai providers use ${ok.find((n) => n !== name) ?? ANTHROPIC_NATIVE}`
      );
    }
    if (ctx.dryRun) return void process.stdout.write(`would make ${name} the active provider\n`);
    const { repointed } = useProvider(name);
    process.stdout.write(`Active provider: ${name}${repointed ? ` (${repointed} class${repointed === 1 ? "" : "es"} re-pointed)` : ""}\n`);
  },
};

export const providersCommand: CommandDef = {
  name: "providers",
  summary: "List providers (● = active); `providers use NAME` switches",
  description:
    "Shows every provider you can start a session on, its default model, and how much of its quota is used when that is known.\n" +
    "● marks the active provider.",
  options: [{ ...OPT.json }],
  examples: ["pai providers", "pai providers --json", "pai providers use glm"],
  seeAlso: ["pai new", "pai open", "pai providers use"],
  subcommands: [useCommand],
  async run(ctx) {
    const workers = load();
    const rows = providerRows(workers, await readBudget(workers, 4000));
    if (ctx.opts.json) return void process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    const st = makeStyle(colorEnabled());
    process.stdout.write(providersTable(rows, st) + "\n\n");
    process.stdout.write(st.dim("Start on one: pai new --provider NAME · make it the default: pai providers use NAME") + "\n");
  },
};
