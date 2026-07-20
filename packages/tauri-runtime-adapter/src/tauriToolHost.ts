import type {
  AgentToolCall,
  AgentToolHost,
  AgentToolName,
  AgentToolResult,
} from "../../../nkg-ai-flow/packages/runtime/src/nodes/builtin/agent.js";
import {
  PORTABLE_CORE_CAPABILITIES,
  createRuntimeCapabilityManifest,
  type RuntimeCapabilityManifest,
} from "../../../nkg-ai-flow/packages/runtime/src/browser.js";
import type { AppPlatform } from "@nkg-ai-bot/runtime-router";
import type { TauriInvoke } from "./index.js";

const READ_ONLY_TOOLS = new Set<AgentToolName>([
  "list_files",
  "read_file",
  "grep",
]);

export function createTauriPortableCapabilities(
  platform: AppPlatform,
): RuntimeCapabilityManifest {
  return createRuntimeCapabilityManifest({
    platform,
    available: [...PORTABLE_CORE_CAPABILITIES, "filesystem.read"],
  });
}

/**
 * A deliberately small native tool bridge. The native command independently
 * enforces the same allow-list and confines every path to app-local data.
 */
export function createTauriReadOnlyToolHost(options: {
  invoke: TauriInvoke;
}): AgentToolHost {
  return {
    async callTool(call, env): Promise<AgentToolResult> {
      const allowedTools = env.allowedTools.filter((tool) =>
        READ_ONLY_TOOLS.has(tool));
      if (!allowedTools.includes(call.tool)) {
        return denied(call, `tool ${call.tool} is not allowed by the portable runtime`);
      }
      return options.invoke<AgentToolResult>("runtime_tool_call", {
        call: sanitizeCall(call),
        policy: {
          allowedTools,
          maxOutputChars: Math.max(512, Math.min(env.maxOutputChars, 200_000)),
        },
      });
    },
  };
}

function sanitizeCall(call: AgentToolCall): AgentToolCall {
  return {
    tool: call.tool,
    args: Object.fromEntries(
      Object.entries(call.args).filter(([, value]) =>
        value === null || ["string", "number", "boolean"].includes(typeof value)),
    ),
  };
}

function denied(call: AgentToolCall, error: string): AgentToolResult {
  return { ok: false, error, output: { tool: call.tool } };
}
