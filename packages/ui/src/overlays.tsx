// Overlays: bottom sheet (React Aria Sheet), confirm dialog (React Aria Modal)
// and toasts (a small queue of our own; React Aria's toast is still unstable).
import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { Dialog, Heading, Modal, ModalOverlay, Sheet as AriaSheet, SheetBackdrop, SheetContent, SheetOverlay } from 'react-aria-components';
import { Button, type ButtonVariant } from './controls';
import { useCloseOnBack } from './back';
import { dataAttributes, type DataAttributes } from './dom';

/**
 * A bottom sheet. It closes by a downward swipe, a tap on the backdrop and
 * Escape, which all call `onClose`. For the Android back action, put the
 * sheet's open state in the app's history (for example a search parameter),
 * so the back action closes it like any other screen. A sheet that is not in
 * the history (the time picker's panel is one) sets `closeOnBack`: the back
 * action then calls `onClose`, for the topmost such overlay only.
 */
export function Sheet({
  isOpen,
  onClose,
  title,
  children,
  closeOnBack = false,
  ...rest
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  closeOnBack?: boolean;
} & DataAttributes) {
  const overlay = useRef<HTMLDivElement>(null);
  useSheetWorkaround(overlay, isOpen);
  useCloseOnBack(isOpen && closeOnBack, onClose);
  return (
    <SheetOverlay {...dataAttributes(rest)} ref={overlay} className="dk-sheet-overlay" isOpen={isOpen} onOpenChange={open => !open && onClose()}>
      <SheetBackdrop className="dk-sheet-backdrop" swipeAnimation="dk-sheet-backdrop" />
      <AriaSheet className="dk-sheet" overscrollPadding>
        <div className="dk-sheet-handle" aria-hidden />
        <SheetContent className="dk-sheet-content">
          <div onFocus={keepFocusedFieldVisible}>
            <Heading slot="title" className="text-title mb-2 font-bold">{title}</Heading>
            {children}
          </div>
        </SheetContent>
      </AriaSheet>
    </SheetOverlay>
  );
}

/**
 * Workaround for react-spectrum issue 10937 (react-aria-components 1.22.1),
 * seen on Android WebView 157 with a sheet taller than the screen:
 *
 * - Opening: React Aria finishes on the scroller's `scrollend` event. The
 *   sheet is already at rest, so no scroll happens and no `scrollend` fires;
 *   the sheet stays "entering", focus never moves into it, and it cannot close.
 * - Closing other than by swipe (backdrop, Escape, back): React Aria scrolls
 *   the sheet away and waits for its `react-aria-sheet-close` event, which
 *   never comes, so the closed sheet stays on screen.
 *
 * Shortly after each change, send the event React Aria is waiting for if the
 * sheet is still stuck.
 */
function useSheetWorkaround(overlay: React.RefObject<HTMLDivElement | null>, isOpen: boolean) {
  const last = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        const el = overlay.current;
        last.current = el;
        if (el?.hasAttribute('data-entering')) el.querySelector('[data-sheet-scroll]')?.dispatchEvent(new Event('scrollend'));
      }, 700);
      return () => clearTimeout(timer);
    }
    // The element that is closing now. `last` is the one the previous opening saw, which a sheet closed
    // before its own 700 ms had passed never replaced: it is gone from the page, and the new one would stay.
    const el = overlay.current?.isConnected ? overlay.current : last.current;
    const timer = setTimeout(() => {
      if (el?.isConnected) el.dispatchEvent(new CustomEvent('react-aria-sheet-close'));
    }, 800);
    return () => clearTimeout(timer);
  }, [isOpen, overlay]);
}

/**
 * When the on-screen keyboard opens over a sheet, bring the focused field back
 * into view by scrolling the sheet's content only. Not scrollIntoView: that
 * also scrolls React Aria's swipe scroller, which reads as a swipe to dismiss.
 */
function keepFocusedFieldVisible(e: FocusEvent) {
  const field = e.target as HTMLElement;
  if (!field.matches('input, textarea, [role="spinbutton"]')) return;
  const content = field.closest<HTMLElement>('.dk-sheet-content');
  if (!content) return;
  const reveal = () => {
    const vv = window.visualViewport;
    const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const below = field.getBoundingClientRect().bottom - (visibleBottom - 16);
    if (below > 0) content.scrollTop += below;
  };
  // Again once the keyboard has changed the visual viewport.
  reveal();
  setTimeout(reveal, 350);
  window.visualViewport?.addEventListener('resize', reveal, { once: true });
}

/**
 * A question with a cancel and a confirm action. The Android back action
 * cancels it, unless `closeOnBack` is false because the app keeps the dialog
 * in the history.
 */
export function ConfirmDialog({
  isOpen,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  closeOnBack = true,
  ...rest
}: {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  closeOnBack?: boolean;
} & DataAttributes) {
  useCloseOnBack(isOpen && closeOnBack, onCancel);
  const variant: ButtonVariant = destructive ? 'danger' : 'primary';
  return (
    <ModalOverlay {...dataAttributes(rest)} isOpen={isOpen} onOpenChange={o => !o && onCancel()} isDismissable className="bg-scrim fixed inset-0 z-[1000] flex items-center justify-center p-6">
      <Modal className="bg-raised rounded-box w-full max-w-sm p-5 shadow-xl">
        <Dialog role="alertdialog" className="outline-none">
          <Heading slot="title" className="text-title font-bold">{title}</Heading>
          {body && <div className="text-muted mt-2">{body}</div>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onPress={onCancel}>{cancelLabel}</Button>
            <Button variant={variant} onPress={onConfirm}>{confirmLabel}</Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

// ---------------------------------------------------------------- toasts

interface ToastItem {
  id: number;
  message: string;
  action?: { label: string; onPress: () => void };
}

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<(items: ToastItem[]) => void>();
const emit = () => listeners.forEach(l => l(items));

/** Shows a short message at the bottom of the screen for `seconds` (default 4). */
export function showToast(message: string, options: { action?: ToastItem['action']; seconds?: number } = {}): void {
  const item: ToastItem = { id: nextId++, message, action: options.action };
  items = [...items, item];
  emit();
  setTimeout(() => {
    items = items.filter(i => i !== item);
    emit();
  }, (options.seconds ?? 4) * 1000);
}

/** Where toasts appear. Render once, near the root. Announced politely to screen readers. */
export function ToastRegion() {
  const [list, setList] = useState(items);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return (
    <div
      role="status"
      aria-live="polite"
      className="toast toast-center z-[1100]"
      style={{ bottom: 'calc(5rem + var(--dk-inset-bottom) + var(--dk-keyboard))' }}
    >
      {list.map(t => (
        <div key={t.id} className="alert bg-neutral text-neutral-content border-0 shadow-lg">
          <span>{t.message}</span>
          {t.action && (
            <button className="btn btn-ghost btn-sm min-h-touch text-neutral-content" onClick={t.action.onPress}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
