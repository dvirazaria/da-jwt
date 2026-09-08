# מוכנות ל-Backend — "סוגרים קופה"

תאריך: 2026-09-08. מסמך תיעוד בלבד (Task 17); אין כאן שינוי קוד ריצה.
נכתב אחרי סבב "קבוצות, חברים ומשחקי קבוצה" (`docs/superpowers/plans/2026-09-07-groups-foundation.md`),
שבנה את כל מודל הנתונים והזרימות בצד הלקוח, ואחרי מחקר הפלטפורמה וה-artifacts שכבר קיימים
תחת `docs/backend/`. המסמך הזה **לא חוזר** על SQL — הוא מפנה אליו, ומתאר את התמונה מנקודת המבט
של המעבר: מה קיים היום ב-`state`, מה ידרוש שרת, ואיך אחד הופך לשני.

מסמכי היסוד שהוא תלוי בהם ולא משכפל: [`docs/backend/schema.sql`](backend/schema.sql) (DDL),
[`docs/backend/rls-policies.sql`](backend/rls-policies.sql) (הרשאות), [`docs/backend/platform-research.md`](backend/platform-research.md)
(בחירת Supabase), [`docs/backend/migration-from-local-state.md`](backend/migration-from-local-state.md)
(מיגרציה חד-פעמית), [`docs/backend/frontend-seam.md`](backend/frontend-seam.md) (מה משתנה בקוד הלקוח).

## 1. ישויות שדורשות backend

כל הישויות האלה כבר קיימות כ-collections טהורים בתוך `state` (ר' §4) ויש להן טבלה מקבילה ב-`schema.sql`:

| ב-`state` היום | טבלה ב-DB | הערה |
| --- | --- | --- |
| `me` (שם מוקלד) | `profiles` | היום אין UUID אמיתי; `profiles.id` = מזהה ה-auth provider. |
| — (משתמע משמות) | `guests` | אדם בלי חשבון; `resolveGuestId` בלקוח מקביל ל-`identity_key()` ב-DB. |
| `state.groups[]` | `groups` | ללא שינוי מבני. |
| `state.groupMembers[]` | `group_members` | כולל former members (`left`/`removed`). |
| `state.invites[]` | `invites` | טוקן + מצב revoke/expire. |
| `state.friendships[]` | `friendships` | בקשה מכוונת, זוג ייחודי. |
| `state.players/phase/gameId/groupId/startedAt/leaderRef` (המשחק הפתוח היחיד) | `games` | היום יש **שורה אחת** בלבד; ב-DB זו טבלה מלאה. |
| `player` בתוך `state.players[]` | `game_participants` | מושב אחד במשחק אחד. |
| `player.entryLog[]` | `entries` | append-only כבר היום; זהה מבנית. |
| `state.history[].transfers[]` + `settlementStatuses` | `transfers` | reversible כל עוד המשחק פתוח, קפוא אחרי סגירה. |
| `state.debts[]` | `debts` | נוצר רק לסגירה, על העברות שלא סומנו כ"שולם". |
| — (נגזר ב-`toGroupGameSummary`/`buildLeaderboard`) | `game_results_v`, `group_leaderboard_v`/`_public_v` | VIEWs, לא טבלאות — ר' §3. |

## 2. קשרים בין הישויות

`groups 1—N group_members`, `groups 1—N invites`, `groups 1—N games` (עם `group_id NULL` למשחק ללא
קבוצה). `games 1—N game_participants 1—N entries`. `games 1—N transfers`, `games/groups 1—N debts`.
כל טבלה שמצביעה על **אדם** (`group_members`, `game_participants`, `debts`, `games.leader_*`) נושאת
זוג `profile_id NULL REFERENCES profiles / guest_id NULL REFERENCES guests` עם
`CHECK (num_nonnulls(profile_id, guest_id) = 1)` — בדיוק המקביל ל-`ParticipantRef` הקיים בקוד
(`{ userId, guestId, displayName }`). זו נקודת האיחוד היחידה בין "מזוהה" ל"אורח"; ר' `schema.sql` §0–1.
`guests.linked_profile_id` הוא צינור המיזוג העתידי guest→account, בלי לגעת בשורות היסטוריה.

## 3. מקור אמת מול שדות נגזרים

**מקור אמת** (נכתב, לא מחושב): `players`/`buyins`/`entryLog`/`cashout`, `groups`, `groupMembers`,
`invites`, `friendships`, `history` (רשומות משחק סגור), `debts`, `settlementStatuses`. אלה הופכים
לשורות טבלה רגילות ב-DB.

**שדות נגזרים** (Global Constraint 5 בתוכנית: "derived data is computed by adapters, never stored"):
`GroupSummary`, `LeaderboardEntry`, `GroupGameSummary`, `gameWinners`, `tableBalance`, `net`. אלה
נשארים לא-מאוחסנים גם ב-DB — ממומשים כ-VIEWs (`game_results_v`, `group_leaderboard_v`,
`group_leaderboard_public_v`, `my_group_stats_v`), לא כטבלה שנכתבת בסגירה. הסיבה מתועדת ב-`schema.sql` §4:
מקור אמת יחיד (`buy-in total = SUM(entries.amount)`), משחק סגור בלאו-הכי immutable (RLS + טריגר), וכמות
השורות זניחה. הופכת לטבלה מאוחסנת רק אם היקף משתמשים ידרוש זאת (הערה מפורשת בקובץ).

## 4. אחסון זמני היום (`poker-settle-v1`)

מסמך `state` יחיד תחת מפתח `localStorage` אחד (`poker-settle-v1`), מנורמל ע"י `normalize()` בכל
טעינה, נכתב ע"י `save()` היחיד. אין store שני ואין מפתח נוסף (`poker-settle-me`, `-theme`, `-contact`,
`-profile-debts-seen` הם UI-only ונשארים). כשרץ כ-artifact ב-claude.ai, `remoteBody()`/`applyRemote()`/
`initSync()` משכפלים את **אותו** מסמך שלם למסמך Firestore-כמו־(`db.doc("games/current")`) עם
last-writer-wins ברמת המסמך כולו — ולא ברמת שורה. `HISTORY_MAX` (400) חותך את המסמך כדי שלא יגדל
בלי גבול; ר' §14 להשלכה על מיגרציה. זו כל שכבת ה"backend" הקיימת היום, וכולה מיועדת להחלפה מלאה.

