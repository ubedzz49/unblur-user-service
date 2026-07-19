CREATE TABLE IF NOT EXISTS expertise_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('academic', 'competitive', 'corporate')),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS expertise_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expertise_type_id UUID NOT NULL REFERENCES expertise_types(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  UNIQUE (expertise_type_id, slug)
);

CREATE TABLE IF NOT EXISTS user_expertise (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expertise_type_id UUID NOT NULL REFERENCES expertise_types(id) ON DELETE CASCADE,
  expertise_level_id UUID NOT NULL REFERENCES expertise_levels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, expertise_type_id, expertise_level_id)
);

CREATE INDEX IF NOT EXISTS idx_user_expertise_user_id ON user_expertise(user_id);

-- seed the starting taxonomy from the vision doc's examples
INSERT INTO expertise_types (type, name, slug) VALUES
  ('academic', 'Maths', 'maths'),
  ('academic', 'Physics', 'physics'),
  ('academic', 'Chemistry', 'chemistry'),
  ('competitive', 'CAT', 'cat'),
  ('competitive', 'JEE', 'jee'),
  ('competitive', 'UPSC', 'upsc'),
  ('corporate', 'Excel', 'excel'),
  ('corporate', 'Leadership', 'leadership'),
  ('corporate', 'Interview Prep', 'interview-prep')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO expertise_levels (expertise_type_id, name, slug)
SELECT id, level_name, level_slug
FROM expertise_types, (VALUES
  ('maths', 'NCERT Class 10', 'ncert-class-10'),
  ('maths', 'NCERT Class 12', 'ncert-class-12'),
  ('physics', 'CBSE Class 12', 'cbse-class-12'),
  ('chemistry', 'ICSE Class 11', 'icse-class-11'),
  ('cat', 'Quant', 'quant'),
  ('cat', 'DILR', 'dilr'),
  ('jee', 'Physics', 'physics'),
  ('jee', 'Maths', 'maths'),
  ('upsc', 'Polity', 'polity'),
  ('excel', 'Advanced', 'advanced'),
  ('leadership', 'Mid-level', 'mid-level'),
  ('interview-prep', 'General', 'general')
) AS seed(type_slug, level_name, level_slug)
WHERE expertise_types.slug = seed.type_slug
ON CONFLICT (expertise_type_id, slug) DO NOTHING;
