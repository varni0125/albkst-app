# BKST App — Specification v1

Bal-Kishore Sevak Training · Raleigh pilot

---

## 1. What this app is

A standing tracker for BKST delegates. It answers two questions:

- **Delegate:** am I meeting the program's requirements?
- **Karyakar:** who is at risk, and what needs my attention?

It is not a motivation app. The program has hard requirements — 80% on session
grades, one excused absence per year — and the app exists to make compliance
visible before it becomes a dismissal.

### Scope

Six sessions per year: three in fall term, three in spring, roughly a month
apart.

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
  delegate's choice
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

**PIN hashes live in Cloudflare KV, not the Sheet.** A 4-digit PIN has only
10,000 possibilities, so a hash sitting in a spreadsheet is recoverable in
under a second by anyone who can open that spreadsheet — and karyakars can
open it. KV is readable only by the Worker.

Hashing is PBKDF2-SHA256 with a per-user random salt. Five failed attempts
locks that ID for 15 minutes, which is the real defense against guessing a
short PIN.

The Sheet holds roster and program data only. It never holds a credential.

---

## 3. Data model

Google Sheet, one tab per table.

### delegates
| field | notes |
|---|---|
| bk_id | primary key |
| first_name, last_name | |
| center | reserved from day one, single value for now — makes multi-center a config change, not a rewrite |
| term_group | e.g. "Raleigh 2026" |
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
| session_date, start_time | |
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

**Append-only.** Every check-in and every karyakar mark adds a row; nothing is
overwritten. Nineteen delegates checking in within the same two minutes would
otherwise race on a read-modify-write and silently lose a tap. The Worker
reconciles on read — most recent row wins per (session_id, bk_id) — and the
duplicate rows are the audit trail.

Every other tab is one row per key.

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
faster and far more consistent than reading 19 complete quizzes.

Point entry is tap targets (0 / 3 / 5), not a number field.

### Fallback
If typed essays come back noticeably thinner than handwritten ones, split
delivery: MC and short answer in-app, essay on paper, karyakar enters just the
essay points. The grading queue already supports manually entered points, so
this costs nothing to support.

---

## 6. Attendance flow

1. Karyakar opens check-in for the session
2. Delegates tap check-in in the app while the window is open
3. Karyakar closes the window when the session starts
4. **Manual close** available in case a karyakar forgets
5. **Manual mark** for anyone arriving after the window shuts

No QR codes — a code with no time limit can be screenshotted and forwarded, and
QR's advantage (speed at a queue) doesn't apply to 19 people six times a year.

No punctuality tracking. It was a byproduct of timestamped scanning; without
that it isn't meaningful data.

### Absence requests

Delegates submit an absence ahead of a session with a stated reason. A karyakar
approves or denies it.

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

### Delegate
1. **Login** — BK ID + PIN; first-login PIN set
2. **Home / standing**
   - Standing headline: in good standing, or not
   - Six session slots as a bar row — whole year visible at once
   - Next session date, with check-in button when the window is open
   - Homework card, only when the session has homework
   - Session grades list, per session, 80% marked
   - Practice button (v2)
3. **Quiz** — one question at a time, autosaved
4. **Homework upload**
5. **Request absence**

### Karyakar
1. **Login** — separate credentials
2. **Session view**
   - Open/close check-in, live count
   - Roster with manual mark
   - Open/close quiz
3. **Grading queue** — by question, key pinned, tap-to-score
4. **Homework queue** — submitted count, tap through to Drive, enter points
5. **Dashboard / needs attention**
   - Below 80% on any session
   - Absence used
   - Missing homework
   - Red for real consequences, gold for worth-a-word
6. **Delegate detail** — full history plus notes field (post-pilot)

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
- **Delivery channel for reminders is undecided** — email is free, SMS costs
