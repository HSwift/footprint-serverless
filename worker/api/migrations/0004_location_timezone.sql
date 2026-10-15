-- UTC offset in hours at the observation instant (e.g. 8, -5, 5.5, 5.75).
-- NULL preserves compatibility with existing records and clients.
ALTER TABLE Locations ADD COLUMN Timezone REAL
  CHECK (Timezone IS NULL OR (Timezone >= -12 AND Timezone <= 14));
