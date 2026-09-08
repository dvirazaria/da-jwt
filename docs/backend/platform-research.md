# מחקר פלטפורמת Backend — "סוגרים קופה"

תאריך: 2026-09-08. סטטוס: מסמך החלטה, ממתין לאישור הבעלים. לא נכתב קוד אפליקציה.
נבדק מול: `HANDOFF.md`, `docs/superpowers/plans/2026-09-07-groups-foundation.md` (Task 0 audit),
וה-typedefs בסקשן `groups domain (pure)` ב-`kupa-sgura.html`.

---

## 1. סיכום מנהלים

1. **ההמלצה: Supabase** — התוכנית הקודמת ב-`HANDOFF.md` נכונה, ומתחזקת אחרי בדיקה: Postgres סטנדרטי, RLS שהוא Postgres policies רגילות, Realtime, ו-JS client שנטען מ-CDN בלי bundler.
2. **התיקון היחיד לתוכנית**: לא להתחיל עם phone OTP. SMS לישראל דרך Twilio עולה **$0.2575 להודעה** — יקר מדי ובלתי מוגן מפני abuse. להתחיל עם **Google OAuth + email OTP**, ולהשאיר טלפון כדגל עתידי.
3. **שתי מלכודות שחייבות טיפול ביום הראשון**: פרויקט Free נעצר אחרי **7 ימי חוסר פעילות** (צריך cron ping), וה-SMTP המובנה מוגבל ל-**2 מיילים בשעה** (חוסם email OTP — חובה SMTP חיצוני).
4. **Lock-in נמוך באמת**: `pg_dump` אחד מוציא את הסכימה, הנתונים, ה-policies וגם את `auth.users` — כי כל השכבה היא Postgres. זה היתרון שאף מתחרה בקטגוריה לא נותן.
5. **Runner-up: PocketBase בהרצה עצמית** — לבחור בו אם הבעלים מעדיף בעלות מלאה ובינארי אחד על פני שירות מנוהל, ומוכן לתחזק שרת ו-backup. עלות ~$2–5 לחודש, אפס תלות בספק.

---

## 2. טבלת השוואה

