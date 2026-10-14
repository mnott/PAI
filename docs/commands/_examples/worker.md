```bash
# Where do workers run? One persistent switch (stored in <logDir>/routing-policy.json)
pai worker policy                 # show the policy and the route a plain run takes now
pai worker policy prefer-local    # local first, cloud when local is down or its report fails
pai worker policy cloud-only --for 2h   # on the road: never local, back to normal after 2 h
pai worker policy clear           # no policy: class/active routing as before

# Per run (--provider still beats the policy)
pai worker run --urgent --class implement --spec task.txt    # fast turnaround -> cloud
pai worker run --cloud ...        # this run to the cloud under prefer-local/auto
pai worker run --local-ok ...     # this run may go local under prefer-cloud
```

**Routing policy.** `cloud-only` never uses a local provider; `local-only` never uses the cloud
and fails when no local server answers; `prefer-local` tries the first enabled loopback provider
(one `/v1/models` ping, 4 s: a busy server answers slowly) and uses the cloud when none answers or none is configured;
`prefer-cloud` uses the cloud and goes local only when the cloud is in cooldown or over its quota
(or on `--local-ok`); `auto` is `prefer-local`, but cloud on battery (`pmset -g batt`) and for an
`--urgent` run. The chosen route and its reason (`policy prefer-local`, `battery`, `urgent`,
`local down`, `no local provider`, `fall-through (…)`) are stored in the worker status and shown
by `pai worker ps`.

**Fall-through.** Under every policy but `local-only`, a local run whose report is invalid, was
downgraded by the proof check (`claimed proof not run`), is `r=-` or `r=!`, ended without a
report, or hit its max-minutes is repeated once on the cloud as a new worker labelled
`… (fall-through)`. The two statuses link each other (`fell through to <id>`, `fall-through of
<id>`). Local models are right when the spec names cause and owner; for diagnosis from symptoms
use `--cloud` or `--provider`.
