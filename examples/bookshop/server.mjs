#!/usr/bin/env node
// A tiny bookshop API for trying the cmtk AI tester. No dependencies.
//   node server.mjs                 version 1 on port 4100 (today's system)
//   node server.mjs --v2            version 2 on port 4101 (the rewrite)
//   node server.mjs --port 5000     another port
// It has bugs on purpose. STORIES.md says what it should do; don't read this file first if you
// want to find them by testing.
import http from "node:http";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const v2 = args.includes("--v2");
const port = Number(args[args.indexOf("--port") + 1]) || (v2 ? 4101 : 4100);

const BOOKS = [
    ["The Hobbit", "J. R. R. Tolkien", 8.99], ["Emma", "Jane Austen", 4.5], ["Dune", "Frank Herbert", 9.99],
    ["Persuasion", "Jane Austen", 4.5], ["Beloved", "Toni Morrison", 7.25], ["Ulysses", "James Joyce", 12],
    ["Middlemarch", "George Eliot", 6.75], ["The Silmarillion", "J. R. R. Tolkien", 10.5], ["Kindred", "Octavia E. Butler", 8],
    ["Rebecca", "Daphne du Maurier", 5.99], ["Frankenstein", "Mary Shelley", 3.99], ["Small Island", "Andrea Levy", 7.99],
].map(([title, author, price], i) => ({ id: i + 1, title, author, price, ...(v2 ? { currency: "GBP" } : {}) }));

const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const meta = { generatedAt: new Date().toISOString(), requestId: crypto.randomUUID() };
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "read-only shop" });
    if (url.pathname === "/health") return send(res, 200, { status: "ok", version: v2 ? 2 : 1 });

    if (url.pathname === "/api/books") {
        const page = Number(url.searchParams.get("page") ?? 0);
        const size = Number(url.searchParams.get("size") ?? 5);
        if (size > 50) return send(res, 400, { error: "size must be 50 or fewer" });
        try {
            if (page < 0) throw new RangeError(`Invalid array length at BookRepository.page (/srv/shop/repo.js:42) page=${page}`);
            const sorted = v2 ? [...BOOKS].sort((a, b) => a.title.localeCompare(b.title)) : BOOKS;
            const books = sorted.slice(page * size, page * size + size);
            return send(res, 200, { page, size, total: BOOKS.length, pages: Math.ceil(BOOKS.length / size), books, ...meta });
        } catch (err) {
            return send(res, 500, { error: String(err.stack ?? err) });
        }
    }

    const one = /^\/api\/books\/([^/]+)$/.exec(url.pathname);
    if (one) {
        const id = Number(one[1]);
        if (Number.isNaN(id)) return send(res, 500, { error: `TypeError: cannot read book ${one[1]}` });
        const book = BOOKS.find((b) => b.id === id);
        return book ? send(res, 200, { ...book, ...meta }) : send(res, 404, { error: "no such book" });
    }

    if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        if (!q.trim()) return send(res, 400, { error: "q is required" });
        const hits = BOOKS.filter((b) => b.title.includes(q) || b.author.includes(q));
        return send(res, 200, { q, count: hits.length, books: hits, ...meta });
    }
    send(res, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => console.log(`bookshop v${v2 ? 2 : 1} on http://localhost:${port}`));
