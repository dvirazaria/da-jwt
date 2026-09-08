# התפר בין הפרונט לבקאנד

תאריך: 2026-09-08. מה בדיוק משתנה ב-`kupa-sgura.html` כשהסנכרון עובר ל-Supabase, ומה לא.
אין כאן קוד ריצה — זה מפרט לסשן שיבצע.

## מה קיים היום

שכבת הסנכרון היא מסמך אחד, שלם, עם last-writer-wins:

- `save()` — הכותב היחיד. מעדכן `state.updatedAt`, כותב ל-localStorage (`poker-settle-v1`),
  ומפעיל `scheduleRemoteSave()`.
- `remoteBody()` — מרכיב את **כל** ה-state לאובייקט אחד (`players`, `history`, `debts`,
  `groups`, `groupMembers`, `invites`, `friendships`, ...).
- `scheduleRemoteSave()` — debounce של 400ms, מסמן `dirtyUntil = now + 6s`, ואז `gameDoc.set()`.
- `applyRemote(data)` — מנרמל את המסמך הנכנס, משווה JSON מלא מול המצב הנוכחי, ואם שונה —
  **מחליף את `state` כולו** ומרנדר.
- `initSync()` — `window.claude.use("db")` → `db.doc("games/current")` → `onSnapshot`.
- `pendingRemote` / `tryApplyParked()` / `focusout` — לא לחטוף את ה-UI באמצע הקלדה.
- `normalize(s)` — הלואדר/מייגרייטור היחיד, גם ל-localStorage וגם למסמך המרוחק.

**למה זה חייב להשתנות ולא רק להתחלף בספק:** שמונה טלפונים שעורכים אותו שולחן עם
last-writer-wins על מסמך שלם ידרסו זה את זה. buy-in של אחד ייעלם כשהשני ישמור. המעבר הוא
ממסמך ל-**אירועים**: `entries` הוא append-only ממילא, בדיוק כמו `entryLog` היום.

## הצורה החדשה

סקשן אחד מסומן, `// ---------- backend adapter ----------`, מחליף את סקשן הסנכרון הקיים
ומממש ממשק צר אחד (`RemoteStore`), באותה תבנית adapters שכבר קיימת (`getActiveGameSummaries`,
`getGroupSummaries`). החלפת ספק נוגעת בסקשן הזה בלבד.

### 1. Auth session → `me`

`me` מפסיק להיות מחרוזת מ-`poker-settle-me` והופך לתוצר של הסשן:
`supabase.auth.getSession()` → `session.user.id` → קריאה ל-`profiles` → `{ profileId, displayName }`.
`poker-settle-me` נשאר כ-cache אופליין בלבד (כדי שהאפליקציה תרנדר לפני שה-session חוזר), ומאבד
את מעמדו כזהות. `onAuthStateChange` מחליף את מסך ה"התחברות" הנוכחי. מהרגע הזה
`ParticipantRef.userId` מפסיק להיות `null`, ו-`isLeaderboardEligible` מתהדק ל-`userId != null`
בלי לגעת ב-UI — בדיוק כפי שתוכנן ב-Task 0 audit.

### 2. ערוץ realtime למשחק הפתוח

ערוץ אחד לכל משחק פתוח, `game:<gameId>`, `{ config: { private: true } }`, עם Postgres Changes
על `entries` ו-`game_participants` מסוננות ב-`game_id`, ועל שורת ה-`games` עצמה (בשביל `phase`).
מנוי נפתח כשנכנסים למשחק ונסגר כשיוצאים ממנו — לא ערוץ גלובלי, כי תקרת ה-Free היא 200 חיבורים.
הדשבורד (`games`) לא צריך realtime: קריאה חד-פעמית מספיקה.

### 3. שמירה אופטימית + פיוס מול השרת

הזרימה לכל פעולה (buy-in, הוספת שחקן, cashout, יציאה):

1. מעדכנים את `state` בזיכרון ומרנדרים מיד (כמו היום).
2. `save()` כותב ל-localStorage — הוא נשאר ה-cache האופליין וה-source of truth לרינדור.
3. `queueMutation(op)` שולח את ה-DML הצר לשרת (`insert into entries ...`), לא את כל המסמך.
4. תשובת השרת/אירוע ה-realtime מפייס: לשורה יש `updated_at`, ו-`applyRemoteEvent` מחיל אותה
   רק אם היא חדשה יותר מהעותק המקומי. אותה השוואת `updatedAt` שקיימת ב-`initSync` היום
   עוברת מרמת המסמך לרמת השורה.
5. כישלון רשת → הפעולה נשארת בתור ונשלחת שוב; ה-UI כבר מציג אותה. `setSync(false, ...)`
   ממשיך לשמש כאינדיקטור.

`pendingRemote` / `tryApplyParked()` / ה-`focusout` נשארים כפי שהם: הבעיה שהם פותרים (אל תחליף
ערך בשדה שמישהו מקליד בו) לא נעלמת עם השרת.

### 4. קריאות בטוחות-RLS דרך VIEWs

הקליינט לא בונה חישובי כסף חוצי-משחקים. מה שהוא קורא:

- `game_results_v` — buy-in/cashout/net למשחק שהוא רואה ממילא.
- `group_leaderboard_public_v` — דירוג, משחקים, ניצחונות. **בלי `net`.**
- `my_group_stats_v` — הכסף של המשתמש עצמו בלבד.
- `debts` — RLS מחזירה רק חובות שהוא צד להם.

`group_leaderboard_v` (עם `net`) לא מוענקת לתפקיד הקליינט בכלל. זה מה שמקיים את כלל 10
("אסור להציג P&L של אדם אחר") ברמת ה-DB ולא ברמת ה-UI.

## מה משתנה ומה נשאר — הרשימה המדויקת

| פונקציה | מה קורה לה |
|---|---|
| `initSync()` | **מוחלפת** ב-`initBackend()`: יצירת client, שחזור session, מנוי לערוץ המשחק הפתוח. |
| `remoteBody()` | **נמחקת.** אין יותר גוף מסמך שלם. |
| `scheduleRemoteSave()` | **מוחלפת** ב-`queueMutation(op)` — DML ממוקד במקום `doc.set()`. |
| `applyRemote(data)` | **מוחלפת** ב-`applyRemoteEvent(change)`: מטליאה אוסף אחד לפי `updated_at`, לא מחליפה `state`. |
| `gameDoc`, `CLIENT_ID`, `saveTimer` | נמחקים; `dirtyUntil` נשאר לוגיקת "עריכה טרייה מנצחת". |
| `save()` | **משתנה חלקית**: ממשיך לכתוב localStorage, מפסיק לקרוא ל-`scheduleRemoteSave`, מתחיל לקרוא ל-`queueMutation`. |
| `load()` | נשאר — קורא את ה-cache האופליין לפני שהשרת עונה. |
| `normalize(s)` | **נשארת ומקבלת תפקיד שני**: הממפה משורות שרת לצורה המקומית. `normalizeDebt`, `normalizeGroup`, `normalizeGroupMember`, `normalizeInvite`, `normalizeFriendship` הופכות ל-row mappers — הן כבר בדיוק בצורה הנכונה. |
| `addEntry(player, amount)` | נשארת בזיכרון; מוסיפה קריאה ל-`queueMutation('entries.insert')`. |
| `finishCloseTable()` | **הופכת ל-RPC אחת** (`close_game`) בטרנזקציה: `phase='closed'`, כתיבת `transfers` ו-`debts`. סגירה חייבת להיות אטומית. |
| `buildHistoryEntry`, `buildDebtRecords`, `settlementKey` | נשארות טהורות ומשמשות כמפרט של ה-RPC. `settlement_key` בטבלה זהה לפלט של `settlementKey`. |
| `settle()`, `tableBalance()`, `wholeMoney` | **ללא שינוי.** החישוב נשאר בקליינט; השרת מאמת. |
| כל סקשן `groups domain (pure)` | **ללא שינוי** למעט `isLeaderboardEligible` שמתהדק ל-`userId != null`. |
| `getActiveGameSummaries`, `getGroupSummaries`, `collectionsOf` | **ללא שינוי בחתימה.** מקבלים את אותם אוספים, רק שמקורם השרת. |
| `render()`, `renderGamesDashboard()`, `renderGroupPage()`, `renderProfile()` | **ללא שינוי.** |
| `state.history` | הופך ל-cache של דף אחרון בלבד; ההיסטוריה המלאה נשאלת מ-`games`+`game_results_v`. `HISTORY_MAX` מאבד משמעות. |
| `me` (`poker-settle-me`) | **משתנה**: מגיע מהסשן; המפתח נשאר cache אופליין ולא זהות. |
| `poker-settle-theme`, `-contact`, `-profile-debts-seen` | **ללא שינוי.** מקומיים לגמרי. |

## סדר ביצוע מוצע

1. סקשן ה-adapter נכנס **מנוטרל** (`BACKEND.enabled = false`), וכל הקריאות אליו no-op.
   האפליקציה ממשיכה לעבוד בדיוק כמו היום. שלב זה לא משנה התנהגות ולכן קל לוודא.
2. Auth בלבד: מסך התחברות אמיתי, `profiles` נכתב, `me` מגיע מהסשן. עדיין אין סנכרון נתונים.
3. משחק פתוח בלבד: `games`/`game_participants`/`entries` + ערוץ realtime. זו הנקודה שבה
   שני טלפונים באמת עובדים על אותו שולחן.
4. סגירה: `close_game` RPC, `transfers`, `debts`.
5. קבוצות, חברים, הזמנות, וטבלת הדירוג דרך ה-views.

בכל שלב localStorage נשאר ה-fallback: אם השרת לא זמין, האפליקציה חוזרת בדיוק להתנהגות היום.

## מה אסור לשבור בדרך

- אין `alert` / `confirm` / form submit. הדפוסים הקיימים של אישור דו-שלבי inline נשארים.
- `save()` נשאר הכותב היחיד למצב המקומי. לא מוסיפים store שני ולא מפתח localStorage חדש.
- כסף הוא מספר שלם. `net = cashout - sum(buyins)`. הסכימה כבר אוכפת `integer`.
- משחק סגור לא זז: RLS וטריגרים ב-DB אוכפים את זה, ולא רק ה-UI.
- אף מפתח לא נכנס ל-git. `sb_publishable_...` בלבד ב-HTML, אף פעם `sb_secret_...`.
