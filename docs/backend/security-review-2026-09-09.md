# בדיקת חדירה עוינת ל-RLS — סוגרים קופה

תאריך: 2026-09-09
פרויקט: `aztfjlssjbjhxdqsflgn` (Supabase, production)
מבצע הבדיקה: סוכן Claude, בהרשאת בעל הריפו, מתוך worktree מבודד
קבצי מקור שנקראו: `docs/backend/schema.sql`, `docs/backend/rls-policies.sql`,
`docs/backend/join-invite.sql`, `docs/backend/fix-upsert-policies.sql`, `HANDOFF.md`,
וסעיף ה-`cloud store (Supabase)` ב-`kupa-sgura.html`.

## הקשר ומתודולוגיה

לאפליקציה הזו אין קוד שרת משלה — כל גבול האבטחה הוא Postgres RLS מול Supabase, וה-
publishable key (`sb_publishable_JsCuQh8iaszmRzjITbhOVA_vWqEXrUV`) חשוף בכוונה בקוד
המקור. מודל התוקף שנבדק: מישהו שמחזיק את המפתח הציבורי הזה, יכול להירשם לחשבון משלו,
ויכול לבנות כל בקשת PostgREST שהוא רוצה.

כללי המשחק שנשמרו:
- **בדיקות read-only אנונימיות מול הפרויקט החי הותרו** ובוצעו בפועל (ראו §"מה הוכח
  בזמן אמת"). כל בדיקה כזו היא GET/RPC-קריאה בלבד, ללא Authorization מלבד אותו
  anon key ציבורי.
- **לא בוצעה אף כתיבה, עדכון או מחיקה בפרויקט החי.** לא נוצר חשבון, לא נשלח קוד
  אימות, ולא נקראה `app_redeem_invite` בפרודקשן — גם לא כדי לאמת שהיא נכשלת כמו
  שצריך. כל תרחיש התקפה שדורש session מאומת מנומק על הנייר בלבד, ומלווה בסקריפט
  הרצה ב-`tools/rls-probe.mjs` שבעל הריפו יכול להריץ בעצמו מול חשבון חד-פעמי.
- לא נעשה שימוש ב-service_role/sb_secret_ כלל, ולא נכתב שום SQL ישירות מול הפרויקט.

כל ממצא מסומן בהמשך כ**"הוכח בזמן אמת"** (live HTTP request שביצעתי בפועל מול
`https://aztfjlssjbjhxdqsflgn.supabase.co`, עם פלט מצורף) או **"נומק סטטית"** (מקריאת
קוד ה-SQL/JS בלבד, ללא הרצה). אף ממצא לא מוצג כ"מוכח" אם כל מה שיש לו הוא ניתוח סטטי.

## תקציר ממצאים (סדר חומרה)

| # | חומרה | ממצא | הוכח איך |
|---|--------|------|----------|
| F1 | CRITICAL | אפשר לזייף `debts` נגד קורבן שרירותי | נומק סטטית + סקריפט `--destructive` |
| F2 | HIGH | אפשר לצרף פרופיל אמיתי כמשתתף במשחק בלי הסכמתו | נומק סטטית + סקריפט `--destructive` |
| F3 | HIGH | חשיפת רווח/הפסד אישי בין חברי אותה קבוצה | נומק סטטית (RLS) + אישוש מקוד ה-sync עצמו |
| F4 | MEDIUM | פונקציות עזר של RLS ניתנות להפעלה אנונימית | **הוכח בזמן אמת** — כל 9 הקריאות החזירו 200 |
| F5 | MEDIUM | `profiles.email`/`phone` חשופים במלואם לחברים/שותפי-קבוצה | נומק סטטית + אישוש שהעמודה מאוכלסת בפועל |
| F6 | MEDIUM | הרשאת "יוצר" קבועה ששורדת הדחה מתפקיד, כולל חטיפת `games.group_id` | נומק סטטית |
| F7 | LOW | `app_current_profile_id()` היחידה בלי `search_path` נעוץ | נומק סטטית, סיכון קרוב לאפס |
| F8 | LOW / מידע | אין הגבלת קצב על ניחוש טוקן הזמנה | נומק סטטית — אנטרופיה של 40 סיביות מקהה זאת |

תיקון SQL מוכן לכל ממצא (מלבד F8, שאין לו תיקון ב-RLS) נמצא ב-
`docs/backend/security-fixes.sql`. **הקובץ לא הורץ** — הוא מיועד להרצה ידנית על ידי
בעל הריפו.

---

## F1 — CRITICAL: אפשר לזייף חוב (`debts`) נגד כל משתמש שמכירים את ה-UUID שלו

**התקיפה.** `debts_insert_on_close` (`rls-policies.sql:364-371`) בודקת רק שהקורא
רשאי לכתוב למשחק המפנה (`games.created_by = אני` או חבר פעיל בקבוצת המשחק) — היא
**לא** בודקת בכלל שה-`debtor_profile_id`/`creditor_profile_id` שנכתבים שייכים למישהו
שבאמת שיחק במשחק הזה:

```sql
CREATE POLICY debts_insert_on_close ON debts FOR INSERT TO authenticated
  WITH CHECK (
    status = 'open' AND paid_at IS NULL
    AND EXISTS (SELECT 1 FROM games g
                WHERE g.id = game_id
                  AND (g.created_by = app_current_profile_id()
                       OR (g.group_id IS NOT NULL AND app_is_active_group_member(g.group_id))))
  );
```

בניגוד ל-`transfers`, שמעוגנת ב-FK אמיתי ל-`game_participants`
(`transfers_from_fk`/`transfers_to_fk` ב-`schema.sql:328-331`) ולכן לא ניתן לצרף לה
זהות בדויה — ל-`debts` (`schema.sql:338-361`) אין שום FK או CHECK שמקשר את
`debtor_profile_id`/`creditor_profile_id` בחזרה ל-`game_participants` של אותו משחק.
הם רק `REFERENCES profiles(id)`, כלומר חייבים להיות UUID של פרופיל **קיים במערכת**,
אבל לא חייבים להיות מישהו שהשתתף במשחק הזה בכלל.

**תרחיש מלא (מנומק על הנייר, לא בוצע בפרודקשן):**
1. תוקף לומד את ה-`profile_id` (UUID) של הקורבן — די בכך שהיו אי-פעם באותה קבוצה
   (אפילו קבוצה שהתוקף עזב מיד אחר כך): `group_members_select` חושפת `profile_id`
   מלא לכל חבר קבוצה פעיל.
2. התוקף יוצר משחק ad-hoc משלו (`group_id NULL`, ללא צורך בקבוצה משותפת עם הקורבן).
3. `INSERT INTO debts (game_id, debtor_profile_id, creditor_profile_id, debtor_name,
   creditor_name, amount, status) VALUES (<המשחק שלי>, '<uuid-של-הקורבן>',
   '<uuid-שלי>', 'קורבן', 'תוקף', 5000, 'open')` — עובר את ה-WITH CHECK במלואו.
4. הקורבן, בפתיחה תמימה של Profile > חובות שלו, רואה חוב "אמיתי" של ₪5000 — כי
   `debts_select_parties` (`rls-policies.sql:361-363`) בודקת נכון רק `debtor_profile_id
   = אני OR creditor_profile_id = אני`, אבל לא בודקת שהחוב נוצר ממשחק אמיתי.

**חומרה: CRITICAL.** דורש רק חשבון חינמי + היכרות חד-פעמית עם UUID של הקורבן (סף
נמוך מאוד באפליקציה חברתית), ופוגע ישירות בהבטחת הליבה של המוצר — שחוב קיים רק בזכות
משחק אמיתי שהתרחש.

**תיקון:** `docs/backend/security-fixes.sql` §F1 — מוסיף שני `EXISTS` ל-WITH CHECK
שדורשים ש-`identity_key` של החייב ושל הנושה יתאימו לשורת `game_participants` אמיתית
של אותו `game_id`. זהה במדויק לזהויות שזרימת הסגירה הלגיטימית כבר יוצרת, כך שאין שינוי
התנהגות למשתמש תמים.

---

## F2 — HIGH: צירוף פרופיל אמיתי כ"משתתף" במשחק בלי הסכמתו

**התקיפה.** `game_participants_insert`/`_update` (`rls-policies.sql:319-323`,
מוחלפת ל-`fix-upsert-policies.sql:93-108`) בודקות רק `app_can_write_game(game_id)` —
כלומר שהקורא (לא הנבדק!) רשאי לכתוב למשחק. שום דבר לא בודק שה-`profile_id` הנכתב
הוא הקורא עצמו, או חבר בקבוצה שהמשחק שייך לה:

```sql
CREATE POLICY game_participants_insert ON game_participants FOR INSERT TO authenticated
  WITH CHECK (app_can_write_game(game_id));
```

ההערה שמעל המדיניות המקורית מסבירה שזו החלטה מכוונת: "האפליקציה שיתופית בעיצובה —
כל מי שיושב לשולחן עורך את השולחן" — אבל זה תקף רק להוספת **guests** (שאין להם
סוכנות/חשבון משלהם). לפרופיל אמיתי אין בדיקה מקבילה. שילוב עם F1: תוקף שמצרף את
הקורבן כ"משתתף" במשחק בדוי (עם `cashout` שהתוקף בוחר), ואז סוגר את המשחק ורושם חוב —
מקבל את אותה תוצאה גם בלי לגעת ב-`debts` ישירות, כשהפעם גם `game_results_v.net`
"מוכיח" מספרים.

