import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Map as MapboxMap, GeoJSONSource } from "mapbox-gl";
import type { FeatureCollection, Point } from "geojson";
import { MapPin } from "lucide-react";
import { Mark } from "./components";
import { readViewedPlace, type PlaceSource, type ViewedPlace } from "./map-place";
import { count, lineGeoJSON, pointGeoJSON, validCoordinate, type ConsoleConfig, type LocationPoint } from "./model";
import rtlPluginUrl from "../../node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js?url";

export interface MapActions { fit: () => void; zoom: (direction: number) => void; north: () => void; stop: () => void }
interface Props { config: ConsoleConfig | null; points: LocationPoint[]; selected: LocationPoint | null;
  onSelect: (id: number) => void; days: number; showPoints: boolean; showLines: boolean; showBorders: boolean; showPlaceNames: boolean;
  filteredMode: boolean; autoFit: boolean; bottomInset: number }
const EMPTY = { type: "FeatureCollection" as const, features: [] };
const CLUSTER_ZOOM = 5;
const DIRECTION_VERTEX_LIMIT = 1000;

function addDirectionImage(map: MapboxMap) {
  const canvas = document.createElement("canvas"); canvas.width = 36; canvas.height = 28;
  const context = canvas.getContext("2d"); if (!context) return;
  context.lineCap = "round"; context.lineJoin = "round";
  context.beginPath(); context.moveTo(11, 5); context.lineTo(23, 14); context.lineTo(11, 23);
  context.strokeStyle = "#ffffff"; context.lineWidth = 8; context.stroke();
  context.strokeStyle = "#e87316"; context.lineWidth = 4; context.stroke();
  map.addImage("footprint-direction-arrow", context.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: 2 });
}

