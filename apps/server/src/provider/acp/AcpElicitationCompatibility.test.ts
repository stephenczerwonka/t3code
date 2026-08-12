import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import {
  CurrentAcpElicitationCreateRequest,
  CurrentAcpElicitationCreateResponse,
  isCurrentFormRequest,
  isCurrentSessionFormRequest,
  makeCurrentAcpElicitationResponse,
  makeLegacyAcpElicitationResponse,
  mapAcpFormToUserInput,
  normalizeAcpFormAnswers,
} from "./AcpElicitationCompatibility.ts";

const decodeRequest = Schema.decodeUnknownSync(CurrentAcpElicitationCreateRequest);
const decodeResponse = Schema.decodeUnknownSync(CurrentAcpElicitationCreateResponse);

const request = decodeRequest({
  sessionId: "session-1",
  toolCallId: "tool-1",
  mode: "form",
  message: "Configure the migration.",
  requestedSchema: {
    type: "object",
    title: "Migration",
    properties: {
      strategy: {
        type: "string",
        title: "Strategy",
        description: "Choose a migration strategy.",
        oneOf: [
          { title: "Safe", const: "conservative" },
          { title: "Fast", const: "aggressive" },
        ],
      },
      tags: {
        type: "array",
        title: "Tags",
        items: { type: "string", enum: ["tests", "docs"] },
        minItems: 1,
      },
      retries: {
        type: "integer",
        minimum: 1,
        maximum: 5,
      },
      enabled: {
        type: "boolean",
      },
      note: {
        type: "string",
        minLength: 3,
      },
    },
    required: ["strategy", "tags", "retries", "enabled"],
  },
});

if (!isCurrentSessionFormRequest(request)) {
  throw new Error("expected session-scoped form request");
}

describe("AcpElicitationCompatibility", () => {
  it("maps current ACP forms to reviewable canonical questions", () => {
    expect(mapAcpFormToUserInput(request)).toEqual({
      message: "Configure the migration.",
      questions: [
        {
          id: "strategy",
          header: "Strategy",
          question: "Choose a migration strategy.",
          options: [
            { label: "Safe", description: "Safe", value: "conservative" },
            { label: "Fast", description: "Fast", value: "aggressive" },
          ],
          multiSelect: false,
          required: true,
        },
        {
          id: "tags",
          header: "Tags",
          question: "Configure the migration.",
          options: [
            { label: "tests", description: "tests", value: "tests" },
            { label: "docs", description: "docs", value: "docs" },
          ],
          multiSelect: true,
          required: true,
        },
        {
          id: "retries",
          header: "Migration",
          question: "Configure the migration.",
          options: [],
          multiSelect: false,
          required: true,
        },
        {
          id: "enabled",
          header: "Migration",
          question: "Configure the migration.",
          options: [
            { label: "Yes", description: "Yes", value: "true" },
            { label: "No", description: "No", value: "false" },
          ],
          multiSelect: false,
          required: true,
        },
        {
          id: "note",
          header: "Migration",
          question: "Configure the migration.",
          options: [],
          multiSelect: false,
          required: false,
        },
      ],
    });
  });

  it.effect("converts accepted answers to typed ACP form content", () =>
    Effect.gen(function* () {
      const content = yield* normalizeAcpFormAnswers(request, {
        strategy: "conservative",
        tags: ["tests", "docs"],
        retries: "3",
        enabled: "true",
        note: "ship it",
      });
      expect(content).toEqual({
        strategy: "conservative",
        tags: ["tests", "docs"],
        retries: 3,
        enabled: true,
        note: "ship it",
      });
    }),
  );

  it.effect("accepts unambiguous display labels from older clients", () =>
    Effect.gen(function* () {
      const content = yield* normalizeAcpFormAnswers(request, {
        strategy: "Safe",
        tags: ["tests"],
        retries: 1,
        enabled: "Yes",
      });
      expect(content).toEqual({
        strategy: "conservative",
        tags: ["tests"],
        retries: 1,
        enabled: true,
      });
    }),
  );

  it.effect("omits unanswered optional properties", () =>
    Effect.gen(function* () {
      const content = yield* normalizeAcpFormAnswers(request, {
        strategy: "aggressive",
        tags: ["tests"],
        retries: 1,
        enabled: false,
      });
      expect(content).toEqual({
        strategy: "aggressive",
        tags: ["tests"],
        retries: 1,
        enabled: false,
      });
    }),
  );

  it.effect("keeps invalid answers recoverable in the error channel", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        normalizeAcpFormAnswers(request, {
          strategy: "unknown",
          tags: [],
          retries: 8,
          enabled: "maybe",
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("validates standard ACP string formats", () =>
    Effect.gen(function* () {
      const emailRequest = decodeRequest({
        sessionId: "session-1",
        mode: "form",
        message: "Enter an email.",
        requestedSchema: {
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
        },
      });
      if (!isCurrentSessionFormRequest(emailRequest)) {
        return yield* Effect.die("expected session form");
      }
      const invalid = yield* Effect.exit(
        normalizeAcpFormAnswers(emailRequest, { email: "not-an-email" }),
      );
      expect(invalid._tag).toBe("Failure");
      expect(yield* normalizeAcpFormAnswers(emailRequest, { email: "dev@example.com" })).toEqual({
        email: "dev@example.com",
      });
    }),
  );

  it("uses flat responses for current ACP and nested responses for legacy ACP", () => {
    expect(decodeResponse(makeCurrentAcpElicitationResponse("accept", { enabled: true }))).toEqual({
      action: "accept",
      content: { enabled: true },
    });
    expect(makeCurrentAcpElicitationResponse("decline", {})).toEqual({ action: "decline" });
    expect(makeCurrentAcpElicitationResponse("cancel", {})).toEqual({ action: "cancel" });
    expect(makeLegacyAcpElicitationResponse("accept", { enabled: true })).toEqual({
      action: { action: "accept", content: { enabled: true } },
    });
    expect(makeLegacyAcpElicitationResponse("decline", {})).toEqual({
      action: { action: "decline" },
    });
  });

  it("decodes request-scoped forms and tolerates compatibility type values", () => {
    const formRequest = decodeRequest({
      requestId: 41,
      mode: "form",
      message: "Choose a value.",
      requestedSchema: {
        type: null,
        properties: {},
      },
    });
    expect(isCurrentFormRequest(formRequest)).toBe(true);
    expect(isCurrentSessionFormRequest(formRequest)).toBe(false);
  });

  it("decodes URL requests without treating them as supported form requests", () => {
    const urlRequest = decodeRequest({
      requestId: 42,
      mode: "url",
      elicitationId: "auth-1",
      url: "https://example.com/connect",
      message: "Authorize access.",
    });
    expect(isCurrentSessionFormRequest(urlRequest)).toBe(false);
  });
});
