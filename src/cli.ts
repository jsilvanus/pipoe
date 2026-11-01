#!/usr/bin/env node
import type { PortState, SwitchSnapshot } from "./types.js";

const args = process.argv.slice(2);
let url = process.env["PIPOE_URL"] ?? "http://127.0.0.1:3108";
let json = false;
const rest: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--url") url = args[++i] ?? url;
  else if (a === "--json") json = true;
  else rest.push(a);
}

const usage = `pipoe - PoE switch controller CLI

USAGE:
  pipoe [--url <url>] [--json] <command>

COMMANDS:
  list                        All ports: PoE state, link, power, plus switch totals
  get <port|name>             One port
  on <port|name>              Switch PoE on
  off <port|name>             Switch PoE off
  cycle <port|name> [ms]      Off, wait (default 5000 ms, 1000-60000), on

ENV: PIPOE_URL, PIPOE_API_KEY (bearer token)`;

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (process.env["PIPOE_API_KEY"]) headers["authorization"] = `Bearer ${process.env["PIPOE_API_KEY"]}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${url}${path}`, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function line(p: PortState): string {
  const power = p.powerW === null ? "-" : `${p.powerW} W`;
  return `${String(p.port).padStart(2)}  ${(p.name ?? "").padEnd(10)} poe ${p.poeEnabled ? "on " : "off"}  ${p.status.padEnd(10)} link ${p.link.padEnd(7)} ${power}`;
}

async function run(): Promise<void> {
  const [cmd, ref, extra] = rest;
  if (!cmd || cmd === "help" || args.includes("--help")) return void console.log(usage);
  let out: unknown;
  if (cmd === "list") out = await call("GET", "/api/v1/poe");
  else if (ref && cmd === "get") out = await call("GET", `/api/v1/poe/ports/${encodeURIComponent(ref)}`);
  else if (ref && (cmd === "on" || cmd === "off")) out = await call("POST", `/api/v1/poe/ports/${encodeURIComponent(ref)}/power`, { enabled: cmd === "on" });
  else if (ref && cmd === "cycle") out = await call("POST", `/api/v1/poe/ports/${encodeURIComponent(ref)}/cycle`, extra ? { offMs: Number(extra) } : {});
  else return void console.log(usage);

  if (json) return void console.log(JSON.stringify(out, null, 2));
  if (cmd === "list") {
    const snap = out as SwitchSnapshot;
    snap.ports.forEach((p) => console.log(line(p)));
    console.log(`total: ${snap.totals.consumedW ?? "?"} W of ${snap.totals.budgetW ?? "?"} W`);
  } else console.log(line(out as PortState));
}

run().catch((err) => {
  console.error(`pipoe: ${(err as Error).message}`);
  process.exit(1);
});
