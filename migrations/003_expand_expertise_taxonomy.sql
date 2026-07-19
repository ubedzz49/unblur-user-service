-- Big expansion of the taxonomy: real subjects across school, engineering, medical,
-- commerce, arts, law, competitive exams, and corporate skills. Additive only --
-- never edit 001/002, this is how the taxonomy grows over time.

INSERT INTO expertise_types (type, name, slug) VALUES
  ('academic', 'Mathematics', 'mathematics'),
  ('academic', 'Physics', 'physics-subject'),
  ('academic', 'Chemistry', 'chemistry-subject'),
  ('academic', 'Biology', 'biology'),
  ('academic', 'English', 'english'),
  ('academic', 'Computer Science', 'computer-science'),
  ('academic', 'History', 'history'),
  ('academic', 'Geography', 'geography'),
  ('academic', 'Political Science', 'political-science'),
  ('academic', 'Economics', 'economics'),
  ('academic', 'Accountancy', 'accountancy'),
  ('academic', 'Business Studies', 'business-studies'),
  ('academic', 'Sociology', 'sociology'),
  ('academic', 'Psychology', 'psychology'),
  ('academic', 'Philosophy', 'philosophy'),
  ('academic', 'Statistics', 'statistics'),
  ('academic', 'Data Structures and Algorithms', 'dsa'),
  ('academic', 'Database Management Systems', 'dbms'),
  ('academic', 'Operating Systems', 'operating-systems'),
  ('academic', 'Computer Networks', 'computer-networks'),
  ('academic', 'Object Oriented Programming', 'oop'),
  ('academic', 'Digital Electronics', 'digital-electronics'),
  ('academic', 'Thermodynamics', 'thermodynamics'),
  ('academic', 'Fluid Mechanics', 'fluid-mechanics'),
  ('academic', 'Strength of Materials', 'strength-of-materials'),
  ('academic', 'Structural Analysis', 'structural-analysis'),
  ('academic', 'Surveying', 'surveying'),
  ('academic', 'Electrical Machines', 'electrical-machines'),
  ('academic', 'Power Systems', 'power-systems'),
  ('academic', 'Control Systems', 'control-systems'),
  ('academic', 'Signals and Systems', 'signals-and-systems'),
  ('academic', 'Analog Electronics', 'analog-electronics'),
  ('academic', 'Communication Systems', 'communication-systems'),
  ('academic', 'Anatomy', 'anatomy'),
  ('academic', 'Physiology', 'physiology'),
  ('academic', 'Biochemistry', 'biochemistry'),
  ('academic', 'Pathology', 'pathology'),
  ('academic', 'Pharmacology', 'pharmacology'),
  ('academic', 'Microbiology', 'microbiology'),
  ('academic', 'Medicine (General)', 'medicine-general'),
  ('academic', 'Surgery (General)', 'surgery-general'),
  ('academic', 'Constitutional Law', 'constitutional-law'),
  ('academic', 'Contract Law', 'contract-law'),
  ('academic', 'Criminal Law', 'criminal-law'),
  ('academic', 'Company Law', 'company-law'),
  ('competitive', 'CAT', 'cat-exam'),
  ('competitive', 'JEE Main', 'jee-main'),
  ('competitive', 'JEE Advanced', 'jee-advanced'),
  ('competitive', 'NEET', 'neet'),
  ('competitive', 'UPSC Civil Services', 'upsc-cse'),
  ('competitive', 'GATE', 'gate'),
  ('competitive', 'CLAT', 'clat'),
  ('competitive', 'Bank and SSC Exams', 'bank-ssc'),
  ('corporate', 'SQL', 'sql'),
  ('corporate', 'Python Programming', 'python-programming'),
  ('corporate', 'Data Analysis', 'data-analysis'),
  ('corporate', 'Product Management', 'product-management'),
  ('corporate', 'Digital Marketing', 'digital-marketing'),
  ('corporate', 'Public Speaking', 'public-speaking'),
  ('corporate', 'Financial Modeling', 'financial-modeling'),
  ('corporate', 'Content Writing', 'content-writing'),
  ('corporate', 'Graphic Design', 'graphic-design')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO expertise_levels (expertise_type_id, name, slug)
