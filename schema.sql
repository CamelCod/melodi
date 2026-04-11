-- Melodi D1 Schema — Algorithm First
-- Goal: Store all order, customer, and song data with full personalization
-- Input: Telegram user messages and session data
-- Output: Structured rows queryable for prompt generation and analytics

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT UNIQUE NOT NULL,
  telegram_handle TEXT,
  full_name TEXT,
  gender TEXT,
  age_range TEXT,
  country TEXT,
  preferred_language TEXT,
  total_songs INTEGER DEFAULT 0,
  total_spent REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_ref TEXT UNIQUE NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  status TEXT DEFAULT 'new',

  -- Recipient profile
  recipient_name TEXT,
  recipient_gender TEXT,
  recipient_age_range TEXT,
  relationship TEXT,

  -- Occasion
  occasion TEXT,
  event_date TEXT,

  -- Song preferences
  genre TEXT,
  song_language TEXT,
  vocal_style TEXT,
  tempo TEXT,

  -- Story inputs
  customer_story TEXT,
  key_memory TEXT,
  inside_joke TEXT,

  -- Agent outputs
  suno_prompt TEXT,
  quality_score INTEGER,
  issue_notes TEXT,
  iterations INTEGER DEFAULT 0,

  -- Delivery
  preview_file_key TEXT,
  full_file_key TEXT,
  payment_status TEXT DEFAULT 'unpaid',
  payment_provider TEXT,
  amount_paid REAL DEFAULT 0,
  delivered INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_iterations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  iteration_number INTEGER,
  prompt_used TEXT,
  quality_score INTEGER,
  failing_checks TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS metrics_weekly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT,
  new_orders INTEGER DEFAULT 0,
  songs_generated INTEGER DEFAULT 0,
  avg_quality_score REAL DEFAULT 0,
  regeneration_rate REAL DEFAULT 0,
  conversion_rate REAL DEFAULT 0,
  revenue REAL DEFAULT 0,
  avg_time_minutes REAL DEFAULT 0
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_customers_telegram ON customers(telegram_id);
