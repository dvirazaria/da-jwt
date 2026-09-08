# מיגרציה מ-`poker-settle-v1` לסכימת Postgres

תאריך: 2026-09-08. משלים את [`schema.sql`](schema.sql) ו-[`rls-policies.sql`](rls-policies.sql).
המסמך מתאר איך להוציא את המצב המקומי ממכשיר אחד ולהכניס אותו ל-DB, בלי לגעת ב-`kupa-sgura.html`.

המיגרציה היא **חד-כיוונית ומכשיר-אחד**. היא לא מאחדת נתונים משני טלפונים: אין היום מזהה
משותף בין מכשירים, ולכן איחוד היה יוצר כפילויות. מריצים אותה על המכשיר של הבעלים, פעם אחת.

---

## שלב 1 — ייצוא מהמכשיר

### היום, דרך DevTools

בדפדפן שבו האפליקציה מותקנת, פותחים את הקונסולה על <https://poker-tau-pink.vercel.app/> ומריצים:

```js
copy(localStorage.getItem('poker-settle-v1'))
```

`copy()` מעתיק ללוח. מדביקים לקובץ בשם `export.json` ובודקים שהוא נטען: `JSON.parse` על התוכן
חייב להחזיר אובייקט עם מערך `players`. אם הקונסולה לא תומכת ב-`copy` (Safari), משתמשים ב-
`localStorage.getItem('poker-settle-v1')` ומעתיקים את הפלט ידנית, או מחברים אייפון ל-Mac
ופותחים Web Inspector.

**חשוב:** לייצא מהמכשיר שבו נמצאת ההיסטוריה האמיתית. `HISTORY_MAX` חותך את ההיסטוריה,
ומשחקים שנפלו מהחיתוך פשוט לא קיימים בקובץ — ראה "מה נאבד" למטה.

### מאוחר יותר, כפתור "ייצוא" באפליקציה

השורה הזו לא דורשת backend ואפשר להוסיף אותה מתי שרוצים: פעולה בהגדרות שיוצרת
`new Blob([localStorage.getItem(KEY)], { type: 'application/json' })`, מייצרת `URL.createObjectURL`
ולוחצת על `<a download="kupa-export.json">` נסתר. אין `alert`, אין form submit, אין מפתח
localStorage חדש — כלומר זה תואם לכל האילוצים הקיימים. ב-PWA על iOS הקובץ יורד לתיקיית
ההורדות של Safari.

---

## שלב 2 — המרה ל-SQL

```sh
cd "/Users/dvirazaria/פוקר"
node tools/local-state-to-sql.js export.json \
  --owner 11111111-2222-4333-8444-555555555555 \
  --group-owner-name "דביר" > import.sql
```

- `--owner` (חובה) — ה-UUID של המשתמש המחובר שיהיה בעל הנתונים. אחרי יצירת החשבון,
  לוקחים אותו מ-Supabase: `Authentication → Users`, או `select auth.uid()` כשמחוברים.
- `--group-owner-name` (מומלץ) — השם שהוקלד באפליקציה (`poker-settle-me`). כל מי ששמו זהה
  ימופה ל-`profiles` של הבעלים; כל השאר יהפכו ל-`guests`. בלי הדגל, **כולם** נהיים אורחים
  והבעלים מקבל רק שורת `profiles` ריקה.
- הפלט הוא SQL בלבד ב-stdout; סיכום שורות ואזהרות יוצאים ל-stderr, כדי ש-`> import.sql`
  יישאר נקי.

הכלי נמצא מחוץ ל-deploy (`tools/` ב-`.vercelignore`), בלי תלויות, ולא רץ אף פעם בדפדפן.

---

## שלב 3 — החלה

```sh
psql "$SUPABASE_DB_URL" -f docs/backend/schema.sql
psql "$SUPABASE_DB_URL" -f docs/backend/rls-policies.sql
psql "$SUPABASE_DB_URL" -f import.sql
```

או הדבקה של שלושת הקבצים ב-SQL Editor, באותו סדר. `import.sql` עטוף ב-`BEGIN`/`COMMIT`:
אם שורה אחת נכשלת, שום דבר לא נכנס.

