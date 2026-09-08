# ביקורת פערים לפני backend (Task 19)

תאריך: 2026-09-08. נבדק מול `main` ב-`8e18235` ("chore: build version 43").
מקור הדרישות: `docs/superpowers/plans/2026-09-07-groups-foundation.md` (Task 0 audit, Global
Constraints, Tasks 1–18). כל ההפניות הן ל-`kupa-sgura.html` אלא אם צוין אחרת.
בסיס בדיקה: `node --test tests/*.test.cjs` → 225 עוברים, 0 נכשלים.

## 1. סיכום

ה-foundation שלם בפועל: כל 18 המשימות מומשו, שכבת ה-domain טהורה ונבדקת, וה-UI צורך אותה
דרך adapters כמעט בכל מקום. לא נמצא backend מזויף, לא נמצאו חברויות/הצטרפויות פיקטיביות,
ולא נמצאה דליפת P&L או חובות במסכים הקבוצתיים (מאומת גם ב-`tests/group-privacy.test.cjs`).
הפערים האמיתיים הם קטנים ומקומיים: באג זהות אחד בבורר המשתתפים (כפילות שם), חוסר סינון
חברות ברשימת הקבוצות, בדיקת ה-e2e של Task 16 שחסרה, תיעוד מקור-אמת מיושן, ומיקרו-קופי מיושן.
שום פער שנמצא לא מחייב כתיבה מחדש כשה-backend יגיע.

ספירה: ✅ 27 · ⚠️ 8 · ❌ 1 · ➖ 6.

## 2. טבלת דרישות

