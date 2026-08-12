import {
  type ProviderUserInputAction,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AcpSchema from "effect-acp/schema";

import { ProviderAdapterValidationError } from "../Errors.ts";

const Meta = Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)));

const RequestedSchema = Schema.Struct({
  type: Schema.optionalKey(Schema.Unknown),
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  properties: Schema.optionalKey(Schema.Record(Schema.String, AcpSchema.ElicitationPropertySchema)),
  required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});

const CurrentSessionFormRequest = Schema.Struct({
  mode: Schema.Literal("form"),
  sessionId: Schema.String,
  toolCallId: Schema.optionalKey(Schema.String),
  message: Schema.String,
  requestedSchema: RequestedSchema,
  _meta: Meta,
});

const CurrentRequestFormRequest = Schema.Struct({
  mode: Schema.Literal("form"),
  requestId: AcpSchema.RequestId,
  message: Schema.String,
  requestedSchema: RequestedSchema,
  _meta: Meta,
});

const CurrentSessionUrlRequest = Schema.Struct({
  mode: Schema.Literal("url"),
  sessionId: Schema.String,
  toolCallId: Schema.optionalKey(Schema.String),
  elicitationId: Schema.String,
  url: Schema.String,
  message: Schema.String,
  _meta: Meta,
});

const CurrentRequestUrlRequest = Schema.Struct({
  mode: Schema.Literal("url"),
  requestId: AcpSchema.RequestId,
  elicitationId: Schema.String,
  url: Schema.String,
  message: Schema.String,
  _meta: Meta,
});

export const CurrentAcpElicitationCreateRequest = Schema.Union([
  CurrentSessionFormRequest,
  CurrentRequestFormRequest,
  CurrentSessionUrlRequest,
  CurrentRequestUrlRequest,
]);
export type CurrentAcpElicitationCreateRequest = typeof CurrentAcpElicitationCreateRequest.Type;
export type CurrentAcpSessionFormRequest = typeof CurrentSessionFormRequest.Type;
export type CurrentAcpFormRequest =
  | CurrentAcpSessionFormRequest
  | typeof CurrentRequestFormRequest.Type;

const CurrentAcpElicitationContent = Schema.Record(
  Schema.String,
  AcpSchema.ElicitationContentValue,
);

export const CurrentAcpElicitationCreateResponse = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("accept"),
    content: Schema.optionalKey(Schema.NullOr(CurrentAcpElicitationContent)),
  }),
  Schema.Struct({ action: Schema.Literal("decline") }),
  Schema.Struct({ action: Schema.Literal("cancel") }),
]);
export type CurrentAcpElicitationCreateResponse = typeof CurrentAcpElicitationCreateResponse.Type;

