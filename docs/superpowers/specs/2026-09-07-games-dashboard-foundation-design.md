# תשתית מסך משחקים — מסמך תכנון

## מטרה

להרחיב את טאב ״משחקים״ הקיים למסך מסודר עם פעולות מהירות, משחקים פעילים וקבוצות, תוך שימוש ב־game state ובזרימת השולחן/סגירה שכבר קיימים. השינוי נשאר בתוך `kupa-sgura.html`, אינו מוסיף טאב, backend, קבוצות דמה או מנגנון משחק מקביל.

## מצב קיים ומגבלות

האפליקציה היא PWA חד־קובצי. היא מחזיקה משחק נוכחי יחיד ב־`state`, עם `phase` מסוג `active`, `settlement` או `closed`. מסך ״משחקים״ נבנה כרגע בתוך `renderGamesDashboard()` ומציג כרטיס בסיסי למשחק הנוכחי או empty state. אין מאגר קבוצות, route ליצירת קבוצה או אוסף אמיתי של משחקים פעילים.

מקור האמת נשאר `state` הקיים. ה־UI החדש לא ייצור localStorage נוסף, mock backend, משחקים מומצאים או קבוצות מומצאות. מצב פתיחת הכרטיסים יישמר בזיכרון בלבד ויתאפס ברענון.

## מבנה המסך

מסך ״משחקים״ יכיל שלושה אזורים בלבד, בסדר הבא:

1. פעולות מהירות.
2. משחקים פעילים.
3. הקבוצות שלי.

התוכן יישאר ממורכז כפי שהוגדר בגרסה הנוכחית, עם RTL תקין לטקסט עברי. הכרטיסים יהיו קומפקטיים, עם קו או רקע עדין, ללא צל כבד וללא badges מיותרים.

## פעולות מהירות

`renderQuickActions()` יציג שני כפתורים שווי משקל באותה שורה:

- ״+ צור קבוצה״: כפתור מושבת עם `disabled` ו־`aria-disabled="true"`. תווית קטנה ״בקרוב״ תבהיר שהמצב מכוון ולא תקלה. לא יהיה handler, route או state לקבוצות בשלב הזה.
- ״משחק ללא קבוצה״: כפתור secondary/ghost שמפעיל את `startUngroupedGame()` הקיים. הוא אינו יוצר game engine חדש.

## חוזה הנתונים של משחק פעיל

ה־UI של אזור המשחקים הפעילים יקבל נתונים רק דרך `ActiveGameSummary`. הוא לא יקרא ישירות מ־`state` ולא יחשב סכומים בעצמו.

החוזה יהיה אובייקט JavaScript רגיל עם השדות הבאים:

```js
{
  gameId,
  title, // string | null
  phase,
  playerCount,
  playerNames,
  players: [{ id, name, buyinTotal, entryCount }],
  potSize,
  totalEntries,
  startedAt,
  updatedAt
}
```

`title` יהיה מחרוזת או `null`. למשחק ללא קבוצה קיים שם אמיתי — ״משחק ללא קבוצה״. אם בעתיד יגיע משחק קבוצתי בלי שם קבוצה אמיתי, הכותרת תושמט במקום להמציא שם.

`startedAt` ו־`updatedAt` יהיו `null` כאשר הערך אינו קיים. ה־renderer לא יציג שורה עבור ערך חסר.

`getActiveGameSummaries(state)` יהיה ה־adapter היחיד מה־game state לחוזה הזה. במבנה הנוכחי הוא יחזיר מערך ריק עבור demo/closed, או מערך עם summary יחיד עבור המשחק הנוכחי. כך ה־section והכרטיסים כבר יתמכו במערך של משחקים, בלי להמציא אוסף או לשכפל state.

הכותרת למשחק שנוצר דרך ״משחק ללא קבוצה״ תהיה ״משחק ללא קבוצה״, מפני שזה סוג המשחק שנבחר בפועל. בעתיד adapter של קבוצות יוכל לספק שם קבוצה אמיתי. אם אין שם אמיתי, לא יוצג שם קבוצה מומצא.

## זמן התחלה ועדכון

`startUngroupedGame()` יוסיף `startedAt` עם timestamp אמיתי בעת יצירת משחק חדש. `normalize`, `remoteBody` ו־`applyRemote` יעבירו אותו כשקיים. משחק legacy שאין בו `startedAt` יישאר ללא ערך ולא יוצג לו זמן התחלה.

`updatedAt` הקיים ייכלל ב־summary רק כשהוא ערך תקין. הכרטיס יציג שעה מקומית קצרה עבור timestamps תקינים. לא יחושב או יוצג זמן מומצא.

## משחקים פעילים וכרטיס משחק

`renderActiveGamesSection(summaries)` יציג ״אין משחקים פעילים כרגע״ כאשר המערך ריק. אחרת הוא ירנדר `renderActiveGameCard(summary, actions)` עבור כל summary.

`renderActiveGameCard(summary, actions)` יקבל נתונים רק דרך `ActiveGameSummary`. הפרמטר `actions` יכיל callbacks התנהגותיים בלבד, כגון כניסה למשחק והרחבה. הכרטיס לא יקרא ישירות מ־`state`, לא יחשב בעצמו סכומים ולא יכיר את מבנה השחקן הפנימי.

המצב הסגור של הכרטיס יציג:

- אינדיקציית מצב עדינה: ״משחק פעיל״ או ״בסגירה״ לפי `phase`.
- כותרת המשחק.
- מספר שחקנים ושמות מקוצרים עד ארבעה שמות, ולאחריהם `+N` כשצריך.
- זמן התחלה רק אם `startedAt` קיים.
- כפתור ״כנס לשולחן״.
- כפתור ״הרחב״ עם חץ למטה/למעלה ו־`aria-expanded`.

״כנס לשולחן״ יעבור דרך `enterActiveGame(gameId)`. במבנה הנוכחי הפונקציה תאמת שמדובר במשחק הנוכחי ואז תשתמש ב־`continueCurrentGame()` הקיים. `active` יפתח את השולחן ו־`settlement` יפתח את מסך הסגירה. לא ייווצר route או state נוסף.

מצב מורחב יוצג inline ויכלול רק נתונים קיימים מה־summary: שחקנים עם buy-in מצטבר ומספר כניסות, קופה כוללת, מספר כניסות כולל, זמן התחלה וזמן עדכון. לא יוצגו רווח, הפסד או cashout במהלך משחק פעיל.

`expandedGameCards` יהיה `Set` בזיכרון בלבד. פתיחה וסגירה ירנדרו מחדש את dashboard ולא יקראו ל־`save()`.

## קבוצות

`getGroupSummaries()` יחזיר כרגע תמיד `[]`. הוא לא יקרא מ־localStorage ולא יכיל fixtures או נתוני דמה.

`renderGroupsSection(groups)` יציג במצב הריק רק את הטקסט ״אין לך קבוצות עדיין״. כפתור ״+ צור קבוצה״ יופיע פעם אחת בלבד באזור הפעולות המהירות.

`renderGroupCard(group)` יוגדר כפונקציית renderer שמקבלת summary מבחוץ ותומכת בשם, avatar/placeholder, מספר חברים, אינדיקציית משחק פעיל ופרטים מורחבים אופציונליים. הפונקציה לא תופעל עם נתונים מלאכותיים. `expandedGroupCards` יהיה `Set` בזיכרון בלבד ולא יישמר.

החוזה העתידי של קבוצה יוכל לקבל `members`, `lastGame`, `gameCount`, `leader` ו־`topPlayers`, אך ה־renderer יציג כל שדה רק אם הוא קיים. לא תיבנה לוגיקת leaderboard, חברים, הרשאות או היסטוריה.

## פירוק פונקציות

`renderGamesDashboard()` יישאר נקודת הכניסה ויעסוק רק בהרכבת המסך. הפונקציות המתוכננות:

- `getActiveGameSummaries(state)` — adapter יחיד למשחקים פעילים.
- `getGroupSummaries()` — adapter ריק לקבוצות.
- `renderQuickActions(parent)`.
- `renderActiveGamesSection(parent, summaries)`.
- `renderActiveGameCard(summary, actions)`.
- `renderGroupsSection(parent, groups)`.
- `renderGroupCard(group)`.
- `enterActiveGame(gameId)` — חיבור לכרטיס הנבחר דרך ה־flow הקיים.
- helpers טהורים להצגת שמות וזמנים.

הפונקציות יקבלו נתונים ויחזירו DOM או יצרפו אותו ל־parent. חישובי pot וכניסות יבוצעו ב־adapter, וה־renderers לא יקראו ישירות מ־`state`.

## Persistence וסנכרון

השדה החדש היחיד ב־game state יהיה `startedAt`, הנדרש לזמן התחלה אמיתי. הוא יישמר באותו snapshot קיים ב־localStorage ובסנכרון Claude. לא ייווצר storage נוסף.

מצבי הרחבה, empty states וקבוצות לא יישמרו. אין שינוי ב־history, debts, settlement statuses, buy-ins, cashouts או סגירת המשחק.

## בדיקות וקבלה

- בדיקות adapter יאשרו ש־closed/demo מחזירים מערך ריק וש־active/settlement מחזירים `ActiveGameSummary` מלא מנתונים קיימים בלבד.
- `startedAt` יישמר למשחק חדש, יעבור normalization וסנכרון, ויישאר חסר ב־legacy.
- שמות השחקנים יקוצרו עד ארבעה ו־`+N` יחושב נכון.
- הרחבת משחק תשנה רק `expandedGameCards` ולא את `state` או localStorage.
- `getGroupSummaries()` יחזיר מערך ריק וה־empty state יציג ״אין לך קבוצות עדיין״.
- כפתור ״+ צור קבוצה״ יהיה מושבת וייראה כ־coming soon.
- renderer של GroupCard יתמוך בפתיחה וסגירה מנתונים חיצוניים, בלי שקבוצות דמה יופיעו באפליקציה.
- ״כנס לשולחן״ ימשיך להשתמש ב־phase ובמסכי המשחק הקיימים.
- הניווט יישאר עם ״משחקים״ ו״פרופיל״ בלבד.
- כל בדיקות הכניסות, האיזון, התשלומים, החובות, הפרופיל וה־phase הקיימות ימשיכו לעבור.
- QA ידני יבדוק מסך צר ורחב, מצב כהה ובהיר, empty state, משחק פעיל, הרחבה וכניסה לשולחן ללא שגיאות console.

## מחוץ לתחום

אין במשימה זו backend, יצירת קבוצה, הצטרפות, הזמנות, QR, קוד קבוצה, חברים, הרשאות, leaderboard, סטטיסטיקות מתקדמות, התראות, תשלומי Bit/PayBox, עמוד קבוצה או flow משחק חדש.
