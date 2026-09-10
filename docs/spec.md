# BKST App — Specification v1

Bal-Kishore Sevak Training · Alabama pilot

---

## 1. What this app is

A standing tracker for BKST delegates. It answers two questions:

- **Delegate:** am I meeting the program's requirements?
- **Karyakar:** who is at risk, and what needs my attention?

It also carries the programme for each session — the running order and the
meals — because a session runs three days at a centre people drive to, and
that information otherwise lives in a message nobody can find on the Saturday
morning. That is a deliberate widening of what the app is for.

It is not a motivation app. The program has hard requirements — 80% on session
grades, one excused absence per year — and the app exists to make compliance
visible before it becomes a dismissal.

### Scope

Six sessions per year: three in fall term, three in spring, roughly a month
apart. Each runs three days, Friday to Sunday, hosted at one center that the
whole cohort travels to.

**Fall 2026** — Sept 11–13 Birmingham, Oct 2–4 Montgomery, Nov 20–22
Birmingham. Spring dates are not set.

Twenty-five delegates across five Alabama centers: Birmingham 9, Dothan 9,
Montgomery 3, Huntsville 2, Mobile 2.

**In scope**
- Attendance, with a karyakar-controlled check-in window
- In-app quizzes (multiple choice, short answer, essay)
- Karyakar grading queue
- Homework upload (only on the 1–2 sessions that have homework)
- Delegate standing view
- Karyakar dashboard with attention flags

**Explicitly out of scope**
- Rank/tier progression — too much machinery for one mandal
- Niyam tracking — self-reported daily data goes stale by week three
- Behavior scoring — qualitative karyakar notes instead
- Parent access
- Sabha attendance — stays in BKMS, no integration
- School grades — cannot be verified, handled offline
- Quiz retakes — a low score stays a low score

---

## 2. Roles and auth

One login form for everyone: an ID and a PIN. The Worker looks up the ID,
determines the role, and routes from there. Delegates never see a karyakar
screen and are never told one exists.

### Delegate
- **Username:** BK ID (canonical, avoids name collisions and spelling variants)
- **Password:** 4–6 digit PIN the delegate sets on first login; length is the
  delegate's choice. Repeated (`1111`) and consecutive (`1234`) PINs are
  refused
- BK ID alone is not a secret — karyakars know it, it appears on forms — so it
  cannot serve as the password on an app that holds graded assessments
- Karyakar can reset a forgotten PIN
- Any device: phone, tablet, laptop. Encourage larger devices for essay sessions

### Karyakar
- **Username:** karyakar ID, `K`-prefixed so it can never collide with a BK ID
- **Password:** 4–6 digit PIN, same mechanism as the delegate side. Email and a
  long password were considered and rejected as too tedious to type at the
  start of every session
- Any karyakar can reset another karyakar's PIN. Log who did it and when
- **Role is checked server-side on every request**, not just at login. A
  delegate must not be able to reach karyakar data by changing a URL

### Credential storage

**PIN hashes never touch the Sheet.** A 4-digit PIN has only 10,000
possibilities, so a hash sitting in a spreadsheet is recoverable in under a
second by anyone who can open that spreadsheet — and karyakars can open it.

They live instead in a Cloudflare Durable Object, one per account, readable
only by the Worker. Durable Objects rather than KV because the same object
holds the failed-attempt counter: KV is eventually consistent, so rapid
increments overwrite each other and a lockout never trips.

Hashing is PBKDF2-SHA256 with a per-user random salt, at 100,000 iterations —
the ceiling the Workers runtime allows. Five failed attempts locks that ID for
15 minutes, which is the real defense against guessing a short PIN.

The Sheet holds roster and program data only. It never holds a credential.

### Accepted risk: first login

Whoever reaches an account first sets its PIN, and BK IDs are not secret. So
someone who knows a delegate's BK ID could claim that account before the
delegate does.

