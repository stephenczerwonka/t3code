import { type ApprovalRequestId, type ProviderUserInputAction } from "@t3tools/contracts";
import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
  resolvePendingUserInputAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onRespond: (action: ProviderUserInputAction) => void;
  onAdvance: () => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onRespond,
  onAdvance,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onRespond={onRespond}
      onAdvance={onAdvance}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onRespond,
  onAdvance,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onRespond: (action: ProviderUserInputAction) => void;
  onAdvance: () => void;
}) {
  const progress = derivePendingUserInputProgress(
    prompt.questions,
    answers,
    questionIndex,
    prompt.requiresReview === true,
  );
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  useEffect(() => {
    if (!activeQuestion || activeQuestion.multiSelect || !optimisticSingleSelect) {
      return;
    }
    if (optimisticSingleSelect.questionId !== activeQuestion.id) {
      setOptimisticSingleSelect(null);
      return;
    }
    if (
      progress.customAnswer.trim().length === 0 &&
      progress.selectedOptionLabels.includes(optimisticSingleSelect.optionValue)
    ) {
      setOptimisticSingleSelect(null);
    }
  }, [
    activeQuestion,
    optimisticSingleSelect,
    progress.customAnswer,
    progress.selectedOptionLabels,
  ]);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const handleOptionSelection = useEffectEvent((questionId: string, optionValue: string) => {
    if (activeQuestion?.multiSelect) {
      onToggleOption(questionId, optionValue);
      return;
    }
    setOptimisticSingleSelect({ questionId, optionValue });
    onToggleOption(questionId, optionValue);
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      onAdvanceRef.current();
    }, 200);
  });

  // Keyboard shortcut: number keys 1-9 select corresponding options when focus is
  // outside editable fields. Multi-select prompts toggle options in place; single-
  // select prompts keep the existing auto-advance behavior.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding]);

  const responseActions = prompt.responseActions ?? [];
  const actionButtons =
    responseActions.length > 0 ? (
      <div className="mt-3 flex items-center justify-end gap-2">
        {responseActions.includes("decline") ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isResponding}
            onClick={() => onRespond("decline")}
          >
            Decline
          </Button>
        ) : null}
        {responseActions.includes("cancel") ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isResponding}
            onClick={() => onRespond("cancel")}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    ) : null;

  if (progress.isReviewing || !activeQuestion) {
    return (
      <div className="px-4 py-3 sm:px-5">
        <span className="text-secondary-label text-[11px] font-semibold tracking-widest uppercase">
          Review
        </span>
        {prompt.message ? (
          <p className="mt-2 text-sm text-foreground/90">{prompt.message}</p>
        ) : null}
        {prompt.questions.length > 0 ? (
          <div className="mt-3 space-y-2">
            {prompt.questions.map((question) => {
              const answer = resolvePendingUserInputAnswer(question, answers[question.id]);
              const values = answer === null ? [] : Array.isArray(answer) ? answer : [answer];
              const display = values.map(
                (value) =>
                  question.options.find((option) => (option.value ?? option.label) === value)
                    ?.label ?? value,
              );
              return (
                <div key={question.id} className="rounded-lg bg-muted/30 px-3 py-2">
                  <p className="text-secondary-label text-xs">{question.header}</p>
                  <p className="mt-0.5 text-sm text-foreground/90">
                    {display.length > 0 ? display.join(", ") : "Skipped"}
                  </p>
                </div>
              );
            })}
          </div>
        ) : null}
        {actionButtons}
      </div>
    );
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;

  return (
    <div className="px-4 py-3 sm:px-5">
      {prompt.message ? <p className="mb-3 text-sm text-foreground/90">{prompt.message}</p> : null}
      <div className="mb-2 flex items-center gap-3">
        <span className="text-secondary-label text-[11px] font-semibold tracking-widest uppercase">
          {activeQuestion.header}
        </span>
        {activeQuestion.required === false ? (
          <span className="text-secondary-label text-[10px]">Optional</span>
        ) : null}
        {prompt.questions.length > 1 ? (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-secondary-label text-[10px] font-medium tabular-nums">
            {questionIndex + 1}/{prompt.questions.length}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-foreground/90">{activeQuestion.question}</p>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-secondary-label text-xs">Select one or more options.</p>
      ) : null}
      <div className="mt-3 space-y-1.5">
        {activeQuestion.options.map((option, index) => {
          const optionValue = option.value ?? option.label;
          const isOptimisticallySelected =
            optimisticSingleSelect?.questionId === activeQuestion.id &&
            optimisticSingleSelect.optionValue === optionValue;
          const isSelected =
            isOptimisticallySelected ||
            (!customAnswerActive && progress.selectedOptionLabels.includes(optionValue));
          const shortcutKey = index < 9 ? index + 1 : null;
          const className = cn(
            "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25",
            isSelected
              ? "border-primary/30 bg-primary/8 text-foreground"
              : "border-transparent bg-muted/22 text-foreground/85 hover:border-border/45 hover:bg-muted/34",
            isResponding && "opacity-50 cursor-not-allowed",
            !isResponding && "cursor-pointer",
          );
          const content = (
            <>
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="text-secondary-label text-xs">{option.description}</span>
                ) : null}
              </div>
              {isSelected ? (
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
              ) : shortcutKey !== null ? (
                <kbd
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded border border-border/50 text-[11px] font-medium tabular-nums transition-colors duration-150",
                    "bg-background/35 text-secondary-label group-hover:border-border/70 group-hover:text-foreground",
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
            </>
          );
          return (
            <button
              key={`${activeQuestion.id}:${optionValue}`}
              type="button"
              disabled={isResponding}
              onClick={() => {
                handleOptionSelection(activeQuestion.id, optionValue);
              }}
              className={className}
            >
              {content}
            </button>
          );
        })}
      </div>
      {actionButtons}
    </div>
  );
});
