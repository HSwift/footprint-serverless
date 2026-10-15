-- Quality annotations are separate from original location observations.
CREATE TABLE IF NOT EXISTS LocationAnalysisState (
  Device TEXT PRIMARY KEY NOT NULL,
  Revision INTEGER NOT NULL CHECK (Revision > 0)
);

CREATE TABLE IF NOT EXISTS LocationQuality (
  LocationID INTEGER PRIMARY KEY REFERENCES Locations(ID) ON DELETE CASCADE,
  Status TEXT NOT NULL CHECK (Status IN ('pending', 'retained', 'outlier', 'review', 'uncertain')),
  Reason TEXT NOT NULL,
  AlgorithmVersion TEXT NOT NULL,
  Revision INTEGER NOT NULL,
  CheckedAt INTEGER NOT NULL,
  Evidence TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locations_device_id ON Locations(Device, ID);