| | Free tier (2026-09-08) | Auth | Realtime | הרשאות | Lock-in | שילוב בדף סטטי | תפעול | סיכונים |
|---|---|---|---|---|---|---|---|---|
| **Supabase** | 500MB DB, 50K MAU, 5GB egress, 200 realtime conns, 2M הודעות, 2 פרויקטים | Google/OAuth, email OTP, magic link, phone OTP (ספק SMS משלך) | Postgres Changes + Broadcast + Presence, ערוצים פרטיים עם RLS | RLS של Postgres — ביטוי מלא של "חברי קבוצה בלבד" | **נמוך** — Postgres + OSS מלא | ESM מ-jsDelivr/esm.sh, גם UMD | אפס שרת | pause אחרי 7 ימים; Frankfurt (~60–80ms); SMTP מובנה 2/שעה |
| **Firebase** | 1GiB Firestore, 50K reads/יום, 20K writes/יום, 50K MAU, 10GiB egress | Google מצוין, phone OTP מובנה (בתשלום), magic link | Firestore listeners — מצוין | Security Rules (DSL קנייני) | **גבוה** — מודל דוקומנטים + API קנייני | script tag רשמי | אפס שרת | תקרות יומיות; כתיבה מחדש מלאה ביציאה; SMS $0.01–$0.46 |
| **PocketBase** | חינם (הקוד); עלות ה-hosting בלבד | OAuth2 15+, email OTP; phone לא native | SSE מובנה, 10K+ חיבורים על חומרה צנועה | API rules per-collection (DSL משלו, SQL-like) | **נמוך-בינוני** — SQLite + הקוד שלך | UMD מ-jsDelivr — הכי פשוט | **אתה השרת** | volunteer project, גרסה 0.x; backup עליך |
| **Appwrite Cloud** | 5GB bandwidth, 2GB storage, 75K MAU, 250 realtime conns, 2 פרויקטים | OAuth, email OTP, magic URL, phone OTP (Twilio/Vonage וכו') | Realtime מובנה | Permissions per-document + Teams | **בינוני-גבוה** — API קנייני, אין SQL | SDK דרך CDN | אפס שרת | pause אחרי 7 ימים; חברה קטנה יחסית |
| **Nhost** | 1GB DB, 1GB storage, 5GB egress, **פרויקט אחד** | OAuth, email, magic link, 2FA; **אין phone OTP** | GraphQL subscriptions (Hasura) | Hasura permissions (JSON) | **בינוני** — Postgres מתחת, Hasura מעל | דרך CDN | אפס שרת | פרויקט יחיד; pause אחרי 7 ימים; חברה קטנה |
| **Convex** | 0.5GB DB, 1M function calls, 1GB egress, 1GB files | Convex Auth (**beta**), Clerk, Auth0, WorkOS | מצוין — reactive queries by design | פונקציות server-side, לא RLS | **הכי גבוה** — runtime + query API קנייניים | דורש בפועל TS/bundler — **נוגד את ארכיטקטורת הקובץ היחיד** | אפס שרת | יציאה = כתיבה מחדש של כל שכבת הנתונים |
| **Neon/Turso + Vercel Functions + Auth.js** | Neon: 0.5GB, 100 CU-hours; Turso: 5GB, 500M קריאות; Vercel Hobby: 1M invocations, 4 CPU-hrs | Auth.js — אתה מרכיב הכל | **אין** — צריך לבנות (polling/SSE/Pusher) | קוד שאתה כותב בכל endpoint | **הכי נמוך על ה-DB, הכי גבוה על הקוד שלך** | צריך API layer משלך | אתה מתחזק API + auth + realtime | הכי הרבה עבודה לתחזוקן יחיד |
| **InstantDB** | — | — | — | — | — | — | — | **פסול: הענן נסגר ב-31.8.2027** |

---

## 3. ניתוח לכל מועמד

### Supabase — הבחירה
Postgres מנוהל עם PostgREST, GoTrue (auth), Realtime ו-Storage מעליו, כולם open source.
ה-Free tier (נבדק 2026-09-08): 500MB DB, 50,000 MAU, 5GB egress, 200 חיבורי realtime במקביל,
2M הודעות realtime, 1GB אחסון קבצים, 2 פרויקטים פעילים.
ה-RLS הוא בדיוק מה שהאפליקציה צריכה: `"member of group"` הוא `EXISTS (SELECT 1 FROM group_members ...)`,
ו-`"רק ה-P&L שלי"` הוא `debtor_user_id = auth.uid()`. שום DSL קנייני.
Realtime תומך בערוצים פרטיים עם policies על `realtime.messages` — בדיוק מודל "רק חברי הקבוצה רואים את המשחק החי".
טעינה בדף סטטי: `import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'` בתוך `<script type="module">`
(ה-`+esm` של jsDelivr סובל מבאג ידוע עם default imports; esm.sh הוא ה-workaround המקובל, ויש גם build של UMD).
המפתח שנכנס ל-HTML הוא `sb_publishable_...` — מתוכנן להיחשף בקליינט, וה-RLS הוא מה שמגן.
יציבות: גיוס Series F של $500M לפי שווי $10.5B (יוני 2026), ~$170M ARR, ~240 עובדים.
**חסרונות אמיתיים**: אין region בישראל (Frankfurt `eu-central-1` הכי קרוב); pause אחרי 7 ימי שקט;
SMTP מובנה 2 מיילים בשעה; המפתחות ה-legacy (`anon`/`service_role`) יוצאים משימוש עד סוף 2026 — להתחיל ישר עם החדשים.

### Firebase (Firestore + Auth)
הכי בשל, ה-phone OTP הכי חלק, טעינה מ-script tag רשמית. אבל: המודל הוא דוקומנטים, לא טבלאות —
החישוב `sum(buyins) - cashout` והצטברות ה-`entryLog` היו הופכים ל-aggregation ידני, וה-Security Rules הן DSL
שלא ניתן להעביר לשום מקום. תקרות ה-Spark יומיות (50K reads, 20K writes) — משחק חי עם 8 שחקנים
ו-listeners פתוחים שורף reads מהר. יציאה מ-Firestore = כתיבה מחדש של כל שכבת הנתונים. **נפסל על lock-in.**

### PocketBase — ה-runner-up
בינארי Go יחיד + SQLite, עם auth (15+ ספקי OAuth2), realtime דרך SSE, קבצים ופאנל אדמין.
ה-SDK הוא היחיד שנטען כ-UMD אמיתי בשורה אחת: `<script src="https://cdn.jsdelivr.net/npm/pocketbase@0.26.4/dist/pocketbase.umd.min.js">` —
מתאים מושלם לארכיטקטורת הקובץ היחיד. ההרשאות הן API rules per-collection בסינטקס SQL-like
שמבטא היטב "חבר בקבוצה". Hosting: Fly.io ~$2.02/חודש ל-shared-cpu-1x 256MB + $0.15/GB volume
(אין free tier אמיתי, כרטיס אשראי חובה), Railway Free נותן רק $1 קרדיט לחודש — כלומר בפועל VPS זול.
**למה לא ראשון**: אתה השרת. אתה ה-backup. גרסה 0.x בפרויקט מבוסס-מתנדבים, ו-SQLite על דיסק אחד
בלי replication. לתחזקן יחיד שעובד דרך agents זה עוד משטח תפעולי. **לבחור בו אם**: ה-pause של Supabase
מעצבן, או שהבעלים רוצה בעלות מלאה על הבינארי והקובץ.

### Appwrite Cloud
Free נדיב יחסית (75K MAU, 750K executions), phone OTP עם ספקים חיצוניים, realtime מובנה.
אבל ה-API והרשאות ה-per-document הם קנייניים; אין SQL; ה-schema לא נשלף כ-`pg_dump`.
היציאה דורשת ייצוא JSON וכתיבה מחדש של שכבת השאילתות. גם כאן pause אחרי שבוע.
**נפסל**: אותם חסרונות של Supabase, בלי היתרון של Postgres.

### Nhost
Postgres + Hasura + GraphQL. Free: 1GB DB, 5GB egress, **פרויקט אחד בלבד**, pause אחרי שבוע.
אין phone OTP. ה-Postgres שמתחת נייד, אבל כל שכבת ה-GraphQL וה-permissions היא Hasura —
כלומר יציאה = כתיבה מחדש של כל השאילתות. חברה קטנה משמעותית משאר הרשימה. **נפסל.**

### Convex
טכנית מרשים — reactive queries שמתעדכנות לבד, בלי לנהל channels. אבל: השאילתות הן פונקציות
TypeScript שמתפרסמות ל-runtime של Convex. זה **דורש build step**, וזה חוסם ישירות את הכלל
"קובץ HTML אחד, בלי bundler, בלי React/Vite" ב-`CLAUDE.md`. ה-auth המובנה עדיין **beta**.
ה-lock-in הוא הגבוה ביותר ברשימה. **נפסל על ארכיטקטורה.**

### Neon / Turso + Vercel Functions + Auth.js
ה-lock-in הנמוך ביותר על הנתונים (Neon = Postgres רגיל; Turso = SQLite). Neon Free: 0.5GB לפרויקט,
100 CU-hours, 5GB egress, scale-to-zero אחרי 5 דקות. Turso Free: 5GB, 500M row reads, 10M writes.
אבל שום דבר מזה לא מגיע עם auth, בלי permissions ובלי realtime — צריך לכתוב serverless API,
להרכיב Auth.js, ולבנות realtime מאפס (polling/SSE/Pusher). זו הרבה יותר עבודה ויותר קוד לתחזק,
לתחזקן יחיד שעובד דרך agents. שים לב גם ש-**Vercel Hobby מוגבל לשימוש לא-מסחרי**.
**נפסל על מורכבות** — למרות שהוא הזוכה בקריטריון lock-in.

### InstantDB — פסול
ב-22.8.2026 הצוות עבר ל-OpenAI. הרשמות חדשות נסגרו, **כל אפליקציות הענן נכבות ב-31.8.2027**,
גיבויים נשמרים עד 31.8.2028. הקוד נשאר open source לself-hosting. לא מועמד.

---

## 4. המלצה מפורטת

**Stack:** Vercel (static, כמו היום) + Supabase Free ב-`eu-central-1` (Frankfurt) + supabase-js מ-esm.sh.
**Auth:** Google OAuth כברירת מחדל + email OTP (קוד בן 6 ספרות, לא magic link) כגיבוי. Phone OTP — לא עכשיו.

**למה email OTP ולא magic link:** באפליקציה מותקנת ל-home screen, לחיצה על לינק במייל פותחת דפדפן
חיצוני ומאבדת את ה-session של ה-PWA. קוד שמעתיקים ומדביקים נשאר בתוך האפליקציה. זה גם מתיישב
עם התבנית הקיימת של "שני שלבים inline" במקום form submit.

**למה לא phone OTP עכשיו:** Twilio לישראל = **$0.2575 להודעה** (מספר ישראלי $15/חודש; alphanumeric sender ID חינם).
Supabase לא מוכר SMS — אתה מביא חשבון Twilio/MessageBird/Vonage/TextLocal משלך. 20 חברים ×
2 התחברויות בשנה זה $10, אבל loop של retry או abuse הוא חשבון פתוח. אפשר להוסיף מאוחר יותר
כשיש rate limiting ותקציב.

**Realtime למשחק החי:** ערוץ פרטי אחד למשחק, `game:{gameId}`, עם Postgres Changes על טבלאות
`entries` ו-`game_players` מסוננות ב-`game_id`. זה מחליף את `remoteBody`/`applyRemote`/`scheduleRemoteSave`
**וגם משנה את המודל**: היום הסנכרון הוא מסמך שלם עם last-writer-wins, וזה שגוי כששמונה אנשים
עורכים את אותו משחק. המעבר הוא ל-append של אירועים (`entries` הוא append-only ממילא, בדיוק כמו
ה-`entryLog` הקיים) — וזה נופל בול על מודל הנתונים שכבר קיים.

**מה לשמור עין עליו:**
- **pause אחרי 7 ימים** — קבוצת פוקר יכולה לא לשחק שבועיים. חובה cron ping (סעיף 6).
- **2 מיילים בשעה** מה-SMTP המובנה — חוסם email OTP בפועל. חובה SMTP חיצוני מהיום הראשון.
- **200 חיבורי realtime במקביל** — 25 שולחנות פעילים בו-זמנית ב-8 שחקנים. תקרה אמיתית רק בהצלחה גדולה.
- **egress 5GB** — הצוואר האמיתי, לא גודל ה-DB. ראה חישוב למטה.
- **Frankfurt** — ~60–80ms RTT מישראל. לא מורגש באפליקציה הזו; היה מורגש במשחק בזמן אמת.
- **Vercel Hobby לא-מסחרי** — אם האפליקציה אי פעם גובה כסף, זה $20/חודש.

**מסלול עלות משוער** (הנחות: משחק ≈ 8 שחקנים, ~30 entries, ~5KB עם אינדקסים; ~50 משחקים לשנה לקבוצה;
~100KB egress לשחקן למשחק כולל realtime):

| משתמשים | DB לשנה | egress לשנה | מסקנה | עלות/חודש |
|---|---|---|---|---|
| 100 | ~30MB | ~0.5GB | בתוך ה-Free בנוחות | **$0** |
| 1,000 | ~310MB | ~5GB | על הקו של egress; DB בסדר | **$0** ואם הפעילות אמיתית — Pro $25 |
| 10,000 | ~3.1GB | ~50GB | חייב Pro (8GB disk, 250GB egress כלולים) | **$25–40** (Pro + compute Small; Pro כולל $10 קרדיט) |

התקציב ל-100 ול-1,000 משתמשים הוא **אפס**. המעבר ל-Pro כדאי כבר ב-1,000 לא בגלל מכסות אלא
בגלל ביטול ה-pause וגיבויים יומיים — $25 לחודש כדי לא לאבד משחק חי.

---

## 5. דרך היציאה

מה שנשאר נייד בלי לגעת בו: **הסכימה, הנתונים, ה-RLS policies, ומשתמשי ה-auth** — כולם Postgres.

1. **גיבוי**: `pg_dump --clean --if-exists -d "$SUPABASE_DB_URL" > kupa.sql`. זה מוציא גם את
   `public` (הנתונים שלך), גם את ה-policies, וגם את סכימת `auth` על `auth.users` ו-`auth.identities`.
2. **שחזור** ל-Neon / RDS / Postgres על VPS: `psql -d <target> -f kupa.sql`. הסכימה והנתונים חיים מיד.
3. **Auth**: יעד א' — Supabase self-hosted (docker-compose, GoTrue קורא את אותן טבלאות; מגבלה:
   אין branching, אין PITR מנוהל, אין backups מנוהלים). יעד ב' — מוצר auth אחר: ה-`id` הוא UUID רגיל,
   אז אפשר לזרוע את המשתמשים באותם UUIDs וכל ה-FK-ים ממשיכים לעבוד. **תנאי:** מהיום הראשון
   כל טבלה עסקית מפנה ל-`profiles.id`, ורק `profiles.id` מפנה ל-`auth.users.id`. נקודת ניתוק אחת.
