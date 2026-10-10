import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";

/**
 * Auto-configures the Buddhi AI MCP server (Streamable HTTP, /mcp, Bearer
 * crtx_* auth) into every AI tool we can find on this machine — Claude
 * Desktop, Claude Code, Cursor, Windsurf, VS Code. No local process to spawn
 * (no @buddhi-ai/mcp-server package): every one of these clients supports
 * remote/HTTP MCP servers natively, so we just write the URL + auth header.
 *
 * Never clobbers a config file blindly — merges into the existing JSON
 * (preserving unrelated servers/settings) and writes a timestamped .bak
 * first. A file we can't parse is skipped with a warning, not overwritten.
 */

type Shape = "anthropic" | "vscode";

interface McpTarget {
  name: string;
  configPath: string;
  shape: Shape;
  /** Whether this tool looks installed / this looks like a real project — decides whether we touch it. */
  applicable: () => boolean;
}

function appDataDir(): string {
  // Windows: %APPDATA% (Roaming). Fall back to the conventional path if unset.
  return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
}

function claudeDesktopConfigPath(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(appDataDir(), "Claude", "claude_desktop_config.json");
    default:
      return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

function looksLikeAProject(cwd: string): boolean {
  return existsSync(join(cwd, ".git")) || existsSync(join(cwd, "package.json"));
}

function targets(cwd: string): McpTarget[] {
  const claudeDesktopPath = claudeDesktopConfigPath();
  const cursorGlobalDir = join(homedir(), ".cursor");
  const windsurfDir = join(homedir(), ".codeium", "windsurf");
  const inProject = looksLikeAProject(cwd);

  return [
    {
      name: "Claude Desktop",
      configPath: claudeDesktopPath,
      shape: "anthropic",
      applicable: () => existsSync(dirname(claudeDesktopPath)),
    },
    {
      name: "Claude Code (this project)",
      configPath: join(cwd, ".mcp.json"),
      shape: "anthropic",
      applicable: () => inProject,
    },
    {
      name: "Cursor (global)",
      configPath: join(cursorGlobalDir, "mcp.json"),
      shape: "anthropic",
      applicable: () => existsSync(cursorGlobalDir),
    },
    {
      name: "Cursor (this project)",
      configPath: join(cwd, ".cursor", "mcp.json"),
      shape: "anthropic",
      applicable: () => inProject && existsSync(join(cwd, ".cursor")),
    },
    {
      name: "Windsurf",
      configPath: join(windsurfDir, "mcp_config.json"),
      shape: "anthropic",
      applicable: () => existsSync(windsurfDir),
    },
    {
      name: "VS Code (this project)",
      configPath: join(cwd, ".vscode", "mcp.json"),
      shape: "vscode",
      applicable: () => inProject,
    },
  ];
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // exists but not valid JSON — don't touch it
  }
}

function mergeEntry(existing: Record<string, unknown>, shape: Shape, url: string, apiKey: string): Record<string, unknown> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (shape === "vscode") {
    const servers = (existing.servers as Record<string, unknown>) ?? {};
    return { ...existing, servers: { ...servers, buddhi: { type: "http", url, headers } } };
  }
  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {};
  return { ...existing, mcpServers: { ...mcpServers, buddhi: { url, headers } } };
}

export interface McpInstallResult {
  configured: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export function installMcp(url: string, apiKey: string, cwd: string = process.cwd()): McpInstallResult {
  const mcpUrl = `${url.replace(/\/$/, "")}/mcp`;
  const result: McpInstallResult = { configured: [], skipped: [] };

  for (const target of targets(cwd)) {
    if (!target.applicable()) continue; // tool not found / not a project — silently skip, not an error

    const existing = readJson(target.configPath);
    if (existing === null) {
      result.skipped.push({ name: target.name, reason: `${target.configPath} exists but isn't valid JSON — left untouched` });
      continue;
    }

    try {
      if (existsSync(target.configPath)) {
        copyFileSync(target.configPath, `${target.configPath}.bak-${Date.now()}`);
      }
      mkdirSync(dirname(target.configPath), { recursive: true });
      const merged = mergeEntry(existing, target.shape, mcpUrl, apiKey);
      writeFileSync(target.configPath, JSON.stringify(merged, null, 2));
      result.configured.push(target.name);
    } catch (e) {
      result.skipped.push({ name: target.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}
