#!/usr/bin/env node
// The mailbox adapter: each system sends to its own capture server (Mailpit or MailHog), and this
// reports what arrived. It only ever talks to an address that has shown it is one of the two.
// Docs: README.md here, and docs/ADAPTERS.md.
import crypto from "node:crypto";

import { address, direct, jsonFrom, millis, Refusal, refuseUnsupported, SAFE_METHODS, sendToSystem, serve, settle, under } from "./runtime.mjs";

const PAGE = 200;
const MOST_MESSAGES = 10_000;

const lower = (o, name) => {
    const hit = Object.entries(o ?? {}).find(([k]) => k.toLowerCase() === name);
    return Array.isArray(hit?.[1]) ? hit[1][0] : hit?.[1];
};

// ---- Which server is it? ----

/** What each capture server has answered as. A server is asked once per address, once per run of the adapter. */
const known = new Map();

async function isMailpit(base) {
    const res = await direct(under(base, "/api/v1/info"), {}, `capture server ${base}`);
    if (!res.ok) return false;
    const info = await res.json().catch(() => null);
    return typeof info?.Version === "string" && typeof info?.Database === "string" && typeof info?.Messages === "number" && typeof info?.RuntimeStats === "object" && info.RuntimeStats !== null;
}

async function isMailHog(base) {
    const res = await direct(under(base, "/api/v2/messages?limit=1"), {}, `capture server ${base}`);
    if (!res.ok) return false;
    const list = await res.json().catch(() => null);
    if (!Array.isArray(list?.items) || ![list.total, list.start, list.count].every((n) => typeof n === "number")) return false;
    // MailHog has no call that says what it is, so its web page has to say it too.
    const page = await direct(under(base, "/"), {}, `capture server ${base}`);
    return page.ok && /mailhog/i.test(await page.text());
}

/** The capture server for a target, or a refusal if the address does not answer as Mailpit or MailHog. */
async function capture(target) {
    const base = address(target, "capture_url");
    if (!known.has(base)) {
        const kind = (await isMailpit(base)) ? MAILPIT : (await isMailHog(base)) ? MAILHOG : undefined;
        if (!kind) throw new Refusal(`${base} does not answer as Mailpit or MailHog, so this adapter refuses to use it. Only capture servers are allowed, never a real mail server`);
        known.set(base, kind);
    }
    return { base, ...known.get(base) };
}

// ---- Facts about a message ----

const MASK = "<masked>";
const SECRET_NAME = /token|code|key|sig|secret|auth|session|otp|nonce|hash|ticket|password|pwd/i;
/** A value that looks generated: a UUID, long hex, or a long mix of letters and digits. */
const looksGenerated = (v) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^[0-9a-f]{16,}$/i.test(v) ||
    (v.length >= 16 && /^[A-Za-z0-9_.~%+=-]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v));

/** A link with its tokens masked, so the same link on two runs reads the same. */
function maskLink(link) {
    let u;
    try { u = new URL(link); } catch { return link; }
    const path = u.pathname.split("/").map((seg) => (looksGenerated(seg) ? MASK : seg)).join("/");
    const query = [...u.searchParams].map(([k, v]) => `${k}=${SECRET_NAME.test(k) || looksGenerated(v) ? MASK : v}`).join("&");
    const fragment = u.hash.length > 1 ? (looksGenerated(u.hash.slice(1)) ? `#${MASK}` : u.hash) : "";
    return `${u.origin}${path}${query ? `?${query}` : ""}${fragment}`;
}

const LINK = /https?:\/\/[^\s<>"'`]+/g;
const trimLink = (l) => l.replace(/[.,;:!?)\]]+$/, "");
const maskLinksIn = (text) => text.replace(LINK, (l) => { const t = trimLink(l); return maskLink(t) + l.slice(t.length); });
const unescapeHref = (h) => h.replaceAll("&amp;", "&");

