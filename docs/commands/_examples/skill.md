```bash
# Which skills have actually been triggered, most-used first
pai skill telemetry

# Only skills still in trial (quarantined, not yet promoted)
pai skill telemetry --status trial

# Machine-readable output for dashboards
pai skill telemetry --json
```

See `Notes/swarm/skills-self-educating.md` for the full self-educating loop
(discovery, sandbox trial, telemetry, adaptation).
