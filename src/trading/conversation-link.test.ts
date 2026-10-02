import { describe, expect, it } from "vitest";

import { attachedConversationHref } from "./conversation-link.ts";

describe("attached conversation link", () => {
  it("points at the stored thread and does not allocate a trading chat", () => {
    expect(attachedConversationHref("thread-from-store")).toBe("/?threadId=thread-from-store");
    expect(attachedConversationHref("thread/with space")).toBe("/?threadId=thread%2Fwith%20space");
    expect(attachedConversationHref("thread-from-store")).not.toContain("/desk");
    expect(attachedConversationHref("thread-from-store")).not.toContain("new");
  });
});
