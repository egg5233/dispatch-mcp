# Fleet dispatch — agent protocol (v2, 2026-09-03)

跨 agent 訊息匯流排。伺服器 `:7900`（pm2 `dispatch`），CLI 在 `~/.dispatch/`。身分 = 你的 tmux pane（自動，`$TMUX_PANE` → `fleet.json`）。
**規則來源**：`coordination/DISPATCH-V2-SPEC.md`（使用者拍板）；本檔是給 agent 的操作手冊。

## 收訊

```
~/.dispatch/dispatch-recv                      # 讀最多 30 則未讀，每則一行摘要
~/.dispatch/dispatch-recv --full <id>          # 某一則全文（摘要行超過 120 字時必看）
~/.dispatch/dispatch-recv --priority high+     # 只讀 high 以上（medium/low 留在伺服器）
~/.dispatch/dispatch-recv --all                # 不限筆數（輸出仍有 64 KB 上限）
~/.dispatch/dispatch-recv --since <id>         # 看某則之後的所有往來（不改變已讀狀態）
~/.dispatch/dispatch-recv --full all           # 這次 drain 的每則都印全文
```

摘要行格式：`id  時間  from→to  type  priority  [旗標]  前 120 字`。旗標：`[ACK!]` 需要你回 ack、`[T-…]` 關聯任務、`[FORCE]`、`[re <id>]`、`[DONE]/[CONTINUING]/…`、`[n attach]`。
**沒回傳的訊息留在伺服器未讀**（`--limit`/`--priority` 是真正的部分讀取，不會丟）。每則讀過的訊息也會附加到 `~/.dispatch/spool-<handle>.jsonl` 當本地存檔。

## 發訊

```
~/.dispatch/dispatch-send <handle|all> [旗標] "<body>"
  --type task|question|request_permission|report|ack|info   (預設 info)
  --priority low|medium|high|immediate                      (預設 medium；PRIORITY=high 環境變數仍可用)
  --ack yes|no|auto              auto = priority 為 high/immediate 時必須 ack (預設 no)
  --re <msg id | task id>        回覆/ack/report 對象
  --task <T-id>                  明確指定任務
  --state done|continuing|waiting|blocked   (只給 --type report)
  --attach <path> ...            附檔（本機絕對路徑，可多個；不是上傳，i5 上的 agent 讀不到）
  --force                        只能配 --priority immediate（見下）
```

**body 上限 1,500 字元**（超過伺服器回 400）——長內容寫成檔案、body 放摘要 + `--attach`。

## type 語意

| type | 用途 | 收到後你該做什麼 |
|---|---|---|
| `task` | 指派工作；伺服器自動建 `tasks` 列，id `T-YYYYMMDD-NN` | 需要 ack 時先 ack（見旗標 `[ACK!]`），做完/卡住用 `report` 回 |
| `question` | 要你回答 | 用任何 type 帶 `--re <id>` 回，該問題自動標 answered |
| `request_permission` | 要人/coord 決定 GO/NO-GO | 同上，`--re` 回 |
| `report` | 進度回報（`--state` 必帶，預設 continuing） | **永遠不要 ack 一則 report**（伺服器會拒） |
| `ack` | 「收到、開始做」 | 必須 `--re <訊息 id>`；對方 task 自動變 acked |
| `info` | 其他 | 看情況 |

## priority 到達語意（Claude handle，hooks 已啟用時）

| priority | 你什麼時候會看到 | 誰負責送到你面前 |
|---|---|---|
| `low` | 下一個自然回合開頭（SessionStart / UserPromptSubmit digest） | 不主動喚醒；watcher 不打鍵盤 |
| `medium` | 你這回合結束時 Stop hook 擋下、要你先讀；閒置時 watcher 打一行 recv 提示 | Stop hook + watcher |
| `high` | 同 medium，並且 `--ack auto` 時要求 ack | Stop hook + watcher |
| `immediate` | **下一個工具呼叫邊界**（PreToolUse/PostToolUse 把全文塞進 context） | Pre/PostToolUse hook |
| `immediate --force` | 下一個工具呼叫被 **拒絕一次**（reason = 全文），直到你跑 dispatch-recv | PreToolUse deny |

