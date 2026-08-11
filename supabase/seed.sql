-- Demo seed data (run after creating admin user in Supabase Dashboard)
-- Replace USER_ID with actual auth.users UUID

-- Example:
-- UPDATE profiles SET role = 'admin' WHERE email = 'admin@example.com';

-- INSERT INTO projects (id, name, description, created_by)
-- VALUES ('00000000-0000-4000-8000-000000000001', 'Battle Start VR', 'Демо-проект', 'USER_ID');

-- INSERT INTO project_members (project_id, user_id, member_role)
-- VALUES ('00000000-0000-4000-8000-000000000001', 'USER_ID', 'owner');
