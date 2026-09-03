---
title: "{{PROJECT}} coordination — layout map and conventions"
type: protocol
task:
agent: {{COORDINATOR}}
date: {{DATE}}
git:
status: active
supersedes:
---
# {{PROJECT}} — coordination/

The shared, versioned record of the {{PROJECT}} agent fleet: what was decided, what was reviewed, how things are run. Created from `templates/coordination/` in the dispatch-mcp repo by `dispatch-init-project`. The message bus and task tracker are dispatch (`~/.dispatch/PROTOCOL.md`); this directory holds the documents those messages point at.

## Tree

```
coordination/
├── README.md        this file — map + conventions
├── CLAUDE.md        the coordinator's instructions (the coordinator Claude runs in this directory)
├── STATUS.md        human-readable status board, newest first (dispatch is the system of record)
├── tasks/           T-YYYYMMDD-NN-<slug>.md — mirror of dispatch tasks, written by the server
├── docs/
│   ├── runbooks/    operator procedures: how to run, recover, cut over, stop
│   ├── incidents/   incident-YYYY-MM-DD-<slug>.md post-mortems
│   ├── designs/     designs, plans, proposals, specs, briefs, decisions
│   ├── releases/    release notes, prep checklists, packaging
│   ├── research/    research, findings, audits, surveys, experiment write-ups
│   ├── reviews/     code/design reviews and review requests
│   └── protocol/    interface contracts and protocols specific to this project
├── data/<experiment>/   raw experiment output, one README.md per experiment (NOT in git)
├── logs/            frozen agent logs and journals (append-only files that are not documents)
├── scripts/         ops scripts that belong to the coordination of this project
└── archive/YYYY-MM/ finished material (NOT in git)
```

## Where a new file goes

| you are writing… | directory | filename |
|---|---|---|
| a procedure someone will follow | `docs/runbooks/` | `<topic>-runbook-<YYYYMMDD>.md` |
| a post-mortem | `docs/incidents/` | `incident-<YYYY-MM-DD>-<slug>.md` |
| a design, plan, proposal, spec | `docs/designs/` | `<topic>-design-<YYYYMMDD>.md`, `<topic>-plan-<YYYYMMDD>.md` |
| release notes / prep | `docs/releases/` | `release-<version>-notes-<YYYYMMDD>.md` |
| findings, an audit, a survey | `docs/research/` | `<topic>-findings-<YYYYMMDD>.md`, `<topic>-audit-<YYYYMMDD>.md` |
| a review of commit `<sha7>` | `docs/reviews/` | `<topic>-<sha7>-review-<YYYYMMDD>.md`; re-review adds `-r2`, `-r3` |
| an interface contract | `docs/protocol/` | `<topic>-protocol-<YYYYMMDD>.md` |
| raw output of an experiment | `data/<experiment>/` | keep original names; add `README.md` |
| a session checkpoint / handoff | `archive/YYYY-MM/` | `SESSION-<YYYY-MM-DD>-<slug>.md` |

Rules: date in the filename, agent in the frontmatter, lowercase-hyphen slugs, no spaces. Never rename an existing document; supersede it (frontmatter `supersedes:`) instead.

## Frontmatter (every document under `docs/`, `logs/`, and this README)

```yaml
---
title: <human title>
type: runbook | incident | design | release | research | review | protocol | log | task
task: T-YYYYMMDD-NN          # dispatch task id this document answers, empty if none
agent: <dispatch handle>     # who wrote it
date: YYYY-MM-DD
git: <sha7>                  # commit the document is about, empty if none
status: draft | active | done | superseded
supersedes: <filename>       # empty if none
---
```

## Tasks mirror

`tasks/` is written by the dispatch server: every `type=task` message becomes `tasks/T-YYYYMMDD-NN-<slug>.md` with the task's messages appended as they arrive. Do not edit those files by hand; the server owns them. They are tracked in git so the history of who was asked what survives the server database.

## STATUS.md

The coordinator's board. Newest first, one paragraph per event, never edit old entries. Format is in the file. Milestones, decisions, incidents and cutovers go there; everything longer goes under `docs/` and STATUS links to it.

## Things that must not move without checking

Before moving or renaming anything in this directory: `crontab -l`, systemd `Documentation=` lines, sync scripts under `scripts/`, and other projects' `CLAUDE.md` files may reference paths here by absolute name. Grep for the filename first; update the reference in the same commit as the move.

## Git

This directory is its own git repository (initialized by `dispatch-init-project`). `data/` and `archive/` are ignored except for their `README.md`. Commit documents when they are written; the coordinator commits the `tasks/` mirror and `STATUS.md` at milestones.

## Pointers

- `~/.dispatch/PROTOCOL.md` — agent protocol: `dispatch-send` / `dispatch-recv`, message types and priorities, task lifecycle, the report-on-idle rule.
- dispatch-mcp repo: `README.md` (server, CLI, hooks, fleet), `cli/PROTOCOL.md` (same protocol, versioned), `docs/runbooks/onboard-new-project.md` (how this project was set up, how to add agents, offboarding).