沒裝 hooks 的 session：只剩 watcher 的鍵盤路徑（閒置時打 recv 提示，medium 以上）。Codex handle：目前只有 watcher 路徑（Codex hooks 查證見 README）。

## 任務生命週期

`type=task` → 伺服器建 `T-YYYYMMDD-NN`（status `open`；`--ack yes` 或 `--ack auto` + high/immediate ⇒ ack_required，ack 前在板上顯示「未認領」）。
- `dispatch-send <from> --type ack --re <task 訊息 id> "收到"` → task `acked`
- `--type report --state continuing` → `in_progress`；`waiting`/`blocked` → 同名狀態；`done` → `closed`，report 的 body 成為 result
- `--re` 可給任務 id 或當初那則 task 訊息 id；**沒帶 `--re`/`--task` 的 report 不會動任何任務**（只算「這回合有回報」）——要關任務一定要指名
- **Stop hook 會擋下**「持有 open task 且本回合沒送 report」的 session —— REPORT-ON-IDLE 現在是機械強制，不只靠自覺

## Hooks（每個 Claude session 的 settings 裡呼叫 `~/.dispatch/hook.sh <event>`）

| event | 行為 |
|---|---|
| SessionStart | 未讀 digest + open tasks → additionalContext |
| UserPromptSubmit | presence=busy；digest → additionalContext；記錄回合起點 |
| PreToolUse / PostToolUse | 有 immediate 未讀 → 全文（第一次）/ 一行提醒；`--force` → 拒絕一次（跑 dispatch-recv 的呼叫永不被拒） |
| Stop | presence=turn_end；有 medium+ 未讀 或 open task 沒回報 → exit 2 擋下（每回合最多一次；`stop_hook_active` 時放行） |
| Notification (idle_prompt) | presence=idle |
| SessionEnd | presence=offline |
| Wait（B′，已驗證） | async Stop hook：長輪詢 `/msg/wait`，有 medium+ 就 exit 2 → Claude Code 叫醒閒置 session（3 秒內） |

伺服器掛了：每個呼叫 ≤ 2 秒逾時、靜默放行，絕不卡住 agent。

啟用（session 的 `.claude/settings.json` 或 `~/.claude/settings.json`；實測改了設定檔下一次 Stop 就生效，不用重啟 session）：
```json
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"$HOME/.dispatch/hook.sh SessionStart","timeout":10}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"$HOME/.dispatch/hook.sh UserPromptSubmit","timeout":10}]}],
 "PreToolUse":[{"hooks":[{"type":"command","command":"$HOME/.dispatch/hook.sh PreToolUse","timeout":10}]}],
 "PostToolUse":[{"hooks":[{"type":"command","command":"$HOME/.dispatch/hook.sh PostToolUse","timeout":10}]}],
 "Stop":[{"hooks":[{"type":"command","command":"$HOME/.dispatch/hook.sh Stop","timeout":10}]}],
 "Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"$HOME/.dispatch/hook.sh Notification","timeout":10}]}],
 "SessionEnd":[{"hooks":[{"type":"command","command":"$HOME/.dispatch/hook.sh SessionEnd","timeout":10}]}]
}}
```
（Wait hook 已實測可用，設定見下一節。）

## 閒置喚醒路徑（B′ 實測結果，2026-09-03 17:07）