## 5. Endpoints / actions נדרשים

רשימת ה-RPC/actions שהלקוח יצטרך (שם מוצע → קלט → אפקט). מבוססת על הפונקציות הטהורות שכבר קיימות
ב-`kupa-sgura.html` תחת `// ---------- groups domain (pure) ----------` ו-`// ---------- invites (pure) ----------`,
שכל אחת מהן היא בדיוק המפרט לפונקציית ה-RPC המקבילה:

| Action | קלט | אפקט |
| --- | --- | --- |
| `auth.signIn` | Google OAuth / email OTP | יוצר/טוען שורת `profiles`; ר' §6. |
| `groups.create` | `name, avatarDataUrl?` | INSERT `groups` + `group_members` (יוצר = admin, active). מקביל ל-`buildGroupCreation`. |
| `groups.rename` / `.setAvatar` | `groupId, name`/`dataUrl` | UPDATE `groups`, admin בלבד. |
| `groups.archive` / `.unarchive` / `.delete` | `groupId` | UPDATE `archived_at`/`deleted_at` (soft delete תמיד). |
| `groups.members.add` | `groupId, ref, role` | INSERT `group_members`; מקביל ל-`addGroupMember`. |
| `groups.members.remove` / `.setRole` | `memberId, ...` | UPDATE `status='removed'`/`role`; מסרב אם admin אחרון (`isLastActiveAdmin`). |
| `groups.members.leave` | `groupId` | UPDATE `status='left'` על השורה של המשתמש עצמו. |
| `invites.create` / `.revoke` | `groupId` | INSERT/UPDATE `invites`; טוקן 8 תווים כמו `generateInviteToken`. |
| `invites.redeem` | `token` | `SECURITY DEFINER` RPC (§9) — הצטרפות אמיתית, לא קיים בלקוח היום. |
| `friends.request.create` | `toRef` | INSERT `friendships` (status `pending`); מקביל ל-`createFriendRequest`. |
| `friends.request.respond` | `id, accept` | UPDATE `status`; מקביל ל-`respondToFriendRequest`. |
| `games.start` | `groupId\|null, participants[]` | INSERT `games` + `game_participants` + `entries` ראשוני (buy-in פתיחה). |
| `games.entries.add` | `gameId, participantId, amount` | INSERT ל-`entries` (append-only, לא UPDATE). |
| `games.participants.exit` | `participantId, cashout` | UPDATE `game_participants.status='exited', cashout`. |
| `games.close` | `gameId, transfers[]` | RPC אחת אטומית (`close_game`): `phase='closed'`, כתיבת `transfers`+`debts`. |
| `debts.markPaid` | `debtId` | UPDATE `status='paid', paid_at`; רק הנושה. |
| `guests.linkToProfile` | `guestId, profileId` | `SECURITY DEFINER` RPC בהסכמת שני הצדדים (ר' migration-from-local-state.md). |

הרשימה הזו **לא** כוללת חישוב סכומים בשרת מעבר לאימות — `settle()`/`tableBalance()`/`wholeMoney`
נשארים בלקוח; השרת רק שומר ומאמת integer, לפי `frontend-seam.md` §"מה נשאר".

## 6. הנחות אימות (authentication)

היום: "התחברות" היא שם מוקלד בלבד (`poker-settle-me`), לא אימות — `HANDOFF.md` וה-CLAUDE.md כבר
מזהירים לא להתייחס אליה כגבול אבטחה. `ParticipantRef.userId` הוא **תמיד `null`** בקוד הקיים; שום
דבר לא ממציא לו ערך (Task 0 audit). המעבר, לפי `platform-research.md` §4–6: Google OAuth כברירת מחדל
+ email OTP כגיבוי (לא magic link — פותח דפדפן חיצוני ומאבד session ב-PWA מותקנת; לא phone OTP —
$0.2575/הודעה ל-Twilio בישראל). `profiles.id` שווה למזהה ה-auth provider — נקודת הצימוד היחידה לספק
(`schema.sql` §1). אחרי שה-session חי, `me` הופך לתוצר של `supabase.auth.getSession()` במקום מחרוזת
מקומית, ו-`isLeaderboardEligible` מתהדק אוטומטית ל-`userId != null` בלי לגעת ב-UI —
בדיוק כפי שתוכנן מראש. `poker-settle-me` לא נעלם; הוא נשאר cache אופליין (`frontend-seam.md` §1).

## 7. בקשות חברות (friend requests)

המודל קיים ומתועד במלואו כ-Friendship `{ requester, addressee, status, ... }` וכל שלוש הפונקציות
הטהורות (`friendRequestsFor`, `createFriendRequest`, `respondToFriendRequest`) עובדות ונבדקות
(`tests/friends.test.cjs`). ה-UI (לשונית "חברים" בפרופיל) **מציג** שלוש רשימות ריקות ואינו קורא
ל-`createFriendRequest` בכלל — נבדק ב-regex ייעודי, כדי שלא ייווצרו friendships מקומיות מזויפות.
ה-DB: `friendships` עם `UNIQUE` על הזוג הלא-מסודר (מי שביקש ראשון), כך שהיחס בפועל בלתי-מכוון.
תלוי לחלוטין ב-`profiles` אמיתיים — שני הצדדים חייבים חשבון; לכן זו הישות היחידה שלא מהגרת חלקית
(ר' §14).

## 8. הזמנות לקבוצה (group invites)

הלקוח כבר מייצר ומציג טוקן אמיתי: `createInvite`/`activeInvite`/`revokeInvite`/`inviteLink`/
`formatInviteCode`/`parseJoinToken`, עם UI מלא (קוד, "העתק קישור", "שתף", תא QR עם הטקסט "QR יופיע
עם חיבור לשרת" — placeholder בכוונה, `.games-invite-qr`). מה שחסר: **מימוש ההצטרפות עצמה** — ר' §9.
ה-DB מוסיף `expires_at`/`revoked_at` ו-RPC `redeem_invite(p_token)`.

## 9. זרימת ההצטרפות (join flow)

היום: פתיחת `?join=CODE` מציגה הודעה ("קיבלת הזמנה לקבוצה. הצטרפות תעבוד כשהשרת יחובר.") ו**לא
משנה state בכלל** — נבדק שהמצב לא זז. הסיבה שזו לא UPDATE רגילה גם ב-DB: מי שמצטרף עדיין אינו חבר,
ואין SELECT policy שנותנת לו לקרוא את הקבוצה או את הטוקן. לכן ההצטרפות **חייבת** לעבור דרך פונקציה
`SECURITY DEFINER` (`redeem_invite`) שמאמתת `revoked_at`/`expires_at` בעצמה ומכניסה את שורת
`group_members` מבפנים — לא UPDATE ישיר מהלקוח (`rls-policies.sql`, ליד סעיף ה-group_members policies).

## 10. חברויות (memberships)

`group_members.status ∈ active|left|removed`; former members **נשארים** בטבלה כי הדירוג עדיין סופר
את המשחקים הסגורים שלהם (`isFormerMember` ב-`LeaderboardEntry`). אילוץ ב-DB: `UNIQUE` חלקי על
`(group_id, identity)` **רק** ל-status `active` — עזיבה וחזרה יוצרות שורה היסטורית שנייה, לא דורסות
את הראשונה. "לקבוצה תמיד יש admin אחד לפחות" לא ניתן להבעה כ-constraint הצהרתי (deferred trigger);
נאכף בנתיב ה-UPDATE של admin ובלקוח (`isLastActiveAdmin`) — מתועד כפער מכוון ב-`schema.sql`.

## 11. מטריצת הרשאות

| פעולה | admin | member פעיל | former member | guest (לא-חבר) |
| --- | --- | --- | --- | --- |
| צפייה בקבוצה/היסטוריה/דירוג | ✓ | ✓ | ✗ (לא ב-SELECT) | ✗ |
| הוספת/הסרת חברים, שינוי role | ✓ | ✗ | ✗ | ✗ |
| עריכת משחק פתוח (buy-in/cashout/יציאה) | ✓ | ✓ (שיתופי, כל חבר פעיל) | ✗ | ✓ אם participant/creator של משחק ad-hoc |
| התחלת משחק לקבוצה | ✓ | ✓ | ✗ | ✗ |
| עזיבת קבוצה | ✓ אם לא ה-admin האחרון | ✓ | — | — |
| ארכוב/מחיקת קבוצה | ✓ | ✗ | ✗ | ✗ |
| צפייה ב-net/P&L אישי | עצמו בלבד | עצמו בלבד | עצמו בלבד | עצמו בלבד |
| צפייה בחובות | צד לחוב בלבד | צד לחוב בלבד | צד לחוב בלבד | צד לחוב בלבד |

הטבלה ממפה ישירות לפונקציות ה-predicate ב-`rls-policies.sql` (`app_is_active_group_member`,
`app_is_group_admin`, `app_can_read_game`, `app_can_write_game`, `app_is_game_participant`,
`app_is_friend_of`) — כולן `SECURITY DEFINER` כדי למנוע רקורסיה של policy שקורא לטבלה שהיא מגינה
עליה. השורה "net/P&L" ו"חובות" היא Global Constraint 10 בתוכנית ("קבוצה לא מציגה net/חוב של אדם אחר"),
וברמת ה-DB זו לא רק מוסכמת UI: `group_leaderboard_v` (עם `net`) לא מוענקת לתפקיד הלקוח כלל; רק
`group_leaderboard_public_v` (בלי כסף) ו-`my_group_stats_v` (רק המשתמש עצמו).

## 12. concurrency של משחק פעיל

היום: סלוט גלובלי יחיד (`state.players/phase/gameId`) — **כל המכשיר**, לא רק כל קבוצה, יכול להריץ
משחק אחד בו-זמנית. `canStartGroupGame` מבחין בין שני מצבים: `group-has-open-game` (לקבוצה הזו כבר
יש משחק) ו-`another-game-open` (למכשיר יש משחק של קבוצה/ad-hoc אחר) — המגבלה השנייה היא מגבלת המנוע
הקיים, לא כלל מוצרי. ה-DB **משחרר** את המגבלה השנייה: `games_one_open_per_group_uk` הוא `UNIQUE INDEX`
חלקי על `group_id WHERE phase <> 'closed'` — per-group, לא per-device. כלומר כמה קבוצות יכולות להריץ
משחקים פתוחים במקביל בשרת אחד; המגבלה "מכשיר אחד, משחק אחד" נעלמת ברגע שיש client-side routing אמיתי
בין משחקים (כבר לא רלוונטית כשה-UI קורא `games` לפי `group_id` ולא סלוט יחיד). משחקי ad-hoc
(`group_id NULL`) נשארים בלתי-מוגבלים כי הם per-device מטבעם.

## 13. חובות והתחשבנות (debts/settlement persistence)

היום: `settlementStatuses` הוא toggle הפיך **בתוך המשחק הפתוח בלבד** (מפתח = `settlementKey`); בסגירה,
`buildDebtRecords` הופך רק העברות שלא סומנו ל-`debts` (status `open`), עם `debtorName`/`creditorName`
כמזהה (לא `debtorUserId`/`creditorUserId` — אלה מזהי שחקן **פר-משחק**, לא מזהי אדם — ר' §14). תשלום
חוב (`updateDebtAsPaid`) לא נוגע במאזן הפוקר או בהיסטוריה. ה-DB ממפה 1:1: `transfers` הפיכות
(`status` open/paid) כל עוד `games.phase <> 'closed'`, וטריגר immutability (`schema.sql` §7) קופא
אותן וגם את שאר שורות המשחק אחרי סגירה — **חוץ מ**החריג המתועד: `transfers.status` עדיין מותר לזוז
אחרי סגירה, כי תשלום חוב קורה אחרי שהמשחק כבר סגור. `debts` נוצרות ב-RPC `close_game` היחיד יחד עם
`transfers`, בטרנזקציה אחת — לא בשתי כתיבות נפרדות שיכולות להתפצל אם אחת נכשלת.

## 14. מיגרציה מהמסמך הנוכחי

מפורט במלואו ב-[`migration-from-local-state.md`](backend/migration-from-local-state.md); תמצית:
חד-כיוונית, **מכשיר אחד** (אין מזהה משותף בין מכשירים לאיחוד). `tools/local-state-to-sql.js` (מחוץ
ל-deploy, ב-`.vercelignore`) הופך ייצוא `poker-settle-v1` ל-SQL עם UUIDv5 דטרמיניסטי לכל ישות ו-
`ON CONFLICT DO NOTHING` (אידמפוטנטי, ניתן להריץ פעמיים). זהות ממופה **לפי שם**: השם ב-`--group-owner-name`
הופך ל-`profiles` של הבעלים, כל שם אחר הופך ל-`guests` — אותו כלל בדיוק כמו `resolveGuestId` בלקוח.
מה שלא עובר: `friendships` (דורש שני `profiles`, לפני שכולם נרשמים — נוצרות מחדש ידנית), `avatarDataUrl`
(data URL לא שייך לעמודת טקסט — עולה ל-Storage בנפרד), `settlementStatuses` של משחק פתוח (אין transfers
עדיין לחבר אליהן), היסטוריה שנחתכה מעבר ל-`HISTORY_MAX` לפני הייצוא, ו-`debtorUserId`/`creditorUserId`
(מזהי פר-משחק — נפתרים מחדש לפי שם, לא מועברים כמות שהם). רשימה מלאה + בדיקות שפיות ב-SQL נמצאות
במסמך המקושר.

## מה לא נכלל כאן

בחירת הפלטפורמה, עלויות, טבלת השוואת ספקים ותוכנית ההתחברות ל-5 הצעדים — ב-`platform-research.md`.
DDL מלא, אינדקסים, VIEWs וטריגרי immutability — ב-`schema.sql`. נוסח מדויק של כל policy — ב-`rls-policies.sql`.
סדר ביצוע מוצע (adapter מנוטרל → auth → משחק פתוח → סגירה → קבוצות) ורשימת "מה משתנה בכל פונקציה
קיימת" — ב-`frontend-seam.md`.
