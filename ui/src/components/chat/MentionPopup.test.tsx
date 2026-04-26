import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MentionPopup } from "./MentionPopup";

describe("MentionPopup", () => {
  it("renders items when open", () => {
    const html = renderToStaticMarkup(
      <MentionPopup
        open={true}
        items={[{ label: "alice", value: "@alice" }]}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("alice");
  });

  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      <MentionPopup
        open={false}
        items={[{ label: "alice", value: "@alice" }]}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toBe("");
  });
});
