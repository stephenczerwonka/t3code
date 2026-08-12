import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadPr } from "./thread-pr-presentation";

const pullRequest: NonNullable<VcsStatusResult["pr"]> = {
  number: 3774,
  title: "Desktop-style pull request indicator",
  url: "https://github.com/t3tools/t3code/pull/3774",
  baseRef: "main",
  headRef: "codex/desktop-style-pr-indicator",
  state: "merged",
  updatedAt: "2026-04-10T00:00:00.000Z",
};

describe("presentThreadPr", () => {
  it("uses the compact pull request number label without a hash prefix", () => {
    expect(presentThreadPr(pullRequest, undefined)).toMatchObject({
      label: "3774",
      updatedAt: "2026-04-10T00:00:00.000Z",
      accessibilityLabel: "#3774 pull request merged",
      textClassName: "text-violet-600 dark:text-violet-400",
    });
  });

  it("uses merge-request terminology for GitLab", () => {
    expect(
      presentThreadPr(pullRequest, {
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      }),
    ).toMatchObject({
      label: "3774",
      accessibilityLabel: "#3774 merge request merged",
    });
  });
});
