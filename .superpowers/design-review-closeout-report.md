# Design review closeout — P2/P3 rows (section 4)

Verified every P2/P3 row (7–35) in `docs/design-review-2026-09-08.md` against the current
`kupa-sgura.html` (version 63) before touching anything, per the task's warning that the review
document is stale. Result: **all rows are already implemented** — in commit `b87b7e8` and the
design rounds since. No code change was required, so nothing was committed.

## Per-row verification table

| # | Ask | Status | Evidence |
|---|---|---|---|
| 7 | `p.buyins.length + " כניסות"` → `formatEntryCount` | already done | line 6729: `formatEntryCount(p.buyins.length)` |
| 8 | `g.players.length + " שחקנים"` → `formatPlayerCount` | already done | line 8143: `formatPlayerCount(g.players.length)` |
| 9 | space between number/unit in `formatDuration`; "0דק׳" → "פחות מדקה" | already done | line 2927 `formatDuration`: `mins + " דק׳"` (space present), `0` → `"פחות מדקה"` |
| 10 | `.pval` needs `pos/neg/zero` classes for best/worst night | already done | line 695 CSS + line 8113 `tone()` helper applied to best/worst cells |
| 11 | unify date format (`toLocaleDateString`) across debts/history | already done | all 3 call sites (5273, 7705, 8142) use identical `{day:"numeric", month:"short"}` |
| 12 | remove duplicate "חובות"/"חברים" section title next to tab | already done | explicit "Row 12" comment at line 8079; debt pane has no `ptitle` |
| 13 | `.games-card-toggle` label "הרחב"→"כווץ" when expanded | already done | line 5423 |
| 14 | unify `.games-section-title`/`.ptitle`/`.results h2` into one rule/spacing | already done | line 354, single shared rule |
| 15 | group-start panel: title "מי משחק?" + "נבחרו N מתוך M" counter | already done | lines 5805, 5870–5872 with "Row 15" comment |
| 16 | exit panel: label/placeholder, ₪ sign, "ביטול", positioned inside `.prow` | already done | lines 6888–6935, explicit "Row 16" comment; `.exit-currency`, `exitCancelBtn` present |
| 17 | separate "עריכה" from the exit-tag meta string | already done | lines 280–288, 6731–6732, "Row 17" comment |
| 18 | 44px touch targets + 16px gap for member promote/remove | already done | lines 553–563, "Row 18" comment |
| 19 | `.set-flat` neutral = `--text`, disabled = `--faint` (not opacity) | already done | lines 871–874, 931–932 |
| 20 | settlement: drop the duplicate red imbalance sentence | already done | lines 7013–7020, "Row 20" comment |
| 21 | join notice: show group name, dim the code, add "לא עכשיו" | already done | markup lines 1162–1169 (`joinNoticeGroup`, `joinNoticeCode` is `--dim`, `joinNoticeLaterBtn`) |
| 22 | one shared "יעבוד כשהאפליקציה תתחבר לשרת" string | already done | `SERVER_NOTE` constant (line 1284) used at 5 call sites |
| 23 | back-arrow from table to group page | already done | `renderTableHeader` (line 6617) builds `.back-arrow`; click handler at 6630 returns to `openGroup` |
| 24 | unify debt meta wording + direction colour in the row itself | already done | line 7726 "ממתין לתשלום" everywhere; line 7725 `pos`/`neg` on `.debt-amount`, "D4" comment |
| 25 | indent `.games-history-rank` so it reads as nested | already done | line 583: `padding-inline-start: 14px`, `color: var(--dim)` |
| 26 | verify archived-group route opens read-only group page | already done | `openGroup`→`setAppView("group")`; lines 6542–6552 render read-only "הקבוצה בארכיון" state with restore in settings |
| 27 | anchor avatar+name in a row instead of centered head | already done | `.games-group-head` (line 443): `display:flex; justify-content:flex-start; text-align:start` |
| 28 | debts tab switcher — **owner decision: keep as tabs** | no longer applies | left untouched per instructions; confirmed still `role="tablist"` / `.profile-tab` at lines 8049–8060 |
| 29 | theme-switch thumb accent color when active; 20px action spacing | already done | line 870 `.switch.on::after { background: var(--accent) }`; line 828 `.set-in { gap: 20px }` |
| 30 | `.btn-plus` touch target to 44px | already done | lines 190–192, "Row 30" comment: 38px circle + `::before { inset: -3px }` = 44px hit area |
| 31 | invite block: QR or sentence, not both saying the same thing | already done | lines 6508–6514: QR always shown, `SERVER_NOTE` (a different, non-redundant message) only when `!supabase` |
| 32 | unify inline panel shape (title, full-width field, confirm+cancel) | already done | add-member panel matches create-group panel; "Row 32" comment at line 6203 |
| 33 | remove/rename "פעולות מהירות" generic heading | already done | string no longer present anywhere in the file |
| 34 | align settings entry point (icon + label) on both screens | already done | `#settingsBtn` (lines 1008–1011) and group's `settingsBtn` (lines 5676–5682) both render icon + visible "הגדרות" label |
| 35 | update `DESIGN.md` re: friends tab's three lists vs. one message | already done | `DESIGN.md` lines 330–336 describe the empty state *and* the three `renderFriendGroup` lists (friends/incoming/outgoing) matching `kupa-sgura.html` lines 7965–7981 |

## Outcome

- Rows verified: 29 (7–35).
- Already done: 28.
- No longer applies: 1 (row 28 — explicit owner decision, untouched).
- Newly fixed: 0 — no code changes were needed.
- Tests: ran `node --test tests/*.test.cjs` → 600/600 passing (baseline unchanged, no new tests needed since nothing changed).
- `git diff --check`: clean. Last `<script>` body parses via `new Function`.
- No commit was created (nothing to commit — working tree unchanged aside from this report).
