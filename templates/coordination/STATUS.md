# {{PROJECT}} status board

Human-readable summary kept by the coordinator. **Dispatch is the system of record** (messages,
tasks, `tasks/` mirror); this board is what a person reads first.

Format: newest first, one paragraph per event, never edit old entries:

`YYYY-MM-DD HH:MMZ <handle>: **HEADLINE** — what changed, evidence (paths, commit sha, task id), what is still open.`

{{DATE}} {{COORDINATOR}}: **project initialized** — `coordination/` created from dispatch-mcp `templates/coordination/` by `dispatch-init-project`; workspace `{{WORKSPACE}}`, tmux session `{{PROJECT}}`, coordinator handle `{{COORDINATOR}}`.