**可用，成為主路徑。** `asyncRewake: true` 的 Stop hook 會在背景跑 `hook.sh Wait`（長輪詢 `/msg/wait?priority=medium+`）；有 medium+ 訊息時它 exit 2，Claude Code 在 3 秒內把 session 叫醒（畫面出現「Stop hook feedback」，系統提醒內容 = digest），agent 自己跑 `dispatch-recv` 處理。實測：17:07:35 送出 → 17:07:38 agent 回覆。`low` 不會觸發（waiter 只看 medium+）。每次 Stop 會重新起一個 waiter（舊的由 pid 檔殺掉）；waiter 壽命 = `DISPATCH_WAIT_TOTAL_S`（預設 600 秒）到期後 exit 0 靜默結束，之後只剩 watcher 鍵盤路徑與下一回合 digest。

啟用（加進上面 Stop 那組，與同步 Stop hook 並列）：
```json
"Stop":[{"hooks":[
  {"type":"command","command":"$HOME/.dispatch/hook.sh Stop","timeout":10},
  {"type":"command","command":"$HOME/.dispatch/hook.sh Wait","timeout":900,"async":true,"asyncRewake":true}
]}]
```
備援：對閒置的 Claude handle，`dispatch-send` 會印 `hint: <handle> is idle (Claude session "<name>") — SendMessage(to="<name>")`，coord 可用原生 SendMessage 立即叫醒；Codex handle 維持 P0 的守衛式鍵盤 watcher（Codex 0.148 hooks 沒有 Stop 事件，見 README）。

## Fleet

`~/.dispatch/fleet.json` 是唯一名冊（handle → token/runtime/pane/session_name）；`~/.dispatch/dispatch-fleet check` 印健康表（pane 前景程式是否等於 runtime、watcher 狀態、Claude session 名稱/閒忙、伺服器端未讀深度與 open tasks），`dispatch-fleet sync [--write]` 重建（`--write` 同時重生 registry.json 給舊工具）。

| handle | runtime | pane |
|---|---|---|
| coord | claude | %0 |
| dispatch-dev | claude | %16 |
| docs-migrate | claude | %17 |
| kernel-2 | claude | %3 |
| kernel-codex | codex | %5 |
| kernel-h100 | claude | %2 |
| pearl-infra | claude | %4 |
| pearl-review | codex | %6 |
| pearl-server | claude | %9 |

tmux-bridge / to-fleet remain as fallback.

## ★★ REPORT-TO-COORD-ON-IDLE — dispatch protocol (user standing rule, 2026-06-23)

NEVER end a turn or go idle silently while you hold an active assignment. As your LAST action
before stopping, ALWAYS run `~/.dispatch/dispatch-send coord "<status>"` reporting what you just
did + current state, tagged with EXACTLY ONE of:
- [BLOCKED] — you need coord to decide/unblock before continuing (coord will re-poke you to proceed).
- [CONTINUING] — the turn ended but the assignment is NOT done; you intend to keep going. Use this
  INSTEAD of silently stopping mid-task, so coord's mailbox loop re-pokes you to resume next cycle.
- [DONE] — assignment complete, no action needed.
- [WAITING: <what>, ETA <when>] — blocked on an external dependency (build/test/GPU/pool/user).

WHY: coord's mailbox loop is the orchestrator. A silent idle = the work stalls until a human notices.
A status ping on EVERY idle lets coord pick you up within one cycle and keep you moving. A
[CONTINUING] or [BLOCKED] ping is NEVER noise here — report even small updates.

## ★★ GIT HANDOFF DISCIPLINE (user standing rule, 2026-06-24)

Recurring failure that has BLOCKED work + caused confusion (host-wiring b4999d9 was committed i5-local
and never pushed → pearl-review couldn't fetch it; the shape-override change sat as a loose nano2 .diff
and never hit a branch). Fix — these are MANDATORY for every agent:

1. **"Done" for any handoff = PUSHED TO ORIGIN.** Before you report a branch/sha to coord or another
   agent as ready (for review / merge / test / handoff), it MUST be on `origin`. A box-local commit is
   NOT a deliverable.
