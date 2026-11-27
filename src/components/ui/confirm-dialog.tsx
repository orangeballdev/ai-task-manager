"use client";

// A drop-in replacement for window.confirm() that renders a themed modal
// instead of the native browser dialog. Usage mirrors sonner's toast():
//
//   import { confirm } from "@/components/ui/confirm-dialog";
//   if (!(await confirm("Delete this task? This cannot be undone."))) return;
//
// or with more control:
//
//   const ok = await confirm({
//     title: "Delete task",
//     description: "This cannot be undone.",
//     confirmLabel: "Delete",
//     variant: "destructive",
//   });
//
// <ConfirmDialogHost /> must be mounted once near the root of the app (it
// lives in src/app/layout.tsx next to <Toaster />). It renders whichever
// confirmation is currently pending, backed by a small module-level store
// so any client component can trigger it without needing a React context.

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title?: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "destructive" renders the confirm button in the destructive color (e.g. for deletes). */
  variant?: "default" | "destructive";
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve?: (value: boolean) => void;
}

type Listener = (state: ConfirmState) => void;

let state: ConfirmState = { open: false, description: "" };
const listeners = new Set<Listener>();

function setState(next: Partial<ConfirmState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener(state));
}

/**
 * Opens the shared confirmation modal and resolves to `true`/`false` based
 * on the user's choice. Only one confirmation can be open at a time.
 */
export function confirm(options: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof options === "string" ? { description: options } : options;
  return new Promise<boolean>((resolve) => {
    setState({ ...opts, open: true, resolve });
  });
}

export function ConfirmDialogHost() {
  const [local, setLocal] = React.useState<ConfirmState>(state);

  React.useEffect(() => {
    listeners.add(setLocal);
    return () => {
      listeners.delete(setLocal);
    };
  }, []);

  function settle(value: boolean) {
    local.resolve?.(value);
    setState({ open: false, resolve: undefined });
  }

  return (
    <Dialog
      open={local.open}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <DialogContent className="max-w-sm" showClose={false}>
        <DialogHeader>
          <DialogTitle>{local.title ?? "Are you sure?"}</DialogTitle>
          <DialogDescription>{local.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => settle(false)}>
            {local.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            type="button"
            variant={local.variant === "destructive" ? "destructive" : "default"}
            onClick={() => settle(true)}
            autoFocus
          >
            {local.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
