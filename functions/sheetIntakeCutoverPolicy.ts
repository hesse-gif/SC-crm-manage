import type {
  SheetCutoverRecord,
  SheetCutoverState,
} from "./sheetIntakeTypes";

export interface SheetCutoverTransitionPolicyInput {
  current: SheetCutoverRecord;
  targetState: SheetCutoverState;
  requestedCheckpoint: SheetCutoverState | null;
  requestedTargetExitAt: string | null;
  nowMs: number;
}

export interface SheetCutoverTransitionPolicy {
  rollbackCheckpoint: SheetCutoverState | null;
  targetExitAt: string | null;
  isRollback: boolean;
}

/** Pure policy shared by preview and apply so the two paths cannot drift. */
export function evaluateSheetCutoverTransition(
  input: SheetCutoverTransitionPolicyInput,
): SheetCutoverTransitionPolicy {
  const { current, targetState } = input;
  if (current.state === "retired" || current.state === targetState) {
    throw invalidTransition(current.state, targetState);
  }

  if (current.state === "shadow" && targetState === "dual_read") {
    if (input.requestedCheckpoint && input.requestedCheckpoint !== "shadow") {
      throw failedPrecondition("shadow to dual_read must use shadow as its rollback checkpoint");
    }
    const exitAtMs = Date.parse(input.requestedTargetExitAt ?? "");
    if (!Number.isFinite(exitAtMs) || exitAtMs <= input.nowMs) {
      throw failedPrecondition("entering dual_read requires a future targetExitAt deadline");
    }
    return {
      rollbackCheckpoint: "shadow",
      targetExitAt: input.requestedTargetExitAt,
      isRollback: false,
    };
  }

  if (current.state === "dual_read" && targetState === "shadow") {
    assertNoDeadlineRewrite(current.targetExitAt, input.requestedTargetExitAt);
    if (input.requestedCheckpoint && input.requestedCheckpoint !== "shadow") {
      throw failedPrecondition("dual_read rollback checkpoint cannot be changed");
    }
    return { rollbackCheckpoint: null, targetExitAt: null, isRollback: true };
  }

  if (current.state === "dual_read" && targetState === "primary") {
    assertNoDeadlineRewrite(current.targetExitAt, input.requestedTargetExitAt);
    const checkpoint = input.requestedCheckpoint ?? "dual_read";
    assertLegacyCheckpoint(checkpoint);
    return {
      rollbackCheckpoint: checkpoint,
      targetExitAt: requiredExistingDeadline(current.targetExitAt),
      isRollback: false,
    };
  }

  if (current.state === "primary" && targetState === "rollbackable_primary") {
    assertNoDeadlineRewrite(current.targetExitAt, input.requestedTargetExitAt);
    const checkpoint = current.rollbackCheckpoint ?? input.requestedCheckpoint;
    assertLegacyCheckpoint(checkpoint);
    if (
      input.requestedCheckpoint &&
      current.rollbackCheckpoint &&
      input.requestedCheckpoint !== current.rollbackCheckpoint
    ) {
      throw failedPrecondition("rollback checkpoint cannot change during promotion");
    }
    return {
      rollbackCheckpoint: checkpoint,
      targetExitAt: requiredExistingDeadline(current.targetExitAt),
      isRollback: false,
    };
  }

  if (
    (current.state === "primary" || current.state === "rollbackable_primary") &&
    targetState === (current.rollbackCheckpoint ?? input.requestedCheckpoint)
  ) {
    const checkpoint = current.rollbackCheckpoint ?? input.requestedCheckpoint;
    assertLegacyCheckpoint(checkpoint);
    if (
      input.requestedCheckpoint &&
      current.rollbackCheckpoint &&
      input.requestedCheckpoint !== current.rollbackCheckpoint
    ) {
      throw failedPrecondition("rollback checkpoint cannot change during rollback");
    }
    assertNoDeadlineRewrite(current.targetExitAt, input.requestedTargetExitAt);
    return targetState === "shadow"
      ? { rollbackCheckpoint: null, targetExitAt: null, isRollback: true }
      : {
          rollbackCheckpoint: "shadow",
          targetExitAt: requiredExistingDeadline(current.targetExitAt),
          isRollback: true,
        };
  }

  if (current.state === "rollbackable_primary" && targetState === "retired") {
    assertNoDeadlineRewrite(current.targetExitAt, input.requestedTargetExitAt);
    if (
      input.requestedCheckpoint &&
      input.requestedCheckpoint !== current.rollbackCheckpoint
    ) {
      throw failedPrecondition("rollback checkpoint cannot change during retirement");
    }
    assertLegacyCheckpoint(current.rollbackCheckpoint);
    return {
      rollbackCheckpoint: current.rollbackCheckpoint,
      targetExitAt: requiredExistingDeadline(current.targetExitAt),
      isRollback: false,
    };
  }

  throw invalidTransition(current.state, targetState);
}

function assertNoDeadlineRewrite(current: string | null, requested: string | null): void {
  if (requested && requested !== current) {
    throw failedPrecondition("targetExitAt cannot change after entering dual_read");
  }
}

function requiredExistingDeadline(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw failedPrecondition("cutover source is missing its targetExitAt deadline");
  }
  return value;
}

function assertLegacyCheckpoint(
  value: SheetCutoverState | null,
): asserts value is "shadow" | "dual_read" {
  if (value !== "shadow" && value !== "dual_read") {
    throw failedPrecondition("rollback checkpoint must be shadow or dual_read");
  }
}

function invalidTransition(current: SheetCutoverState, target: SheetCutoverState): Error {
  return failedPrecondition(`invalid cutover transition ${current} -> ${target}`);
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}