2. **Report the remote ref + verify it.** Report as `origin/<branch> @ <sha>` and confirm with
   `git ls-remote origin <branch>` (paste/observe the sha). "Committed" alone is BANNED — say WHERE it
   lives. Repos push over SSH (`git@github.com:egg5233/...`); you already have push access, so push.
3. **Push at EVERY boundary.** Any cross-agent transition (dev→review, kernel→miner, producer→coord)
   → commit + push FIRST. Never "I committed on my box, you pull from it."
4. **No loose diffs/patches as the source of truth.** Don't park work as a `.diff`/`.patch` on a box
   (e.g. `nano2:/root/*.diff`). Put it on a pushed branch. A diff file is OK only as transient
   transport; the canonical artifact is the `origin` branch.
5. **Unpushed WIP MUST be labeled.** If you report progress that is NOT yet pushed, tag it explicitly
   `WIP local-only, not pushed` so no one treats it as fetchable.

coord-side gate: before dispatching a downstream agent against a reported sha, coord runs
`git ls-remote origin <branch>` to confirm it's on origin; if not, it bounces back to the producer
("push first") instead of dispatching downstream.

WHY: a sha that isn't on origin is invisible to every other agent + host. Reporting one as "ready"
stalls the whole pipeline at the next fetch. Pushing at the boundary is ~2s and removes an entire
class of BLOCKs.

## ★★ WINRATE GATE = DEFAULT PERF METRIC (user standing rule, 2026-07-15 — SUPERSEDES pool-credited-only)

