"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  ariaLabel?: string;
};

export function SegmentedControl<T extends string>({
  ariaLabel,
  className = "",
  disabled = false,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean | ((option: T) => boolean);
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  value: T | undefined;
}) {
  return (
    <ToggleGroup
      className={`segmented-control ${className}`.trim()}
      type="single"
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue) onChange(nextValue as T);
      }}
      aria-label={ariaLabel}
      variant="outline"
      size="sm"
      spacing={0}
    >
      {options.map((option) => {
        const optionDisabled = typeof disabled === "function" ? disabled(option.value) : disabled;
        return (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.ariaLabel}
            disabled={optionDisabled}
          >{option.label}</ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
