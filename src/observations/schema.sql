-- Observations table — captures classified tool call events
CREATE TABLE IF NOT EXISTS pai_observations (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id INTEGER,
  project_slug TEXT,
  type TEXT NOT NULL CHECK (type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
  title TEXT NOT NULL,
  narrative TEXT,
  tool_name TEXT,
  tool_input_summary TEXT,
  files_read JSONB DEFAULT '[]'::jsonb,
  files_modified JSONB DEFAULT '[]'::jsonb,
  concepts JSONB DEFAULT '[]'::jsonb,
  content_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obs_project ON pai_observations(project_id);
CREATE INDEX IF NOT EXISTS idx_obs_session ON pai_observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_type ON pai_observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_created ON pai_observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_hash ON pai_observations(content_hash);

-- Session summaries — structured end-of-session summaries
CREATE TABLE IF NOT EXISTS pai_session_summaries (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  project_id INTEGER,
  project_slug TEXT,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  observation_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ss_project ON pai_session_summaries(project_id);
CREATE INDEX IF NOT EXISTS idx_ss_session ON pai_session_summaries(session_id);