Accepted for the pilot rather than fixed. All twenty-five delegates log in at
session one, which closes the window almost immediately, and requiring a
karyakar to unlock each account first adds friction to the one session where
everyone is already busy. Revisit if the pilot grows past one mandal.

---

## 3. Data model

Google Sheet, one tab per table.

### delegates
| field | notes |
|---|---|
| bk_id | primary key, the BKMS ID from the application |
| first_name, last_name | |
| grade | high school grade, 9 to 12 |
| center | the delegate's home center — five of them, so this is real data from day one, not a placeholder |
| term_group | e.g. "Alabama 2026-2027" |
| active | false on dismissal or withdrawal |
| notes | free text, karyakar-only, qualitative |

### karyakars
| field | notes |
|---|---|
| karyakar_id | primary key, `K`-prefixed |
| first_name, last_name | |
| active | false when someone stops serving |
| created_at | |

No PIN column — credentials live in KV, per section 2.

### sessions
| field | notes |
|---|---|
| session_id | |
| term | fall / spring |
| session_date, session_end_date | a session spans three days |
| location | the host center |
| start_time | |
| checkin_state | closed / open / closed_manually |
| has_homework | most sessions: false |
| hw_due_date, hw_points | set by karyakar when creating the assignment |
| hw_created_by | |

### attendance
| field | notes |
|---|---|
| session_id, bk_id | |
| status | present / absent |
| absence_outcome | approved (excused) / denied (zero) / no_request (zero) |
| absence_number | counts every absence, approved or not — 2 ends participation |
| reason | delegate's stated reason |
| decision_note | karyakar's reason, shown to the delegate on denial |
| decided_by, decided_at | |
| source | self_checkin / karyakar_marked |
| marked_at, marked_by | |

**Written through a buffer.** A self check-in is recorded durably the instant
it is tapped and flushed to the Sheet a second later, with everyone else's, as
a single append. Google serialises writes to one spreadsheet, and twenty-five
people tapping at once measured at nine of them failing.

**Append-only.** Every check-in and every karyakar mark adds a row; nothing is
overwritten. Twenty-five delegates checking in within the same two minutes would
otherwise race on a read-modify-write and silently lose a tap. The Worker
reconciles on read — most recent row wins per (session_id, bk_id) — and the
duplicate rows are the audit trail.

Every other tab is one row per key.

### schedule
| field | notes |
|---|---|
| schedule_id | primary key |
| session_id | |
| day | 1, 2 or 3. The dates come from the session, so nobody retypes them |
| start_time, end_time | 24 hour, so it sorts. Shown as 12 hour. End may be blank |
| item | what is happening |
| presenter | optional |
| location | optional |
| is_meal | shown in gold, in the running order rather than on its own screen |
| note | |

Cue numbers and total time are not stored: one is row order, the other is end
minus start.

### absence_requests
| field | notes |
|---|---|
| request_id | primary key |
| session_id, bk_id | |
| reason | the delegate's own words |
| requested_at | |
| state | pending / approved / denied / cancelled |
| decided_by, decided_at | |
| decision_note | the karyakar's words; required to deny |

### questions
| field | notes |
|---|---|
| session_id, q_no | |
| type | mc / short / essay |
| question_text | |
| option_a…option_d | mc only |
| answer_key | correct option for mc; grading guidance for short/essay |
| points | |

Transcribed from the national PDF into the Sheet. Do **not** build a PDF parser
— the format isn't yours to control and a silent template change would corrupt
a graded quiz.

### responses
| field | notes |
|---|---|
| session_id, bk_id, q_no | |
| answer | selected option or text |
| points_awarded | auto for mc, karyakar-entered for short/essay |
| graded_by, graded_at | |

### submissions (homework)
| field | notes |
|---|---|
| session_id, bk_id | |
| file_url | Google Drive link |
| submitted_at | |
| status | submitted / late / missing |
| points_awarded | |