export const MapView = memo(forwardRef<MapActions, Props>(function MapView(props, ref) {
  const container = useRef<HTMLDivElement>(null), map = useRef<MapboxMap | null>(null);
  const latest = useRef(props); latest.current = props;
  const syncPointVisibility = useRef<() => void>(() => {});
  const syncBorderVisibility = useRef<() => void>(() => {});
  const syncPlaceVisibility = useRef<() => void>(() => {});
  const [ready, setReady] = useState(false), [error, setError] = useState("");
  const [view, setView] = useState({ center: [120.143, 30.252] as [number, number], zoom: 13.8, place: null as string | null });
  const focusedName = props.selected ? props.selected.city?.trim() || view.place || `位置点 ${props.selected.id}` : null;
  const placeName = focusedName || (view.zoom >= 9 ? view.place : null);
  const token = props.config?.mapboxToken, style = props.config?.mapboxStyle;
  const pointData = useMemo(() => pointGeoJSON(props.points), [props.points]);
  const lineData = useMemo(() => props.showLines ? lineGeoJSON(props.points) : EMPTY, [props.points, props.showLines]);
  const lineVertices = lineData.features[0]?.geometry.coordinates.length || 0;
  const showDirections = props.showLines && lineVertices > 1 && lineVertices <= DIRECTION_VERTEX_LIMIT;
  const endpointData = useMemo<FeatureCollection<Point>>(() => {
    if (!lineData.features.length || !pointData.features.length) return EMPTY;
    // App supplies points in chronological order; the point source already
    // omits invalid coordinates and rounds them exactly like the line source.
    const start = pointData.features[0], end = pointData.features.at(-1)!;
    const sharedPosition = start.geometry.coordinates.every((value, index) => value === end.geometry.coordinates[index]);
    return { type: "FeatureCollection", features: [start, end].map((point, index) => ({
      ...point, properties: { ...point.properties, endpoint: index ? "end" : "start", radius: sharedPosition && index ? 6 : 4 },
    })) };
  }, [pointData, lineData]);
  const padding = () => {
    const height = container.current?.clientHeight || 600, width = container.current?.clientWidth || 320;
    const top = Math.min(155, height * .2), side = Math.min(72, width * .1);
    return { top, left: side, right: side, bottom: Math.min(latest.current.bottomInset + 100, height - top - 100) };
  };
  const fit = () => {
    const points = latest.current.points.filter(validCoordinate), m = map.current;
    if (!m || !points.length) return;
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const p of points) { west = Math.min(west, p.longitude); east = Math.max(east, p.longitude);
      south = Math.min(south, p.latitude); north = Math.max(north, p.latitude); }
    m.fitBounds([[west, south], [east, north]], { maxZoom: 15.5, duration: 650,
      padding: padding() });
  };
  useImperativeHandle(ref, () => ({ fit, zoom: direction => {
    if (direction > 0) map.current?.zoomIn(); else map.current?.zoomOut();
  }, north: () => map.current?.resetNorth(), stop: () => { map.current?.stop(); } }));

  useEffect(() => {
    if (!token || !container.current) return;
    let disposed = false;
    setError("");
    void import("mapbox-gl").then(async ({ default: mapboxgl }) => {
      if (disposed) return;
      if (!mapboxgl.supported()) { setError("当前浏览器不支持 WebGL 2，无法加载交互地图。"); return; }
      // Host the plugin with the app and let Mapbox load its worker code only
      // when Arabic or Hebrew labels are encountered.
      if (mapboxgl.getRTLTextPluginStatus() === "unavailable") mapboxgl.setRTLTextPlugin(rtlPluginUrl, null, true);
      await Promise.all([document.fonts.ready,
        document.fonts.load('500 12px "Noto Sans Arabic Variable"', "العربية"),
        document.fonts.load('500 12px "Noto Sans Hebrew Variable"', "עברית")]);
      if (disposed) return;
      const m = new mapboxgl.Map({ container: container.current!, accessToken: token,
        style: style || "mapbox://styles/mapbox/light-v11", center: [120.143, 30.252], zoom: 13.8,
        projection: "mercator", attributionControl: false, logoPosition: "bottom-right",
        localFontFamily: getComputedStyle(document.documentElement).fontFamily });
      map.current = m;
      let placeLayers: string[] = [], placeSources: PlaceSource[] = [], previousPlace: ViewedPlace | null = null, placeLookupPending = true;
      m.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
      m.on("error", () => setError("底图未能加载，请检查 Mapbox Token、域名限制或网络连接。"));
      m.on("load", () => {
        if (disposed) return;
        const labels = (m.getStyle().layers || []).filter(layer => layer.type === "symbol" && "source-layer" in layer && layer["source-layer"] === "place_label");
        placeLayers = labels.map(layer => layer.id);
        placeSources = Array.from(new Map(labels.map(layer => {
          const source = "source" in layer ? String(layer.source) : "";
          return [source, { source, sourceLayer: "place_label" }];
        })).values());
        let placeVisibility = "";
        syncPlaceVisibility.current = () => {
          const visibility = latest.current.showPlaceNames ? "visible" : "none";
          if (visibility === placeVisibility) return;
          placeVisibility = visibility;
          for (const id of placeLayers) m.setLayoutProperty(id, "visibility", visibility);
        };
        syncPlaceVisibility.current();
        // The default light basemap is brought into our neutral palette. Leave
        // an explicitly supplied custom Studio style under the owner's control.
        if (!style || style === "mapbox://styles/mapbox/light-v11") {
          for (const layer of m.getStyle().layers || []) {
            if (layer.type === "background") m.setPaintProperty(layer.id, "background-color", "#f9f9f9");
            if (layer.type === "fill") m.setPaintProperty(layer.id, "fill-color", layer.id.includes("water") ? "#e5e7eb" : "#f3f3f3");
            if (layer.type === "line") m.setPaintProperty(layer.id, "line-color", layer.id.includes("road") ? "#ffffff" : "#d4d4d4");
            if (layer.type === "symbol") { m.setPaintProperty(layer.id, "text-color", "#727272"); m.setPaintProperty(layer.id, "text-halo-color", "#ffffff"); }
          }
        }
        // Cache the national-border layers once. Toggle every variant together
        // without recreating the map or rebuilding the trajectory sources.
        const borderLayers = (m.getStyle().layers || []).filter(layer => layer.type === "line"
          && layer["source-layer"] === "admin" && /^admin-0-boundary(?:-|$)/.test(layer.id)).map(layer => layer.id);
        let borderVisibility = "";
        syncBorderVisibility.current = () => {
          const visibility = latest.current.showBorders ? "visible" : "none";
          if (visibility === borderVisibility) return;
          borderVisibility = visibility;
          for (const id of borderLayers) m.setLayoutProperty(id, "visibility", visibility);
        };
        syncBorderVisibility.current();
        m.addSource("footprint-lines", { type: "geojson", data: EMPTY, tolerance: 1, buffer: 64, lineMetrics: true });
        m.addLayer({ id: "footprint-lines", type: "line", source: "footprint-lines",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-gradient": ["interpolate", ["linear"], ["line-progress"],
            0, "#fdba74", .5, "#f6821f", 1, "#b45309"], "line-width": 2.5, "line-opacity": .85 } });
        addDirectionImage(m);
        // Reuse the chronological line source. Native placement spaces icons
        // in screen pixels; collisions suppress crowded arrows automatically.
        m.addLayer({ id: "footprint-directions", type: "symbol", source: "footprint-lines",
          layout: { visibility: "none", "symbol-placement": "line", "symbol-spacing": 180,
            "icon-image": "footprint-direction-arrow", "icon-size": 1, "icon-padding": 6,
            "icon-rotation-alignment": "map", "icon-pitch-alignment": "map", "icon-keep-upright": false,
            "icon-allow-overlap": false, "icon-ignore-placement": false } });
        m.addSource("footprint-points", { type: "geojson", data: EMPTY, buffer: 64,
          cluster: true, clusterRadius: 48, clusterMaxZoom: CLUSTER_ZOOM });
        m.addLayer({ id: "footprint-clusters", type: "circle", source: "footprint-points", filter: ["has", "point_count"],
          paint: { "circle-color": "#ffffff", "circle-stroke-color": "#f6821f", "circle-stroke-width": 1.5,
            "circle-radius": ["step", ["get", "point_count"], 17, 100, 22, 1000, 28] } });
        m.addLayer({ id: "footprint-count", type: "symbol", source: "footprint-points", filter: ["has", "point_count"],
          layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"] },
          paint: { "text-color": "#262626" } });
        m.addSource("footprint-filtered-points", { type: "geojson", data: EMPTY, buffer: 64, cluster: false });
        for (const id of ["footprint-points", "footprint-filtered-points"]) {
          m.addLayer({ id, type: "circle", source: id, filter: ["!", ["has", "point_count"]],
            paint: { "circle-color": "#f6821f",
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2, 16, 4],
              "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" } });
          m.on("click", id, event => {
            const pointId = event.features?.[0]?.properties?.id;
            if (typeof pointId === "number") latest.current.onSelect(pointId);
          });
        }
        // Both sources stay ready. A fractional zoom threshold requires an
        // explicit layer switch: clusterMaxZoom alone changes at integer zooms.
        // The cache avoids layout work on every animation frame and no camera
        // event rebuilds GeoJSON, sends setData, or updates React state.
        let pointVisibility = "";
        const updatePointVisibility = () => {
          const { showPoints, filteredMode } = latest.current;
          const direct = filteredMode || m.getZoom() > CLUSTER_ZOOM;
          const mode = !showPoints ? "hidden" : direct ? "direct" : "clustered";
          if (mode === pointVisibility) return;
          pointVisibility = mode;
          for (const id of ["footprint-points", "footprint-clusters", "footprint-count"])
            m.setLayoutProperty(id, "visibility", mode === "clustered" ? "visible" : "none");
          m.setLayoutProperty("footprint-filtered-points", "visibility", mode === "direct" ? "visible" : "none");
        };
        syncPointVisibility.current = updatePointVisibility;
        m.on("zoom", updatePointVisibility); updatePointVisibility();
        m.addSource("footprint-selection", { type: "geojson", data: EMPTY });
        m.addLayer({ id: "footprint-selection-ring", type: "circle", source: "footprint-selection",
          paint: { "circle-radius": 12, "circle-color": "#ffffff", "circle-opacity": .75,
            "circle-stroke-width": 1.5, "circle-stroke-color": "#f6821f" } });
        m.addLayer({ id: "footprint-selection-dot", type: "circle", source: "footprint-selection",
          paint: { "circle-radius": 4, "circle-color": "#f6821f" } });
        m.addSource("footprint-endpoints", { type: "geojson", data: EMPTY, buffer: 32 });
        m.addLayer({ id: "footprint-endpoints", type: "circle", source: "footprint-endpoints",
          layout: { visibility: "none", "circle-sort-key": ["case", ["==", ["get", "endpoint"], "start"], 1, 0] },
          paint: { "circle-radius": ["get", "radius"], "circle-color": "#ffffff", "circle-stroke-width": 1.5,
            "circle-stroke-color": ["match", ["get", "endpoint"], "start", "#fdba74", "#b45309"] } });
        m.on("click", "footprint-endpoints", event => {
          const pointId = event.features?.[0]?.properties?.id;
          if (typeof pointId === "number") latest.current.onSelect(pointId);
        });
        m.on("click", "footprint-clusters", event => {
          const feature = event.features?.[0]; if (!feature || feature.geometry.type !== "Point") return;
          const coordinates = feature.geometry.coordinates as [number, number];
          (m.getSource("footprint-points") as GeoJSONSource).getClusterExpansionZoom(feature.properties!.cluster_id, (err, zoom) => {
            if (!err && !disposed && zoom !== null && zoom !== undefined) m.easeTo({ center: coordinates, zoom });
          });
        });
        // Delegated hover handlers query features on every mousemove. Do one
        // bounded query while idle, and let camera gestures proceed freely.
        let lastHoverCheck = -Infinity;
        m.on("mousemove", event => {
          const now = performance.now();
          if (event.originalEvent.buttons || m.isMoving() || now - lastHoverCheck < 80) return;
          lastHoverCheck = now;
          const features = m.queryRenderedFeatures(event.point, { layers: ["footprint-points", "footprint-filtered-points", "footprint-clusters", "footprint-endpoints"] });
          m.getCanvas().style.cursor = features.length ? "pointer" : "";
        });
        m.on("movestart", () => { m.getCanvas().style.cursor = ""; });
        m.on("mouseout", () => { m.getCanvas().style.cursor = ""; });
        setError(""); setReady(true);
      });
      // Camera metadata stays inside the map component; ending a gesture
      // must not rerender the data table or recompute the page's statistics.
      m.on("moveend", () => {
        const center = m.getCenter(), zoom = m.getZoom(); placeLookupPending = true;
        setView(current => ({ center: [center.lng, center.lat], zoom, place: current.place }));
      });
      // One bounded lookup after the camera and tiles settle, never per frame.
      // Keep this state in MapView so panning does not rerender the data table.
      m.on("idle", () => {
        if (disposed || !placeLookupPending || m.isMoving()) return;
        placeLookupPending = false;
        if (m.getZoom() < 9) return;
        const place = readViewedPlace(m, placeLayers, placeSources, previousPlace, mapboxgl.LngLat.convert);
        if (!place) return;
        previousPlace = place;
        setView(current => current.place === place.name ? current : { ...current, place: place.name });
      });
    }).catch(() => { if (!disposed) setError("地图组件加载失败，请刷新重试。"); });
    return () => {
      disposed = true; syncPointVisibility.current = () => {}; syncBorderVisibility.current = () => {}; syncPlaceVisibility.current = () => {};
      map.current?.remove(); map.current = null; setReady(false);
    };
  }, [token, style]);
  useEffect(() => { if (ready) syncBorderVisibility.current(); }, [ready, props.showBorders]);
  useEffect(() => { if (ready) syncPlaceVisibility.current(); }, [ready, props.showPlaceNames]);
  useEffect(() => {
    if (!ready || !map.current) return;
    // The unclustered source also serves the full dataset above zoom 5, so it
    // is populated on data changes rather than when a zoom gesture crosses 5.
    (map.current.getSource("footprint-filtered-points") as GeoJSONSource).setData(pointData);
    if (!props.filteredMode) (map.current.getSource("footprint-points") as GeoJSONSource).setData(pointData);
  }, [ready, pointData, props.filteredMode]);
  // setPadding uses jumpTo and stops active animations. Apply it before any
  // initial fit so font/data loading order cannot cancel the first overview.
  useEffect(() => { if (ready) map.current?.setPadding(padding()); }, [ready, props.bottomInset]);
  useEffect(() => {
    // Clearing filters or layers updates data while keeping the current camera.
    // Initial loading and selecting a new range can still frame its points.
    if (ready && props.autoFit) fit();
  }, [ready, pointData, props.filteredMode, props.autoFit]);
  useEffect(() => {
    if (!ready || !map.current) return;
    (map.current.getSource("footprint-lines") as GeoJSONSource).setData(lineData);
  }, [ready, lineData]);
  useEffect(() => {
    if (!ready || !map.current) return;
    (map.current.getSource("footprint-endpoints") as GeoJSONSource).setData(endpointData);
    map.current.setLayoutProperty("footprint-endpoints", "visibility", endpointData.features.length ? "visible" : "none");
  }, [ready, endpointData]);
  useEffect(() => {
    const m = map.current; if (!ready || !m) return;
    syncPointVisibility.current();
    m.setLayoutProperty("footprint-lines", "visibility", props.showLines ? "visible" : "none");
    // Dense tracks retain the gradient without the cost of symbol placement.
    m.setLayoutProperty("footprint-directions", "visibility", showDirections ? "visible" : "none");
  }, [ready, props.showPoints, props.showLines, props.filteredMode, showDirections]);
  useEffect(() => {
    const m = map.current; if (!ready || !m) return;
    (m.getSource("footprint-selection") as GeoJSONSource).setData(pointGeoJSON(props.selected ? [props.selected] : []));
    if (props.selected && validCoordinate(props.selected)) m.easeTo({ center: [props.selected.longitude, props.selected.latitude],
      zoom: Math.max(m.getZoom(), 14.3), padding: padding(), duration: 500 });
  }, [ready, props.selected]);
  useEffect(() => {
    const observer = new ResizeObserver(() => map.current?.resize());
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return <div className="map-stage" style={{ "--map-bottom": `${props.bottomInset + 20}px` } as React.CSSProperties}>
    <div className="map-container" ref={container} aria-label="足迹地图" />
    <section className="map-summary" aria-label="当前轨迹概览">
      <div className="summary-title">{placeName ? <><MapPin className="summary-location-mark" size={25} /><h1 className="location-name" title={placeName} dir="auto">{placeName}</h1></>
        : <><Mark /><h1>footprint<span>.</span></h1></>}</div>
      <p className="summary-stats"><span>{count(props.points.length)} 个位置点</span><span>{count(props.days)} 天</span></p>
    </section>
    {props.config && !token && <div className="map-notice"><MapPin size={13} /><span>请配置 Mapbox Token 以加载地图</span></div>}
    {token && !ready && !error && <div className="map-notice" role="status">正在加载 Mapbox 底图…</div>}
    {error && <div className="map-notice map-error" role="alert">{error}</div>}
    {lineVertices > 1 && <div className="trajectory-order" style={{ bottom: `${props.bottomInset + 50}px` }} aria-label="轨迹连线颜色由浅至深，时间从早到晚">
      <span>较早</span><i /><span>较晚</span>
    </div>}
    <div className="map-meta" style={{ bottom: `${props.bottomInset + 26}px` }}>
      <span className="map-scale"><i />{token ? `Z ${view.zoom.toFixed(1)}` : "等待底图"}</span>
      {token && <span>{Math.abs(view.center[0]).toFixed(4)}° {view.center[0] < 0 ? "W" : "E"} / {Math.abs(view.center[1]).toFixed(4)}° {view.center[1] < 0 ? "S" : "N"}</span>}
      <span className="coordinate-system">WGS84</span>
    </div>
  </div>;
}));
