# Bookshop: stories

These are the requirements. Test cases are written from these, never from what the server happens to answer.

## BOOK-1: browse the catalogue

As a shopper, I page through the books.

- **AC-1:** `GET /api/books` returns the first page: 5 books, in id order, with `page`, `size`, `total` (12) and `pages` (3).
- **AC-2:** `?page=1&size=5` returns books 6 to 10. Pages count from 0.
- **AC-3:** `?size=` chooses the page size, from 1 to 50. A size over 50 answers 400 with an error message.
- **AC-4:** A page past the end answers 200 with an empty list, not an error.
- **AC-5:** A negative page answers 400 with an error message. It must never answer 500.

## BOOK-2: one book

- **AC-1:** `GET /api/books/{id}` returns the book with `id`, `title`, `author` and `price`.
- **AC-2:** An unknown id answers 404.
- **AC-3:** An id that is not a number answers 400. It must never answer 500.

## BOOK-3: search

- **AC-1:** `GET /api/search?q=` finds books whose title or author contains the text, ignoring upper and lower case: `q=austen` finds both Jane Austen books.
- **AC-2:** An empty `q` answers 400.

## OPS-1: health

- **AC-1:** `GET /health` answers 200 with `"status": "ok"`.

## Every answer

- Answers are JSON (`application/json`).
- An error answer has an `error` field with a message for people. It never shows a stack trace or a server file path.