export interface NormalizedAcpForm {
  readonly message: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function propertyOptions(
  property: AcpSchema.ElicitationPropertySchema,
): ReadonlyArray<UserInputQuestion["options"][number]> {
  if (property.type === "string") {
    if (property.oneOf && property.oneOf.length > 0) {
      return property.oneOf.map((option) => ({
        label: nonEmpty(option.title) ?? option.const,
        description: nonEmpty(option.title) ?? option.const,
        value: option.const,
      }));
    }
    return (property.enum ?? []).map((value) => ({
      label: value,
      description: value,
      value,
    }));
  }
  if (property.type === "boolean") {
    return [
      { label: "Yes", description: "Yes", value: "true" },
      { label: "No", description: "No", value: "false" },
    ];
  }
  if (property.type !== "array") {
    return [];
  }
  if ("enum" in property.items) {
    return property.items.enum.map((value) => ({
      label: value,
      description: value,
      value,
    }));
  }
  return property.items.anyOf.map((option) => ({
    label: nonEmpty(option.title) ?? option.const,
    description: nonEmpty(option.title) ?? option.const,
    value: option.const,
  }));
}

export function isCurrentFormRequest(
  request: CurrentAcpElicitationCreateRequest,
): request is CurrentAcpFormRequest {
  return request.mode === "form";
}

export function isCurrentSessionFormRequest(
  request: CurrentAcpElicitationCreateRequest,
): request is CurrentAcpSessionFormRequest {
  return isCurrentFormRequest(request) && "sessionId" in request;
}

export function mapAcpFormToUserInput(
  request: CurrentAcpFormRequest | AcpSchema.ElicitationRequest,
): NormalizedAcpForm {
  if (request.mode !== "form") {
    return { message: request.message, questions: [] };
  }
  const required = new Set(request.requestedSchema.required ?? []);
  const schemaTitle = nonEmpty(request.requestedSchema.title);
  const message = nonEmpty(request.message) ?? schemaTitle ?? "Input requested";
  const entries = Object.entries(request.requestedSchema.properties ?? {});
  return {
    message,
    questions: entries.map(([id, property], index) => ({
      id,
      header: nonEmpty(property.title) ?? schemaTitle ?? `Question ${index + 1}`,
      question: nonEmpty(property.description) ?? message,
      options: propertyOptions(property),
      multiSelect: property.type === "array",
      required: required.has(id),
    })),
  };
}

function validationError(issue: string): ProviderAdapterValidationError {
  return new ProviderAdapterValidationError({
    provider: "devin",
    operation: "respondToUserInput",
    issue,
  });
}

function asString(
  value: unknown,
  key: string,
): Effect.Effect<string, ProviderAdapterValidationError> {
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(validationError(`Answer '${key}' must be a string.`));
}

function parseNumber(
  value: unknown,
  key: string,
  integer: boolean,
): Effect.Effect<number, ProviderAdapterValidationError> {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    return Effect.fail(validationError(`Answer '${key}' must be a finite number.`));
  }
  if (integer && !Number.isInteger(parsed)) {
    return Effect.fail(validationError(`Answer '${key}' must be an integer.`));
  }
  return Effect.succeed(parsed);
}

function validateString(
  key: string,
  value: string,
  property: Extract<AcpSchema.ElicitationPropertySchema, { readonly type: "string" }>,
): Effect.Effect<string, ProviderAdapterValidationError> {
  let normalized = value;
  if (property.oneOf && property.oneOf.length > 0) {
    const exact = property.oneOf.find((option) => option.const === value);
    const legacyMatches = property.oneOf.filter((option) => option.title === value);
    if (exact) {
      normalized = exact.const;
    } else if (legacyMatches.length === 1 && legacyMatches[0]) {
      normalized = legacyMatches[0].const;
    } else {
      return Effect.fail(validationError(`Answer '${key}' must match an available option.`));
    }
  } else if (property.enum && !property.enum.includes(value)) {
    return Effect.fail(validationError(`Answer '${key}' must match an available option.`));
  }
  if (
    property.minLength !== undefined &&
    property.minLength !== null &&
    normalized.length < property.minLength
  ) {
    return Effect.fail(
      validationError(`Answer '${key}' is shorter than ${property.minLength} characters.`),
    );
  }
  if (
    property.maxLength !== undefined &&
    property.maxLength !== null &&
    normalized.length > property.maxLength
  ) {
    return Effect.fail(
      validationError(`Answer '${key}' is longer than ${property.maxLength} characters.`),
    );
  }
  const validFormat = (() => {
    switch (property.format) {
      case "email":
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
      case "uri":
        return URL.canParse(normalized);
      case "date":
        return (
          /^\d{4}-\d{2}-\d{2}$/.test(normalized) &&
          Number.isFinite(Date.parse(`${normalized}T00:00:00Z`))
        );
      case "date-time":
        return normalized.includes("T") && Number.isFinite(Date.parse(normalized));
      default:
        return true;
    }
  })();
  return validFormat
    ? Effect.succeed(normalized)
    : Effect.fail(validationError(`Answer '${key}' does not match the requested format.`));
}

