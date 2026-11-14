-- Soul pre-mission onboarding progress (per user/workspace).
-- Additive only: no second onboarding, no answer content stored here. Answers are saved as consented
-- user_context facts through the existing consent mechanism after the explicit consent step.
CREATE TABLE IF NOT EXISTS soul_onboarding (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES identity_workspaces(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'IN_PROGRESS',
  step text NOT NULL DEFAULT 'WELCOME',
  locale text NOT NULL DEFAULT 'en',
  consent_id text,
  skipped_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  dismissed_at timestamptz,
  CONSTRAINT soul_onboarding_status_check CHECK (status IN ('IN_PROGRESS', 'PAUSED', 'COMPLETED', 'DISMISSED')),
  CONSTRAINT soul_onboarding_step_check CHECK (step IN ('WELCOME', 'LANGUAGE', 'CONSENT', 'ACTIVITY', 'OBJECTIVES', 'NEEDS', 'PREFERENCES', 'FIRST_OBJECTIVE', 'DONE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS soul_onboarding_user_workspace_unique ON soul_onboarding (user_id, workspace_id);
CREATE INDEX IF NOT EXISTS soul_onboarding_user_idx ON soul_onboarding (user_id);