4. **ה-API**: `supabase-js` הוא PostgREST + GoTrue + Realtime — כולם open source. גם אם עוזבים
   את הענן, אפשר להריץ בדיוק את אותו wire protocol ולא לגעת בקוד הקליינט בכלל.
5. **בידוד בקוד**: כל הקריאות ל-Supabase יושבות בסקשן אחד מסומן ב-`kupa-sgura.html`
   (`// ---------- backend adapter ----------`), מאחורי אותה תבנית adapters שכבר קיימת
   (`getActiveGameSummaries`, `getGroupSummaries`). החלפת ספק נוגעת בסקשן אחד, לא ב-UI.

מה שלא נייד ודורש עבודה: הגדרות ה-Auth בקונסולה (redirect URLs, ספקי OAuth) — יום עבודה,
ו-Realtime — ספק אחר ידרוש adapter אחר לאותו סקשן מבודד.

---

## 6. תוכנית התחברות — 5 הצעדים הראשונים

**צעד 1 — חשבון ומפתחות (הבעלים ידנית).**
לפתוח פרויקט Supabase בשם `kupa-sgura-prod`, region **Central EU (Frankfurt) `eu-central-1`**, תוכנית Free.
להעתיק שני ערכים: **Project URL** ו-**Publishable key** (`sb_publishable_...`). **לא** את ה-secret key —
הוא עוקף RLS ואסור שיצא מהמחשב. להוסיף את `https://poker-tau-pink.vercel.app` ל-Auth → URL Configuration.
*האייג'נט לא יכול לעשות את זה — נדרשת התחברות אנושית.*