**חומרה: HIGH.** דורש שהתוקף ידע את ה-UUID של הקורבן (אותו סף כמו F1); אינו דורש
קבוצה משותפת בזמן ההתקפה עצמה.

**תיקון:** `security-fixes.sql` §F2 — מוסיפה תנאי: מותר לצרף `profile_id` רק אם הוא
(א) הקורא עצמו, או (ב) חבר **פעיל** באותה קבוצה שהמשחק שייך לה (בדיוק הקבוצה שבוחר
ה-participant-picker לפי `HANDOFF.md`). משחקי ad-hoc (`group_id IS NULL`) מוגבלים
ל-self-או-guest בלבד, כי אין רשימת חברים לבדוק מולה. שורות guest נשארות פתוחות
לגמרי, כמו היום.

---

## F3 — HIGH: חשיפת רווח/הפסד אישי בין חברי אותה קבוצה — RLS אוכפת רק את גבול הקבוצה, לא את גבול השחקן

זהו הממצא שהמשימה ביקשה לבדוק ישירות: **"בדקו אם ה-RLS אוכפת את זה או רק ה-UI, ואמרו
זאת במפורש."** התשובה: **רק ה-UI אוכף. ה-RLS לא.**

**מה כתוב במוצר.** `HANDOFF.md:159-163` מתאר את `GroupGameSummary` כחשוף רק ל-"תאריך,
מספר שחקנים, שמות מנצחים, קופה (pot), דגל איזון" — בלי סכום אישי לאף שחקן. אותו קובץ:
`buildLeaderboard() ... "never exposes a money field to the renderer"` — גם הליגה
המצטברת לא חושפת כסף של אף אחד מלבד עצמך. ב-`kupa-sgura.html` (שורות 4761, 5587,
6237-6243) הטקסט היחיד שמוצג הוא "בקופה X" — סכום כולל, לא לפי שחקן.

**מה ה-RLS בפועל מאפשרת.** `entries_select` ו-`game_participants_select`
(`rls-policies.sql:317-318, 330-331`) שתיהן שערן היחיד הוא `app_can_read_game(game_id)`
— כלומר **כל חבר פעיל בקבוצה**, לאו דווקא מי ששיחק במשחק הספציפי הזה, ולאו דווקא
כשהמשחק פתוח. `game_participants` כולל את עמודת `cashout`; `entries` כולל את `amount`
של כל buy-in. `game_results_v` (`schema.sql:290-309`) מחשבת ישירות `net` לכל משתתף,
ו-`GRANT SELECT ON game_results_v TO authenticated` (`rls-policies.sql:404`) לא
מוסיפה שום הגבלה נוספת מעבר לאותה `app_can_read_game`. כלומר: כל חבר קבוצה יכול
לשלוף ישירות, ב-REST גולמי, buy-in ו-cashout מדויקים של כל שחקן אחר, בכל משחק
בקבוצה — פתוח או סגור, ששיחק בו או לא.

זה **לא** דולף בין קבוצות (`app_can_read_game` בודקת נכון חברות בקבוצה של המשחק
עצמו) — הבעיה היא שהחסימה עוצרת בגבול הקבוצה, ולא יורדת לרמת "רק מי שהשתתף במשחק
הזה, ורק המספר שלו עצמו".

