# Apple on-device model (apple-fm)

The system language model of macOS (FoundationModels framework), served on loopback by `tools/apple-fm-bridge` as a subset of the Anthropic Messages API. It is an opt-in local provider: it is in no tier and is used only when named (`--local apple-fm`, `--where apple-fm`).

## Facts

| Item | Value |
|---|---|
| Availability | macOS with Apple Intelligence enabled; the bridge is built from `tools/apple-fm-bridge` |
| Endpoint | `http://127.0.0.1:8037` (`/v1/messages`, `/v1/models`), no API key |
| Context | 8192 tokens (input and output together) |
| Speed | median ~28 tokens/s, median time to first token ~2.7 s (10-task sample below) |
| Tool calling | JSON in the prompt only; no native tool-call channel |

## Why a worker loop does not fit

A Claude Code worker sends its system prompt and tool definitions with every request, about 6k of the 8k tokens. That leaves too little room for task text, file contents and tool results, so multi-turn tool loops overflow almost at once. The model suits short, self-contained prompts: a function, a rewrite, a classification.

## Quality sample: function-level easy set

First 10 tasks of the easy set the lab uses (`codeeval-tasks.jsonl`). Each prompt is the task text plus "Reply with only the code." No system prompt, no retries, 1024 max tokens, 120 s limit per task. Graded as the lab grades: the lab's `extract` takes the code block, `run_tests` runs the task's asserts in an isolated, network-denied process.

| # | Task | Result | TTFT s | tok/s |
|---|---|---|---|---|
| 1 | fizzbuzz_list | pass | 2.6 | 28 |
| 2 | is_palindrome | pass | 2.2 | 54 |
| 3 | two_sum | pass | 10.5 | 48 |
| 4 | roman_to_int | pass | 2.2 | 20 |
| 5 | int_to_roman | pass | 1.9 | 19 |
| 6 | valid_brackets | fail (SyntaxError) | 11.6 | 28 |
| 7 | merge_intervals | pass | 0.7 | 27 |
| 8 | flatten | pass | 3.1 | 59 |
| 9 | word_freq | fail (AssertionError) | 2.8 | 51 |
| 10 | gcd_lcm | fail (SyntaxError) | 2.7 | 26 |

**7 of 10 pass.** Median tokens/s 28, median TTFT 2.7 s. Token counts are estimated (characters / 4) because the bridge stream reports no output token count; tokens/s is measured from the first token to the end.

Comparison: the local gyro-l model's known easy-set rate is 95 % (paper 4, full set, agent harness). It was not re-run for this sample because its slots were busy with workers. The two runs differ in harness and size, so read the gap (70 % vs 95 %) as indicative, not exact. The two SyntaxErrors point to stray non-code text in the reply despite the instruction.

## Try it

```
pai models start apple-fm
pai models chat apple-fm
```

`pai models chat <provider>` is a small REPL: it sends `/v1/messages` with a rolling history trimmed to the model's context (about 4 characters per token), streams the answer, `/reset` clears the history and `/quit` exits. It also works for gyro-l.
