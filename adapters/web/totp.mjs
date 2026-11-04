#!/usr/bin/env node
// Time-based codes (RFC 6238) for test users. The seed comes from an environment variable and only the current
// six-digit code leaves this file: no function here returns, prints or names the seed's value.
// As a command: node adapters/web/totp.mjs CMTK_TEST_TOTP_SEED prints the code and nothing else.
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function seedBytes(variable) {
    const text = process.env[variable];
    if (text === undefined || !text.trim()) throw new Error(`the environment variable ${variable} is not set: a test user's TOTP seed goes there, in base32`);
    const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
        const v = ALPHABET.indexOf(ch);
        // Only what is wrong, never what it holds.
        if (v < 0) throw new Error(`the environment variable ${variable} is not base32: a TOTP seed uses A to Z and 2 to 7`);
        value = (value << 5) | v;
        bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; value &= (1 << bits) - 1; }
    }
    if (!out.length) throw new Error(`the environment variable ${variable} is not base32: a TOTP seed uses A to Z and 2 to 7`);
    return Buffer.from(out);
}

/** The code for this moment, from the seed in an environment variable. */
export function totpCode(variable, { now = Date.now(), digits = 6, stepSeconds = 30 } = {}) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / stepSeconds)));
    const mac = crypto.createHmac("sha1", seedBytes(variable)).update(counter).digest();
    const at = mac[mac.length - 1] & 0x0f;
    const number = (mac.readUInt32BE(at) & 0x7fffffff) % 10 ** digits;
    return String(number).padStart(digits, "0");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try {
        if (!process.argv[2]) throw new Error("name the environment variable that holds the seed");
        process.stdout.write(`${totpCode(process.argv[2])}\n`);
    } catch (err) {
        process.stderr.write(`totp: ${err.message}\n`);
        process.exitCode = 2;
    }
}