**הרשאות:** מריצים את הייבוא בחיבור ישיר ל-DB כבעל הסכימה. RLS מופעל (`ENABLE`) ולא נכפה
(`FORCE`), ולכן חיבור הבעלים לא מסונן וכל השורות נכנסות. אסור לנסות לייבא עם המפתח הפומבי
של הקליינט — ה-policies יחסמו כמעט כל שורה.

---

## איך זהויות ממופות

| בקובץ המקומי | ב-DB |
|---|---|
| השם ב-`--group-owner-name` | `profiles` — שורה אחת, ה-`--owner` |
| כל שם אחר (שחקן, חבר קבוצה, בעל חוב) | `guests` — שורה אחת לכל **שם** |
| `player.guestId` | לא משמש כמפתח; השם הוא המפתח |

הכלל הוא בכוונה **שם**, לא `guestId`, כי זה בדיוק מה ש-`resolveGuestId(collections, displayName)`
עושה באפליקציה ("guestId אחד לכל displayName במכשיר הזה"), וזה גם היחיד שמאפשר לחוב —
ש-`debtorUserId` שלו הוא מזהה שחקן **פר-משחק** ולא מזהה אדם — להתחבר לאותו אורח שממנו הוא נוצר.
זה גם אומר ששני אנשים שונים עם אותו שם ימוזגו. האפליקציה אוסרת שמות כפולים באותו שולחן,
אז זה עקבי עם ההתנהגות הקיימת, אבל שווה לעבור על רשימת ה-`guests` אחרי הייבוא.

### קישור אורח לחשבון (guest → account)

כשחבר קבוצה נרשם באמת, לא מעבירים שורות היסטוריה. מעדכנים שדה אחד:

```sql
-- להריץ רק אחרי אישור מפורש של שני הצדדים
UPDATE guests
SET linked_profile_id = '<the new profile uuid>', linked_at = now()
WHERE id = '<the guest uuid>' AND linked_profile_id IS NULL;
```

התהליך המומלץ ב-UI: אחרי שהחבר מתחבר בפעם הראשונה, מציגים לו "מצאנו אותך כ'עומר' ב-3 משחקים
של הקבוצה — לחבר?" ורק לחיצה שלו מבצעת את הקישור. בצד השרת זו חייבת להיות פונקציית
`SECURITY DEFINER` שמוודאת שגם יוצר האורח וגם בעל החשבון הסכימו — `UPDATE` רגיל היה מאפשר
ליוצר האורח להצמיד חשבון של מישהו אחר. הקישור אף פעם לא מוחק את שורת ה-`guests`, ולכן
אפשר לבטל אותו.

---

## סדר, ידמפוטנטיות, והרצה חוזרת

1. **מזהים דטרמיניסטיים.** כל `id` הוא UUIDv5 מעל namespace קבוע ומעל המזהה המקורי:
   `game:<gameId>`, `participant:<gameId>:<playerId>`, `entry:<entryId>`, `guest:n:<displayName>`
   וכן הלאה. אותו קלט תמיד מייצר אותם UUID-ים.
2. **פלט זהה בייט-בייט.** אין חותמת זמן ואין אקראיות בפלט, אז אפשר להריץ פעמיים ולהשוות
   עם `diff`. (יש על זה בדיקה ב-`tests/local-state-to-sql.test.cjs`.)
3. **`ON CONFLICT DO NOTHING` בכל שורה.** ייבוא שני של אותו קובץ לא משנה כלום.
4. **סדר FK.** `profiles → guests → groups → group_members → invites → friendships → games →
   game_participants → entries → transfers → debts`. כל השורות בטרנזקציה אחת.
5. **ייצוא מאוחר יותר מאותו מכשיר** מוסיף רק את מה שחדש: משחקים ישנים כבר קיימים עם אותם
   מזהים ונדחים ב-`ON CONFLICT`. אזהרה אחת: משחק שהיה פתוח בייצוא הראשון ונסגר מאז ייכנס
   בפעם הראשונה כ-`active`; לפני ייצוא שני צריך למחוק אותו ידנית או לסגור אותו ב-DB, כי
   `ON CONFLICT DO NOTHING` לא יעדכן את ה-`phase`.

