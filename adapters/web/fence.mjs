// The fence: a small proxy on this machine that every browser request passes through. Playwright's routes do not
// see a redirect the browser follows, or a socket a worker opens. This does, because the browser has no other way
// out. What reaches it for an address the case may not use has already got past the routes, so it is stopped and
// reported, and the case cannot pass. It writes no header, no path and no query anywhere.
import http from "node:http";
import net from "node:net";

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade"]);
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Headers as sent, less those for one hop only, and less credentials when `strip` holds their names. */
function pass(raw, strip) {
    const out = [];
    for (let i = 0; i < raw.length; i += 2) {
        const name = raw[i].toLowerCase();
        if (!HOP.has(name) && !strip?.has(name)) out.push(raw[i], raw[i + 1]);
    }
    return out;
}

const bare = (hostname) => hostname.replace(/^\[|\]$/g, "");
const originOf = (scheme, authority) => { try { return new URL(`${scheme}://${authority}`).origin; } catch { return undefined; } };

/**
 * @param allowed the origins this case may reach
 * @param target the target's own origin: the only one that may hear credentials
 * @param writes whether this case may change data
 * @param credentials header names and values, as the routes send them
 * @param onStop (why, request, hostname): something was stopped here. It never holds a path or a query
 * @param onFailure (code): the system itself could not be reached
 */
export async function startFence({ allowed, target, writes, credentials, onStop, onFailure }) {
    const names = new Set(Object.keys(credentials));
    const open = new Set();
    const agent = new http.Agent({ keepAlive: false });

    const server = http.createServer((req, res) => {
        let url;
        try {
            url = new URL(req.url);
        } catch {
            return req.socket.destroy();
        }
        if (!allowed.has(url.origin)) {
            onStop("a redirect, or another request the page's routes could not see, tried to reach an address that is not a target in cmtk.yaml", `${req.method} ${url.origin}`, url.hostname);
            return req.socket.destroy();
        }
        if (!writes && !SAFE.has(req.method)) {
            onStop("a redirect, or another request the page's routes could not see, tried to change data, and this case only reads", `${req.method} ${url.origin}`, url.hostname);
            return req.socket.destroy();
        }
        const onward = http.request({ agent, hostname: bare(url.hostname), port: url.port || 80, path: url.pathname + url.search, method: req.method, headers: pass(req.rawHeaders, url.origin === target ? undefined : names), setHost: false }, (answer) => {
            res.writeHead(answer.statusCode, answer.statusMessage, pass(answer.rawHeaders));
            answer.pipe(res);
            answer.on("error", () => res.destroy());
        });
        onward.on("error", (err) => { if (!res.destroyed && !req.socket.destroyed) onFailure(err.code); res.destroy(); req.socket.destroy(); });
        res.on("close", () => { if (!res.writableFinished) onward.destroy(); });
        req.pipe(onward);
    });

    // CONNECT carries https, and web sockets. On an http address only a web socket uses it, so that much can be told apart.
    server.on("connect", (req, socket, head) => {
        socket.on("error", () => {});
        const secure = originOf("https", req.url);
        const plain = originOf("http", req.url);
        const hostname = plain ? new URL(plain).hostname : "";
        if (secure && allowed.has(secure)) return tunnel(req.url, socket, head);
        if (plain && allowed.has(plain)) {
            if (writes) return tunnel(req.url, socket, head);
            onStop("a web socket the page's routes could not see, from a worker, tried to open, and this case only reads", `WEBSOCKET ${plain}`, hostname);
            return socket.destroy();
        }
        onStop("a redirect or a web socket the page's routes could not see tried to reach an address that is not a target in cmtk.yaml", `CONNECT ${req.url}`, hostname);
        return socket.destroy();
    });

    function tunnel(authority, socket, head) {
        const { hostname, port } = new URL(`http://${authority}`);
        const onward = net.connect(Number(port) || 80, bare(hostname));
        open.add(onward);
        onward.on("close", () => open.delete(onward));
        onward.on("error", (err) => { onFailure(err.code); socket.destroy(); });
        onward.on("connect", () => {
            socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
            if (head?.length) onward.write(head);
            onward.pipe(socket);
            socket.pipe(onward);
        });
        socket.on("close", () => onward.destroy());
    }

    server.on("connection", (s) => { open.add(s); s.on("close", () => open.delete(s)); s.on("error", () => {}); });
    server.on("clientError", (_err, s) => s.destroy());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve) => {
            for (const s of open) s.destroy();
            agent.destroy();
            server.close(() => resolve());
        }),
    };
}
