// A modal confirmation: focus starts on "cancel", Tab stays inside the dialog, Escape cancels, and the focus goes back
// to where it was when the dialog closes.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export interface ConfirmDialogProps {
  id: string;
  /** Small caption above the headline. */
  caption: string;
  /** The headline (the question or the main statement). */
  heading: string;
  /** Extra class for the headline (e.g. `money` when it contains an amount). */
  headingClass?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ComponentChildren;
}

export function ConfirmDialog({ id, caption, heading, headingClass, confirmLabel, cancelLabel, onConfirm, onCancel, children }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      previous?.focus?.();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const first = cancelRef.current;
    const last = confirmRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div class="dialog-backdrop" onKeyDown={onKeyDown}>
      <div class="card dialog" id={id} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <span class="label">{caption}</span>
        <span class={`h2${headingClass ? ` ${headingClass}` : ''}`} id={`${id}-title`}>
          {heading}
        </span>
        {children}
        <div class="dialog__buttons">
          <button ref={cancelRef} type="button" class="btn btn--ghost" id={`${id}-cancel`} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button ref={confirmRef} type="button" class="btn btn--primary" id={`${id}-ok`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
