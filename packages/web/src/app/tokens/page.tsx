// Access tokens moved into the profile page (§9). Keep this path working for bookmarks/links.
import { redirect } from "next/navigation";

export default function TokensPage() {
  redirect("/profile");
}