**אישוש מעבר לניתוח RLS: קוד ה-sync של האפליקציה עצמה כבר עושה בדיוק את זה.**
`pullCloud()`/`fetchCloudGameChildren()` (`kupa-sgura.html:1800-1870`) מושכות
`entries`+`game_participants` (כולל `cashout`) עבור **כל משחק בכל קבוצה שהמשתמש חבר
בה** — לא רק משחקים שהוא שיחק בהם (ראו ההערה בקוד עצמו, שורה 1825: "games_select is
app_can_read_game(): my groups' games plus any ad-hoc game I created or played in")
— ומחשבות את הליגה/היסטוריית הקבוצה **מקומית, על המכשיר**, מתוך המספרים הגולמיים.
המשמעות: הנתונים האלה כבר יושבים היום ב-localStorage/IndexedDB של כל חבר קבוצה,
נגישים ב-devtools של הדפדפן בלי לכתוב שורת קוד — לא רק תיאורטית נגישים דרך בקשת
PostgREST מותאמת. (זו קריאת קוד, לא הרצה חיה מול חשבון אמיתי — לא בוצע login.)

**חומרה: HIGH**, לא CRITICAL — כי עדיין דורש חברות אמיתית וקבועה בקבוצה (לא קבוצה
מזדמנת/בדויה כמו F1/F2), אבל זו בדיוק החשיפה שהמוצר טורח להצהיר שהוא **לא** עושה.

**למה אין תיקון פעיל ב-`security-fixes.sql` לממצא הזה.** התיקון הנכון ל-RLS
(להגביל `entries_select`/`game_participants_select`/ה-grant על `game_results_v`
ל-"משתתף במשחק הזה בלבד, או היוצר שלו") **יישבר את מסך היסטוריית הקבוצה/ליגה הקיים**
עבור כל משחק סגור שהצופה לא שיחק בו בעצמו — כי כרגע הקליינט תלוי בזה שהוא יכול
למשוך את הנתונים הגולמיים כדי לחשב אותם בעצמו. הפתרון האמיתי דורש שינוי משולב:
צד השרת כבר בנה בדיוק את התצוגות הבטוחות הדרושות — `group_leaderboard_public_v`
ו-`my_group_stats_v` (`rls-policies.sql:402-414`) — אבל `pullCloud()` עדיין לא
משתמשת בהן. תיקון ה-RLS מוכן ומוער (comment) בתחתית `security-fixes.sql`, אבל
לא מופעל — זו החלטת מוצר/הנדסה שהבעלים צריך לתזמן יחד עם שינוי ב-`kupa-sgura.html`,
לא תיקון שאפשר להדביק בשקט תוך כדי סקירת אבטחה.

---

## F4 — MEDIUM: כל פונקציות העזר של RLS ניתנות להפעלה אנונימית (הוכח בזמן אמת)

**התקיפה.** ב-Postgres, EXECUTE על פונקציה חדשה ניתן כברירת מחדל ל-`PUBLIC`. תשע
הפונקציות הבאות ב-`rls-policies.sql` — `app_current_profile_id`,
`app_is_active_group_member`, `app_is_group_admin`, `app_is_game_participant`,
`app_can_read_game`, `app_can_write_game`, `app_shares_group_with`,
`app_group_has_no_members`, `app_is_friend_of` — **אף אחת מהן לא עשתה
`REVOKE ... FROM PUBLIC`**. בניגוד ל-`app_redeem_invite` (`join-invite.sql:131-133`),
שכן נעולה נכון (`REVOKE ALL ... FROM public; REVOKE ALL ... FROM anon; GRANT EXECUTE
... TO authenticated;`), וגם ל-Views רגישים באותו קובץ עצמו
(`REVOKE ALL ON group_leaderboard_v FROM authenticated;`, שורה 402) — כלומר המחבר
בהחלט מכיר ומיישם את הדפוס הזה, רק לא על פונקציות העזר.

**הוכח בזמן אמת.** קריאה אנונימית מלאה (`apikey`+`Authorization: Bearer` = אותו anon
key, ללא session/JWT של משתמש) לכל תשע הפונקציות דרך `POST /rest/v1/rpc/<name>`
החזירה **HTTP 200** לכולן:

| פונקציה | קלט | תשובה |
|---|---|---|
| `app_current_profile_id` | `{}` | `null` |
| `app_is_active_group_member` | `{"p_group_id":"00000000-…"}` | `false` |
| `app_is_group_admin` | " | `false` |
| `app_can_read_game` | `{"p_game_id":"00000000-…"}` | `false` |
| `app_can_write_game` | " | `false` |
| `app_is_game_participant` | " | `false` |
| `app_shares_group_with` | `{"p_profile_id":"00000000-…"}` | `false` |
| `app_group_has_no_members` | `{"p_group_id":"00000000-…"}` | `true` |
| `app_is_friend_of` | `{"p_profile_id":"00000000-…"}` | `false` |

**חשיפת המידע בפועל מוגבלת** — כל התוצאות תלויות ב-`app_current_profile_id()` שמחזירה
`NULL` עבור קורא אנונימי, וכל ההשוואות מול `NULL` הן `false` (לא `true`), כך שאין
כאן דליפת מידע ישירה על תוכן פרטי (אין דרך, למשל, למנות אילו קבוצות קיימות — התשובה
`false` זהה בין "הקבוצה לא קיימת" ל"קיימת אבל אני לא חבר בה"). זה בכל זאת פרצת
הרשאות אמיתית: פונקציות `SECURITY DEFINER` שרצות בהרשאת הבעלים ועוקפות RLS על הטבלה
הבסיסית לא אמורות להיות נגישות בכלל למי שלא מחזיק session — עקרון least-privilege
בסיסי, וכל פונקציה עתידית שתחזיר נתון (לא רק boolean) תהיה חשופה מיד אם תיכתב באותו
דפוס.

**תיקון:** `security-fixes.sql` §F4 — `REVOKE ALL ... FROM PUBLIC/anon` +
`GRANT EXECUTE ... TO authenticated` על כל תשע הפונקציות (כולל
`app_current_profile_id`, למרות שהיא לא `SECURITY DEFINER` — לשם עקביות; `authenticated`
נשארת עם EXECUTE כי כל מדיניות RLS בקובץ קוראת לפונקציות האלה, ובלעדיה כל בדיקת
RLS הייתה נשברת גם למשתמשים אמיתיים).

---

## F5 — MEDIUM: `profiles.email`/`phone` חשופים במלואם לחברים ולשותפי-קבוצה

**התקיפה.** `profiles_select_friends`/`profiles_select_group_mates`
(`rls-policies.sql:179-182`) הן מדיניות **row-level** — מי שעובר אותן רואה את **כל**
העמודות של השורה, כולל `phone`/`email`, כי אין שום `REVOKE`/`GRANT` ברמת עמודה על
`profiles` (בניגוד ל-`transfers`/`debts`, ששם יש בדיוק דפוס כזה, `rls-policies.sql:
389-395`). האפליקציה עצמה **אף פעם** לא מבקשת email/phone של מישהו אחר —
`lookupFriendProfile` (`kupa-sgura.html:6875-6885`) מבקשת רק `id,display_name`
— אבל זו בחירה של הקליינט, לא אכיפה של השרת: כל בקשת REST גולמית
(`GET /rest/v1/profiles?id=eq.<friend-id>&select=email,phone`) עוקפת אותה לגמרי.

**אישוש שהעמודה מאוכלסת בפועל.** `ensureProfile()` (`kupa-sgura.html:6585-6598`)
כותבת `{ id: user.id, display_name: displayName, email: user.email || null }` —
כלומר **כתובת המייל האמיתית שאיתה נרשם המשתמש** נשמרת ב-`profiles.email` בכל login.
`phone` לא מאוכלס על ידי שום קוד קיים (אין נתיב הרשמה בטלפון היום) — סיכון עתידי
סמוי, לא דלף פעיל כרגע.

**חומרה: MEDIUM.** דורש קשר אמיתי (חברות מאושרת דו-צדדית, או קבוצה משותפת דרך invite
תקף) — לא זר גמור — אבל חושף PII אמיתי (מייל מאומת) מעבר למה שהמוצר עצמו מציג אי-פעם.

**תיקון — חלק פעיל:** `security-fixes.sql` §F5 מסיר `SELECT` על `phone` לגמרי
(`REVOKE SELECT (phone) ON profiles FROM authenticated;`) — בטוח ב-100%, כי שום קוד
קיים לא קורא או מסנן לפי העמודה הזו.

**תיקון — חלק דחוי (email).** לא הופעל, ומוסבר במלואו כקטע מוער בסוף
`security-fixes.sql`: `lookupFriendProfile` מסננת `.eq("email", value)` על הטבלה
הגולמית, ו-Postgres דורש הרשאת SELECT על עמודה כדי לסנן לפיה גם כשהיא לא מוחזרת —
מחיקת ההרשאה תשבור את החיפוש-לפי-מייל מיידית (וגם את הבדיקה הקיימת
`tests/friend-requests.test.cjs`: "the profile lookup is an exact single-column
match"). התיקון המלא (מוכן, בהערה) מחליף את הנתיב הזה ב-RPC צר
(`app_lookup_profile_by_email`) שמחזיר רק `id,display_name` תחת אותם תנאי נראות
בדיוק כמו היום (self/friend/group-mate) — אבל דורש גם שינוי תואם ב-`lookupFriendProfile`
עצמה וב-test הקיים, ולכן לא "תיקון טריוויאלי" לפי ההגדרה במשימה; הושאר לבעלים.

---

## F6 — MEDIUM: הרשאת "יוצר" קבועה ששורדת הדחה מתפקיד — כולל חטיפת `games.group_id`

**הרקע.** `fix-upsert-policies.sql` נכתב כדי לפתור בעיית upsert אמיתית: `upsert(...,
{onConflict:"id"})` מתורגם ל-`INSERT ... ON CONFLICT DO UPDATE`, ו-Postgres מפעיל גם
את מדיניות ה-UPDATE על שורה חדשה שרק נוצרת — פונקציות `STABLE SECURITY DEFINER`
כמו `app_is_group_admin()` לא רואות שורה שעדיין באותה statement (זו בדיוק המחלקה
שתוקנה גם בצד הקליינט ב-commit `9eafade`). הפתרון שנבחר ב-`fix-upsert-policies.sql`:
להוסיף לכל מדיניות ענף "או שאני היוצר של השורה הזו/של הקבוצה", שנבדק ישירות מול
העמודה בלי שאילתה חוזרת לאותה טבלה.

**הבעיה: הענפים האלה כבר מיותרים, ומסוכנים.** commit `9eafade` פתר את הבעיה **בצד
הקליינט**: `splitCloudWrites()` (`kupa-sgura.html`) שולחת כל שורה חדשה כ-`INSERT ...
ON CONFLICT DO NOTHING` — לעולם לא כ-upsert שנוגע בענף ה-UPDATE. `CLOUD_INSERT_ONLY`
(`kupa-sgura.html:1536`) מכיל רק `entries`/`transfers`/`debts` — כלומר `groups`,
`group_members`, `invites` ו-`games` **כולן** כבר עוברות דרך `splitCloudWrites`,
ולכן התרחיש שהענפים האלה נועדו לתקן (שורה חדשה לגמרי שפוגעת בענף ה-UPDATE) כבר לא
קורה מהקליינט האמיתי בכלל. מה שנשאר הוא רק החיסרון: הרשאה **בלתי-מותנית וקבועה**.

- **`games_update_member`** (`fix-upsert-policies.sql:71-85`) — ה-WITH CHECK
  `created_by = app_current_profile_id() OR group_id IS NULL OR
  app_is_active_group_member(group_id)` נותן ל-**יוצר** של כל משחק פתוח לבצע
  `UPDATE games SET group_id = <כל קבוצה אחרת>` — **בלי שום דרישת חברות בקבוצת
  היעד**, כי הענף הראשון (`created_by = אני`) עוקף לגמרי את הבדיקה. מכיוון ש-
  `games_one_open_per_group_uk` (`schema.sql:217-218`) מאפשרת לכל היותר משחק פתוח
  אחד לקבוצה, זהו פרימיטיב הטרדה/DoS נגד **כל קבוצה במערכת** (גם כזו שהתוקף מעולם
  לא היה חבר בה): "לחנות" שם משחק-דמה משלו חוסם את חברי הקבוצה האמיתיים מלפתוח
  שולחן חדש עד שהתוקף מטפל בו (ורק היוצר, לא מנהלי הקבוצה, יכול למחוק אותו לפי
  `games_delete_creator`).
- **`groups_update_admin`**/**`group_members_update_admin`**
  (`fix-upsert-policies.sql:115-118, 126-139`) — יוצר הקבוצה שומר לנצח את היכולת
  לשנות שם/ארכיון/מחיקה רכה של הקבוצה, ואת היכולת לשנות **תפקיד של כל חבר** (כולל
  לקדם את עצמו בחזרה למנהל) — גם אחרי שהודח כדין מתפקיד המנהל.
- **`invites_update_admin`** (`fix-upsert-policies.sql:154-157`) — צר יותר: יוצר
  הזמנה ספציפית שומר את הזכות לבטל/לערוך **אותה הזמנה** גם אחרי אובדן הרשאת מנהל.

**חומרה: MEDIUM.** לא נגיש לזר גמור (התוקף חייב להיות היוצר המקורי, כלומר "פנימי"
לשעבר), אבל מדובר בהסלמת/שימור הרשאות אמיתית + וקטור הטרדה בין-קבוצתי אמיתי (חטיפת
`group_id`) שלא דורש שום קשר קודם לקבוצת הקורבן.

**תיקון:** `security-fixes.sql` §F6 — מחזיר את ארבע המדיניות הללו בדיוק לניסוח
שהיה לפני `fix-upsert-policies.sql` (מסיר את ענף ה-creator). **לא נבדק בזמן אמת**
(דורש כתיבה) — מומלץ לבעלים להריץ מחדש בדיוק את שלבים 2-4 מסעיף "HOW TO VERIFY" של
`fix-upsert-policies.sql` אחרי ההחלה, כדי לוודא שה-upsert המקורי עדיין לא נכשל
ב-42501; אם כן נכשל, יש לעצור ולפתוח את הממצא הזה מחדש במקום לכפות את הענפים בחזרה.
בנוסף: הענף הכפול שנוסף ב-`game_participants_update` (`fix-upsert-policies.sql:93-108`)
זוהה כ**redundant בלבד ולא כהרחבת הרשאה** — `app_can_write_game()` כבר כוללת ענף
`created_by = app_current_profile_id()` משלה (`rls-policies.sql:107-116`), כך שהוא
לא נספר כממצא נפרד, רק הוסר לניקיון בתיקון F2.

---

## F7 — LOW: `app_current_profile_id()` היחידה בלי `search_path` נעוץ

שמונה מתוך תשע הפונקציות ב-`rls-policies.sql` הן `SECURITY DEFINER SET search_path
= public`. `app_current_profile_id()` (שורות 23-37) היא היחידה בלי `SET search_path`.
בפועל הסיכון קרוב לאפס: הפונקציה **אינה** `SECURITY DEFINER` (רצה בהרשאת הקורא, לא
הבעלים), והגוף שלה (`SELECT auth.uid()`) הוא קריאה יחידה למזהה סכימה מלא
(`auth.uid()`) — אין שם אף זיהוי לא-מוסמך ש-`search_path` יכול להשפיע על הפירוש שלו.
עדיין, מכיוון שהיא נקראת מתוך כל שמונה הפונקציות האחרות, ולשם עקביות/הגנת-עומק,
`security-fixes.sql` §F7 מוסיף את הנעיצה — שינוי ש**לא יכול** לשנות התנהגות (אין שם
שום דבר ש-search_path עלול להשפיע עליו).

---

## F8 — LOW / מידע: אין הגבלת קצב על ניחוש טוקן הזמנה

`app_redeem_invite` (`join-invite.sql`) נעולה נכון (§F4 לעיל), ואין שום הגבלת קצב
ברמת ה-DB על מספר הקריאות אליה מחשבון מאומת אחד. בפועל זה מקוזז ברובו: הטוקן נוצר
מ-`INVITE_TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"` (32 תווים, בלי 0/O/1/I,
`kupa-sgura.html:2853`) באורך 8 — `32^8 ≈ 1.1×10^12` אפשרויות (כ-40 סיביות), נוצר
דרך `crypto.getRandomValues` כשזמין (`kupa-sgura.html:4407-4413`), עם נפילה ל-
`Math.random()` רק כש-`crypto` לא קיים בכלל. ניחוש מרחוק ב-40 סיביות, מול API
מרוחק, אינו מעשי כיום. **לא נבדק בזמן אמת** (ידרוש אלפי קריאות `app_redeem_invite`,
אסור לפי כללי המשימה). המלצה כהקשחה עתידית בלבד: שקול מנגנון rate-limit ברמת
Edge Function/Gateway אם ההיקף גדל — אין לזה תיקון ב-RLS עצמה, ולכן אין סעיף
תואם ב-`security-fixes.sql`.

---

## מה נוסה ולא הצליח להישבר

| # | תרחיש שנוסה | תוצאה | איך נבדק |
|---|---|---|---|
| 1 | קריאה אנונימית ל-11 הטבלאות + 4 ה-views (`profiles`, `groups`, `games`, `entries`, `debts`, `group_members`, `invites`, `guests`, `friendships`, `transfers`, `game_participants`, `game_results_v`, `group_leaderboard_v`, `group_leaderboard_public_v`, `my_group_stats_v`) | כולן `200 []` — אף שורה לא חוזרת למשתמש אנונימי | **הוכח בזמן אמת** |
| 2 | קריאת חובות של זרים (`debts` ששני הצדדים בהם שונים ממני) | `debts_select_parties` דורשת `debtor_profile_id = אני OR creditor_profile_id = אני` בלבד, בלי חריג | נומק סטטית (הריקנות לאנונימי הוכחה בזמן אמת; המקרה "משתמש מאומת אך לא צד לחוב" לא ניתן להדגמה בלי חשבון אמיתי) |
| 3 | הצטרפות לקבוצה בלי הזמנה, כולל דריסת ה-bootstrap (`app_group_has_no_members`) | הפונקציה בודקת **כל** שורת `group_members` (גם `left`/`removed`), כך שברגע שהיה לקבוצה חבר אחד אי-פעם, הנתיב נסגר לצמיתות; הצטרפות דרך `group_members_insert_admin` דורשת מנהל פעיל בפועל | נומק סטטית |
| 4 | זיוף זהות דרך פרמטר-קלט לפונקציית עזר (למשל: פרמטר `p_profile_id` שמשמש כ"אני" במקום `app_current_profile_id()`) | בכל תשע הפונקציות ובכל `app_redeem_invite`, זהות **הקורא עצמו** תמיד נגזרת מ-`app_current_profile_id()`/`auth.uid()`, אף פעם לא מפרמטר קלט; פרמטרים כמו `p_profile_id` תמיד מתארים את **הצד השני** בהשוואה | נומק סטטית — כל תשע הפונקציות נקראו |
| 5 | מוטציה של משחק סגור (`entries`, `game_participants`, `games`, `transfers`) | חסום כפול: RLS (`phase <> 'closed'` ב-USING) **וגם** triggers ברמת הסכמה (`app_assert_game_open`, `app_assert_game_row_editable`, `app_assert_transfer_editable`, `schema.sql:452-513`) שפועלים גם מול חיבור בעלים/service role | נומק סטטית |
| 6 | ביטול חוב ששולם, או שינוי `amount`/זהויות ב-`debts` אחרי יצירה | הרשאת עמודה מוגבלת ל-`(status, paid_at, paid_by_profile_id)` בלבד (`rls-policies.sql:393-395`); USING דורש `status='open'` כך שאין נתיב חזרה מ-paid ל-open בכלל, לאף אחד | נומק סטטית |
| 7 | הזרקת SQL דרך `EXECUTE`/`format()` דינמי | מקום יחיד בכל הקוד שמשתמש ב-`EXECUTE format()` (`schema.sql:540-553`) — מריץ מערך Postgres קבוע מראש (`ARRAY['profiles','guests',...]`), לא קלט לקוח; לא ניתן לקריאה מ-client כלל (בלוק DO חד-פעמי) | נומק סטטית |
| 8 | הרשמה כמנהל דרך `group_members_insert_admin` בלי להיות מנהל/יוצר | שני הענפים דורשים או מנהל פעיל אמיתי, או בדיוק תנאי ה-bootstrap מ-#3 | נומק סטטית |
| 9 | חובות עם צד שהוא guest (לא פרופיל) — הפער המתועד ב-`rls-policies.sql:381-384` | מתועד במפורש כפער ידוע ומכוון על ידי המחבר, ולא ניתן לניצול כי ל-guest אין login בכלל | נומק סטטית, לא ממצא חדש |

## מה הוכח בזמן אמת מול מה שנומק על הנייר בלבד

**הוכח בזמן אמת (live HTTP, ללא session, ללא כל כתיבה):**
- F4 — כל תשע קריאות ה-RPC לפונקציות העזר החזירו HTTP 200 לקורא אנונימי (§F4).
- כל 15 בדיקות ה-SELECT האנונימיות בטבלה שב"מה נוסה ולא הצליח להישבר" #1 — כולן
  `200 []`. **הסתייגות חשובה בכנות:** תשובה ריקה מ-PostgREST זהה בין "RLS חוסמת
  כראוי" לבין "הטבלה ריקה בפועל" — Postgres לא מבחין בין השניים כלפי חוץ (וזו
  בדיוק התכונה הרצויה של RLS תקינה). המסקנה המוצקה מהבדיקה היא: **אין שום נתיב
  שמחזיר ולו שורה אחת לקורא אנונימי**, לא "יש X שורות מוסתרות".
- הגדרות ה-auth הציבוריות (`GET /auth/v1/settings`) — לצורך הקשר בלבד, לא ממצא.

**נומק סטטית בלבד (לא הורץ, לא בוצע שום login/signup/write):** F1, F2, F3, F5
(למעט האישוש של `ensureProfile` שהוא קריאת קוד לא הרצה), F6, F7, F8, וכל שורה בטבלת
"מה נוסה ולא הצליח להישבר" מלבד #1.

## שלושת התוצרים

1. `docs/backend/security-review-2026-09-09.md` — המסמך הזה.
2. `docs/backend/security-fixes.sql` — SQL מוכן להדבקה, אידמפוטנטי, מסודר להרצה
   מלמעלה למטה; שני קטעים (F3, וחצי מ-F5) מסומנים במפורש כ-DEFERRED ומגיעים
   כהערות בלבד, כי הפעלתם דורשת שינוי תואם ב-`kupa-sgura.html` שלא בוצע. **לא הורץ.**
3. `tools/rls-probe.mjs` — סקריפט Node ללא תלויות; בדיקות read-only כברירת מחדל,
   ובדיקות write-path (הדגמת F1/F2 בפועל) מאחורי `--destructive` המכובה כברירת מחדל
   ומתועד כדורש חשבון חד-פעמי.

## לא נגעתי ב-`kupa-sgura.html`

כל שמונת הממצאים הם בעיות RLS/מדיניות טהורות — הלקוח הלגיטימי כבר שולח בדיוק את
מה שהתיקונים ממשיכים לאפשר (ראו ההערות בכל סעיף תיקון), כך שאין תיקון "טריוויאלי"
שדורש גם שינוי אפליקציה. F3 ו-F5(email) כן דורשים שינוי קליינט, אבל לא טריוויאלי
(הם שוברים מסך קיים / test קיים בלי תיאום), ולכן הושארו כהמלצה מתועדת בלבד, בהתאם
להנחיה "אם ממצא ניתן לתיקון טריוויאלי ב-kupa-sgura.html בלי לפגוע בהתנהגות המוצר —
תקנו גם שם; אחרת השאירו את קובץ האפליקציה בלי נגיעה."

---

## נספח (2026-09-09, מאוחר יותר): ההתנגשות בין F6 ל-`fix-upsert-policies.sql` — נבדקה, לא רק נומקה

**מה התגלה.** `security-fixes.sql` §F6 (לעיל) מחזיר חמש מדיניות בדיוק לניסוח שהיה
לפני `fix-upsert-policies.sql` — כלומר מסיר מהן את ענף ה-"או שאני היוצר" ש-
`fix-upsert-policies.sql` הוסיף. אותו ענף, לפי הכותרת של `fix-upsert-policies.sql`
עצמו, קיים כדי לפתור תקלת ייצור אמיתית: `commit 9eafade` (שורת commit: "fix: insert
new cloud rows instead of upserting them") תיעד ש-`upsert(rows, { onConflict: "id"
})` — המתורגם ל-`INSERT ... ON CONFLICT (id) DO UPDATE` — גרם ל-42501 על **כל** כתיבה
ראשונה של שורה חדשה בטבלאות `groups`/`group_members`/`invites`/`games`, לפני שתוקן.
כלומר: לכאורה, הסרת הענף מחזירה בדיוק את התקלה שהוא בא לתקן. המשימה הזו נדרשה
**לברר**, לא להניח, אם זה נכון עדיין מול קוד הלקוח כפי שהוא היום — ולא לסמוך על
הנוסח הקיים של §F6 (שכבר טען את אותה מסקנה) בלי לבדוק אותו.

**המנגנון (רמת ביטחון: גבוהה, מבוסס על שילוב של תיעוד PostgreSQL + שחזור אמפירי
שכבר תועד בקוד, לא על הרצת SQL חדשה — אסור למשימה הזו להריץ SQL מול הפרויקט).**
`INSERT ... ON CONFLICT DO UPDATE` הוא command יחיד שכפוף גם למדיניות ה-INSERT
**וגם** למדיניות ה-UPDATE של הטבלה — לא רק כש-conflict אמיתי קורה, אלא כתכונה
מובנית של איך Postgres אוכף RLS על הצורה הזו של statement (זה גם ההסבר העקבי
היחיד לתצפית המתועדת ב-`fix-upsert-policies.sql`: upsert של שורה **חדשה לגמרי**
נכשל ב-42501, לא רק upsert שבאמת התנגש בשורה קיימת). בנפרד מזה, ובנוסף לזה:
פונקציות `STABLE SECURITY DEFINER` שקוראות שוב לאותה טבלה שה-statement כותב אליה
(`app_is_group_admin` קוראת ל-`group_members`, `app_can_read_game`/
`app_is_active_group_member` קוראות בעקיפין לטבלת המשחק/החברות) לא רואות את השורה
שאותו statement עצמו עדיין באמצע כתיבתה — זו תופעת snapshot/MVCC ידועה היטב
סביב `ON CONFLICT DO UPDATE` ולא באג ב-Postgres. שני האפקטים יחד: ענף שנקרא ישירות
מעמודות השורה החדשה עצמה (כמו `created_by = app_current_profile_id()`) לא סובל
מהבעיה בכלל, כי WITH CHECK תמיד רואה את ערכי השורה המוצעת ישירות, בלי שאילתה חוזרת.

**מה נבדק בפועל מול `kupa-sgura.html` (לא רק נקרא, גם עוקב אחרי הזרימה).**
`CLOUD_INSERT_ONLY` (`kupa-sgura.html`, סביב `// ---------- cloud store (Supabase)
----------`) מכיל אך ורק `entries`/`transfers`/`debts` — **כל חמש** הטבלאות
שהתיקון ב-§F6 נוגע בהן (`groups`, `group_members`, `invites`, `games`,
`game_participants`) נמצאות מחוץ למפה הזו, ולכן עוברות דרך הענף השני של
`pushCloudRun()`, שקורא ל-`splitCloudWrites(upserts, known, "id")` **לפני** כל
כתיבה. שורה שה-`id` שלה לא ב-`known` (הבסיס המאושר — אך ורק תוצאה של push קודם
שהצליח, או של pull שקרא אותה בפועל מהשרת; לעולם לא כתיבה מקומית אופטימית) יוצאת
כ-`.upsert(rows, { onConflict: "id", ignoreDuplicates: true })`, ש-PostgREST
מתרגם ל-`INSERT ... ON CONFLICT (id) DO NOTHING` — צורה שלא מפעילה מדיניות UPDATE
בכלל (דורשת רק הרשאת INSERT). רק שורה שכבר **ב-`known`** — כלומר כבר הוכחה כקיימת
בשרת — יוצאת כ-upsert אמיתי שנוגע במדיניות UPDATE, ובשלב הזה השורה כבר commit-
ה בטרנזקציה קודמת ונפרדת (כל קריאת `.upsert()`/`.select()` היא בקשת HTTP/
statement נפרד ש-`pushCloudRun()` ממתין לו (`await`) ברצף), כך שהפונקציות
`STABLE SECURITY DEFINER` קוראות אותה כמו כל קריאה רגילה. נבדקו גם מסלולי retry
(`classifyCloudError`/`cloudBackoffDelay`, ראו `.superpowers/network-resilience-
report.md`) ו-first-device seeding (`enterCloudMode` מאפס את `lastPushedRows`
ל-`null`): בשום מסלול `known` לא מתמלא משורה שלא אושרה בפועל, ולכל ארבעת קריאות
ה-`.upsert(` הקיימות בקובץ כולו (נבדק ב-grep ממצה) יש חשבון — אין נתיב שעוקף את
`splitCloudWrites` עבור אחת מחמש הטבלאות האלה. `game_participants_update` שונה
מהותית מהארבע האחרות: `app_can_write_game()` (הפונקציה שהמדיניות שלו מבוססת
עליה) קוראת לטבלת `games` — טבלה **אחרת** מזו שנכתבת — ותמיד הייתה "upsert-safe"
מעצמה, גם לפני `fix-upsert-policies.sql`; הענף שהוא הוסיף שם היה redundant בלבד
(כבר מתועד ב-§F2 למעלה), לא תיקון אמיתי לבעיה הזו.

**מסקנה.** גוף חמש המדיניות ב-§F6 **לא שונה** בעקבות הבדיקה הזו — הניסוח שכבר היה
שם (חזרה לגרסה שלפני `fix-upsert-policies.sql`, בלי ענף creator) נכון ובטוח
להרצה, בתנאי שקוד הלקוח ממשיך להיראות כפי שהוא נבדק כאן. מה שכן נוסף: הערה צמודה
לכל אחת מחמש המדיניות ב-`security-fixes.sql` שמסבירה במפורש *למה* היא upsert-safe
בלי הענף, שתי הערות תיעוד ב-`kupa-sgura.html` (ליד `CLOUD_INSERT_ONLY` וליד
`splitCloudWrites`) שמזהירות מפורשות נגד העברת אחת מהחמש למסלול upsert גולמי,
וכלי `tools/rls-introspect.sql` (read-only בלבד) שמאפשר לוודא מה **בפועל** רץ
במסד לפני הרצת `security-fixes.sql` ואחריה.

**אזהרה לקורא עתידי — אל תשחזרו את ענף ה-creator.** אם `42501` יחזור על כתיבה
ראשונה של שורה חדשה **אחרי** הרצת §F6, החשד הראשון צריך להיות **שינוי בצד
הלקוח** — מישהו הוסיף אחת מחמש הטבלאות ל-`CLOUD_INSERT_ONLY`, או כתב upsert גולמי
שעוקף את `splitCloudWrites` — ולא "חסר ענף creator ב-SQL". הרצת
`tools/rls-introspect.sql` (בלוק 3) מראה מיד אם הענף אכן נעדר מהמדיניות החיות;
אם הוא נעדר וה-42501 עדיין קורה, התקלה היא בקוד הלקוח, ותיקון הבעיה הוא לתקן
את הלקוח כך שיחזור להשתמש ב-`splitCloudWrites` — **לא** להחזיר הרשאת יוצר קבועה
שפותחת מחדש את F6 (יוצר שהודח נשאר בעל שליטה לצמיתות).

---

## F3 — סגירה (2026-09-10): `docs/backend/player-boundary.sql`

**המנגנון.** `entries_select`/`game_participants_select` צומצמו מ-"כל חבר פעיל
בקבוצה של המשחק" ל-"מי שהוא בעצמו משתתף **במשחק הזה בדיוק** (`app_is_game_participant`),
או היוצר שלו" — אותו תיקון שהיה כתוב ומוער ב-`security-fixes.sql` §F3 (deferred), הופעל
כעת במיגרציה נפרדת משלו (`player-boundary.sql`) כדי לא לגעת בקובץ שכבר רץ בפרודקשן.
`game_results_v` לא נגעה — היא `WITH (security_invoker = true)`, כלומר יורשת את אותה
הגבלה אוטומטית מ-`entries`/`game_participants` בלי צורך בשינוי ה-GRANT שלה.

**חלופות שנשקלו ונדחו** (מפורטות בהערת הכותרת של `player-boundary.sql`):
עמודה-ברמת-GRANT/REVOKE נדחתה כי הלקוח שולף `select=*` בכל מקום — חיסום עמודה שובר
כל קריאה, לא רק את הדולפת. View עם `SECURITY DEFINER` שמחליף את הטבלאות נדחה
ספציפית לממצא הזה — הוא היה שובר את ה-realtime של מסך המשחק הפתוח
(`postgres_changes` על `game_participants`/`entries`), בלי תועלת פרטיות נוספת
(מי שכבר יושב סביב השולחן רשאי לראות זה את זה).

**האם התיקון חל גם על היסטוריה סגורה, או רק על משחק פתוח — ולמה.** חל על שניהם,
בכוונה. הממצא המקורי (§F3 למעלה) הראה בפירוש ש-`entries_select`/`game_participants_select`
לא הבחינו בין `phase` פתוח לסגור, ו-`pullCloud()` מושכת ילדים גולמיים לכל משחק סגור
בכל קבוצה בדיוק כמו לכל משחק פתוח — אין בקוד הלקוח שום קריאה נפרדת "רק לצופה". החלת
התיקון רק על משחקים פתוחים הייתה משאירה את כל ה-**היסטוריה** הסגורה (הנתונים שבאמת
כבר נשמרים לתמיד) חשופה במלואה — הפער החשוב ביותר שהממצא הצביע עליו.

**מה זה שובר, ומה לא.** מי שבאמת שיחק במשחק (פתוח או סגור) — משתתף אמיתי — ממשיך
לראות הכול על אותו משחק בלבד, בדיוק כמו היום; שום regression על מסך המשחק הפתוח
או על מסך הסגירה. מה שכן משתנה: `pullCloud()` כבר תמיד משכה entries/game_participants
גולמיים לכל משחק **בכל** קבוצה שהמשתמש חבר בה כדי לחשב מקומית את היסטוריית/ליגת
הקבוצה (`buildHistoryEntryFromCloud`, `toGroupGameSummary`, `buildLeaderboard`) —
זו בדיוק תלות שקיימת בקוד היום, ומתועדת גם ב-F3 המקורי. אחרי ההרצה, כל משחק
שהצופה לא שיחק בו יחזיר **אפס שורות** ל-`entries`/`game_participants` שלו (RLS חוסם
לחלוטין, לא חלקית) — ובלי שינוי בלקוח זה היה מרנדר שורת "0 שחקנים" מקולקלת
בהיסטוריית הקבוצה, או (במקרה של משחק פתוח) מאמץ בטעות שולחן זר ריק כמשחק הנוכחי
של המכשיר.

**שינוי הלקוח (`kupa-sgura.html`).** נוספה פונקציה טהורה אחת,
`cloudGameChildrenAreTrustworthy(gameRow, participantRows, viewerProfileId)`, שמבחינה
בין "0 שורות כי המשחק ריק לגמרי ואני היוצר" (שולחן ריק אמיתי, `isEmptyOpenGame`)
לבין "0 שורות כי ה-RLS חסם" (כל מקרה אחר) — ושני מקומות המיזוג ב-`applyCloudPull`
(בניית `history` מ-`closedGames`, ובניית `openCandidates` מ-`openGames`) עוברים
דרכה במקום לבדוק ריקות בעצמם. משמעות בפועל: **החזרה הבטוחה ביותר היא השמטה, לא
רינדור שגוי ולא דליפה** — היסטוריית קבוצה מדלגת כרגע על משחקים שהצופה לא שיחק בהם
(פחות שלמות, אך בלי דליפה ובלי קלקול), עד לשינוי ה-frontend המתואם המלא.

**מה עדיין לא תוקן, בכוונה — ולמה זה סבב נפרד.** מסכי ליגה/היסטוריה של קבוצה
(`getGroupSummaries`, `buildLeaderboard`, `toGroupGameSummary`) עדיין מחשבים
net/מנצחים/pot **מקומית**, מתוך שורות גולמיות שנשלפות מהשרת — לא מה-views הבטוחים
שכבר קיימים (`group_leaderboard_public_v`, `my_group_stats_v`), ולא מ-view מצטבר
בטוח שקול-מבנה ל-`GroupGameSummary` (שם/תאריך/כמות שחקנים/מנצחים/pot/דגל-איזון,
בלי כסף לפי שחקן) שעדיין לא נכתב. חיבור הלקוח ל-views הבטוחים האלה — או כתיבת
view/RPC בטוח נוסף לתקציר משחק קבוצתי — הוא שינוי frontend מתואם ולא תיקון SQL
בן-יום; זה מה שמחזיר את השלמות שהוקרבה כרגע (משחקים חסרים בהיסטוריה) בלי לפתוח
מחדש את הדליפה. ראה `.superpowers/player-boundary-report.md` לתוכנית המלאה.

**בדיקה.** `tools/rls-probe.mjs --destructive` נרחב בסעיף 5 החדש: חשבון A יוצר
קבוצת בדיקה, מוסיף את חשבון B כחבר פעיל (בלי הסכמתו — פער נפרד וידוע, משמש כאן
רק כתשתית לבדיקה), משחק משחק יחיד בתוך הקבוצה (B לא משתתף), ומנסה לקרוא כ-B את
`game_participants`/`entries` של אותו משחק — לפני התיקון מצופה `200` עם שורות
(F3 מאושש), אחריו `200` עם מערך ריק. לא הורץ מול הפרודקשן החי על ידי הבדיקה
הזו — נדרשים שני חשבונות חד-פעמיים כפי שמתועד בכותרת הקובץ.
