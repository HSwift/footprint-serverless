-- Historical-location evidence uses a small spatial range per candidate.
CREATE INDEX IF NOT EXISTS idx_locations_device_latitude_longitude_date
ON Locations (Device, Latitude, Longitude, Date, ID);
