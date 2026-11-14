// Loaded into the toolkit and the adapter by the replay test (--import). It records any connection a process
// opens to anything but this machine, into the file named by CMTK_NETWORK_LOG. A model call would be one.
import fs from "node:fs";
import net from "node:net";

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const o = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof o === "object" && o ? o.host ?? (o.path ? "pipe" : "localhost") : typeof args[1] === "string" ? args[1] : "localhost";
    if (!["localhost", "127.0.0.1", "::1", "pipe"].includes(host)) fs.appendFileSync(process.env.CMTK_NETWORK_LOG, `${host}\n`);
    return connect.apply(this, args);
};