| דרישה | סטטוס | ראיה | הערה |
|---|---|---|---|
| משחק פתוח = active+settlement, סגור = closed | ✅ | `normalizePhase` 900, `canStartGroupGame` 1635 | |
| זרימה: התחלה → שולחן → סיום (החזקה 1ש') → settlement → סגירה | ✅ | `beginFinishGameHold` 3746, `finishGame` 3771, `finishCloseTable` 3821 | `חזור לעריכת המשחק` 3778 |
| יצירת קבוצה (שם + תמונה אופציונלית) | ✅ | `buildGroupCreation` 1664, `createGroup` 2030, `renderCreateGroupPanel` 2265 | תמונה 96×96 JPEG, `resizeAvatarImage` 2134 |
| משחק פתוח אחד לקבוצה | ✅ | `canStartGroupGame` 1635 | ראה ➖ "משחק אחד למכשיר" |
| כל חבר פעיל יכול לפתוח משחק ולהוסיף שחקנים | ⚠️ | `startGroupGame` 1995, `addPlayer` 4180 | אין בדיקת חברות בפועל — ראה פער #3 |
| leader = מי שפתח, metadata בלבד | ⚠️ | `state.leaderRef` 1005/1060/2002, `buildHistoryEntry` 1201 | נשמר ומועתק להיסטוריה אך לא מוצג בשום מקום |
| admin: שם/תמונה/חברים/תפקידים/ארכיון/מחיקה | ✅ | overlay 4241–4375, `renameGroup` 1745, `archiveGroup` 1761, `deleteGroup` 1777 | הורדת תפקיד קיימת ב-`setMemberRole` בלי UI (לא נדרש) |
| חבר יכול לעזוב | ⚠️ | `leaveGroup` 1724, כפתור 4360 | אחרי עזיבה הקבוצה נשארת ב"הקבוצות שלי" — פער #3 |
| חברים לשעבר: היסטוריה ודירוג נשמרים, לא ברשימה הפעילה | ✅ | `formerMembers` 1486, `renderFormerMembers` 2988, `buildLeaderboard` 1553 (`isFormerMember`) | תג "לשעבר" |
| הזמנה: קישור/QR/קוד = טוקן אחד | ✅ | `generateInviteToken` 1807, `inviteLink` 1832, `formatInviteCode` 1835, `renderGroupInvite` 3106 | QR = placeholder מוצהר |
| כל חבר יכול לשתף הזמנה | ✅ | `renderGroupInvite` 3106 (`summary.isMember`) | ביטול = admin בלבד |
| אין הצטרפות מרוחקת מזויפת | ✅ | `parseJoinToken` 1842, boot 4468–4480 | מציג notice ומנקה query, לא נוגע ב-state |
| Friends: request → pending → accepted/rejected + UI | ✅ | `friendRequestsFor` 1304, `createFriendRequest` 1323, `respondToFriendRequest` 1343, טאב 4094–4116 | אין קריאה מה-UI (נאכף ב-`tests/friends.test.cjs`) |
| אורחים: שם בלבד + `guestId` יציב | ✅ | `createPlayer` 1793, `resolveGuestId` 1462 | |
| אורח יכול לנצח ולהופיע בהיסטוריה | ✅ | `gameWinners` 1500, `toGroupGameSummary` 1509 | ללא סינון זכאות — נכון |
| אורח לא בדירוג המצטבר אלא אם חבר | ➖ | `isLeaderboardEligible` 1548 | חריגה מתועדת (Task 0) |
| מודל מאפשר מיזוג עתידי לחשבון | ✅ | `userId: null` ב-`normalizeParticipantRef` 1395, `normalizeGroupMember` 1415 | |
| פרטיות: אין P&L/חובות של אחרים במסכים קבוצתיים | ✅ | `tests/group-privacy.test.cjs`, `toGroupGameSummary` 1509 | רק `potSize`/`totalEntries` מצרפיים |
| מנצח = net מקסימלי, תיקו → מספר מנצחים | ✅ | `gameWinners` 1500 | |
| דירוג נגזר, שמות בלבד | ✅ | `buildLeaderboard` 1553, `renderGroupLeaders` 2825 | `LeaderboardEntry` בלי שדה כסף |
| משחקים סגורים immutable | ✅ | `finishCloseTable` 3821 | שום קוד לא עורך `history[i]` אחרי סגירה |
| ארכיון מסתיר; מחיקה = soft delete | ✅ | `visibleGroups` 1490, `archivedGroups` 1493, `deleteGroup` 1777 | |
| מחיקה לא פוגעת ברקורד/P&L/חובות | ✅ | `renderProfile` 4003 קורא `state.history`/`state.debts` ללא groupId | |
| מחיקת קבוצה עם משחק פתוח נחסמת | ✅ | `refreshGroupSettings` 4286–4290 | נימוק inline "סגור קודם את המשחק הפעיל" |
| עזיבה/הסרה כ-admin אחרון נחסמת | ✅ | `isLastActiveAdmin` 1785, 4299–4302 | ניסוח שגוי — פער #6 |
| יציאת שחקן עם cashout, בלי rebuy, ניתן לעריכה | ✅ | `exitPlayer` 1353, `updateExitCashout` 1362, UI 3311/3342/3388 | ללא כפתור `+` לשחקן שיצא |
| הסכום מוזן מראש ב-settlement | ✅ | `render` 3527 (`inp.value = p.cashout`) + תג "יצא" 3524 | |
| ביטול כניסה אחרונה לשחקן שיצא | ⚠️ | `render` 3455–3486 | ה-undo נמצא בתוך תפריט ה-`+` שלא נרנדר לשחקן שיצא — הדרישה בלתי-נגישה |
| מקור אמת מינימלי, נתונים נגזרים מחושבים | ✅ | `getGroupSummary` 1589, `buildLeaderboard` 1553, `gameWinners` 1500 | אין אחסון של winners/gameCount/lastGame |
| Persistence: אותו מסמך state, בלי backend מזויף | ✅ | `normalize` 967, `save` 1029, `remoteBody` 1048 | אין מפתחות localStorage חדשים |
| `applyRemote` משווה את כל האוספים | ⚠️ | `applyRemote` 1094 | חסרים `groupId` ו-`leaderRef` בהשוואה — פער #7 |
| state ישן ללא השדות החדשים נטען | ✅ | `normalize` 981–1005 | ברירות מחדל לכל שדה חדש, מכוסה בטסטים |
| Dashboard: פעולות מהירות / משחקים פעילים / קבוצות | ✅ | `renderGamesDashboard` 2562, `renderQuickActions` 2245, `renderGroupCard` 2410 | ארכיון מקופל 2503 |
| `ActiveGameSummary` הוא ה-shape היחיד לכרטיס הפעיל | ✅ | `getActiveGameSummaries` 2175 | חתימה הורחבה ל-`(gameState, groups)` |
| הרחבות כרטיס לא קוראות `save()` | ✅ | Sets בזיכרון 872–875 | |
| Motion בכל אלמנט אינטראקטיבי חדש | ✅ | `button:active` 67, `.anim`/`.load-in`, `tests/motion.test.cjs` | guard של reduced-motion אחרון בגיליון |
| Task 16: `tests/e2e-state.test.cjs` | ❌ | הקובץ לא קיים | תרחישים B–D אומתו ידנית בלבד (progress.md) |
| Task 17: `docs/backend-readiness.md` | ⚠️ | קיים (198 שורות), לא מקומט | נכתב במקביל לביקורת הזו |
| Task 17: עדכון `HANDOFF.md` ו-`DESIGN.md` | ⚠️ | `HANDOFF.md` 134 עדיין מיושן; `DESIGN.md` ללא אזכור קבוצות | פער #2 |

## 3. פערים לתיקון עכשיו (frontend, קטן)

### #1 — כפילות שם בין אורח לחבר לא-מסומן · חומרה: גבוה
מיקום: `renderStartGameAddGuest` שורה 2778, `startGroupGame` שורה 1995.
בדיקת הכפילות בהוספת אורח משווה רק מול חברים **מסומנים** (`selectedNames`) ומול אורחים קיימים.
לכן אפשר להוסיף אורח בשם של חבר פעיל שאינו מסומן, ואז לסמן את אותו חבר — `startGroupGame` יוצר
שני `Player` בעלי אותו `name` בלי שום guard, בדיוק המצב ש-`addPlayer` (4184) חוסם מפורשות
("duplicate names would merge menus, records and transfers"). ההשלכות אמיתיות: `openMenu`
מזוהה לפי שם, `settle()` (1281) ממפה לפי שם, ו-`buildDebtRecords` (1236) עושה
`find(p => p.name === move.from)` ולכן ייצור חוב על השחקן הלא נכון. תיקון: להשוות את שם האורח
מול `activeMembers(state.groupMembers, currentGroupId).map(m => m.displayName)` כולם, ובנוסף
להוסיף ב-`startGroupGame` בדיקה שמסננת/דוחה `participants` עם שם חוזר לפני יצירת השחקנים
(שכבת הגנה שנייה, כי הבחירה יכולה להשתנות אחרי הוספת האורח).

### #2 — תיעוד מקור-אמת מיושן ומטעה · חומרה: גבוה
מיקום: `HANDOFF.md` שורות 47 ו-134; `CLAUDE.md` פסקת "Architecture contract"; `DESIGN.md`.
(סוכן Task 17 עדכן את ראש `HANDOFF.md` תוך כדי הביקורת הזו; מה שלהלן הוא מה שנשאר.)
שורה 134 עדיין קובעת ש-`getGroupSummaries()` "must stay an empty adapter until groups are real"
ושהכפתור "+ צור קבוצה" מושבת בכוונה — שתי אמירות שסותרות את הקוד בפועל. גם סכימת ה-state
(שורה 47) חסרה את `groups/groupMembers/invites/friendships/leaderRef/startedAt` ואת
`status/exitedAt/guestId/memberId` בשחקן. `CLAUDE.md` חוזר על אותה טענה ("`getGroupSummaries()`
returns `[]` until a real groups data source exists"), ו-`DESIGN.md` לא מזכיר קבוצות כלל.
תיקון: לעדכן את סעיף ה-data model, להחליף את פסקת ה-groups placeholder בתיאור ה-adapters בפועל
(`collectionsOf`, `getGroupSummary(ies)`, `buildLeaderboard`, `canStartGroupGame`), לתקן את
`CLAUDE.md`, ולהוסיף ל-`DESIGN.md` את הרכיבים החדשים (עמוד קבוצה, שורות חבר, בלוק הזמנה,
בורר משתתפים, תג "יצא").

### #3 — קבוצה שעזבת נשארת פעילה במכשיר · חומרה: בינוני
מיקום: `getGroupSummaries` שורה 1619, `renderGroupPrimaryAction` שורה 2616, `startGroupGame` שורה 1995.
`visibleGroups` לא מסנן לפי חברות, ולכן אחרי "עזוב קבוצה" הקבוצה עדיין מופיעה תחת "הקבוצות שלי",
נפתחת, ומציגה "התחל משחק" פעיל — אף שאין למשתמש `findMyMembership`. `startGroupGame` גם לא בודק
חברות וקובע `leaderRef.displayName = me` גם למי שאינו חבר. תיקון מינימלי: להוסיף ל-`GroupSummary`
סינון/סימון — או לא להציג ב"הקבוצות שלי" קבוצות ש-`isMember === false`, או להשאיר אותן לקריאה
בלבד עם נימוק inline ("עזבת את הקבוצה") ולחסום את מסלול ההתחלה ב-`startGroupGame` בבדיקת
`findMyMembership(state.groupMembers, groupId, me)`. מומלץ השני: הוא לא מוחק נתונים ומתיישר עם
ההתנהגות שה-backend ייתן.

### #4 — Task 16 האוטומטי חסר · חומרה: בינוני
מיקום: `tests/` (אין `e2e-state.test.cjs`).
התוכנית דורשת סקריפט שמריץ תרחיש מלא מעל שכבת ה-domain (יצירת קבוצה → חברים → משחק → כניסות →
יציאה → סגירה → היסטוריה → דירוג → מחיקה) ובודק invariants אחרי כל שלב: אין id כפול, סכומים
מאוזנים, ומספר המשחקים ברקורד האישי לא משתנה אחרי מחיקת קבוצה. תיקון: קובץ חדש בדפוס ה-vm-slice
הקיים (`tests/groups-domain.test.cjs` הוא התבנית הקרובה ביותר, כולל ה-stub של `newId`).

### #5 — מיקרו-קופי מיושן בפרופיל · חומרה: בינוני
מיקום: שורה 4146.
המצב הריק של "ערבים אחרונים" מפנה לטאב "חישוב" שכבר לא קיים (הטאבים היום הם משחקים/פרופיל).
תיקון: לנסח מחדש לפי הניווט הנוכחי, למשל: "עוד אין ערבים ברקורד. אחרי סגירת שולחן הערב יופיע כאן."

### #6 — ניסוח שגוי בחסימת admin אחרון · חומרה: נמוך
מיקום: שורה 4302.
"מנה מנהל אחר קודם" נקרא כשם עצם ולא כציווי. תיקון: "מַנֵּה מנהל אחר קודם" או, עדיף בעברית פשוטה,
"העבר ניהול לחבר אחר קודם". (הניסוח הועתק מהתוכנית — לתקן גם שם אם רלוונטי.)

### #7 — `applyRemote` לא משווה `groupId`/`leaderRef` · חומרה: נמוך
מיקום: שורה 1094.
מפתחות ההשוואה הם `g,q,e,p,h,d,s,a,gr,gm,iv,fr` — כל ארבעת האוספים החדשים נכללים, אבל שני שדות
המשחק הנוכחי `groupId` ו-`leaderRef` לא. סנכרון שבו רק אחד מהם השתנה ייחשב "זהה" וייזרק. בפועל
שינוי `groupId` תמיד מלווה בשינוי `players`/`gameId`, ולכן הסיכון תיאורטי — אבל הוא בדיוק סוג הבאג
שיתפוצץ כשיהיה backend אמיתי. תיקון: להוסיף שני מפתחות להשוואה משני הצדדים.

### #8 — `leaderRef` לא עובר נורמליזציה בטעינה · חומרה: נמוך
מיקום: `normalize` שורה 1005 (`leaderRef: s.leaderRef || null`).
כל שאר ה-refs עוברים `normalizeParticipantRef` (1395); `leaderRef` נשמר כפי שהוא, כך ש-snapshot
מרוחק פגום יכול להכניס `userId` בדוי או שדות זרים ל-state. תיקון: `s.leaderRef ? normalizeParticipantRef(s.leaderRef) : null`.

### #9 — נגישות: משוב "הועתק ✓" ו-`aria-expanded` על "יציאה" · חומרה: נמוך
מיקום: שורות 3125 ו-3311.
אין `aria-live` בשום מקום בקובץ, ולכן הודעת ההעתקה לא מוכרזת; כפתור "יציאה" פותח פאנל אבל אין לו
`aria-expanded` (בניגוד לכפתור ה-`+` בשורה 3352 ולכל שאר ה-toggles). תיקון: `role="status"` על
`.games-invite-copied`, ו-`aria-expanded` שמתעדכן על `.exit-toggle` לפי `exitOpen === p.name`.

### #10 — הערות מיושנות שסותרות את הקוד · חומרה: נמוך
מיקום: שורות 2616–2620 (`renderGroupPrimaryAction`).
ההערה עדיין אומרת "Task 8 wires the actual start-game handler here" ו-"when it IS ok the button is
still disabled for this task" — שניהם כבר לא נכונים. תיקון: לעדכן את ההערה לתיאור ההתנהגות בפועל.

### #11 — שורת הסטטוס בשולחן לא משתמשת ב-`formatPlayerCount` · חומרה: נמוך
מיקום: שורה 3602.
מחרוזת קשיחה `state.players.length + " שחקנים"` מייצרת "1 שחקנים", בעוד ה-dashboard כבר מציג
"שחקן אחד" דרך `formatPlayerCount` (2225). תיקון: לקרוא לפונקציה הקיימת.

## 4. פערים שממתינים ל-backend

- **הצטרפות דרך הזמנה** — `parseJoinToken` (1842) רק מזהה טוקן ומציג notice. Redemption דורש
  אימות טוקן בצד שרת ורישום חברות. מוצהר ב-UI ("הצטרפות דרך הזמנה תעבוד כשהאפליקציה תתחבר לשרת").
- **QR** — placeholder מכוון (3164). מחולל inline אפשרי כבר עכשיו, אבל אין מה לקודד עד שיש route
  הצטרפות אמיתי.
- **בקשות חברות אמיתיות** — ה-domain קיים ונבדק; שום handler ב-UI לא יוצר friendship, בכוונה.
- **חשבונות אמיתיים** — `userId` תמיד `null`; הזהות היא `displayName`/`guestId` בלבד. `findMyMembership`
  (1475) יוחלף ב-`userId === session.userId`.
- **מיזוג אורח→חשבון** — המודל תומך, אין flow.
- **משחקים מקבילים בין קבוצות** — מנוע ה-slot היחיד. `canStartGroupGame` מחזיר `another-game-open`.
- **תמונות קבוצה** — data URL ב-localStorage; ב-backend יעברו ל-storage.
- **`HISTORY_MAX = 400`** — הדירוג הקבוצתי נגזר מ-`state.history`, ולכן משחקים ישנים שיפלו מהתקרה
  ייעלמו מהדירוג בשקט. אין תקרה ב-backend.

## 5. חריגות מכוונות

| חריגה | תיעוד | סביר? |
|---|---|---|
| זכאות לדירוג לפי חברות ולא לפי `userId != null` | Task 0, "Leaderboard eligibility decision" | כן — מתהדק לפונקציה אחת (`isLeaderboardEligible` 1548) |
| משחק פתוח אחד לכל המכשיר, לא רק לקבוצה | Task 0, "Single active game decision" | כן — `canStartGroupGame` מדווח `another-game-open` וה-UI מסביר |
| זהות לפי שם ("מי אתה?") אינה אימות | Task 0, "Identity decision" | כן |
| `renderGroupLastGame` הוסר (כפילות עם שורת ההיסטוריה הראשונה) | `task-11-12-report.md` | כן — Task 12 עצמו מבקש "keep one list" |
| היסטוריה קבוצתית מציגה את כל המשחקים ולא 5 | `task-11-12-report.md` | כן — Task 11 גובר על Task 4 |
| `addPlayer` פותר `memberId` לפי התאמת שם | `task-8-report.md` | כן — עקבי עם `resolveGuestId` |
| `createInvite` מקבל `token` מבחוץ | `task-7-report.md` | כן — משאיר את `generateInviteToken` טהור |

חריגות **לא** מתועדות שנמצאו: אין ל-`leaderRef` שום צרכן ב-UI (סעיף 2), ו-undo של כניסה אחרונה
אינו נגיש לשחקן שיצא (סעיף 2) — שתיהן מוזכרות כאן ולא בשום דוח מימוש.

## 6. סיכונים ארכיטקטוניים לפני backend

1. **UI שקורא `state` ישירות במקום adapter** — `renderGroupPage` (3204) קורא `state.invites`,
   `renderStartGamePanel` (2665), `renderAddRowChips` (3232) ו-`refreshGroupSettings` (4262) קוראים
   `state.groupMembers`. הם עוברים דרך פונקציות domain טהורות (`activeInvite`, `activeMembers`), אז
   זו לא הפרה חמורה, אבל `collectionsOf` (2156) לא כולל `invites` והכוונה המקורית הייתה שכל קריאה
   תעבור דרכו. שווה ליישר לפני שמחליפים את מקור הנתונים.
2. **זהות לפי שם ממזגת אנשים שונים** — `resolveGuestId` (1462) מחזיר את ה-`guestId` של חבר קיים עם
   אותו `displayName`. אורח בשם זהה לחבר יקבל את זהותו ויתמזג לשורת הדירוג שלו. זו התנהגות מכוונת
   ("name is the identity key"), אבל היא מגבירה את חומרת פער #1 ותדרוש החלטת migration מפורשת.
3. **`debtorUserId` הוא בפועל `player.id` של אותו משחק** — `buildDebtRecords` (1244). מתועד
   ב-`docs/superpowers/plans/2026-09-08-remaining-work.md`; ה-migration חייב למפות ל-`userId/guestId`.
4. **הדירוג תלוי בשימור ההיסטוריה המקומית** — ראה `HISTORY_MAX`. בנוסף, "איפוס רקורד"
   (`setClearBtn`, 4245) מרוקן את `state.history` אך משאיר את `state.debts`, כך שנשארים חובות
   ללא משחק מקור. התנהגות קיימת מלפני עבודת הקבוצות, אבל היא כעת מוחקת גם כל דירוג קבוצתי.
