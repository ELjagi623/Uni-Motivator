// A button that opens the file chooser for calendar files (.ics / .zip). The real <input type="file"> is visually hidden
// but stays focusable, so keyboard users can use it.

export interface FileButtonProps {
  id: string;
  label: string;
  ariaLabel?: string;
  multiple?: boolean;
  /** The accept attribute (default: calendar files). */
  accept?: string;
  onFiles: (files: FileList) => void;
}

export function FileButton({ id, label, ariaLabel, multiple, accept, onFiles }: FileButtonProps) {
  return (
    <label class="btn btn--ghost btn--small">
      <input
        class="sr-only"
        id={id}
        type="file"
        multiple={multiple}
        aria-label={ariaLabel ?? label}
        accept={accept ?? '.zip,.ics,application/zip,text/calendar'}
        onChange={(e) => {
          const input = e.currentTarget as HTMLInputElement;
          if (input.files && input.files.length > 0) onFiles(input.files);
          input.value = '';
        }}
      />
      <span aria-hidden="true">{label}</span>
    </label>
  );
}
