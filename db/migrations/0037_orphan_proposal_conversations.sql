-- Clean up review-discussion conversations whose proposal no longer exists (orphaned because the
-- skill — and thus its proposals — was permanently deleted before this cleanup existed). The
-- conversation context is polymorphic (no FK on subject_id), so these weren't cascade-deleted and
-- showed up in the messages UI as "@null/?" threads. Messages + participants cascade from the
-- conversation. Going forward, deleteSkill removes these in the same transaction. SKILLY_SPEC.md §24.
BEGIN;

DELETE FROM conversations c
 WHERE c.subject_type = 'proposal'
   AND c.subject_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.id = c.subject_id);

-- Drop dangling message alerts that point at conversations that no longer exist (e.g. just removed
-- above, or by a prior skill delete).
DELETE FROM notifications n
 WHERE n.type = 'message.new'
   AND NOT EXISTS (
     SELECT 1 FROM conversations c WHERE c.id::text = n.payload->>'conversationId'
   );

COMMIT;