function linksOf(text, html) {
    const all = (text.match(LINK) ?? []).map(trimLink);
    for (const m of (html ?? "").matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const h = unescapeHref(m[1] ?? m[2] ?? "").trim();
        if (/^https?:\/\//i.test(h)) all.push(h);
    }
    return [...new Set(all.map(maskLink))].sort();
}

/** The same shape from either server: no ids, no dates, recipients sorted, attachments by hash. */
function report({ from, to, cc, bcc, subject, text, html, attachments }) {
    const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
    const sorted = (l) => [...l].sort();
    return {
        from,
        to: sorted(to),
        cc: sorted(cc),
        bcc: sorted(bcc),
        subject,
        text: maskLinksIn(clean),
        links: linksOf(clean, html),
        attachments: [...attachments].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
}

const named = (name, addr) => (name ? `${name} <${addr}>` : addr);

// ---- Mailpit ----

const MAILPIT = {
    name: "Mailpit",
    async ids(base) {
        const ids = [];
        for (let start = 0; ; start += PAGE) {
            const list = await jsonFrom(await direct(under(base, `/api/v1/messages?start=${start}&limit=${PAGE}`), {}, "Mailpit"), "Mailpit");
            if (!Array.isArray(list?.messages)) throw new Refusal("Mailpit's list of messages has no `messages`");
            ids.push(...list.messages.map((m) => m.ID));
            if (ids.length > MOST_MESSAGES) throw new Refusal(`the capture server holds more than ${MOST_MESSAGES} messages; empty it first`);
            if (list.messages.length === 0 || ids.length >= (list.messages_count ?? list.total ?? 0)) return ids;
        }
    },
    async message(base, id) {
        const m = await jsonFrom(await direct(under(base, `/api/v1/message/${encodeURIComponent(id)}`), {}, "Mailpit"), "Mailpit");
        const part = async (a, inline) => {
            let sha256 = a.Checksums?.SHA256?.toLowerCase();
            if (!sha256) {
                const res = await direct(under(base, `/api/v1/message/${encodeURIComponent(id)}/part/${encodeURIComponent(a.PartID)}`), {}, "Mailpit");
                if (!res.ok) throw new Refusal(`Mailpit answered ${res.status} for an attachment`);
                sha256 = crypto.createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
            }
            return { name: a.FileName, type: String(a.ContentType ?? "").split(";")[0].trim().toLowerCase(), sha256, ...(inline ? { inline: true } : {}) };
        };
        const addrs = (l) => (l ?? []).map((a) => a.Address);
        return report({
            from: named(m.From?.Name, m.From?.Address),
            to: addrs(m.To), cc: addrs(m.Cc), bcc: addrs(m.Bcc),
            subject: m.Subject ?? "",
            text: m.Text, html: m.HTML,
            attachments: [...await Promise.all((m.Attachments ?? []).map((a) => part(a, false))), ...await Promise.all((m.Inline ?? []).map((a) => part(a, true)))],
        });
    },
    async empty(base) {
        const res = await direct(under(base, "/api/v1/messages"), { method: "DELETE" }, "Mailpit");
        if (!res.ok) throw new Refusal(`Mailpit answered ${res.status} when asked to empty the mailbox`);
    },
};

// ---- MailHog: it stores the raw message, so the MIME is read here ----

const decoderFor = (charset) => {
    try { return new TextDecoder(charset || "utf-8"); } catch { return new TextDecoder("utf-8"); }
};

/** =?utf-8?B?...?= and =?utf-8?Q?...?= in a header. */
const decodeWords = (s) => String(s ?? "").replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, charset, enc, data) => {
    const bytes = enc.toLowerCase() === "b" ? Buffer.from(data, "base64")
        : qpBytes(data.replace(/_/g, " "));
    return decoderFor(charset).decode(bytes);
});

function qpBytes(text) {
    const soft = text.replace(/=\r?\n/g, "");
    const bytes = [];
    for (let i = 0; i < soft.length; i++) {
        const hex = soft.slice(i + 1, i + 3);
        if (soft[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; }
        else bytes.push(...Buffer.from(soft[i], "utf8"));
    }
    return Buffer.from(bytes);
}

function bodyBytes(body, encoding) {
    const e = String(encoding ?? "").trim().toLowerCase();
    if (e === "base64") return Buffer.from(String(body ?? "").replace(/\s+/g, ""), "base64");
    if (e === "quoted-printable") return qpBytes(String(body ?? ""));
    return Buffer.from(String(body ?? ""), "utf8");
}

/** A header's value and parameters: `text/plain; charset=utf-8`. */
function headerParts(value) {
    const [first, ...rest] = String(value ?? "").split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const params = {};
    for (const p of rest) {
        const eq = p.indexOf("=");
        if (eq > 0) params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, "");
    }
    return { value: first.trim().toLowerCase(), params };
}

