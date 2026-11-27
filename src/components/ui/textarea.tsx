import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // field-sizing-content grows the textarea to fit what's typed, which is nice on
        // desktop but on mobile it means every keystroke that wraps a line resizes the
        // element while it's focused under the on-screen keyboard. That continuous reflow
        // is what makes mobile browsers lose track of where the focused field is and
        // "correct" the scroll position — it shows up as the page randomly jumping to the
        // top while typing. Capping the growth and letting the textarea scroll internally
        // once it hits that cap keeps the rest of the page layout stable while typing.
        // Callers that want a different cap (e.g. the chat composer's max-h-32) can still
        // override this via className, since cn()/twMerge resolves the conflict.
        "flex field-sizing-content max-h-[50vh] overflow-y-auto min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