### scores
| field | notes |
|---|---|
| session_id, bk_id | |
| quiz_points, quiz_possible | |
| hw_points, hw_possible | null when session has no homework |
| session_grade | percentage |
| published | false until every question is graded |

---

## 4. Grading rules

- **Points, not percentages.** Every question carries points; essays get partial
  credit. Percentage is computed, never entered.
- **One points pool per session.** Session grade = points earned ÷ points
  available. Homework, when it exists, is simply more points in the same pool.
  There is no weighting to configure — a karyakar creates a homework assignment
  worth N points and the math absorbs it automatically.
- **80% threshold** applies to the session grade, whatever it's composed of.
- **A session with no quiz and no homework carries no grade.** Session one is
  like this. It counts for attendance and for the absence limit, but there are
  no points in its pool, so it is left out of the year's denominator entirely
  — the same treatment an approved absence gets.
- **An approved absence does not count toward the grade.** The session is
  excluded from the denominator entirely — a delegate with one approved absence
  is graded on five sessions, not six. A denied or unrequested absence records a
  zero, which does count.
- In the six-slot year bar, an approved absence displays as excused: its own
  neutral state, not a gap and not a miss.
- **Publish all at once**, when the last question of the session is graded.
  Delegates see "awaiting grade" until then, never a partial score creeping up.
- **No retakes.** A low score is displayed plainly, in red, with no alarm banner
  and no escalation — flagging something the delegate cannot act on is
  punishment on a screen.

---

## 5. Quiz flow

### Setup
Karyakar transcribes the national PDF into the questions tab: text, options,
key, points, type.

**Length:** 15–20 questions minimum. With 80% as a hard line and no retakes, a
10-question quiz means one badly worded item decides someone's session.

### Taking
- Karyakar opens the quiz window at end of session; closes it when done
- Multiple choice option order randomized per delegate
- **Answers saved on every tap** — a dead battery must not cost a grade that
  can't be retaken
- One attempt, submit at the end
- MC auto-grades on submit; short and essay route to the grading queue

### Grading — by question, not by delegate
Karyakar picks a question and sees every delegate's answer to it in one scroll,
with the answer key pinned at the top. Same headspace, repeated judgement:
faster and far more consistent than reading 25 complete quizzes.

Point entry is tap targets (0 / 3 / 5), not a number field.

### Fallback
If typed essays come back noticeably thinner than handwritten ones, split
delivery: MC and short answer in-app, essay on paper, karyakar enters just the
essay points. The grading queue already supports manually entered points, so
this costs nothing to support.

---

## 6. Attendance flow

**One check-in per session, not per day.** A session is a single unit for
attendance, grading, and the absence counter, however many days it runs.

1. Karyakar opens check-in for the session
2. Delegates tap check-in in the app while the window is open
3. Karyakar closes the window when the session starts
4. **Manual close** available in case a karyakar forgets
5. **Manual mark** for anyone arriving after the window shuts

### The check-in code

A delegate cannot check themselves in unless they have scanned the code shown
on a karyakar's screen. The open window alone is not enough — without this,
anyone could check in from home while it is open.

The code carries its own expiry, signed, and lasts thirty minutes. A karyakar
generates one, the screen draws it as a QR with a countdown, and it can be
saved as an image to print or project. Delegates scan it with their ordinary
camera app, which opens the app with the code in the URL; there is no scanner
built into the app, because iOS has no browser support for one.

This reverses the original decision to use no QR codes, which reasoned that "a
code with no time limit can be screenshotted and forwarded". This code has a
time limit. What it stops is checking in from elsewhere without ever having
seen the code. What it does not stop is someone deliberately relaying a live
code to a friend at home within the half hour, and a check-in window is
normally open for far less than that.

A delegate who cannot scan is marked by a karyakar. There is no typed
fallback: a code that can be read aloud can be read down a phone.

No punctuality tracking. It was a byproduct of timestamped scanning; without
that it isn't meaningful data.

