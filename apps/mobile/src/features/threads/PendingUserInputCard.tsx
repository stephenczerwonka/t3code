import type { ApprovalRequestId, ProviderUserInputAction } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import {
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
  resolvePendingUserInputAnswer,
} from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly pendingUserInput: PendingUserInput;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string | string[]> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly onSelectOption: (
    requestId: ApprovalRequestId,
    questionId: string,
    optionValue: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: (action?: ProviderUserInputAction) => Promise<unknown>;
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  // The surface is opaque on purpose: the card floats over the thread feed
  // with no blur behind it, so a translucent background renders the questions
  // on top of whatever message happens to sit underneath.
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const responseActions = props.pendingUserInput.responseActions ?? [];
  const [reviewing, setReviewing] = useState(
    props.pendingUserInput.requiresReview === true && props.pendingUserInput.questions.length === 0,
  );
  useEffect(() => {
    setReviewing(
      props.pendingUserInput.requiresReview === true &&
        props.pendingUserInput.questions.length === 0,
    );
  }, [
    props.pendingUserInput.questions.length,
    props.pendingUserInput.requestId,
    props.pendingUserInput.requiresReview,
  ]);
  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        User input needed
      </Text>
      <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
        {props.pendingUserInput.message ?? "Fill in the pending answers"}
      </Text>
      {reviewing ? (
        <View className="gap-2">
          {props.pendingUserInput.questions.map((question) => {
            const answer = resolvePendingUserInputAnswer(question, props.drafts[question.id]);
            const values = answer === null ? [] : Array.isArray(answer) ? answer : [answer];
            const display = values.map(
              (value) =>
                question.options.find((option) => (option.value ?? option.label) === value)
                  ?.label ?? value,
            );
            return (
              <View
                key={question.id}
                className="rounded-2xl bg-white px-3.5 py-3 dark:bg-neutral-950/70"
              >
                <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500">
                  {question.header}
                </Text>
                <Text className="mt-1 font-sans text-base text-neutral-950 dark:text-neutral-50">
                  {display.length > 0 ? display.join(", ") : "Skipped"}
                </Text>
              </View>
            );
          })}
        </View>
      ) : (
        props.pendingUserInput.questions.map((question) => {
          const draft = props.drafts[question.id];
          return (
            <View key={question.id} className="gap-2 pt-1">
              <View className="flex-row items-center gap-2">
                <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500 dark:text-neutral-500">
                  {question.header}
                </Text>
                {question.required === false ? (
                  <Text className="font-sans text-xs text-neutral-500">Optional</Text>
                ) : null}
              </View>
              <Text className="font-sans text-base leading-snug text-neutral-950 dark:text-neutral-50">
                {question.question}
              </Text>
              {question.multiSelect ? (
                <Text className="font-sans text-xs text-neutral-500">
                  Select one or more options.
                </Text>
              ) : null}
              <View className="flex-row flex-wrap gap-2.5">
                {question.options.map((option) => {
                  const optionValue = option.value ?? option.label;
                  const selected =
                    draft?.selectedOptionLabels?.includes(optionValue) === true &&
                    !draft.customAnswer?.trim().length;
                  return (
                    <Pressable
                      key={optionValue}
                      className={cn(
                        "rounded-full border px-3 py-2.5 ",
                        selected
                          ? "border-blue-300/50 bg-blue-50 dark:border-blue-400/28 dark:bg-blue-400/14"
                          : "border-neutral-200 bg-white dark:border-white/6 dark:bg-neutral-950/70",
                      )}
                      onPress={() =>
                        props.onSelectOption(
                          props.pendingUserInput.requestId,
                          question.id,
                          optionValue,
                        )
                      }
                    >
                      <Text
                        className={cn(
                          "font-t3-bold text-sm",
                          selected
                            ? "text-sky-700 dark:text-sky-300"
                            : "text-neutral-600 dark:text-neutral-300",
                        )}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {!question.multiSelect ? (
                <TextInput
                  value={draft?.customAnswer ?? ""}
                  onChangeText={(value) =>
                    props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
                  }
                  placeholder="Or type a custom answer"
                  className="min-h-[54px] rounded-2xl border border-neutral-200 bg-white px-3.5 py-3 font-sans text-base text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50"
                />
              ) : null}
            </View>
          );
        })
      )}
      {reviewing && props.pendingUserInput.questions.length > 0 ? (
        <Pressable
          className="self-start rounded-xl border border-neutral-300 px-3 py-2.5 dark:border-white/10"
          disabled={isResponding}
          onPress={() => setReviewing(false)}
        >
          <Text className="font-t3-bold text-sm text-neutral-700 dark:text-neutral-200">Back</Text>
        </Pressable>
      ) : null}
      {responseActions.length > 0 ? (
        <View className="flex-row justify-end gap-2">
          {responseActions.includes("decline") ? (
            <Pressable
              className="rounded-xl border border-neutral-300 px-3 py-2.5 dark:border-white/10"
              disabled={isResponding}
              onPress={() => void props.onSubmit("decline")}
            >
              <Text className="font-t3-bold text-sm text-neutral-700 dark:text-neutral-200">
                Decline
              </Text>
            </Pressable>
          ) : null}
          {responseActions.includes("cancel") ? (
            <Pressable
              className="rounded-xl px-3 py-2.5"
              disabled={isResponding}
              onPress={() => void props.onSubmit("cancel")}
            >
              <Text className="font-t3-bold text-sm text-neutral-500">Cancel</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <Pressable
        className={cn(
          "items-center justify-center rounded-2xl px-4 py-3.5",
          props.answers ? "bg-blue-500" : "bg-neutral-200 dark:bg-neutral-700/60",
        )}
        disabled={props.answers === null || isResponding}
        onPress={() => {
          if (props.pendingUserInput.requiresReview === true && !reviewing) {
            setReviewing(true);
            return;
          }
          void props.onSubmit("accept");
        }}
      >
        <Text className="font-t3-extrabold text-sm text-white">
          {props.pendingUserInput.requiresReview === true && !reviewing
            ? "Review answers"
            : "Submit answers"}
        </Text>
      </Pressable>
    </View>
  );
}
