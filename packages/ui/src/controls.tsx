// Controls: React Aria for behaviour, daisyUI classes for the look. daisyUI
// styles [aria-checked], [aria-pressed] and [aria-selected], so the visual
// state follows React Aria with no extra code.
import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Checkbox,
  FieldError,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Switch,
  Text,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  ToggleButton,
  ToggleButtonGroup,
  type Key,
} from 'react-aria-components';
import { Check } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'neutral';
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-error',
  neutral: '',
};

export function Button({
  variant = 'neutral',
  block,
  onPress,
  isDisabled,
  type = 'button',
  children,
  id,
}: {
  variant?: ButtonVariant;
  block?: boolean;
  onPress?: () => void;
  isDisabled?: boolean;
  type?: 'button' | 'submit';
  children: ReactNode;
  id?: string;
}) {
  return (
    <AriaButton id={id} type={type} onPress={onPress} isDisabled={isDisabled} className={`btn min-h-touch ${VARIANT[variant]} ${block ? 'btn-block' : ''}`}>
      {children}
    </AriaButton>
  );
}

const FIELD = 'input border-control bg-base-200 text-body min-h-touch w-full';

export function TextField({
  label,
  description,
  placeholder,
  value,
  defaultValue,
  onChange,
  isRequired,
  errorMessage,
  isInvalid,
}: {
  label: string;
  description?: string;
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (v: string) => void;
  isRequired?: boolean;
  errorMessage?: string;
  isInvalid?: boolean;
}) {
  return (
    <AriaTextField className="fieldset" value={value} defaultValue={defaultValue} onChange={onChange} isRequired={isRequired} isInvalid={isInvalid}>
      <Label className="fieldset-legend text-small">{label}</Label>
      <Input className={`${FIELD} data-[invalid]:border-error`} placeholder={placeholder} />
      {description && <Text slot="description" className="text-caption text-muted">{description}</Text>}
      <FieldError className="text-caption text-error">{errorMessage}</FieldError>
    </AriaTextField>
  );
}

export function TextArea({ label, placeholder, value, defaultValue, onChange, rows = 3 }: { label: string; placeholder?: string; value?: string; defaultValue?: string; onChange?: (v: string) => void; rows?: number }) {
  return (
    <AriaTextField className="fieldset" value={value} defaultValue={defaultValue} onChange={onChange}>
      <Label className="fieldset-legend text-small">{label}</Label>
      <AriaTextArea className="textarea border-control bg-base-200 text-body w-full" placeholder={placeholder} rows={rows} />
    </AriaTextField>
  );
}

export interface SelectOption {
  id: string;
  label: string;
}

export function Select({
  label,
  options,
  value,
  defaultValue,
  onChange,
  placeholder = 'Choose…',
}: {
  label: string;
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  placeholder?: string;
}) {
  return (
    <AriaSelect
      className="fieldset"
      selectedKey={value}
      defaultSelectedKey={defaultValue}
      onSelectionChange={(k: Key | null) => k !== null && onChange?.(String(k))}
      placeholder={placeholder}
    >
      <Label className="fieldset-legend text-small">{label}</Label>
      <AriaButton className="select border-control bg-base-200 text-body min-h-touch w-full text-start">
        <SelectValue className="truncate data-[placeholder]:text-muted" />
      </AriaButton>
      <Popover className="bg-raised rounded-box border-divider w-(--trigger-width) border shadow-lg" offset={4}>
        <ListBox className="max-h-80 overflow-y-auto p-1 outline-none">
          {options.map(o => (
            <ListBoxItem
              key={o.id}
              id={o.id}
              textValue={o.label}
              className={({ isSelected, isFocused }) =>
                `rounded-field min-h-touch flex cursor-pointer items-center justify-between px-3 outline-none ${isFocused ? 'bg-base-200' : ''} ${isSelected ? 'text-accent-text font-medium' : ''}`
              }
            >
              {({ isSelected }) => (
                <>
                  {o.label}
                  {isSelected && <Check size={16} />}
                </>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

/**
 * A row that is one big checkbox: a tap anywhere on it toggles. daisyUI's
 * 24px box is only the visual.
 */
export function CheckboxRow({
  title,
  subtitle,
  trailing,
  isSelected,
  defaultSelected,
  onChange,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  isSelected?: boolean;
  defaultSelected?: boolean;
  onChange?: (selected: boolean) => void;
}) {
  return (
    <Checkbox className="min-h-touch flex cursor-pointer items-center gap-3 px-4 py-2" isSelected={isSelected} defaultSelected={defaultSelected} onChange={onChange}>
      {({ isSelected: on, isFocusVisible }) => (
        <>
          <span aria-hidden aria-checked={on} className={`checkbox checkbox-primary ${isFocusVisible ? 'outline-primary outline-2 outline-offset-2' : ''}`} />
          <span className="min-w-0 flex-1">
            <span className="text-body block font-medium">{title}</span>
            {subtitle && <span className="text-caption text-muted block">{subtitle}</span>}
          </span>
          {trailing}
        </>
      )}
    </Checkbox>
  );
}

/** A row that is one big switch. */
export function SwitchRow({ title, subtitle, isSelected, defaultSelected, onChange }: { title: ReactNode; subtitle?: ReactNode; isSelected?: boolean; defaultSelected?: boolean; onChange?: (on: boolean) => void }) {
  return (
    <Switch className="min-h-touch flex cursor-pointer items-center justify-between gap-4 py-2" isSelected={isSelected} defaultSelected={defaultSelected} onChange={onChange}>
      {({ isSelected: on, isFocusVisible }) => (
        <>
          <span className="min-w-0">
            <span className="text-body block font-medium">{title}</span>
            {subtitle && <span className="text-caption text-muted block">{subtitle}</span>}
          </span>
          <span aria-hidden aria-checked={on} className={`toggle toggle-primary ${isFocusVisible ? 'outline-primary outline-2 outline-offset-2' : ''}`} />
        </>
      )}
    </Switch>
  );
}

/** One choice out of a few, as a row of segments. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  options: Array<{ id: T; label: string }>;
  value?: T;
  defaultValue?: T;
  onChange?: (id: T) => void;
}) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      className="tabs tabs-box flex-nowrap"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={value !== undefined ? [value] : undefined}
      defaultSelectedKeys={defaultValue !== undefined ? [defaultValue] : undefined}
      onSelectionChange={keys => {
        const [k] = [...keys];
        if (k !== undefined) onChange?.(String(k) as T);
      }}
    >
      {options.map(o => (
        <ToggleButton key={o.id} id={o.id} className={({ isSelected }) => `tab min-h-touch flex-1 px-1 ${isSelected ? 'tab-active' : 'text-muted'}`}>
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
