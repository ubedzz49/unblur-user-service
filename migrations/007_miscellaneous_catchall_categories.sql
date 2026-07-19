-- Adds one "Miscellaneous {Field}" catch-all expertise_type per core field/family already
-- present in the taxonomy (see 002-004). These exist for the case where a user clearly has
-- expertise or a doubt within a broad field (e.g. Engineering, Islamic Studies) but it doesn't
-- cleanly match any single curated subject within that field. They are curated (type matches
-- whichever category the field belongs to), not 'user-submitted' -- an ad-hoc bucket per field
-- is better than every such case spawning its own random user-submitted node. Each catch-all
-- gets a single 'General' level, matching the existing General-level convention (see 003's
-- data-analysis/product-management/etc. and 005's custom-expertise default level).

INSERT INTO expertise_types (type, name, slug) VALUES
  -- academic
  ('academic', 'Miscellaneous School Subjects', 'misc-school-subjects'),
  ('academic', 'Miscellaneous Mathematics', 'misc-mathematics'),
  ('academic', 'Miscellaneous Engineering', 'misc-engineering'),
  ('academic', 'Miscellaneous Medical', 'misc-medical'),
  ('academic', 'Miscellaneous Commerce', 'misc-commerce'),
  ('academic', 'Miscellaneous Arts & Humanities', 'misc-arts-humanities'),
  ('academic', 'Miscellaneous Law', 'misc-law'),
  ('academic', 'Miscellaneous Science', 'misc-science'),
  ('academic', 'Miscellaneous Postgraduate/PhD Research', 'misc-postgraduate-research'),
  -- competitive
  ('competitive', 'Miscellaneous Competitive Exams', 'misc-competitive-exams'),
  -- corporate
  ('corporate', 'Miscellaneous Corporate Skills', 'misc-corporate-skills'),
  -- life -- one per religious/spiritual tradition seeded in 004, plus wellbeing/guidance
  ('life', 'Miscellaneous Hindu Philosophy and Scriptures', 'misc-hindu-philosophy'),
  ('life', 'Miscellaneous Islamic Studies', 'misc-islamic-studies'),
  ('life', 'Miscellaneous Christian Theology', 'misc-christian-theology'),
  ('life', 'Miscellaneous Buddhist Philosophy', 'misc-buddhist-philosophy'),
  ('life', 'Miscellaneous Sikh Philosophy (Gurbani)', 'misc-sikh-philosophy'),
  ('life', 'Miscellaneous Comparative Religion and Philosophy', 'misc-comparative-religion'),
  ('life', 'Miscellaneous Psychological/Emotional Wellbeing', 'misc-psychological-wellbeing'),
  ('life', 'Miscellaneous Life Guidance / Life Decisions', 'misc-life-guidance')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO expertise_levels (expertise_type_id, name, slug)
SELECT id, level_name, level_slug
FROM expertise_types, (VALUES
  ('misc-school-subjects', 'General', 'general'),
  ('misc-mathematics', 'General', 'general'),
  ('misc-engineering', 'General', 'general'),
  ('misc-medical', 'General', 'general'),
  ('misc-commerce', 'General', 'general'),
  ('misc-arts-humanities', 'General', 'general'),
  ('misc-law', 'General', 'general'),
  ('misc-science', 'General', 'general'),
  ('misc-postgraduate-research', 'General', 'general'),
  ('misc-competitive-exams', 'General', 'general'),
  ('misc-corporate-skills', 'General', 'general'),
  ('misc-hindu-philosophy', 'General', 'general'),
  ('misc-islamic-studies', 'General', 'general'),
  ('misc-christian-theology', 'General', 'general'),
  ('misc-buddhist-philosophy', 'General', 'general'),
  ('misc-sikh-philosophy', 'General', 'general'),
  ('misc-comparative-religion', 'General', 'general'),
  ('misc-psychological-wellbeing', 'General', 'general'),
  ('misc-life-guidance', 'General', 'general')
) AS seed(type_slug, level_name, level_slug)
WHERE expertise_types.slug = seed.type_slug
ON CONFLICT (expertise_type_id, slug) DO NOTHING;
