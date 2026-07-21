import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_CHAT_FLOW,
  BUILTIN_CHAT_FLOW_ID,
  BUILTIN_CHAT_FLOW_VERSION,
  BUILTIN_REFLECTION_FLOW,
  BUILTIN_REFLECTION_FLOW_ID,
  BUILTIN_REFLECTION_FLOW_VERSION,
  ensureBuiltinFlows,
} from "../src/builtinFlows";

describe("built-in Flow catalog", () => {
  it("seeds the chat Flow when missing and never embeds a provider secret", async () => {
    const upsert = vi.fn(async () => undefined);
    const created = await ensureBuiltinFlows({ list: async () => [], upsert });

    expect(created).toBe(2);
    expect(upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: BUILTIN_CHAT_FLOW_ID,
      version: BUILTIN_CHAT_FLOW_VERSION,
      graph: BUILTIN_CHAT_FLOW,
    }));
    expect(upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: BUILTIN_REFLECTION_FLOW_ID,
      version: BUILTIN_REFLECTION_FLOW_VERSION,
      graph: BUILTIN_REFLECTION_FLOW,
    }));
    const serialized = JSON.stringify([BUILTIN_CHAT_FLOW, BUILTIN_REFLECTION_FLOW]);
    expect(serialized).toContain("$var:LLM_API_KEY");
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("preserves an existing locally edited built-in Flow", async () => {
    const upsert = vi.fn(async () => undefined);
    const created = await ensureBuiltinFlows({
      list: async () => [
        {
          id: BUILTIN_CHAT_FLOW_ID,
          version: BUILTIN_CHAT_FLOW_VERSION,
          name: "用户修改版",
          graph: { id: BUILTIN_CHAT_FLOW_ID, version: BUILTIN_CHAT_FLOW_VERSION },
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: BUILTIN_REFLECTION_FLOW_ID,
          version: BUILTIN_REFLECTION_FLOW_VERSION,
          name: "用户修改版反思",
          graph: { id: BUILTIN_REFLECTION_FLOW_ID, version: BUILTIN_REFLECTION_FLOW_VERSION },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      upsert,
    });

    expect(created).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
});