SELECT id, level_name, level_slug
FROM expertise_types, (VALUES
  -- Mathematics: spans nearly every stream
  ('mathematics', 'Primary (Class 1-5)', 'primary'),
  ('mathematics', 'Middle (Class 6-8)', 'middle'),
  ('mathematics', 'High School (Class 9-10)', 'high-school'),
  ('mathematics', 'Higher Secondary — Science (Class 11-12)', 'hs-science'),
  ('mathematics', 'Higher Secondary — Commerce (Class 11-12)', 'hs-commerce'),
  ('mathematics', 'Engineering (B.Tech)', 'engineering'),
  ('mathematics', 'B.Sc', 'bsc'),
  ('mathematics', 'PhD — Applied', 'phd-applied'),
  ('mathematics', 'PhD — Pure', 'phd-pure'),

  ('physics-subject', 'High School (Class 9-10)', 'high-school'),
  ('physics-subject', 'Higher Secondary (Class 11-12 PCM/PCB)', 'higher-secondary'),
  ('physics-subject', 'Engineering (B.Tech)', 'engineering'),
  ('physics-subject', 'B.Sc', 'bsc'),
  ('physics-subject', 'PhD', 'phd'),

  ('chemistry-subject', 'High School (Class 9-10)', 'high-school'),
  ('chemistry-subject', 'Higher Secondary — PCM (Class 11-12)', 'hs-pcm'),
  ('chemistry-subject', 'Higher Secondary — PCB (Class 11-12)', 'hs-pcb'),
  ('chemistry-subject', 'Engineering (B.Tech)', 'engineering'),
  ('chemistry-subject', 'B.Sc', 'bsc'),
  ('chemistry-subject', 'PhD', 'phd'),

  ('biology', 'High School (Class 9-10)', 'high-school'),
  ('biology', 'Higher Secondary — PCB (Class 11-12)', 'higher-secondary'),
  ('biology', 'B.Sc', 'bsc'),
  ('biology', 'PhD', 'phd'),

  ('english', 'Primary (Class 1-5)', 'primary'),
  ('english', 'Middle (Class 6-8)', 'middle'),
  ('english', 'High School (Class 9-10)', 'high-school'),
  ('english', 'Higher Secondary (Class 11-12)', 'higher-secondary'),
  ('english', 'BA Literature', 'ba-literature'),

  ('computer-science', 'Middle (Class 6-8, basics)', 'middle'),
  ('computer-science', 'High School (Computer Applications)', 'high-school'),
  ('computer-science', 'Higher Secondary (Class 11-12)', 'higher-secondary'),
  ('computer-science', 'Engineering (B.Tech)', 'engineering'),
  ('computer-science', 'PhD', 'phd'),

  ('history', 'Middle (Class 6-8)', 'middle'),
  ('history', 'High School (Class 9-10)', 'high-school'),
  ('history', 'Higher Secondary — Humanities', 'higher-secondary'),
  ('history', 'BA', 'ba'),

  ('geography', 'Middle (Class 6-8)', 'middle'),
  ('geography', 'High School (Class 9-10)', 'high-school'),
  ('geography', 'Higher Secondary — Humanities', 'higher-secondary'),
  ('geography', 'BA', 'ba'),
  ('geography', 'UPSC Optional', 'upsc-optional'),

  ('political-science', 'Higher Secondary — Humanities', 'higher-secondary'),
  ('political-science', 'BA', 'ba'),
  ('political-science', 'UPSC Optional', 'upsc-optional'),

  ('economics', 'Higher Secondary — Commerce', 'hs-commerce'),
  ('economics', 'Higher Secondary — Humanities', 'hs-humanities'),
  ('economics', 'BA', 'ba'),
  ('economics', 'B.Com', 'bcom'),
  ('economics', 'PhD', 'phd'),

  ('accountancy', 'Higher Secondary — Commerce', 'higher-secondary'),
  ('accountancy', 'B.Com', 'bcom'),

  ('business-studies', 'Higher Secondary — Commerce', 'higher-secondary'),
  ('business-studies', 'B.Com', 'bcom'),

  ('sociology', 'Higher Secondary — Humanities', 'higher-secondary'),
  ('sociology', 'BA', 'ba'),
  ('sociology', 'UPSC Optional', 'upsc-optional'),

  ('psychology', 'Higher Secondary — Humanities', 'higher-secondary'),
  ('psychology', 'BA', 'ba'),

  ('philosophy', 'BA', 'ba'),

  ('statistics', 'Higher Secondary — Commerce', 'higher-secondary'),
  ('statistics', 'B.Sc', 'bsc'),
  ('statistics', 'B.Com', 'bcom'),
  ('statistics', 'PhD', 'phd'),

  ('dsa', 'Engineering (B.Tech CS)', 'engineering-cs'),
  ('dsa', 'GATE CS', 'gate-cs'),

  ('dbms', 'Engineering (B.Tech CS)', 'engineering-cs'),
  ('dbms', 'GATE CS', 'gate-cs'),

  ('operating-systems', 'Engineering (B.Tech CS)', 'engineering-cs'),
  ('operating-systems', 'GATE CS', 'gate-cs'),

  ('computer-networks', 'Engineering (B.Tech CS)', 'engineering-cs'),
  ('computer-networks', 'GATE CS', 'gate-cs'),

  ('oop', 'Engineering (B.Tech CS)', 'engineering-cs'),

  ('digital-electronics', 'Engineering (B.Tech ECE)', 'engineering-ece'),
  ('digital-electronics', 'Engineering (B.Tech CS)', 'engineering-cs'),

  ('thermodynamics', 'Engineering (Mechanical)', 'engineering-mechanical'),
  ('thermodynamics', 'Engineering (Chemical)', 'engineering-chemical'),
  ('thermodynamics', 'Higher Secondary (Class 11-12 PCM)', 'higher-secondary'),

  ('fluid-mechanics', 'Engineering (Mechanical)', 'engineering-mechanical'),
  ('fluid-mechanics', 'Engineering (Civil)', 'engineering-civil'),
  ('fluid-mechanics', 'Engineering (Chemical)', 'engineering-chemical'),

  ('strength-of-materials', 'Engineering (Mechanical)', 'engineering-mechanical'),
  ('strength-of-materials', 'Engineering (Civil)', 'engineering-civil'),

  ('structural-analysis', 'Engineering (Civil)', 'engineering-civil'),
  ('surveying', 'Engineering (Civil)', 'engineering-civil'),

  ('electrical-machines', 'Engineering (Electrical)', 'engineering-electrical'),
  ('power-systems', 'Engineering (Electrical)', 'engineering-electrical'),

  ('control-systems', 'Engineering (Electrical)', 'engineering-electrical'),
  ('control-systems', 'Engineering (ECE)', 'engineering-ece'),

  ('signals-and-systems', 'Engineering (ECE)', 'engineering-ece'),
  ('signals-and-systems', 'Engineering (Electrical)', 'engineering-electrical'),

  ('analog-electronics', 'Engineering (ECE)', 'engineering-ece'),
  ('communication-systems', 'Engineering (ECE)', 'engineering-ece'),

  ('anatomy', 'MBBS — 1st Year (Pre-clinical)', 'mbbs-1'),
  ('physiology', 'MBBS — 1st Year (Pre-clinical)', 'mbbs-1'),
  ('biochemistry', 'MBBS — 1st Year (Pre-clinical)', 'mbbs-1'),
  ('pathology', 'MBBS — 2nd Year (Para-clinical)', 'mbbs-2'),
  ('pharmacology', 'MBBS — 2nd Year (Para-clinical)', 'mbbs-2'),
  ('microbiology', 'MBBS — 2nd Year (Para-clinical)', 'mbbs-2'),
  ('medicine-general', 'MBBS — Clinical', 'mbbs-clinical'),
  ('surgery-general', 'MBBS — Clinical', 'mbbs-clinical'),

  ('constitutional-law', 'LLB', 'llb'),
  ('contract-law', 'LLB', 'llb'),
  ('criminal-law', 'LLB', 'llb'),
  ('company-law', 'LLB', 'llb'),

  ('cat-exam', 'Quant', 'quant'),
  ('cat-exam', 'DILR', 'dilr'),
  ('cat-exam', 'VARC', 'varc'),

  ('jee-main', 'Physics', 'physics'),
  ('jee-main', 'Chemistry', 'chemistry'),
  ('jee-main', 'Maths', 'maths'),

  ('jee-advanced', 'Physics', 'physics'),
  ('jee-advanced', 'Chemistry', 'chemistry'),
  ('jee-advanced', 'Maths', 'maths'),

  ('neet', 'Physics', 'physics'),
  ('neet', 'Chemistry', 'chemistry'),
  ('neet', 'Biology', 'biology'),

  ('upsc-cse', 'Prelims — General Studies', 'prelims-gs'),
  ('upsc-cse', 'Prelims — CSAT', 'prelims-csat'),
  ('upsc-cse', 'Mains — Essay', 'mains-essay'),
  ('upsc-cse', 'Mains — GS1', 'mains-gs1'),
  ('upsc-cse', 'Mains — GS2', 'mains-gs2'),
  ('upsc-cse', 'Mains — GS3', 'mains-gs3'),
  ('upsc-cse', 'Mains — GS4', 'mains-gs4'),
  ('upsc-cse', 'Optional — Public Administration', 'optional-pub-ad'),
  ('upsc-cse', 'Optional — Sociology', 'optional-sociology'),
  ('upsc-cse', 'Optional — Geography', 'optional-geography'),

  ('gate', 'Computer Science', 'cs'),
  ('gate', 'Mechanical', 'mechanical'),
  ('gate', 'Civil', 'civil'),
  ('gate', 'Electrical', 'electrical'),
  ('gate', 'Electronics and Communication', 'ece'),

  ('clat', 'Legal Reasoning', 'legal-reasoning'),
  ('clat', 'Logical Reasoning', 'logical-reasoning'),
  ('clat', 'English', 'english'),
  ('clat', 'General Knowledge', 'gk'),
  ('clat', 'Quantitative Techniques', 'quant'),

  ('bank-ssc', 'Quantitative Aptitude', 'quant'),
  ('bank-ssc', 'Reasoning', 'reasoning'),
  ('bank-ssc', 'English', 'english'),
  ('bank-ssc', 'General Awareness', 'general-awareness'),
  ('bank-ssc', 'Computer Knowledge', 'computer-knowledge'),

  ('sql', 'Beginner', 'beginner'),
  ('sql', 'Advanced', 'advanced'),
  ('python-programming', 'Beginner', 'beginner'),
  ('python-programming', 'Advanced', 'advanced'),
  ('data-analysis', 'General', 'general'),
  ('product-management', 'General', 'general'),
  ('digital-marketing', 'General', 'general'),
  ('public-speaking', 'General', 'general'),
  ('financial-modeling', 'General', 'general'),
  ('content-writing', 'General', 'general'),
  ('graphic-design', 'General', 'general')
) AS seed(type_slug, level_name, level_slug)
WHERE expertise_types.slug = seed.type_slug
ON CONFLICT (expertise_type_id, slug) DO NOTHING;
