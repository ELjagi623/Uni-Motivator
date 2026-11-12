// Small, presentational building blocks. They only render what they are given.

import type { ComponentChildren } from 'preact';
import { t } from '../../i18n';

export interface ButtonProps {
  variant?: 'primary' | 'ghost' | 'plain' | 'danger';
  small?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  id?: string;
  /** Toggle buttons: whether the toggle is on (`aria-pressed`). */
  pressed?: boolean;
  ariaLabel?: string;
  onClick?: () => void;
  children: ComponentChildren;
}

const VARIANT_CLASS = { primary: 'btn--primary', ghost: 'btn--ghost', danger: 'btn--danger', plain: '' } as const;

export function Button({ variant = 'plain', small, disabled, type = 'button', id, pressed, ariaLabel, onClick, children }: ButtonProps) {
  const cls = ['btn', VARIANT_CLASS[variant], small ? 'btn--small' : ''].filter(Boolean).join(' ');
  return (
    <button class={cls} type={type} id={id} disabled={disabled} aria-pressed={pressed} aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
}

export interface ChoiceGroupProps<T extends string> {
  name: string;
  /** Accessible name of the group (visually hidden). */
  legend: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  variant: 'chip' | 'seg';
  onChange: (value: T) => void;
}

/** A radio group drawn as chips or as a segmented control. Native radios keep arrow-key navigation and focus. */
export function ChoiceGroup<T extends string>({ name, legend, value, options, variant, onChange }: ChoiceGroupProps<T>) {
  return (
    <fieldset class={`choice choice--${variant}`}>
      <legend class="sr-only">{legend}</legend>
      {options.map((option) => (
        <label class="choice__item" key={option.value}>
          <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
          <span class="choice__label">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export interface CheckboxProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

export function Checkbox({ checked, label, onChange }: CheckboxProps) {
  return (
    <label class="check">
      <input type="checkbox" checked={checked} aria-label={label} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span class="check__box" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12l5 5 9-10" />
        </svg>
      </span>
    </label>
  );
}

export interface StepBarProps {
  current: number;
  total: number;
}

/** The segmented progress bar at the top of the wizard. */
export function StepBar({ current, total }: StepBarProps) {
  const items = Array.from({ length: total }, (_, i) => i + 1);
  return (
    <ol class="steps" aria-label={t('onboarding.progress')}>
      {items.map((n) => (
        <li key={n} class={n <= current ? 'done' : ''} aria-current={n === current ? 'step' : undefined}>
          <span class="sr-only">{t('onboarding.stepOfTotal', { n, total })}</span>
        </li>
      ))}
    </ol>
  );
}

export interface TextInputProps {
  id: string;
  value: string;
  onInput: (value: string) => void;
  label: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'decimal' | 'text';
  maxLength?: number;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  disabled?: boolean;
}

/** A bare input (no wrapper) with an accessible name. */
export function TextInput({ id, value, onInput, label, placeholder, inputMode, maxLength, invalid, describedBy, className, disabled }: TextInputProps) {
  return (
    <input
      id={id}
      class={`field__input ${className ?? ''}`.trim()}
      type="text"
      value={value}
      placeholder={placeholder}
      inputMode={inputMode}
      maxLength={maxLength}
      disabled={disabled}
      aria-label={label}
      aria-invalid={invalid ? 'true' : undefined}
      aria-describedby={describedBy}
      autoComplete="off"
      spellcheck={false}
      onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
    />
  );
}

export function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div class="notice" role="status">
      <span class="grow">{message}</span>
      <Button small variant="ghost" onClick={onDismiss}>
        {t('notice.dismiss')}
      </Button>
    </div>
  );
}