### Absence requests

Delegates submit an absence ahead of a session with a stated reason. A karyakar
approves or denies it, from the Attention tab.

**Requests close when a session begins.** Someone taken ill that morning
phones a karyakar, who can excuse them after the fact. A delegate can cancel
their own request while it is still pending; once decided it is a karyakar's
to change.

**Approving records the excused absence immediately.** Denying records
nothing: section 6 says a delegate who is denied and turns up anyway gets a
normal grade, so a denial must not pre-mark anyone absent. If they then fail
to appear, closing the check-in window records it as denied — carrying the
karyakar's reason — rather than as a plain no-show.

Requests live in their own tab, not in `attendance`. A pending request is not
an absence and must not be counted as one.

| outcome | grade effect | counts toward dismissal |
|---|---|---|
| Approved | excluded from the grade | yes |
| Denied, delegate attends anyway | normal grade | no |
| Denied, delegate misses | zero for the session | yes |
| No request, no-show | zero for the session | yes |

**The counter and the grade track separate things.** Every absence counts toward
the two-absence limit regardless of outcome, but only an approved one is
excluded from the grade. A delegate can therefore be dismissed on a second
absence even though the first was approved.

**Denials must state a reason**, shown on the delegate's screen. A rejection
without an explanation is punishment; with one, it's a decision the delegate can
respond to by showing up.

**Retroactive excusing.** Real emergencies don't file paperwork in advance. A
karyakar can mark a session approved after the fact when someone gets sick that
morning.

**Displayed as "0 of 1"** — an allowance being spent, not a streak. This is the
highest-stakes number in the app, and karyakars must see it before a delegate is
surprised by it.

---

## 7. Homework flow

Homework is rare — one or two sessions a year. A karyakar creates the assignment
on a session when there is one, setting a due date and a points value. Sessions
without homework show nothing about it anywhere — no empty cards, no zero rows
in the queue.

Homework is **scored**, not just marked submitted, and its points join the
session's pool alongside the quiz.

- **Storage:** Google Drive via service account. Worker takes the upload, writes
  the file, stores the link in the Sheet. Karyakars grade from a Drive folder
  they already know how to use — no admin UI to build.
- **Accept images**, not just PDFs. Most submissions will be a phone photo of
  handwritten work. PDFs and Office files too. Cap ~20MB.
- **Rename server-side:** `session04_dhruv-patel_2026-03-21.pdf`. Never keep the
  delegate's filename — the folder should sort itself.
- **No in-app preview.** Link out; the phone renders it.
- **One submission per delegate per session**, replaceable until the deadline.
- The submitted / late / missing **state** matters more than the file. The file
  is evidence attached to the state.

---

## 8. Screens

One login screen serves both roles. What you see afterwards is decided by the
Worker, not by the address you type.

### Delegate — one screen, no tabs

Nothing on it is crowded, so splitting it would mean tapping to reach things
currently visible at a glance. Revisit when grades give it real content.

1. **Login** — BK ID + PIN; first-login PIN set
2. **Your year**
   - Absence allowance, "0 of 1", turning gold once spent
   - Next session card: dates, location, a countdown, and the check-in button
     when the window is open and a code has been scanned
   - Request an absence, or cancel one still pending
   - Six session slots as a bar row — three scheduled, three marked spring
   - Session list; a denial shows the karyakar's reason here, not behind a tap
3. **Session detail** — one session: what you are marked, the reason if any,
   and the request flow for that session
4. **Quiz** (phase 2), **Homework upload** (phase 3)

Grades are deliberately absent until scores exist. A standing headline on the
basis of nothing is worse than no headline.

### Karyakar — four tabs

1. **Sessions** — the three cards, then one session:
   - Open/close check-in, live count, roster grouped by centre
   - Generate the check-in code, shown as a QR with a countdown, savable
   - Tap a name to mark present, excused, or absent
   - Open/close quiz (phase 2)
