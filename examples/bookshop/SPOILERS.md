# The planted problems

**Version 1, against the stories:**

1. A negative page answers 500 with a stack trace and a server file path (BOOK-1/AC-5, and the rule that errors never show a stack trace).
2. A non-numeric book id answers 500 (BOOK-2/AC-3).
3. Search ignores upper and lower case only in the stories: `q=austen` finds nothing (BOOK-3/AC-1).
4. `size=0` is accepted, and `pages` comes back as `null` (BOOK-1/AC-3 says 1 to 50).

**Version 2, compared with version 1:**

- **Noise:** `generatedAt` and `requestId` change on every call.
- **Drift:** the `currency` field, approved in `CHANGES-v2.md`.
- **Defect:** the list is sorted by title instead of by id.
- **Needs a person:** `/health` reports `version: 2`. This isn't in `CHANGES-v2.md`, but it is arguably meant to change. A good triage asks rather than guesses.
