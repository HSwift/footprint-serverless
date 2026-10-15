-- Compatible with the latest footprint-serverless.old schema.
-- Existing locations and projects are preserved when adopting migrations.
CREATE TABLE IF NOT EXISTS Locations (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  Longitude NUMERIC(10,6),
  Latitude NUMERIC(10,6),
  City TEXT,
  Device TEXT,
  Date DATETIME
);

CREATE TABLE IF NOT EXISTS Projects (
  ID INTEGER PRIMARY KEY AUTOINCREMENT,
  Name TEXT,
  StartTime DATETIME,
  EndTime DATETIME
);

CREATE INDEX IF NOT EXISTS idx_locations_date ON Locations(Date, ID);
CREATE INDEX IF NOT EXISTS idx_locations_device_date ON Locations(Device, Date, ID);
CREATE INDEX IF NOT EXISTS idx_projects_name ON Projects(Name);
