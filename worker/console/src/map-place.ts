import type { LngLat, Map as MapboxMap, MapboxGeoJSONFeature } from "mapbox-gl";

export interface PlaceSource { source: string; sourceLayer: string }
export interface ViewedPlace { name: string; center: [number, number] }

// Query only the basemap's already-loaded place labels. Names describe the
// nearby visible place; label points do not establish administrative borders.
export function readViewedPlace(map: MapboxMap, layers: string[], sources: PlaceSource[], previous: ViewedPlace | null,
  toLngLat: (coordinates: [number, number]) => LngLat): ViewedPlace | null {
  if (!layers.length) return null;
  const center = map.getCenter();
  const candidates = (features: MapboxGeoJSONFeature[]) => features.flatMap(feature => {
    const properties = feature.properties;
    if (feature.geometry.type !== "Point" || !properties
      || !["settlement", "settlement_subdivision", "state"].includes(properties.class)) return [];
    const name = [properties["name_zh-Hans"], properties.name_zh, properties.name, properties.name_en]
      .find(value => typeof value === "string" && value.trim());
    if (!name) return [];
    const coordinates = feature.geometry.coordinates as [number, number];
    const distance = center.distanceTo(toLngLat(coordinates));
    const coarse = properties.class === "state" || ["city", "town"].includes(properties.type);
    return [{ name: String(name).replace(/\u200b/g, " ").replace(/\s+/g, " ").trim(), distance, coarse }];
  }).sort((a, b) => a.distance - b.distance);
  const rendered = candidates(map.queryRenderedFeatures({ layers }));
  let place = rendered.find(candidate => candidate.coarse);
  // City labels disappear at close zooms in Light v11. Retain a name near its
  // original lookup location rather than changing the heading on zoom alone.
  if (!place && previous && center.distanceTo(toLngLat(previous.center)) <= 2000) return previous;
  if (!place) {
    const loaded = candidates(sources.flatMap(({ source, sourceLayer }) => map.querySourceFeatures(source, { sourceLayer })));
    place = loaded.find(candidate => candidate.coarse && candidate.distance <= 30_000)
      || [...rendered, ...loaded].filter(candidate => candidate.distance <= 5000).sort((a, b) => a.distance - b.distance)[0];
  }
  return place ? { name: place.name, center: [center.lng, center.lat] } : null;
}
