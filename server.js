import express from "express";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REQUIRED_PIN = "5226";
const MAX_ATTEMPTS = 5;
const LOCK_TIME_MS = 5000; // 10 minutes

let failedAttempts = 0;
let lockedUntil = 0;
const BAUDRATE = 115200;
const HTTP_PORT = 8080;

const PREFERRED_PORT = process.env.SERIAL_PORT || "COM3";
const RESCAN_MS = 2000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let port = null;
let parser = null;
let connectedPath = null;
let state = "DISCONNECTED";
let lastLine = "";

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

async function listPorts() {
  return await SerialPort.list();
}

function cleanup() {
  try { parser?.removeAllListeners(); } catch {}
  try { port?.removeAllListeners(); } catch {}
  try { port?.close(); } catch {}
  port = null;
  parser = null;
  connectedPath = null;
  state = "DISCONNECTED";
}
app.post("/login", (req, res) => {
  const now = Date.now();

  if (lockedUntil > now) {
    return res.status(403).json({ error: "Locked. Try later." });
  }

  const pin = String(req.body.pin || "");

  if (pin === REQUIRED_PIN) {
    failedAttempts = 0;
    return res.json({ ok: true });
  }

  failedAttempts++;

  if (failedAttempts >= MAX_ATTEMPTS) {
    lockedUntil = now + LOCK_TIME_MS;
    failedAttempts = 0;
    return res.status(403).json({ error: "Too many attempts. Locked." });
  }

  res.status(401).json({ error: "Invalid PIN" });
});
async function openPort(pathStr) {
  return new Promise((resolve, reject) => {
    try {
      const sp = new SerialPort({ path: pathStr, baudRate: BAUDRATE });
      const rp = sp.pipe(new ReadlineParser({ delimiter: "\n" }));

      sp.on("open", () => resolve({ sp, rp }));
      sp.on("error", (e) => reject(e));

      // Note: SerialPort auto-opens by default; "open" event will fire.
    } catch (e) {
      reject(e);
    }
  });
}

async function tryConnect() {
  if (state !== "DISCONNECTED") return;
  state = "CONNECTING";

  const ports = await listPorts();
  const paths = ports.map(p => p.path);

  // Prefer explicit port if present
  const ordered = [];
  if (paths.includes(PREFERRED_PORT)) ordered.push(PREFERRED_PORT);
  for (const p of paths) if (!ordered.includes(p)) ordered.push(p);

  for (const p of ordered) {
    try {
      log("Trying", p);

      const { sp, rp } = await openPort(p);

      // Consider connected immediately
      port = sp;
      parser = rp;
      connectedPath = p;
      state = "CONNECTED";
      log("CONNECTED", p);

      parser.on("data", (lineRaw) => {
        const line = String(lineRaw).trim();
        if (line) {
          lastLine = line;
          // Optional logging
          // log("ESP:", line);
        }
      });

      port.on("close", () => {
        log("DISCONNECTED", connectedPath);
        cleanup();
      });

      port.on("error", (e) => {
        log("SERIAL ERROR", e?.message || e);
        cleanup();
      });

      // Nudge device (harmless if firmware ignores)
      setTimeout(() => {
        try { port.write("\n"); port.write("PING\n"); } catch {}
      }, 300);

      return;
    } catch (e) {
      // failed, try next
    }
  }

  state = "DISCONNECTED";
}

setInterval(() => {
  if (state === "DISCONNECTED") {
    tryConnect();
  }
}, RESCAN_MS);

app.post("/send", (req, res) => {
    if (lockedUntil > Date.now()) {
    return res.status(403).json({ error: "Locked." });
    }

    if (req.headers["x-auth"] !== REQUIRED_PIN) {
    return res.status(401).json({ error: "Unauthorized" });
    }
  if (!port || state !== "CONNECTED") {
    return res.status(500).json({ error: "Not connected" });
  }

  const cmd = String(req.body.cmd || "").trim().toUpperCase();
  if (!["B1", "B2"].includes(cmd)) {
    return res.status(400).json({ error: "Invalid command" });
  }

  try {
    port.write(cmd + "\n");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/status", (req, res) => {
  res.json({
    state,
    port: connectedPath,
    lastLine
  });
});

app.listen(HTTP_PORT, () => {
  log("Web UI: http://localhost:" + HTTP_PORT);
});