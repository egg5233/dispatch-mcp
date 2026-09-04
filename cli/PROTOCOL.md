# Fleet dispatch — agent protocol (v2, 2026-09-03)

跨 agent 訊息匯流排。伺服器 `:7900`（pm2 `dispatch`），CLI 在 `~/.dispatch/`。身分 = 你的 tmux pane（自動，`$TMUX_PANE` → `fleet.json`）。每個 handle 屬於一個 **專案**（fleet.json `projects`）；`dispatch-send coord` 的 `coord` 由伺服器解析成**你所屬專案的 coordinator**（coordinator 本身就叫 `coord` 的專案不受影響）。
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
~/.dispatch/dispatch-send <handle|all|coord> [旗標] "<body>"
  coord = 你所屬專案的 coordinator（伺服器解析；回覆會印 "sent -> coord-xxx (alias coord)"）
  --type task|question|request_permission|report|ack|info   (預設 info)
  --title "<標題>"               type=task 建議必填：存進 tasks.title、當鏡像檔名 slug；
                                 未給則取 body 第一行去掉 [TASK] 類前綴、截 80 字
  --priority low|medium|high|immediate                      (預設 medium；PRIORITY=high 環境變數仍可用)
  --ack yes|no|auto              auto = priority 為 high/immediate 時必須 ack (預設 no)
  --re <msg id | task id>        回覆/ack/report 對象
  --task <T-id>                  明確指定任務
  --state done|continuing|waiting|blocked   (只給 --type report)
  --project <name>               type=task：改歸到別的專案（預設 = 發送者的專案 → 該專案的 coordination/tasks/ 鏡像）
  --attach <path> ...            附檔（本機絕對路徑，可多個；不是上傳，其他主機上的 agent 讀不到）
  --force                        只能配 --priority immediate（見下）
```

**body 上限 1,500 字元**（超過伺服器回 400）——長內容寫成檔案、body 放摘要 + `--attach`。

## type 語意

| type | 用途 | 收到後你該做什麼 |
|---|---|---|
| `task` | 指派工作（建議帶 `--title`）；伺服器自動建 `tasks` 列，id `T-YYYYMMDD-NN`，鏡像檔 `coordination/tasks/T-YYYYMMDD-NN-<title slug>.md` | 需要 ack 時先 ack（見旗標 `[ACK!]`），做完/卡住用 `report` 回 |
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

**可用，成為主路徑。** `asyncRewake: true` 的 Stop hook 會在背景跑 `hook.sh Wait`（長輪詢 `/msg/wait?priority=medium+`）；有 medium+ 訊息時它 exit 2，Claude Code 在 3 秒內把 session 叫醒（畫面出現「Stop hook feedback」，系統提醒內容 = digest），agent 自己跑 `dispatch-recv` 處理。實測：17:07:35 送出 → 17:07:38 agent 回覆。`low` 不會觸發（waiter 只看 medium+）。每次 Stop 會重新起一個 waiter（舊的由 pid 檔殺掉）；waiter 壽命 = min(`DISPATCH_WAIT_TOTAL_S`, hook 的 `timeout`)：**Claude Code 會在 hook `timeout` 到時殺掉 async waiter 且不喚醒**（實測 timeout 900 → 15 分鐘後 waiter 消失、之後的 high 訊息沒人接）。所以設定用 timeout 86400 + DISPATCH_WAIT_TOTAL_S=86000（一天）；到期靜默結束後只剩 watcher 鍵盤路徑與下一回合 digest。

啟用（加進上面 Stop 那組，與同步 Stop hook 並列）：
```json
"Stop":[{"hooks":[
  {"type":"command","command":"$HOME/.dispatch/hook.sh Stop","timeout":10},
  {"type":"command","command":"DISPATCH_WAIT_TOTAL_S=86000 $HOME/.dispatch/hook.sh Wait","timeout":86400,"async":true,"asyncRewake":true}
]}]
```
備援：對閒置的 Claude handle，`dispatch-send` 會印 `hint: <handle> is idle (Claude session "<name>") — SendMessage(to="<name>")`，coord 可用原生 SendMessage 立即叫醒；Codex handle 維持 P0 的守衛式鍵盤 watcher（Codex 0.148 hooks 沒有 Stop 事件，見 README）。

## Fleet 與專案

`~/.dispatch/fleet.json` 是本機名冊（`projects.<name>` → coordination_dir/tmux_session/coordinator；`handles.<h>` → token/runtime/pane/project/session_name），伺服器 DB 存同一份（遠端主機的 handle 以伺服器為準）。`~/.dispatch/dispatch-fleet check` 印健康表（project、pane 前景程式是否等於 runtime、watcher 狀態、Claude session 名稱/閒忙、伺服器端未讀深度與 open tasks，加上每個專案 fleet.json＝伺服器、coordinator 有帳號），`dispatch-fleet sync [--write]` 重建（projects 與 project 欄位保留）。

專案規則：handle 全域唯一、只屬一個專案；`type=task` 歸發送者的專案，鏡像寫到該專案的 `coordination/tasks/`；平台型 handle（例如維護 dispatch 本身的 agent）可以放在自己的專案、由某個既有 coordinator 兼管，任何 coordinator 都可直接發給它。新專案：`dispatch-fleet project add <name> --dir … --session … --coordinator coord-<name>` → `dispatch-fleet add coord-<name> --project <name> --cwd … --runtime claude` → `dispatch-fleet add <name>-<role> …`（可 `--pane %N` 登記既有 pane）→ `dispatch-fleet check`。退場：每個 handle `dispatch-fleet remove <h> --watcher`，再 `dispatch-fleet project remove <name>`。Dashboard 右上角可切換專案。

本機 handle 清單看 `~/.dispatch/dispatch-fleet check`（每列有 project / pane / runtime / watcher / 未讀）。

tmux-bridge / to-fleet remain as fallback.

## 本機附加規則

主機營運方的常設規則（使用者裁定）放在 `~/.dispatch/PROTOCOL.local.md`，`deploy/install-cli.sh` 會把它接在本檔之後寫成 `~/.dispatch/PROTOCOL.md`；不進 dispatch-mcp repo。
