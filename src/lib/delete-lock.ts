/**
 * Tiny app-wide tracker for "a delete request is currently in flight".
 *
 * Deleting a task (or bulk-deleting several) can take a visible moment —
 * the server has to touch the DB and clean up the on-disk workspace clone.
 * While that's happening the UI can feel like it's ignoring clicks (e.g.
 * "New Task" in the header doesn't seem to respond). This module lets any
 * delete call-site announce "I'm deleting" so a single UI-level guard
 * (see NavigationGuard) can warn the user if they try to navigate away
 * mid-delete, instead of leaving them wondering why nothing happened.
 *
 * Plain module-level state + a subscriber set (not React context) so
 * call-sites that aren't nested under a shared provider — dialogs, list
 * rows, kanban cards — can all report to the same counter without prop
 * drilling.
 */

type Listener = (isDeleting: boolean) => void;

let count = 0;
const listeners = new Set<Listener>();

function notify() {
  const isDeleting = count > 0;
  for (const listener of listeners) listener(isDeleting);
}

/** Call when a delete request starts. Always pair with a matching endDelete(), e.g. in a finally block. */
export function beginDelete(): void {
  count += 1;
  notify();
}

/** Call when a delete request finishes (success or failure). */
export function endDelete(): void {
  count = Math.max(0, count - 1);
  notify();
}

export function isDeleteInFlight(): boolean {
  return count > 0;
}

export function subscribeDeleteState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: reset state between test runs. */
export function __resetDeleteLockForTests(): void {
  count = 0;
  listeners.clear();
}
