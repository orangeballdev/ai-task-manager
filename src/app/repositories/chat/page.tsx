import { Suspense } from "react";
import RepoChatClient from "./RepoChatClient";

export const dynamic = "force-dynamic";

export default function RepoChatPage() {
  return (
    <Suspense>
      <RepoChatClient />
    </Suspense>
  );
}
