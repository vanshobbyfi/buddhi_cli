#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { installMcp } from "./mcp-install.js";

/**
 * Buddhi AI CLI. A thin, dependency-free client over the Buddhi AI backend:
 *   buddhi login [--key crtx_...] [--url http://localhost:4040]
 *   buddhi whoami
 *   buddhi push <file> [--title "..."] [--scope engineering]
 *
 * The agent key (crtx_...) is created in the Buddhi AI dashboard / onboarding.
 * It authenticates as the human it acts for, so every write is scoped + audited.
 */

const CONFIG_PATH = join(homedir(), ".buddhi", "config.json");
const DEFAULT_URL = "http://localhost:4040";

interface Config {
  apiKey: string;
  url: string;
  actingUser?: { name: string; email: string; role: string; level: string };
}

function loadConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch {
    return null;
  }
}

function saveConfig(cfg: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function parseFlags(argv: string[]): { _: string[]; [k: string]: string | string[] | boolean } {
  const out: { _: string[]; [k: string]: string | string[] | boolean } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function verifyKey(url: string, key: string): Promise<Config["actingUser"]> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/cli/verify`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `verify failed (${res.status})`);
  }
  const data = (await res.json()) as { actingUser: Config["actingUser"] };
  return data.actingUser;
}

function runMcpInstall(url: string, key: string): void {
  const result = installMcp(url, key);
  if (result.configured.length > 0) {
    console.log(`✓ MCP connected in: ${result.configured.join(", ")}`);
  }
  for (const skip of result.skipped) {
    console.log(`  (skipped ${skip.name}: ${skip.reason})`);
  }
  if (result.configured.length === 0 && result.skipped.length === 0) {
    console.log("  No supported AI tools detected on this machine — run `buddhi mcp install` again from inside a project, or after installing one.");
  }
}

async function login(flags: ReturnType<typeof parseFlags>): Promise<void> {
  const url = (flags.url as string) || process.env.BUDDHI_URL || DEFAULT_URL;
  let key = (flags.key as string) || process.env.BUDDHI_API_KEY || "";
  if (!key) key = await prompt("Paste your Buddhi AI API key (crtx_...): ");
  if (!key.startsWith("crtx_")) {
    console.error("✗ That does not look like a Buddhi AI key (expected crtx_...).");
    process.exit(1);
  }
  process.stdout.write("Verifying with Buddhi AI… ");
  const actingUser = await verifyKey(url, key);
  saveConfig({ apiKey: key, url, actingUser });
  console.log("done.");
  console.log(`✓ Logged in as ${actingUser?.name} <${actingUser?.email}> — role ${actingUser?.role}.`);
  console.log(`  Credentials saved to ${CONFIG_PATH}`);

  if (!flags["skip-mcp"]) {
    console.log("\nLooking for Claude Desktop, Claude Code, Cursor, Windsurf, and VS Code to connect automatically…");
    runMcpInstall(url, key);
  }
}

async function mcp(flags: ReturnType<typeof parseFlags>): Promise<void> {
  const sub = flags._[1];
  if (sub !== "install") {
    console.error("Usage: buddhi mcp install");
    process.exit(1);
  }
  const cfg = loadConfig();
  if (!cfg) {
    console.error("Not logged in. Run: buddhi login --key crtx_...");
    process.exit(1);
  }
  runMcpInstall(cfg.url, cfg.apiKey);
}

async function whoami(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("Not logged in. Run: buddhi login --key crtx_...");
    process.exit(1);
  }
  const actingUser = await verifyKey(cfg.url, cfg.apiKey);
  console.log(`${actingUser?.name} <${actingUser?.email}> — role ${actingUser?.role}, level ${actingUser?.level}`);
  console.log(`Endpoint: ${cfg.url}`);
}

async function push(flags: ReturnType<typeof parseFlags>): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("Not logged in. Run: buddhi login --key crtx_...");
    process.exit(1);
  }
  const file = flags._[1];
  if (!file || !existsSync(file)) {
    console.error("Usage: buddhi push <file> [--title \"...\"] [--scope engineering]");
    process.exit(1);
  }
  const content = readFileSync(file, "utf8");
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/api/memories`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      content,
      title: (flags.title as string) || file,
      scope: (flags.scope as string) || undefined,
      source: "Buddhi AI CLI",
      tags: ["cli"],
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(`✗ push failed: ${body.error ?? res.status}`);
    process.exit(1);
  }
  const data = (await res.json()) as { memory?: { id?: string }; status?: string };
  // A key that is not trusted to write directly sends the file for review instead.
  if (data.status === "pending_review") {
    console.log("✓ Sent for review. It becomes company memory once approved in Buddhi → Agent Memory.");
    return;
  }
  console.log(`✓ Pushed memory ${data.memory?.id ?? ""}`.trim());
}

function usage(): void {
  console.log(`Buddhi AI CLI

Usage:
  buddhi login [--key crtx_...] [--url ${DEFAULT_URL}] [--skip-mcp]
  buddhi whoami
  buddhi push <file> [--title "..."] [--scope engineering]
  buddhi mcp install     Connect the Buddhi AI MCP server into every detected
                          AI tool (Claude Desktop, Claude Code, Cursor,
                          Windsurf, VS Code) — also runs automatically after
                          login unless --skip-mcp is passed.

Env: BUDDHI_API_KEY, BUDDHI_URL`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const cmd = flags._[0];
  try {
    switch (cmd) {
      case "login":
        await login(flags);
        break;
      case "whoami":
        await whoami();
        break;
      case "push":
        await push(flags);
        break;
      case "mcp":
        await mcp(flags);
        break;
      default:
        usage();
        process.exit(cmd ? 1 : 0);
    }
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