For any perf A/B (kernel / variant / shape / dispatch), run the **WINRATE GATE** (offline calibrated
winner-rate = hits/attempts × difficulty; see coord's winrate-gate-runbook) as the DEFAULT. Do **NOT**
run a live **pool-credited** accepted-share A/B anymore **EXCEPT** for special bugs that only manifest
pool-side (e.g. **stale-share testing**, or a "pool < local" discrepancy report).

WHY: pool-credited resolution is Poisson-limited — resolving a ~1.4% effect at a static-diff pool needs
~350 HOURS/arm (the CLC +1.36% ABBA on herominers left CI [-16.7%,+51.1%], p=0.45, UNRESOLVED). The
winrate gate computes the same credited-equivalent DETERMINISTICALLY offline: ~hundreds-of-thousands of
calibrated hits in 600s/leg → delta resolves to ~0.2-0.3% CI in minutes. This does NOT resurrect naive
bench — the winrate gate is a calibrated credited-equivalent, not local avg_ths; iso-clock/local stays
scouting-only.

★ POOL-BLOCK WORKAROUND (for the special-bug live-pool cases + any live confirm from a rented/DC box):
when the box's datacenter IP is RST'd/NOHASH'd by the Pearl pools, mine via the **CN2_1..CN2_8 forwarder
IPs** (bypass the HK DC-IP RST): cn2_1=38.181.34.151 · cn2_2=207.56.227.64 · cn2_3=191.223.40.85 ·
cn2_4=191.223.40.84 · cn2_5=191.223.40.83 · cn2_6=191.223.40.104 · cn2_7=191.223.40.103 ·
cn2_8=191.223.40.102. herominers fwd = `stratum+ssl-insecure://191.223.40.83:1200` (ssl-insecure; worker
name must have NO `+`).

## ★★ PERF / BENCHMARK BUILD = DIST, BOTH LEGS (user standing rule, recurred 2026-06-24)

Every hashrate/perf A/B number MUST be measured on a SHIP-CONSISTENT `PEARL_CUDA_ARCH=dist` build —
NOT a single-arch (`PEARL_CUDA_ARCH=sm_XX`) or dev build. **This applies to BOTH legs: the candidate
AND the baseline.**

WHY: a single-arch / dev build compiles the GENERIC kernel. The shipped `dist` build's runtime
dispatch routes each arch to its dedicated TUNED variant (FIXED_RANK256_/FIXED_RANK512_ + FAST_LAYOUT_
+ PERSISTENT_CTA_ + ASSUME_FULL_TILES_ + per-arch WM/WN + SWIZZLE). The generic kernel is much slower.
Concrete recurrence (2026-06-24): an A100 r256 BASELINE built single-arch via `add_arch_default_args`
(which only has an sm_120a branch → sets NOTHING for sm_80) read ~52 avg_ths instead of the dist-tuned
~184 → made rank-512 look like +263% when the real delta is ~+15%. Earlier (2026-06-15): 5070Ti
generic ~150 vs dist ~167. **An undertuned BASELINE inflates the candidate's win just as badly as an
undertuned candidate.**

RULES:
1. Build `PEARL_CUDA_ARCH=dist`. If you need the positional/insecure path (shape override, VALIDATE_*),
   build `dist` + `--features insecure-transport` — ONE binary does both; insecure-transport is
   transport-only, zero kernel/perf effect.
2. Both A/B legs come from the SAME dist build (force the variant with PEARL_KERNEL_VARIANT, don't
   switch to a single-arch build for either leg).
3. Single-arch is fine ONLY for a quick functional/correctness smoke — NEVER for a number, and NEVER
   for the baseline. (Correctness too: re-prove bit-exact in the dist-baked config, not the dev one.)
4. coord will NOT waive this for "fallback arches" (sm_80/sm_75/etc) — those are exactly the arches
   `add_arch_default_args` leaves untuned, so they need dist MOST.
5. Companion rules already in coord memory: live-pool submit (not BENCH) for submit-path A/Bs;
   power-cap awareness (log power.draw per leg); nvshare ≠ perf baseline.

## ★★ BENCHMARK STRATEGY = (G + WM/WN) FIRST, THEN SHAPE (user standing rule, 2026-06-25, rev2)

Every perf eval of a kernel config is TWO ORDERED STAGES — never judge from one shape at one tile config:
1. **Find the best KERNEL TILE CONFIG first = best (G swizzle, WM/WN warp-tiling) jointly.** Sweep
   G {8,16,32} × WM/WN {2/4, 4/2, 4/4, …valid combos} at a fixed reference shape (131072²); pick the
   arch's best (G, WM/WN). These are L2/band-working-set + warp-tiling properties, ~per-arch / per-L2-tier.
   (WM/WN are compile-time `-DWM_/-DWN_`; default bake is 2/4 — do NOT assume it's optimal, SWEEP it.)
2. **THEN sweep SHAPE with best-(G,WM/WN) fixed.** Full M×N grid spanning square / tall-narrow (M<N) /
   wide-N and several sizes (16384²/32768²/65536²/98304²/131072² + 8192x131072/16384x65536/16384x131072/
   16384x262144/32768x131072/32768x262144 + 32768x65536/65536x131072/65536x262144). Short-scout to rank,
   then 5-min live-pool confirm the top 3-4.

Result = best-G × best-WM/WN × best-shape. Compare against the baseline at ITS shipped/auto-tuned config
(v2.1.10 release auto-picks its own shape). WHY: all THREE tile knobs (G, WM/WN, shape) INTERACT; the
2026-06-25 gate round swept G+shape but used baked WM2/WN4 (not re-confirmed at best-G×best-shape) — that's
an incomplete eval. rank-512 is shape-sensitive (sm_75: 65536²=57.9 vs 131072²=44.6 = +30%); WM/WN
historically ±1-2% but unswept-at-best-config. A forced single config UNDERSTATES and gives false par/loss.

★ CORRECTNESS for tile-config (G/WM/WN/shape) sweeps: do NOT run a separate bit-exact/VALIDATE_XORED/GPU2
gate — the live-pool A/B confirms it. A broken config → invalid shares → rejects, so 0 non-shape rejects on
herominers during the 5-min run = correct (the pool validates the proof). These are tile-config sweeps of an
already-validated mainloop. (A NEW kernel mainloop STILL needs bit-exact in the dist-baked config.)
