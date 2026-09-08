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

## מה כבר בוצע

**שלב 1** (commit `ba92bb0`): קליינט Supabase, `authUser`, `ensureProfile`, מסך התחברות אמיתי.
**שלב 2a** (המסמך הזה, קטע "מה משתנה ומה נשאר" עודכן בהתאם): `groups`, `group_members`, `invites`,
`friendships` ו-`guests` עברו לשרת. שני מצבים, UI אחד: `cloudMode()` הוא `!!(supabase && authUser)`.
עם סשן — Supabase הוא מקור האמת, ומסמך ה-`state` המקומי נשאר עותק העבודה שכל ה-renderers והאדפטרים
כבר קוראים; בלי סשן — האפליקציה מתנהגת בדיוק כמו קודם, כולל סנכרון מסמך ה-Claude. שני הכותבים לעולם
לא רצים יחד.

הסטייה המכוונת מהתכנון שלמטה: **`normalize()` לא הפכה לממפה שורות**. במקום זה נוסף סקשן טהור נפרד,
`// ---------- cloud mapping (pure) ----------`, שמכיל את הממפים לשני הכיוונים (`groupToRow`/
`rowToGroup` וכו'), את `buildCloudRows`, `diffCollections` ו-`mergeCloudIntoState`. `normalize()`
נשארה השוער היחיד של המצב המקומי ורצה על התוצאה של המיזוג — כך `normalizeGroup`/`normalizeGroupMember`
ממשיכות לאכוף את החוזה המקומי (למשל `userId: null`) גם על נתונים שהגיעו מהשרת.

מה שעדיין מקומי בלבד אחרי 2a: המשחק הפתוח, `history`, `debts`, `settlementStatuses`, ומימוש `?join=`.

## מה משתנה ומה נשאר — הרשימה המדויקת

| פונקציה | מה קורה לה |
|---|---|
| `initSync()` | **2a: מדולגת לגמרי במצב ענן** (`if (cloudMode()) return`), ו-`enterCloudMode()` מאפס את `gameDoc` אם הסשן הגיע אחריה. בלי סשן היא רצה מילה במילה כמו קודם. בהמשך תוחלף ב-`initBackend()` עם ערוץ realtime למשחק הפתוח. |
| `remoteBody()` | נשארת בינתיים — היא מסלול ה"בלי סשן". **נמחקת** כשגם המשחק יעבור לשרת. |
| `scheduleRemoteSave()` | **2a: נשארת כמסלול בלי-סשן**; במצב ענן `save()` קורא במקומה ל-`scheduleCloudPush()` (אותו debounce של 400ms). בהמשך תוחלף ב-`queueMutation(op)`. |
| `applyRemote(data)` | נשארת למסלול בלי-סשן. **2a הוסיף** `applyCloudPull()`: ממפה שורות, ממזג עם `mergeCloudIntoState`, מריץ `normalize()` ומרנדר. |
| `gameDoc`, `CLIENT_ID`, `saveTimer` | נשארים למסלול בלי-סשן; `enterCloudMode()` מנטרל אותם. `dirtyUntil` **נשאר וגם משמש את מסלול הענן** (עריכה טרייה מנצחת pull). |
| `save()` | **2a: השתנה חלקית** — ממשיך לכתוב localStorage, ואז `if (cloudMode()) scheduleCloudPush(); else scheduleRemoteSave();`. |
| `// ---------- cloud mapping (pure) ----------` | **חדש ב-2a.** ממפי שורות דו-כיווניים, `refToIdentityRow`/`identityRowToRef` (דפוס הזהות `profile_id`/`guest_id`), `guestToRow`, `buildCloudRows`, `diffCollections`, `mergeCloudIntoState`. טהור לגמרי, נבדק ב-`tests/cloud-mapping.test.cjs`. |
| `// ---------- cloud store (Supabase) ----------` | **חדש ב-2a.** `pullCloud`, `pushCloud` (upsert לפי סדר FK: guests → groups → group_members → invites → friendships), `scheduleCloudPush`/`scheduleCloudPull`, `applyCloudPull`, `enterCloudMode`/`exitCloudMode`. |
| `load()` | נשאר — קורא את ה-cache האופליין לפני שהשרת עונה. |
| `normalize(s)` | **נשארת בדיוק כפי שהיא** — השוער היחיד של המצב המקומי, ורצה גם על תוצאת `mergeCloudIntoState`. מיפוי השורות עצמו **לא** נכנס אליה אלא לסקשן `cloud mapping (pure)` (ראו "מה כבר בוצע"), כדי ש-`normalizeGroupMember` תמשיך לאכוף את החוזה המקומי (`userId: null`) גם על נתוני שרת. |
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

1. ~~סקשן ה-adapter נכנס **מנוטרל**~~ — בוצע אחרת: הקליינט עצמו הוא ה-no-op כשאין supabase-js
   (`supabase === null`), וזה מה שמחזיק את מסלול האופליין.
2. ✅ **שלב 1 — Auth בלבד:** מסך התחברות אמיתי, `profiles` נכתב, `me` מגיע מהסשן.
3. ✅ **שלב 2a — קבוצות, חברים, הזמנות, אורחים:** `groups`/`group_members`/`invites`/`friendships`/
   `guests` עם pull על התחברות ועל חזרה ללשונית, ו-push מדולג (diff) בסדר FK.
   הסדר הוקדם לפני המשחק כי זה החלק שכבר קיים במלואו ב-UI ואין לו realtime.
4. שלב 2b — משחק פתוח: `games`/`game_participants`/`entries` + ערוץ realtime. זו הנקודה שבה
   שני טלפונים באמת עובדים על אותו שולחן.
5. שלב 2c — סגירה: `close_game` RPC, `transfers`, `debts`.
6. שלב 3 — מימוש `?join=` דרך `redeem_invite`, קישור אורח לחשבון, `ParticipantRef.userId` אמיתי,
   וטבלת הדירוג דרך ה-views.

בכל שלב localStorage נשאר ה-fallback: אם השרת לא זמין, האפליקציה חוזרת בדיוק להתנהגות היום.

## מה אסור לשבור בדרך

- אין `alert` / `confirm` / form submit. הדפוסים הקיימים של אישור דו-שלבי inline נשארים.
- `save()` נשאר הכותב היחיד למצב המקומי. לא מוסיפים store שני ולא מפתח localStorage חדש.
- כסף הוא מספר שלם. `net = cashout - sum(buyins)`. הסכימה כבר אוכפת `integer`.
- משחק סגור לא זז: RLS וטריגרים ב-DB אוכפים את זה, ולא רק ה-UI.
- אף מפתח לא נכנס ל-git. `sb_publishable_...` בלבד ב-HTML, אף פעם `sb_secret_...`.
