// The repository import moved into the propose page's "I have a repo" tab (SKILLY_SPEC.md §64.2).
// Keep this path working for earlier links, carrying `url`/`ref` (and anything else) along.
import { redirect } from "next/navigation";
import { legacyImportRedirect } from "../../../lib/proposeTab";

export default async function ImportRedirectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(legacyImportRedirect(await searchParams));
}