**צעד 2 — מפתחות באתר סטטי (האייג'נט מכין, הבעלים ממלא).**
ה-publishable key **נועד** להיכנס ל-HTML הפומבי; מה שמגן הוא RLS, לא סודיות המפתח.
האייג'נט מכין בלוק const בראש ה-IIFE ב-`kupa-sgura.html`, והבעלים מדביק את שני הערכים.
כלל שנשאר: כל טבלה חדשה נוצרת עם `ENABLE ROW LEVEL SECURITY` **באותו commit** — טבלה בלי policy
עם publishable key היא נתונים פתוחים לעולם. בנוסף האייג'נט מוסיף בדיקה שדוחה `sb_secret_` בקוד
(הרפו הזה כבר הדליף מפתח פעם אחת — ראה `HANDOFF.md`).

**צעד 3 — סכימה ו-RLS (האייג'נט מכין, הבעלים מריץ).**
האייג'נט כותב `docs/backend/schema.sql` שממפה 1:1 ל-typedefs הקיימים:
`profiles`, `groups`, `group_members`, `invites`, `friendships`, `games`, `game_players`,
`entries` (append-only), `settlements`, `debts`, `audit_log` (insert-only, בלי update/delete policies).
ה-policies מבטאות שלושה כללים: חבר קבוצה קורא את הקבוצה; שחקן כותב רק את ה-entries של עצמו;
`debts` ו-net נחשפים רק ל-`auth.uid()` שהוא צד לחוב — כדי לקיים את כלל 10 בתוכנית הקבוצות
("אסור להציג P&L של אדם אחר"). הבעלים מדביק את הקובץ ל-SQL Editor ומריץ.

**צעד 4 — ערוץ realtime למשחק הפעיל (האייג'נט).**
`supabase.channel('game:' + gameId, { config: { private: true } })` + Postgres Changes על
`entries` ו-`game_players` מסוננות ב-`game_id`, ו-policies על `realtime.messages` שמגבילות את ה-topic
לחברי הקבוצה. זה מחליף את `remoteBody`/`applyRemote`/`scheduleRemoteSave`. **שינוי מודל מכוון**:
מ-last-writer-wins על מסמך שלם ל-append של אירועים, כי כמה טלפונים עורכים את אותו משחק.
ה-localStorage נשאר כ-cache ל-offline. **בנוסף**: workflow ב-GitHub Actions שדוגם endpoint קל
כל 3 ימים כדי למנוע pause — האייג'נט מכין את הקובץ, ואין בו סוד.

**צעד 5 — UX של auth (האייג'נט מכין, הבעלים מספק מפתחות).**
מסך ההתחברות הנוכחי (שם בלבד) הופך ל: "המשך עם Google" + "שלחו לי קוד למייל" (OTP בן 6 ספרות),
והשם שהוקלד נשמר כ-`profiles.display_name` — כך שכל ה-UI הקיים שמזהה לפי שם ממשיך לעבוד
בזמן המעבר. שני דברים שהבעלים חייב לעשות: (א) ליצור OAuth Client ב-Google Cloud Console
ולהדביק client id + secret בהגדרות Supabase; (ב) **לחבר SMTP חיצוני** (Resend/Postmark, free tier)
— בלי זה ה-OTP נחסם על 2 מיילים בשעה וזה לא יעבוד בכלל.
אחרי שה-auth חי, `ParticipantRef.userId` מפסיק להיות `null` ו-`isLeaderboardEligible` מתהדק
ל-`userId != null` בלי לגעת ב-UI — בדיוק כפי שתוכנן ב-Task 0 audit.

---

## 7. מקורות

כולם נבדקו ב-**2026-09-08**.

- Supabase pricing — <https://supabase.com/pricing>
- Supabase project pausing — <https://supabase.com/docs/guides/platform/free-project-pausing>
- Supabase API keys (publishable/secret, deprecation של legacy) — <https://supabase.com/docs/guides/api/api-keys>
- Supabase Realtime authorization — <https://supabase.com/docs/guides/realtime/authorization>
- Supabase auth rate limits (2 מיילים בשעה) — <https://supabase.com/docs/guides/auth/rate-limits>
- Supabase phone login (ספקי SMS) — <https://supabase.com/docs/guides/auth/phone-login>
- Supabase regions — <https://supabase.com/docs/guides/platform/regions>
- Supabase self-hosting — <https://supabase.com/docs/guides/self-hosting>
- supabase-js ב-CDN — <https://www.jsdelivr.com/package/npm/@supabase/supabase-js>, <https://github.com/orgs/supabase/discussions/41118>
- Supabase Series F / ARR — <https://sacra.com/c/supabase/>
- Firebase pricing — <https://firebase.google.com/pricing>
- Firebase auth limits — <https://firebase.google.com/docs/auth/limits>
- Appwrite pricing — <https://appwrite.io/pricing>
- Appwrite auth methods — <https://appwrite.io/blog/post/appwrite-auth-methods>
- Nhost pricing — <https://nhost.io/pricing>
- Convex pricing — <https://www.convex.dev/pricing>
- Convex auth (beta) — <https://docs.convex.dev/auth>
- InstantDB — הצוות ל-OpenAI, סגירת ענן — <https://www.instantdb.com/essays/instant_team_joins_openai>
- PocketBase FAQ — <https://pocketbase.io/faq/>
- PocketBase JS SDK — <https://github.com/pocketbase/js-sdk>
- Neon pricing — <https://neon.com/pricing>
- Turso pricing — <https://turso.tech/pricing>
- Fly.io pricing — <https://fly.io/docs/about/pricing/>
- Railway free tier 2026 — <https://www.saaspricepulse.com/tools/railway>
- Vercel Hobby plan — <https://vercel.com/docs/plans/hobby>
- Twilio SMS pricing Israel ($0.2575) — <https://www.twilio.com/en-us/sms/pricing/il>
