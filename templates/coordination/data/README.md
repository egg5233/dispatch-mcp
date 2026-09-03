# data/

Experiment output: logs, csv/tsv, sweep results, captured traffic. **Not tracked in git** (see `.gitignore`).

- One directory per experiment: `data/<experiment>/`, named after the document that describes it
  (e.g. `docs/research/<topic>-<qualifier>-<YYYYMMDD>.md` ↔ `data/<topic>-<qualifier>/`).
- Every experiment directory gets its own `README.md`: what was run, on which host/hardware, which
  commit, which file is the summary. That README is the only thing a reader should need.
- Raw files keep their original names; do not rename after the fact.
