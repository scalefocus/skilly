-- Profile photo for maintainer bubbles (SKILLY_SPEC.md §19).
-- Captured from Entra ID at the user's OWN sign-in: the Auth.js AzureAD provider fetches
-- the Graph profile photo with the user's delegated User.Read token and hands it to the
-- session as a small data URI; the jwt callback persists it here. No app-level Graph
-- permission is needed. Users who have never signed in have NULL → the UI renders an
-- initials bubble instead.
ALTER TABLE users ADD COLUMN avatar TEXT;
