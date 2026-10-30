-- Plugins, stage 1 (docs/PLUGINS.md): one verified package store per installation (outside the team folder), and who
-- each installed plugin is turned on for, as a principal list like integration_access (everyone / group / user).
-- Stage 1 writes only "everyone" (the whole company); group and person entries come with the next stage.
-- Additive and ignorable: no min_compatible_reader, so an older build (0.2.9) still opens this database and simply
-- never enables a plugin.

-- Every verified package version kept in <data>/plugins/store (the active one and the rollback target).
CREATE TABLE plugin_packages (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  -- the verified manifest exactly as signed (JSON text) and its detached signature
  manifest TEXT NOT NULL,
  signature TEXT,
  trust TEXT NOT NULL CHECK (trust IN ('official', 'test', 'unverified')),
  key_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('file', 'catalog', 'import')),
  -- folder name under <data>/plugins/store/<plugin_id>/
  store_dir TEXT NOT NULL,
  installed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  installed_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version)
);

-- One row per installed plugin: the active version, the version a rollback returns to, and the permissions an
-- owner/admin approved for that exact manifest (a new manifest digest needs a new approval).
CREATE TABLE plugin_installs (
  plugin_id TEXT PRIMARY KEY,
  active_version TEXT NOT NULL,
  previous_version TEXT,
  permissions TEXT NOT NULL,
  approved_manifest_sha256 TEXT NOT NULL,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Who the plugin is on for. No row: installed but off.
CREATE TABLE plugin_access (
  plugin_id TEXT NOT NULL REFERENCES plugin_installs(plugin_id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('everyone', 'group', 'user')),
  subject_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (plugin_id, subject_type, subject_id)
);

-- Files a skill pack placed under skills/<plugin id>/ while it is on (writes there are refused for everyone, see
-- server/src/policy/authorize.ts), with the SHA-256 written, so turning it off removes exactly those files.
CREATE TABLE plugin_managed_files (
  rel TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE INDEX plugin_managed_files_plugin ON plugin_managed_files (plugin_id);
CREATE TABLE plugin_managed_roots (
  rel TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL
);