function fileName(type, disposition) {
    const star = disposition.params["filename*"];
    if (star) return decodeURIComponent(star.replace(/^[^']*'[^']*'/, ""));
    return decodeWords(disposition.params.filename ?? type.params.name ?? "");
}

/** Addresses in a header such as `Ann <a@x.test>, "B, C" <b@x.test>`, split on commas outside quotes. */
function parseAddresses(value) {
    return decodeWords(value).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.trim()).filter(Boolean).map((one) => {
        const m = /^(.*)<([^>]+)>\s*$/.exec(one);
        return m ? { name: m[1].trim().replace(/^"|"$/g, ""), address: m[2].trim() } : { name: "", address: one };
    });
}

/** The leaf parts of a message, in order. A multipart inside a multipart is walked too. */
function leaves(part, out = []) {
    const parts = part.MIME?.Parts;
    if (Array.isArray(parts) && parts.length) for (const p of parts) leaves(p, out);
    else out.push(part);
    return out;
}

const pathOf = (p) => `${p.Mailbox}@${p.Domain}`;

const MAILHOG = {
    name: "MailHog",
    async ids(base) {
        return (await this.page(base)).map((m) => m.ID);
    },
    /** MailHog's list holds each whole message, so it is read here and kept for `message`. */
    async page(base) {
        const all = [];
        for (let start = 0; ; start += PAGE) {
            const list = await jsonFrom(await direct(under(base, `/api/v2/messages?start=${start}&limit=${PAGE}`), {}, "MailHog"), "MailHog");
            if (!Array.isArray(list?.items)) throw new Refusal("MailHog's list of messages has no `items`");
            all.push(...list.items);
            if (all.length > MOST_MESSAGES) throw new Refusal(`the capture server holds more than ${MOST_MESSAGES} messages; empty it first`);
            if (list.items.length === 0 || all.length >= (list.total ?? 0)) return all;
        }
    },
    async message(base, id) {
        const m = await jsonFrom(await direct(under(base, `/api/v1/messages/${encodeURIComponent(id)}`), {}, "MailHog"), "MailHog");
        const headers = m.Content?.Headers ?? {};
        const from = parseAddresses(lower(headers, "from"))[0] ?? { name: "", address: m.From ? pathOf(m.From) : "" };
        const to = parseAddresses(lower(headers, "to")).map((a) => a.address);
        const cc = parseAddresses(lower(headers, "cc")).map((a) => a.address);
        // Blind copies appear only on the envelope.
        const bcc = (m.To ?? []).map(pathOf).filter((a) => !to.includes(a) && !cc.includes(a));
        let text = "", html = "";
        const attachments = [];
        for (const leaf of leaves({ Headers: headers, Body: m.Content?.Body, MIME: m.MIME })) {
            const type = headerParts(lower(leaf.Headers, "content-type") ?? "text/plain");
            const disposition = headerParts(lower(leaf.Headers, "content-disposition"));
            const bytes = bodyBytes(leaf.Body, lower(leaf.Headers, "content-transfer-encoding"));
            const name = fileName(type, disposition);
            const contentId = lower(leaf.Headers, "content-id");
            if (disposition.value === "attachment" || name || contentId) {
                const inline = disposition.value === "inline" || (disposition.value !== "attachment" && Boolean(contentId));
                attachments.push({ name, type: type.value, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), ...(inline ? { inline: true } : {}) });
            } else if (type.value === "text/html") html += decoderFor(type.params.charset).decode(bytes);
            else if (type.value === "text/plain") text += decoderFor(type.params.charset).decode(bytes);
        }
        return report({ from: named(from.name, from.address), to, cc, bcc, subject: decodeWords(lower(headers, "subject")), text, html, attachments });
    },
    async empty(base) {
        const res = await direct(under(base, "/api/v1/messages"), { method: "DELETE" }, "MailHog");
        if (!res.ok) throw new Refusal(`MailHog answered ${res.status} when asked to empty the mailbox`);
    },
};

// ---- The protocol ----

const describe = () => ({
    name: "mailbox",
    kinds: ["email"],
    settings: [
        { name: "capture_url", description: "The capture server's API for this target: Mailpit or MailHog", required: true },
        { name: "base_url", description: "The system itself, which POST, PUT, PATCH and DELETE cases are sent to" },
        { name: "quiet_ms", description: "Mail has stopped arriving when nothing new came for this long. Default 1000" },
        { name: "max_wait_ms", description: "Give up, with an error, if mail is still arriving after this long. Default 15000" },
    ],
});

async function run(c, target, headers) {
    refuseUnsupported(c);
    const server = await capture(target);
    const { base } = server;
    let status = 200;
    let ids;
    if (SAFE_METHODS.has(c.request.method)) {
        // Observing only: the system is not contacted and the mailbox is left as it is.
        ids = await server.ids(base);
    } else {
        // Only what this case caused counts, even when the mailbox was not empty.
        const before = new Set(await server.ids(base));
        status = await sendToSystem(c, target, headers);
        const quiet = millis(target, "quiet_ms", 1000);
        const most = millis(target, "max_wait_ms", 15_000);
        ids = await settle(async () => (await server.ids(base)).filter((id) => !before.has(id)), quiet, most, "mail was");
    }
    const emails = [];
    for (const id of ids) emails.push(await server.message(base, id));
    emails.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { status, headers: {}, effects: { emails } };
}

async function reset(target) {
    const server = await capture(target);
    await server.empty(server.base);
    return { ok: true };
}

await serve({ describe, run, reset });
