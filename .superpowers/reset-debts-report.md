# Sync dot corner placement + Reset/debts investigation — handoff

Branch: `worktree-agent-ac0d11abbc8dd8d2b`
Worktree: `/Users/dvirazaria/פוקר/.claude/worktrees/agent-ac0d11abbc8dd8d2b`
Base commit: `63f2b83` — "docs: record the full applied-SQL order and verification method"

## פריט 1 — מיקום נקודת הסנכרון (`#syncDot`)

**הבעיה:** הנקודה הטורקיזית הקטנה ישבה בתוך `.eyebrow`, בזרימה הרגילה של המסמך, מתחת ללוגו
(`.suits-mark`). זה מיקם אותה קרוב לקצה הימני של המסך אבל לא "בפינה" — היא הייתה נמוכה ב-25px
בערך מאשכול כפתורי הפינה (`.corner`, שמכיל את `#themeBtn`/`#resetBtn`).

**מה נבדק לפני שינוי:** מדדתי את המיקום בפועל דרך הדפדפן (`getBoundingClientRect`) לפני ואחרי,
כדי לא לנחש מספרים. המיקום המקורי היה `top: 62px` (ללא safe-area), אשכול הפינה מתחיל ב-`top: 6px`
— בדיוק כפי שהתיאור בבקשה תיאר ("להזיז למעלה בערך 25px").

**המכשול שהתגלה תוך כדי בדיקה:** הניסיון הראשון היה למקם את הנקודה `position: absolute` עם
`top: calc(37px + env(safe-area-inset-top, 0px))` יחסית לשורש המסמך (בדיוק כמו ש-`.corner`
עובד, בלי הורה עם `position` מוגדר). זה נראה נכון בתיאוריה, אבל בבדיקה בדפדפן חי המיקום בפועל
היה שגוי (`offsetParent` היה `HEADER`, לא השורש). הסיבה: ל-`<header>` יש `class="load-in"`
שמפעיל אנימציית כניסה (`animation: rise .5s ease both`) שמזיזה אותו עם `transform`. גם אחרי
שהאנימציה "נגמרת" ויזואלית, הערך המחושב של `transform` הוא `matrix(1,0,0,1,0,0)` — לא המילה
`none` — ולפי הספסיפיקציה של CSS, כל ערך `transform` שאינו `none` הופך את האלמנט ל-containing
block קבוע לצאצאים עם `position: absolute`. כלומר `<header>` הפך בטעות, ולצמיתות (לא רק בזמן
האנימציה), ל"עוגן" של הנקודה.

**הפתרון הסופי:** במקום להילחם בזה, אימצתי אותו במפורש: `header { ...; position: relative; }`
(שורה חדשה בכלל שכבר היה קיים), ו-`.dot` מקבל `position: absolute; top: -25px;
inset-inline-start: 18px;` — יחסית ל-`<header>` עצמו. מכיוון של-`<header>` יש קצה עליון יציב
וקבוע (תלוי רק ב-padding-top של `.wrap`, שכבר כולל `env(safe-area-inset-top, 0px)`, ובגובה
הלוגו/המרווח שמעליו — לא תלוי ב-view הנוכחי), ה-`-25px` הזה מייצר בדיוק את התוצאה המבוקשת: אותו
מיקום מקורי, מוזז 25px למעלה, בלי לשכפל את חישוב ה-safe-area, ובלי תלות באנימציה החד-פעמית.

**מה אומת בפועל (דפדפן, לא רק קוד):**
- מיקום סופי: `top: 37px` (עם safe-area=0), יציב גם 700ms אחרי טעינת הדף (אחרי שהאנימציה
  "מסתיימת" חזותית).
- שני הטיימים (כהה ובהיר) — נבדק חזותית עם צילום מסך ב-viewport נייד (375×812), הנקודה יושבת
  בפינה הימנית-עליונה בשני המצבים, בלי חפיפה עם `#themeBtn`/`#resetBtn` (הם בצד הפיזי השמאלי,
  `.corner { left: 18px }` מול `inset-inline-start: 18px` של הנקודה, שב-RTL הוא הקצה הימני —
  הצדדים הפיזיים מנוגדים במכוון, כפי שהיה גם לפני השינוי).
- כפתור `יעד מגע 44px` (`.dot::before`) לא נגע — נשאר `44px`/`44px`, ממורכז על הנקודה בכל מיקום.
- בדקתי ש-`.login .eyebrow { justify-content: flex-start; }` (שורה ~768) לא יכול להתנגש: יש
  בדיוק מופע אחד של `class="eyebrow"` בכל הדף, בתוך ה-`<header>` הראשי, ולא בתוך שום overlay עם
  `class="login"` — כלל ה-CSS הזה מת/לא פעיל כרגע, ולא מושפע מהשינוי.

