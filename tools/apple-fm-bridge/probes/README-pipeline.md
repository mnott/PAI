# Flashcard pipeline probe (frozen) — port notes

File: `pipeline-probe-final.swift` (= run 18 plus two guards). Swift, Apple Foundation Models on device, German source text.

## Stages

1. **Sections**: the page text is split at headings; formula lines and debris are stripped; paragraphs are numbered (¶n).
2. **Facts**: the model proposes facts, each with a verbatim quote (capped per paragraph). In addition, CODE adds mandatory facts: every sentence with an accepted *named term* (cue regex: "spricht man von", "sogenannte", "sog.", "nennt man", "heißt", "bezeichnet man als", "wird … X genannt", parenthetical terms), and every sentence with a number and unit. Facts are deduplicated by quote span and statement overlap.
3. **Cards**: the model writes front/back per fact from the quote. CODE then repairs and checks the card (below). A hard flag triggers one regeneration, front only if only the front is bad (the verbatim back of the first try is kept).
4. **Term cards**: a named-term fact gets its front built in code ("Was ist <Term>?", plural "Was sind <Term>?"); if the back fails, the back is the verbatim source sentence.
5. **Dedup**: duplicate fronts or answers are dropped or qualified; a term card supersedes an earlier card without a term.
6. **Summaries** (unchanged since run 13): sentence pick per section, term and number sentences first.

## Code checks (rule, run that introduced it)

Repairs (soft flags, applied silently, informational):
- backDeduped / backListTailStripped / backTrimmed: repeated sentences, list tails and over-long backs are cut (runs 10, 12, 14).
- backVerbatim: a rewrite that only reorders, duplicates a verb, or turns a connective clause into a different logic is replaced by the verbatim source sentence (runs 14, 15, 17).
- backReordered / backParensRepaired / backGrammarFixed / frontGrammarFixed / backAntecedentFixed: sentence order follows the source; unbalanced parentheses and known grammar slips fixed; "die Zahl" gets its antecedent (runs 14, 15).
- backDemonstrative / pull-in: a back starting with a demonstrative or pronoun gets the previous source sentence prepended, never appended (runs 15, 16, 18).
- backConnectiveDropped: a connective sentence not straight after its source predecessor is dropped (run 18).
- backClauseAntecedent: "Dies/Das + verb" sentences get the whole previous statement (run 18).
- backTyposRestored: typos from the model are restored to the source spelling (run 14).
- frontTermCard / backFromQuote / backRewrittenAsIs: code-built term front; verbatim or verbless-term back rewrite (runs 13, 15).
- backDanglingTail: back ends on a demonstrative noun phrase (run 18, review only).

Hard flags (card rejected, most after one regeneration):
- quoteNotVerbatim, emptySide, backStub, backTooLong, backTruncated, frontTruncated, backInFront (run 6–10).
- frontNotQuestion, frontNoFiniteVerb (copula "Was ist …" does not count), frontDanglingAntecedent / vague subject, frontDemonstrative, frontWieTemplate, frontReversed, frontContainsAnswer (runs 11–14).
- frontBackMismatch (front nouns absent from back and quote; "Strong" variant checked on the final front), frontClash (duplicate front) (runs 13–15).
- frontAntonym: front and back ask opposite directions (zu/ab, wärmer/kälter, über/unter) (run 18).
- answerWordsMissing, termsLost (lost number, named term or technical compound), backMissesTerm, backNoFiniteVerb (every sentence of the back needs a finite verb), backNonFact, sideMerge (two opposite sides merged) (runs 12–15).
- **contrastMerge** (final guard 1): see below.

## Final guards

1. A non-verbatim back covering more than one source sentence (≥ half of a sentence's content stems present) gets the review flag `multiSentenceBack` (soft, not clean). It is rejected as `contrastMerge` when the second covered source sentence starts with dagegen, im Gegensatz, jedoch, aber, hingegen, wohingegen, demgegenüber. Verbatim backs and single-sentence rewrites are unaffected.
2. A fact whose quote carries an accepted named-term sentence becomes a term card (front "Was ist <Term>?") even if the model fact was not linked to it (paragraph guesses can be wrong).

## Flags: hard vs soft

`softFlags` in the source lists the flags that keep a card accepted. Any other flag rejects it. `isClean` is the shorter list of flags that do not need review; an accepted card with any other flag is marked `review`.

## Self-test

```
pai build run -- swiftc -parse-as-library -O tools/apple-fm-bridge/probes/pipeline-probe-final.swift -o "$TMPDIR/pipeline-probe-final"
"$TMPDIR/pipeline-probe-final" --selftest [sections dir]
```

No model calls; every check prints `ok` or `FAIL`, the exit code is non-zero on a failure. The optional sections dir adds checks on real paragraphs.

Full run: `"$TMPDIR/pipeline-probe-final" <sections dir> <out dir> German [flash,sum]`. One model process at a time.
