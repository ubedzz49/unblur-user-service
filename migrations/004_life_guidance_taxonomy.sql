-- Adds a fourth top-level category: religious/spiritual, psychological/emotional
-- wellbeing (peer support framing, not clinical therapy), and life-decision guidance.
-- These don't have grade/stream "levels" the way academic subjects do -- levels here
-- are specific traditions, sub-areas, or a simple General/Beginner-Advanced split.

ALTER TABLE expertise_types DROP CONSTRAINT IF EXISTS expertise_types_type_check;
ALTER TABLE expertise_types ADD CONSTRAINT expertise_types_type_check
  CHECK (type IN ('academic', 'competitive', 'corporate', 'life'));

INSERT INTO expertise_types (type, name, slug) VALUES
  ('life', 'Hindu Philosophy and Scriptures', 'hindu-philosophy'),
  ('life', 'Islamic Studies', 'islamic-studies'),
  ('life', 'Christian Theology', 'christian-theology'),
  ('life', 'Buddhist Philosophy', 'buddhist-philosophy'),
  ('life', 'Sikh Philosophy (Gurbani)', 'sikh-philosophy'),
  ('life', 'Comparative Religion and Philosophy', 'comparative-religion'),
  ('life', 'Meditation and Mindfulness', 'meditation-mindfulness'),
  ('life', 'Stress and Anxiety Management', 'stress-anxiety-management'),
  ('life', 'Relationship Guidance', 'relationship-guidance'),
  ('life', 'Grief and Loss Support', 'grief-loss-support'),
  ('life', 'Self-Esteem and Confidence Building', 'self-esteem-confidence'),
  ('life', 'Motivation and Productivity', 'motivation-productivity'),
  ('life', 'Career Guidance', 'career-guidance'),
  ('life', 'Higher Education Planning', 'higher-education-planning'),
  ('life', 'Financial Life Planning', 'financial-life-planning'),
  ('life', 'Marriage and Family Decisions', 'marriage-family-decisions'),
  ('life', 'Goal Setting and Life Coaching', 'goal-setting-life-coaching')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO expertise_levels (expertise_type_id, name, slug)
SELECT id, level_name, level_slug
FROM expertise_types, (VALUES
  ('hindu-philosophy', 'Bhagavad Gita', 'bhagavad-gita'),
  ('hindu-philosophy', 'Vedanta', 'vedanta'),
  ('hindu-philosophy', 'General Practice', 'general'),

  ('islamic-studies', 'Quran and Hadith', 'quran-hadith'),
  ('islamic-studies', 'Fiqh (Islamic Jurisprudence)', 'fiqh'),
  ('islamic-studies', 'General Practice', 'general'),

  ('christian-theology', 'Biblical Studies', 'biblical-studies'),
  ('christian-theology', 'General Practice', 'general'),

  ('buddhist-philosophy', 'Theravada', 'theravada'),
  ('buddhist-philosophy', 'Mahayana', 'mahayana'),
  ('buddhist-philosophy', 'Meditation Practice', 'meditation-practice'),

  ('sikh-philosophy', 'General Practice', 'general'),

  ('comparative-religion', 'General', 'general'),

  ('meditation-mindfulness', 'Beginner', 'beginner'),
  ('meditation-mindfulness', 'Advanced', 'advanced'),

  ('stress-anxiety-management', 'General', 'general'),

  ('relationship-guidance', 'Friendships', 'friendships'),
  ('relationship-guidance', 'Romantic Relationships', 'romantic'),
  ('relationship-guidance', 'Family', 'family'),

  ('grief-loss-support', 'General', 'general'),
  ('self-esteem-confidence', 'General', 'general'),
  ('motivation-productivity', 'General', 'general'),

  ('career-guidance', 'Choosing a Career Path', 'choosing-a-path'),
  ('career-guidance', 'Job Search Strategy', 'job-search'),
  ('career-guidance', 'Career Change', 'career-change'),

  ('higher-education-planning', 'Choosing a College or Major', 'choosing-college'),
  ('higher-education-planning', 'Study Abroad', 'study-abroad'),

  ('financial-life-planning', 'Budgeting Basics', 'budgeting'),
  ('financial-life-planning', 'Major Life Purchases', 'major-purchases'),

  ('marriage-family-decisions', 'General', 'general'),
  ('goal-setting-life-coaching', 'General', 'general')
) AS seed(type_slug, level_name, level_slug)
WHERE expertise_types.slug = seed.type_slug
ON CONFLICT (expertise_type_id, slug) DO NOTHING;
