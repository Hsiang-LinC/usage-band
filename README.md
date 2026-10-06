# usage-band

Band above the prompt: ctx %, cache countdown (1h TTL) and hit rate, 5h/7d quota used, colored by level (quota green <50%, yellow <80%, red after; cache green >5m, yellow ≤5m, red cold; ctx same, and from 80% suggests /compact or a handoff)

```bash
claude plugin marketplace add Hsiang-LinC/usage-band
claude plugin install usage@usage-band
```

Private repo: needs `gh auth login` (or any git credential for github.com) on the machine.

Test: `claude plugin test .`
