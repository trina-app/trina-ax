-- min_compatible_reader: 1
-- Component A: what deleted members and groups left behind (docs/DECISIONS.md "What a deleted member or group leaves
-- behind"). A deleted person stays in users as a tombstone, so the ON DELETE CASCADE of the tables below never ran; a
-- deleted group took its rules with it, but not its AI connection assignments. From this build on deleteUser and
-- deleteGroupAs clean these up themselves; this does it once for what earlier deletes left.
-- 1. The photo, title and status (user_profiles) of people already deleted.
-- 2. Their own AI connections (engine_credentials with their owner_user_id; the token or key with it).
-- 3. AI connection assignments whose group or person is gone. A team connection with any assignment serves only the
--    groups and people it names; one with none serves the whole team. A connection every one of whose assignments is
--    gone served nobody: it is switched off here before its rows go, so that it does not start serving everyone (a
--    paid key for one group would otherwise become the whole team's), and marked (meta.assigneesGone, also when it was
--    off already): switching it on again is refused until someone chooses who uses it. The Activity log says so for
--    each connection changed (credential.update with reason assignees_deleted and no actor), as deleteGroupAs and
--    deleteUser do.
-- Data only (reader 1): an older build reads the same tables and columns.
DELETE FROM user_profiles WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);
DELETE FROM engine_credentials WHERE owner_user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL);

INSERT INTO audit_log (actor_id, action, target, detail)
  SELECT NULL, 'credential.update', c.id, json_object(
    'changed', json(CASE WHEN c.owner_user_id IS NULL AND c.disabled = 0 AND NOT EXISTS (
        SELECT 1 FROM engine_credential_assignments a WHERE a.credential_id = c.id
          AND NOT ((a.subject_type = 'group' AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = a.subject_id))
            OR (a.subject_type = 'user' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.subject_id AND u.deleted_at IS NULL))))
      THEN '["disabled","assignments"]' ELSE '["assignments"]' END),
    'reason', 'assignees_deleted', 'via', 'upgrade',
    'assignmentsBefore', json((SELECT json_group_array(json_object('subjectType', a.subject_type, 'subjectId', a.subject_id))
      FROM engine_credential_assignments a WHERE a.credential_id = c.id)),
    'assignmentsAfter', json((SELECT json_group_array(json_object('subjectType', a.subject_type, 'subjectId', a.subject_id))
      FROM engine_credential_assignments a WHERE a.credential_id = c.id
        AND NOT ((a.subject_type = 'group' AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = a.subject_id))
          OR (a.subject_type = 'user' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.subject_id AND u.deleted_at IS NULL))))))
  FROM engine_credentials c
  WHERE EXISTS (SELECT 1 FROM engine_credential_assignments a WHERE a.credential_id = c.id
    AND ((a.subject_type = 'group' AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = a.subject_id))
      OR (a.subject_type = 'user' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.subject_id AND u.deleted_at IS NULL))));

UPDATE engine_credentials SET disabled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.assigneesGone', json('true'))
  WHERE owner_user_id IS NULL
    AND EXISTS (SELECT 1 FROM engine_credential_assignments a WHERE a.credential_id = engine_credentials.id)
    AND NOT EXISTS (SELECT 1 FROM engine_credential_assignments a WHERE a.credential_id = engine_credentials.id
      AND NOT ((a.subject_type = 'group' AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = a.subject_id))
        OR (a.subject_type = 'user' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.subject_id AND u.deleted_at IS NULL))));

DELETE FROM engine_credential_assignments
  WHERE (subject_type = 'group' AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = engine_credential_assignments.subject_id))
    OR (subject_type = 'user' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = engine_credential_assignments.subject_id AND u.deleted_at IS NULL));