---

## מה נאבד או מקורב

| נושא | מה קורה | למה |
|---|---|---|
| **כניסות ללא זמן** | `entries.created_at = NULL` | הכלל הקיים: אף פעם לא ממציאים זמן לכניסה ישנה. ה-UI מציג "—". |
| **שחקן היסטורי בלי `entryLog`** | כניסה סינתטית אחת בסכום ה-`buyin`, עם `created_at NULL` | שומר על נכונות הסכומים; מפרק את פירוט הכניסות. מדווח כאזהרה ב-stderr. |
| **`debtorUserId` / `creditorUserId`** | לא מועברים | הם מזהי שחקן פר-משחק, לא מזהי אדם. הזהות נפתרת לפי `debtorName`/`creditorName`. |
| **חוב שמצביע על משחק שנפל מההיסטוריה** | נדלג, עם אזהרה | ה-FK ל-`games` היה נכשל. הסכום מופיע בסיכום ה-stderr כדי שאפשר יהיה להזין ידנית. |
| **`friendships`** | לא מועברות; מודפסות כהערות SQL בסוף הקובץ | `friendships` דורשת שני `profiles`, ולפני חשבונות רק לבעלים יש אחד. יוצרים אותן מחדש אחרי שכולם נרשמים. |
| **`avatarDataUrl` של קבוצה** | לא מועבר; `groups.avatar_url` נשאר NULL | data URL בגודל ~12KB לא שייך לעמודה טקסטואלית ב-DB. מעלים את התמונה ל-Storage ומעדכנים את ה-URL. |
| **`settlementStatuses` של המשחק הפתוח** | לא מועברים | `transfers` נוצרות רק בסגירה, ולכן אין למה לחבר את ה-toggle. מדווח כהערה. |
| **`updatedAt` של המסמך** | לא מועבר | ה-DB מחזיק `updated_at` פר-שורה דרך טריגר. |
| **נתוני דמו (`example: true`)** | לא מועברים בכלל | הם דמו. |
| **`games.created_by`** | תמיד הבעלים | לא נשמר במצב המקומי מי פתח משחק ישן. `leader_*` כן מועבר כשיש `leaderRef`. |
| **`entries.created_by`** | תמיד NULL | אין מידע מי רשם את הכניסה; עדיף NULL מאשר לייחס הכול לבעלים. |
| **היסטוריה מעבר ל-`HISTORY_MAX`** | לא קיימת בקובץ | נחתכה במכשיר עוד לפני הייצוא. |

---

## בדיקות שפיות אחרי הייבוא

```sql
-- 1. כל משחק סגור: הפער השמור חייב להתאים לחישוב מחדש מתוך entries.
SELECT g.id, g.balance_difference, -sum(r.net) AS recomputed
FROM games g JOIN game_results_v r ON r.game_id = g.id
WHERE g.phase = 'closed'
GROUP BY g.id, g.balance_difference
HAVING g.balance_difference <> -sum(r.net);          -- ציפייה: 0 שורות

-- 2. אף קבוצה לא קיבלה שני משחקים פתוחים (האינדקס אמור לחסום, זו בדיקה כפולה).
SELECT group_id, count(*) FROM games
WHERE group_id IS NOT NULL AND phase <> 'closed'
GROUP BY 1 HAVING count(*) > 1;                       -- ציפייה: 0 שורות

-- 3. סכום החובות הפתוחים חייב להתאים למה שהפרופיל הראה באפליקציה.
SELECT status, count(*), sum(amount) FROM debts GROUP BY 1;

-- 4. אורחים כפולים בגלל שמות דומים (רווח מיותר, ניקוד).
SELECT display_name, count(*) FROM guests GROUP BY 1 HAVING count(*) > 1;
```

אם בדיקה 1 מחזירה שורות, זו כמעט תמיד כניסה סינתטית: השווה את `game_results_v.buyin_total`
מול `history[].players[].buyin` בקובץ המקורי לפני שמתקנים משהו ב-DB.
