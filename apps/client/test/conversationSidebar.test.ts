import { describe, expect, it } from "vitest";
import type { AssistantSkillIndex } from "../src/assistantSkills";
import { buildConversationSkillSections } from "../src/ConversationSidebar";
import type { LocalConversation } from "../src/storage/repositories";

function skill(assistantId: string, name: string): AssistantSkillIndex {
  return {
    assistantId,
    activeVersion: "1.0.0",
    name,
    description: "",
    flowId: `flow-${assistantId}`,
    flowVersion: "1.0.0",
    capabilities: [],
    activationHints: [],
    pinned: false,
    archived: false,
    useCount: 0,
    successCount: 0,
    failureCount: 0,
    updatedAt: 1,
  };
}

function conversation(id: string, assistantId?: string): LocalConversation {
  return {
    id,
    title: id,
    ...(assistantId ? { assistantId } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("conversation skill sections", () => {
  it("partitions conversations by assistant skill", () => {
    const sections = buildConversationSkillSections(
      [conversation("chat-b", "skill-b"), conversation("chat-a", "skill-a")],
      [skill("skill-b", "写作"), skill("skill-a", "编程")],
    );

    expect(sections.map((section) => section.name)).toEqual(["编程", "写作"]);
    expect(sections[0]?.conversations.map(({ id }) => id)).toEqual(["chat-a"]);
    expect(sections[1]?.conversations.map(({ id }) => id)).toEqual(["chat-b"]);
  });

  it("keeps legacy and unknown-skill conversations visible", () => {
    const sections = buildConversationSkillSections(
      [conversation("legacy"), conversation("unknown", "removed-skill")],
      [],
    );

    expect(sections.map((section) => section.assistantId).sort()).toEqual(["builtin_assistant", "removed-skill"]);
    expect(sections.flatMap((section) => section.conversations).map(({ id }) => id).sort()).toEqual(["legacy", "unknown"]);
  });
});