2. **Delegates** — searchable directory; tapping someone gives their history
   across every session, their absence count, and PIN reset. Reaching a person
   should not require opening a session
3. **Scores** — manual entry, and later the grading queue (phase 2) and the
   homework queue (phase 3)
4. **Attention** — needs-attention dashboard, badged with what is waiting
   - Absence requests to decide
   - Absence used, red at the second one because that ends participation
   - Below 80% and missing homework arrive with grades; the section is absent
     rather than empty, because an empty section promises something the app
     cannot yet do
   - Red for real consequences, gold for worth-a-word

---

## 9. Visual design

Aligned to the ādarsh brand from the parent orientation deck, not the maroon KST
logo. Reason is functional as well as brand: maroon sits too close to red, and
red is doing real work in this app (below 80%, absence warnings). Brand color
and error color must not be cousins.

| role | value |
|---|---|
| Navy — brand, structure, primary actions | `#1E3A5F` |
| Cream — page surface | `#FAF3E3` |
| Gold — small highlights, soft warnings | `#E8DBB8` bg / `#7A5C14` text |
| Red — problems only | `#F6DCDC` bg / `#8E2A2A` text |
| Green — passing | `#DCEDE2` bg / `#2F6B4F` text |
| Muted text | `#7A6E52` |
| Hairline | `#E0D5B8` |

The maroon KST logo lives on the splash screen, login, and about page.

**Typography:** serif for headlines, names, and questions; clean sans for UI and
answers. That split is most of what makes it look considered rather than
templated.

**Principles**
- One action-colored element per screen
- Every warning names its remedy, or isn't shown at all
- Lateness and other soft signals go to karyakars, never as a mark on a
  delegate's screen
- Generous whitespace, hairline borders, no gradients or shadows

---

## 10. Build order

**Phase 1 — usable at the next session**
Auth, roster, attendance with check-in window, manual score entry.
This alone replaces the current process. Build the karyakar side first and well
— it's the real product.

**Phase 2 — quizzes**
Question tab, delegate quiz UI with autosave, MC auto-grading, grading queue.

**Phase 3 — homework**
Drive upload, submission states, homework points. Can be deferred entirely if
the first homework session falls in spring.

**Phase 4 — nice to have**
Practice mode, weekly karyakar digest, add-to-calendar, end-of-year summary
for each delegate.

---

## 11. Open items

### Resolved

- **Weighting** — no weights. One points pool per session; homework adds points
  to it. Karyakar creates the assignment when there is one.
- **Homework grading** — scored, and it affects the session grade.
- **National permission** — not a blocker. The program previously ran these
  quizzes through Google Classroom; the app replaces a tedious workflow rather
  than introducing a new one.
- **PIN resets** — any karyakar can reset any delegate's PIN, and any other
  karyakar's. Log who did it and when.

- **Excused absence** — excluded from the grade entirely, not recorded as a
  zero. Delegate is graded on sessions attended. The 80% applies per session.

- **Absences** — delegate requests with a reason, karyakar approves or denies.
  Approved is excluded from the grade; denied or unrequested carries a zero.
  Every absence counts toward the two-absence limit regardless. Karyakars can
  excuse retroactively for emergencies, and denials must state a reason.

### Still open

None. All policy questions are resolved.

## 12. Known risks

- **The question bank is a content job, not a code job**, and it's the thing
  most likely to be underestimated. Transcription must happen before session one
- **Typed essays will be thinner than handwritten ones.** Mitigate by
  encouraging tablets and laptops; fall back to paper essays if quality drops
- **Six sessions a year means no habit forms.** Reminders before each session
  will do more for engagement than any screen in the app
- **Delegates travel between centers.** A session is hosted at one center and
  the rest drive to it, so absence reasons will often be travel, and the
  karyakar approving them may not be the delegate's own center's karyakar
- **Delivery channel for reminders is undecided** — email is free, SMS costs