function convertAnswer(
  key: string,
  answer: unknown,
  property: AcpSchema.ElicitationPropertySchema,
): Effect.Effect<AcpSchema.ElicitationContentValue, ProviderAdapterValidationError> {
  switch (property.type) {
    case "string":
      return asString(answer, key).pipe(
        Effect.flatMap((value) => validateString(key, value, property)),
      );
    case "boolean":
      if (typeof answer === "boolean") return Effect.succeed(answer);
      if (answer === "true" || answer === "Yes") return Effect.succeed(true);
      if (answer === "false" || answer === "No") return Effect.succeed(false);
      return Effect.fail(validationError(`Answer '${key}' must be Yes or No.`));
    case "number":
    case "integer":
      return parseNumber(answer, key, property.type === "integer").pipe(
        Effect.flatMap((value) => {
          if (
            property.minimum !== undefined &&
            property.minimum !== null &&
            value < property.minimum
          ) {
            return Effect.fail(
              validationError(`Answer '${key}' must be at least ${property.minimum}.`),
            );
          }
          if (
            property.maximum !== undefined &&
            property.maximum !== null &&
            value > property.maximum
          ) {
            return Effect.fail(
              validationError(`Answer '${key}' must be at most ${property.maximum}.`),
            );
          }
          return Effect.succeed(value);
        }),
      );
    case "array": {
      if (!Array.isArray(answer) || !answer.every((entry) => typeof entry === "string")) {
        return Effect.fail(validationError(`Answer '${key}' must be a list of options.`));
      }
      const values = [...new Set(answer)];
      const normalized = values.flatMap((value) => {
        if ("enum" in property.items) {
          return property.items.enum.includes(value) ? [value] : [];
        }
        const exact = property.items.anyOf.find((option) => option.const === value);
        if (exact) return [exact.const];
        const legacyMatches = property.items.anyOf.filter((option) => option.title === value);
        return legacyMatches.length === 1 && legacyMatches[0] ? [legacyMatches[0].const] : [];
      });
      if (normalized.length !== values.length) {
        return Effect.fail(validationError(`Answer '${key}' contains an unavailable option.`));
      }
      if (
        property.minItems !== undefined &&
        property.minItems !== null &&
        values.length < property.minItems
      ) {
        return Effect.fail(
          validationError(`Answer '${key}' requires at least ${property.minItems} selections.`),
        );
      }
      if (
        property.maxItems !== undefined &&
        property.maxItems !== null &&
        values.length > property.maxItems
      ) {
        return Effect.fail(
          validationError(`Answer '${key}' allows at most ${property.maxItems} selections.`),
        );
      }
      return Effect.succeed(normalized);
    }
  }
}

export const normalizeAcpFormAnswers = Effect.fn("normalizeAcpFormAnswers")(function* (
  request: CurrentAcpFormRequest | Extract<AcpSchema.ElicitationRequest, { readonly mode: "form" }>,
  answers: ProviderUserInputAnswers,
) {
  const properties = request.requestedSchema.properties ?? {};
  const required = new Set(request.requestedSchema.required ?? []);
  for (const key of Object.keys(answers)) {
    if (!(key in properties)) {
      return yield* validationError(`Unknown answer key '${key}'.`);
    }
  }
  const content: Record<string, AcpSchema.ElicitationContentValue> = {};
  for (const [key, property] of Object.entries(properties)) {
    const answer = answers[key];
    if (answer === undefined || answer === null || answer === "") {
      if (required.has(key)) {
        return yield* validationError(`Answer '${key}' is required.`);
      }
      continue;
    }
    content[key] = yield* convertAnswer(key, answer, property);
  }
  return content;
});

export function makeCurrentAcpElicitationResponse(
  action: ProviderUserInputAction,
  content: Readonly<Record<string, AcpSchema.ElicitationContentValue>>,
): CurrentAcpElicitationCreateResponse {
  return action === "accept" ? { action, content } : { action };
}

export function makeLegacyAcpElicitationResponse(
  action: ProviderUserInputAction,
  content: Readonly<Record<string, AcpSchema.ElicitationContentValue>>,
): AcpSchema.ElicitationResponse {
  return {
    action: action === "accept" ? { action, content } : { action },
  };
}
