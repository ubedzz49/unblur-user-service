-- Allows a fifth taxonomy category for subjects users add themselves when the curated
-- taxonomy doesn't already have what they typed (e.g. "DSA" when only "Data Structures and
-- Algorithms" exists). These nodes are real expertise_types/expertise_levels rows just like
-- the curated ones, so they can be embedded and participate in feed-matching normally --
-- see POST /expertise-options/custom.

ALTER TABLE expertise_types DROP CONSTRAINT IF EXISTS expertise_types_type_check;
ALTER TABLE expertise_types ADD CONSTRAINT expertise_types_type_check
  CHECK (type IN ('academic', 'competitive', 'corporate', 'life', 'user-submitted'));
