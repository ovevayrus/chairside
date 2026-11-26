-- Keep the calendar preview with the versioned card across reconnects.
ALTER TABLE requests ADD COLUMN late_impact TEXT;