**קבצים ששונו:** `kupa-sgura.html` — 3 מקומות: `.wrap` נשאר ללא שינוי (ניסיון עם
`position: relative` עליו בוטל כי לא היה נחוץ ולא פתר את הבעיה), הכלל `header { ... }` קיבל
`position: relative;`, והכלל `.dot { ... }` קיבל את המיקום המוחלט החדש. תיעוד ההחלטה נמצא
בתגובות שמעל שני הכללים.

**בדיקות:** `tests/sync-dot-position.test.cjs` — 2 טסטים (regex על המקור, כמו
`tests/suits-mark-centring.test.cjs`): (1) מצמיד `position: absolute`, `top: -25px`,
`inset-inline-start: 18px` על `.dot`, ושומר על יעד המגע 44px; (2) מוודא ש-`header` הוא
positioning context מפורש (לא תלוי באנימציה), ש-`.wrap` עדיין נושא את `env(safe-area-inset-top,
0px)` שממנו הנקודה יורשת את ההגנה, ש-`.corner` עדיין על `left: 18px` פיזי (הצד הנגדי), ושיש
מופע יחיד של `class="eyebrow"` בעמוד.

## פריט 2 — חובות אחרי Reset

**מה בודק `#resetBtn` בפועל (נקרא בקוד, לא הונח):** הכפתור מפעיל דפוס "armed" דו-שלבי (כמו כל
פעולה הרסנית באפליקציה), ובלחיצה השנייה מריץ:

```js
state = newCurrentGame(state, { phase: "closed" });
expandedEntries.clear();
openMenu = null; customOpen = null;
save();
setAppView("games");
```

`newCurrentGame(base, patch)` (שורה 3293) בונה slot חדש למשחק ("closed", ללא שחקנים), מסיר את
ה-slot הישן מ-`state.games`, ומחזיר `{ ...base, example: false, gameId, games }` — כלומר הוא
**פורס את כל שאר האובייקט (`base`) ללא שינוי**: `state.debts`, `state.history`, `state.groups`,
`state.groupMembers`, `state.invites`, `state.friendships` — כולם עוברים כמות שהם. שום קוד
בפונקציה הזו נוגע ב-`debts`.

**מה קורה בתצוגה אחרי Reset:** `save()` לא מרנדר בעצמו; `setAppView("games")` כן — היא קוראת
ל-`render()` בסוף (שורה ~5219). `render()` קורא ל-`renderProfile()` **ללא תנאי**, על כל render,
בלי קשר ל-`appView` הנוכחי (שורה 7238). `renderProfile()` מחשב `openDebts` ישירות מ-`state.debts`
בכל קריאה (`(state.debts || []).filter(debt => debt.status === "open")`, שורה 8321) — אין שום
מטמון/cache ביניים. כלומר: גם אם המשתמש היה עובר לטאב "חובות" בפרופיל מייד אחרי Reset, הנתונים
היו טריים לחלוטין.

**מה אומר התיעוד (`HANDOFF.md`, `CLAUDE.md`):** גם `HANDOFF.md` (סעיף על "An empty table is not
a game") וגם `CLAUDE.md` ("Behavior that must not regress") אומרים באופן מפורש ש-`newCurrentGame`
משמר `groups/history/debts`, ושרק `סגור שולחן` (`finishCloseTable`) יוצר רשומות חוב חדשות —
בדיוק העיקרון הזה.

**מסקנה:** זה **מכוון**, לא באג. Reset מוחק רק את השולחן הפתוח הנוכחי (שחקנים, buy-ins, מצב
settlement) — היסטוריה וחובות הן רשומות "סגורות" שכבר לא קשורות למשחק החי, ואמורות לשרוד איפוס
בדיוק כמו ש-DESIGN/HANDOFF דורשים. גם לא נמצאה בעיית תצוגה מיושנת (stale display) — הרינדור של
טאב החובות רץ בלי תנאי בכל render, כולל זה שמופעל מיד אחרי Reset.

**לא בוצע שום שינוי קוד** בעקבות הבדיקה הזו — לא ב-`#resetBtn`, לא ב-`newCurrentGame`, לא
ב-`renderProfile`. הכיסוי הקיים (`tests/empty-table.test.cjs`, סביב שורה 169-178) כבר מוודא
ש-`newCurrentGame` משמר `debts`/`history`/`groups`/`groupMembers` דרך אותו נתיב הקוד (השימוש
ב-`isEmptyOpenGame` בעת יציאה משולחן ריק), כך שלא נוסף טסט כפול לאותה עובדה.

## אימות

- `node --test tests/*.test.cjs` → 649/649 עוברים (647 בסיס + 2 טסטים חדשים).
- `git diff --check` → נקי.
- הסקריפט האחרון (`<script>`) נבדק עם `new Function(...)` → נפרס בהצלחה (404,667 תווים).
