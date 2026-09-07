import React, { useState, useEffect, useRef, useCallback } from "react";
import { evaluateMathExpression } from "../utils/mathExpr";
import { beginHistoryBatch, endHistoryBatch } from "../document/store";

export interface StepperButtonsProps {
  onStep: (dir: 1 | -1, shift: boolean, alt: boolean) => void;
  onStart?: () => void;
  onEnd?: () => void;
  disabled?: boolean;
}

export function StepperButtons({ onStep, onStart, onEnd, disabled }: StepperButtonsProps) {
  const timerRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const activeRef = useRef(false);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (activeRef.current) {
      activeRef.current = false;
      onEnd?.();
    }
  }, [onEnd]);

  const handlePointerDown = (dir: 1 | -1, e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    activeRef.current = true;
    onStart?.();
    const shift = e.shiftKey;
    const alt = e.altKey;
    onStep(dir, shift, alt);
    timerRef.current = window.setTimeout(() => {
      intervalRef.current = window.setInterval(() => {
        onStep(dir, shift, alt);
      }, 60);
    }, 350);
  };

  useEffect(() => stop, [stop]);

  if (disabled) return null;

  return (
    <div className="stepper-btns">
      <button
        type="button"
        tabIndex={-1}
        className="stepper-btn stepper-up"
        aria-label="Increment"
        onPointerDown={(e) => handlePointerDown(1, e)}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
      >
        <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor" aria-hidden="true">
          <path d="M4 0.8L7.2 4.2H0.8L4 0.8Z" />
        </svg>
      </button>
      <button
        type="button"
        tabIndex={-1}
        className="stepper-btn stepper-down"
        aria-label="Decrement"
        onPointerDown={(e) => handlePointerDown(-1, e)}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
      >
        <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor" aria-hidden="true">
          <path d="M4 4.2L0.8 0.8H7.2L4 4.2Z" />
        </svg>
      </button>
    </div>
  );
}

export interface MathNumInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value: number | string;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | string;
}

export function MathNumInput({
  value,
  onCommit,
  min,
  max,
  step = 1,
  className = "num",
  disabled,
  onFocus,
  onBlur,
  onKeyDown,
  ...rest
}: MathNumInputProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    if (!editing) {
      setDraft(String(value));
    }
  }, [value, editing]);

  const finishEdit = () => {
    const evaluated = evaluateMathExpression(draft);
    if (evaluated !== null && Number.isFinite(evaluated)) {
      let finalVal = evaluated;
      if (min !== undefined) finalVal = Math.max(min, finalVal);
      if (max !== undefined) finalVal = Math.min(max, finalVal);
      onCommit(finalVal);
    } else {
      setDraft(String(value));
    }
    setEditing(false);
  };

  const stepValue = (dir: 1 | -1, shift: boolean, alt: boolean) => {
    const parsed = evaluateMathExpression(editing ? draft : String(value));
    const cur = parsed !== null && Number.isFinite(parsed) ? parsed : Number(value) || 0;
    const stp = typeof step === "number" ? step : Number(step) || 1;
    const delta = dir * (shift ? stp * 10 : alt ? stp / 10 : stp);
    let next = Math.round((cur + delta) * 1e6) / 1e6;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    const decimals = String(stp).split(".")[1]?.length ?? 0;
    setDraft(decimals > 0 ? next.toFixed(decimals) : String(next));
    setEditing(false);
    onCommit(next);
  };

  return (
    <div className="num-stepper-wrap">
      <input
        {...rest}
        type="text"
        inputMode="decimal"
        className={className}
        disabled={disabled}
        value={editing ? draft : value}
        onFocus={(e) => {
          setEditing(true);
          setDraft(String(value));
          e.currentTarget.select();
          onFocus?.(e);
        }}
        onBlur={(e) => {
          finishEdit();
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(String(value));
            setEditing(false);
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            beginHistoryBatch();
            stepValue(e.key === "ArrowUp" ? 1 : -1, e.shiftKey, e.altKey);
            endHistoryBatch();
          }
          onKeyDown?.(e);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
      />
      {!disabled && (
        <StepperButtons
          onStep={stepValue}
          onStart={beginHistoryBatch}
          onEnd={endHistoryBatch}
          disabled={disabled}
        />
      )}
    </div>
  );
}
