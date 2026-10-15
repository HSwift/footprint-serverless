import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { SortingState } from "@tanstack/react-table";
import { ArrowLeft, ArrowRight, CalendarDays, ChevronDown, ChevronUp, Crosshair, Layers2, LoaderCircle, Maximize2, Minus, Plus, RefreshCw, Route, Search, Table2, X } from "lucide-react";
import { Button, IconButton, Toggle } from "./components";
import { DataTable } from "./DataTable";
import { ProjectTable } from "./ProjectTable";
import { ProjectEditor } from "./ProjectEditor";
import { PointLocalTime } from "./PointLocalTime";
import { MapView, type MapActions } from "./Map";
import { Timeline } from "./Timeline";
import { aroundPointRange, drawableRange } from "./timeline";
import { getConfig, loadData } from "./api";
import { projectDateTime, projectPointCount, type ProjectDraft } from "./project";
import { count, EMPTY_FILTERS, filterPoints, formatDate, formatTime, sortPoints, type ConsoleConfig, type Filters, type LocationPoint, type Project } from "./model";

export function App() {
  const [config, setConfig] = useState<ConsoleConfig | null>(null);
  const [points, setPoints] = useState<LocationPoint[]>([]), [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true), [loadedCount, setLoadedCount] = useState(0), [error, setError] = useState("");
  const [revision, setRevision] = useState(0), [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [search, setSearch] = useState(""), [selectedId, setSelectedId] = useState<number | null>(null);
  const [showPoints, setShowPoints] = useState(true), [showLines, setShowLines] = useState(false);
  const [showBorders, setShowBorders] = useState(false);
  const [showPlaceNames, setShowPlaceNames] = useState(true);
  const [autoFit, setAutoFit] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false), [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableTab, setTableTab] = useState<"points" | "projects">("points"), [projectSearch, setProjectSearch] = useState("");
  const [projectEditor, setProjectEditor] = useState<{ project?: Project; initialDraft: ProjectDraft } | null>(null);
  const [tableSorting, setTableSorting] = useState<SortingState>([{ id: "timestamp", desc: true }]);
  const [drawerHeight, setDrawerHeight] = useState(58);
  const map = useRef<MapActions>(null), drawerRef = useRef<HTMLDivElement>(null), tableSearch = useRef<HTMLInputElement>(null);
  const editorFocus = useRef<HTMLElement | null>(null);
  const selectTablePoint = useCallback((id: number) => { setSelectedId(id); setTableDialogOpen(false); }, []);
  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal).then(setConfig).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "预览配置未能加载。");
    });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setError(""); setSelectedId(null);
    setPoints([]); setProjects([]); setLoading(true); setLoadedCount(0);
    loadData(controller.signal, setLoadedCount).then(data => {
      if (!controller.signal.aborted) { setPoints(sortPoints(data.locations)); setProjects(data.projects); }
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "数据未能加载。");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setDrawerHeight(entries[0].contentRect.height));
    if (drawerRef.current) observer.observe(drawerRef.current);
    return () => observer.disconnect();
  }, []);
  const visible = useMemo(() => filterPoints(points, filters, projects), [points, filters, projects]);
  const timelinePoints = useMemo(() => filterPoints(points, {
    project: filters.project, filtered: filters.filtered, since: "", until: "",
  }, projects), [points, filters.project, filters.filtered, projects]);
  const canDraw = !!drawableRange(filters);
  // Automatic point cleanup is the normal overview, so low zooms still cluster.
  const filteredMode = canDraw || !!filters.project;
  const preserveMapView = () => {
    setAutoFit(false); map.current?.stop();
  };
  const selectTimeRange = (since: string, until: string, timeWindow?: Filters["timeWindow"]) => {
    if (!drawableRange({ since, until })) return;
    setAutoFit(true);
    setFilters(current => ({ ...current, since, until, timeWindow })); setShowLines(true);
  };
  const clearTimeRange = () => {
    preserveMapView();
    setFilters(current => ({ ...current, since: "", until: "", timeWindow: undefined })); setShowLines(false);
  };
  const toggleOriginalTracks = () => {
    preserveMapView();
    setFilters(current => ({ ...current, filtered: !current.filtered }));
  };
  const tablePoints = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return visible;
    return visible.filter(p => [p.id, p.city, p.device, formatDate(p.timestamp), formatTime(p.timestamp), p.longitude.toFixed(6), p.latitude.toFixed(6)]
      .some(value => String(value ?? "").toLowerCase().includes(query)));
  }, [visible, search]);
  const activeProject = projects.find(project => String(project.id) === filters.project);
  const projectTimestamps = useMemo(() => filterPoints(points, { ...EMPTY_FILTERS, filtered: filters.filtered }, []).map(point => point.timestamp), [points, filters.filtered]);
  const projectCounts = useMemo(() => new Map(projects.map(project => [project.id, projectPointCount(projectTimestamps, project)])), [projects, projectTimestamps]);
  const tableProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    return query ? projects.filter(project => [project.id, project.name, formatDate(project.startTime), formatDate(project.endTime)]
      .some(value => String(value).toLowerCase().includes(query))) : projects;
  }, [projects, projectSearch]);
  const previewProject = (project: Project) => {
    map.current?.stop(); setAutoFit(true);
    setFilters({ ...EMPTY_FILTERS, project: String(project.id) }); setSearch(""); setSelectedId(null);
    setShowPoints(true); setShowLines(true); setTableDialogOpen(false);
  };
  const clearProject = () => { preserveMapView(); setFilters(current => ({ ...current, project: "" })); setShowLines(false); };
  const openProjectEditor = (project?: Project) => {
    editorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const date = formatDate(visible.at(-1)?.timestamp ?? Date.now()).replaceAll(".", "-");
    const start = filters.timeWindow?.start ?? (filters.since ? Date.parse(`${filters.since}T00:00:00+08:00`) : activeProject?.startTime);
    const end = filters.timeWindow?.end ?? (filters.until ? Date.parse(`${filters.until}T23:59:59+08:00`) : activeProject?.endTime);
    setProjectEditor({ project, initialDraft: { name: "", start: start === undefined ? `${date}T00:00:00` : projectDateTime(start),
      end: end === undefined ? `${date}T23:59:59` : projectDateTime(end) } });
  };
  const projectSaved = (project: Project) => {
    setProjects(current => [...current.filter(item => item.id !== project.id), project].sort((a, b) => b.startTime - a.startTime || b.id - a.id));
    if (filters.project === String(project.id)) { map.current?.stop(); setAutoFit(true); setSelectedId(null); }
    setProjectSearch(""); setProjectEditor(null);
  };
  const indices = useMemo(() => new Map(visible.map((p, index) => [p.id, index])), [visible]);
  const selectedIndex = selectedId === null ? -1 : indices.get(selectedId) ?? -1;
  const selected = selectedIndex < 0 ? null : visible[selectedIndex];
  const drawAroundPoint = () => {
    if (!selected) return;
    setAutoFit(true);
    setFilters(current => ({ ...current, ...aroundPointRange(selected.timestamp) }));
    setShowPoints(true); setShowLines(true);
  };
  const closePoint = () => {
    setSelectedId(null);
    if (filters.timeWindow) clearTimeRange();
    else preserveMapView();
  };
  const viewAllTracks = () => {
    map.current?.stop();
    setFilters({ ...EMPTY_FILTERS }); setSearch(""); setProjectSearch(""); setSelectedId(null);
    setShowLines(false); setShowPoints(true); setAutoFit(true);
    // MapView fits after the reset filters produce the full point collection.
  };
  const stats = useMemo(() => {
    const dates = new Set<string>();
    for (const p of visible) {
      dates.add(formatDate(p.timestamp));
    }
    const first = visible[0], last = visible.at(-1);
    return { days: dates.size,
      range: first && last ? `${formatDate(first.timestamp)} — ${formatDate(last.timestamp)}` : "全部时间" };
  }, [visible]);
  const { days } = stats;
  const range = filters.timeWindow
    ? `${formatDate(filters.timeWindow.start)} ${formatTime(filters.timeWindow.start).slice(0, 5)} — ${formatDate(filters.timeWindow.end).slice(5)} ${formatTime(filters.timeWindow.end).slice(0, 5)}`
    : canDraw ? `${filters.since.replaceAll("-", ".")} — ${filters.until.replaceAll("-", ".")}` : stats.range;
  useEffect(() => { if (selectedId !== null && !selected) setSelectedId(null); }, [selectedId, selected]);
  const tabPrefix = tableDialogOpen ? "dialog" : "drawer";
  const originalTracksButton = <Button className="raw-track-toggle" aria-label="显示原始轨迹" aria-pressed={!filters.filtered}
    onClick={toggleOriginalTracks}><span><span className="raw-track-prefix">显示</span>原始轨迹</span></Button>;
  const tabs = <div className="table-tabs" role="tablist" aria-label="表格内容">{(["points", "projects"] as const).map((tab, index) =>
    <button key={tab} role="tab" id={`${tabPrefix}-${tab}-tab`} aria-controls={`${tabPrefix}-${tab}-panel`} aria-selected={tableTab === tab} tabIndex={tableTab === tab ? 0 : -1}
      onClick={() => { setTableTab(tab); if (!tableDialogOpen && !drawerOpen) { map.current?.stop(); setDrawerOpen(true); } }}
      onKeyDown={event => {
        const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : event.key === "ArrowRight" || event.key === "ArrowLeft" ? 1 - index : -1;
        if (next < 0) return; event.preventDefault();
        (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.click();
        (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
      }}>{tab === "points" ? "位置点" : "项目"}</button>)}</div>;
  const tableContent = <div className="table-panel" role="tabpanel" id={`${tabPrefix}-${tableTab}-panel`} aria-labelledby={`${tabPrefix}-${tableTab}-tab`}>
    {tableTab === "points" ? <div className="table-toolbar"><label className="search-input"><Search size={15} /><input ref={tableSearch} aria-label="搜索表格数据" placeholder="搜索编号、城市、设备或坐标…" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="清除搜索" onClick={() => setSearch("")}><X size={14} /></button>}</label>
      {originalTracksButton}
      {activeProject && <Button className="active-project" aria-label="清除项目筛选" title={activeProject.name} onClick={clearProject}><span>{activeProject.name}</span><X size={12} /></Button>}
      <span className="table-order-note">点击编号定位 · 表头可排序</span></div>
      : <div className="table-toolbar project-toolbar"><label className="search-input"><Search size={15} /><input ref={tableSearch} aria-label="搜索项目" placeholder="搜索项目名称或日期…" value={projectSearch} onChange={e => setProjectSearch(e.target.value)} />{projectSearch && <button aria-label="清除项目搜索" onClick={() => setProjectSearch("")}><X size={14} /></button>}</label>
        {originalTracksButton}
        {activeProject && <Button className="active-project" aria-label="清除项目筛选" title={activeProject.name} onClick={clearProject}><span>{activeProject.name}</span><X size={12} /></Button>}
        <span className="table-order-note">按开始时间排序 · 北京时间</span><Button className="new-project" disabled={loading || !!error} onClick={() => openProjectEditor()}><Plus size={14} />新增项目</Button></div>}
    {loading ? <div className="data-state" role="status"><LoaderCircle size={19} className="spinning" /><p>正在读取轨迹<span>已读取 {count(loadedCount)} 个位置点</span></p></div>
      : error ? <div className="data-state data-error" role="alert"><p>{error}</p><Button onClick={() => setRevision(v => v + 1)}>重试</Button></div>
      : tableTab === "points" ? <DataTable points={tablePoints} selectedId={selectedId} onSelect={selectTablePoint} sorting={tableSorting} onSortingChange={setTableSorting} />
        : <ProjectTable projects={tableProjects} counts={projectCounts} selectedId={filters.project} onPreview={previewProject} onEdit={openProjectEditor} />}
  </div>;
  return <Tooltip.Provider delayDuration={250}><Dialog.Root open={tableDialogOpen} onOpenChange={setTableDialogOpen}><main className={`atlas drawer-${drawerOpen ? "compact" : "collapsed"}${tableDialogOpen ? " table-dialog-open" : ""}`}>
    <MapView ref={map} config={config} points={visible} selected={selected} onSelect={setSelectedId} days={days}
      showPoints={showPoints} showLines={showLines && (canDraw || !!activeProject)} showBorders={showBorders} showPlaceNames={showPlaceNames}
      filteredMode={filteredMode} autoFit={autoFit} bottomInset={drawerHeight + 24} />

    <div className="range-control"><TimeRangePopover filters={filters} range={range} points={timelinePoints} disabled={loading}
      onSelectRange={selectTimeRange} onClearRange={clearTimeRange} /></div>
    <div className="refresh-control"><IconButton label="重新加载数据" disabled={loading} onClick={() => setRevision(v => v + 1)}><RefreshCw size={16} className={loading ? "spinning" : ""} /></IconButton></div>

    <div className="map-tools">
      <IconButton label="放大地图" disabled={!config?.mapboxToken} onClick={() => map.current?.zoom(1)}><Plus size={19} /></IconButton>
      <IconButton label="缩小地图" disabled={!config?.mapboxToken} onClick={() => map.current?.zoom(-1)}><Minus size={19} /></IconButton>
      <span className="tool-separator" />
      <IconButton label="查看全部轨迹并清空连线" disabled={!config?.mapboxToken || !points.length} onClick={viewAllTracks}><Crosshair size={18} /></IconButton>
      <Popover.Root><Popover.Trigger asChild><Button className="icon-button" aria-label="地图图层"><Layers2 size={18} /></Button></Popover.Trigger>
        <Popover.Portal><Popover.Content className="popover layer-popover" side="left" sideOffset={10} aria-label="地图图层">
          <div className="popover-heading">地图图层</div><Toggle label="显示位置点" checked={showPoints} onChange={enabled => { if (!enabled) preserveMapView(); setShowPoints(enabled); }} />
          <Toggle label="显示国境线" checked={showBorders} onChange={setShowBorders} />
          <Toggle label="显示地名" checked={showPlaceNames} onChange={setShowPlaceNames} />
        </Popover.Content></Popover.Portal></Popover.Root>
      <Button className="north-button" aria-label="地图朝北" disabled={!config?.mapboxToken} onClick={() => map.current?.north()}><span>N</span><svg viewBox="0 0 18 24" aria-hidden="true"><path d="M9 3L15 21 9 17 3 21Z" /></svg></Button>
    </div>

    {selected && <aside className="point-card" aria-label="选中位置详情" style={{ bottom: `${drawerHeight + 100}px`, maxHeight: `calc(100dvh - ${drawerHeight + 100}px - var(--point-card-top, 16px))` }}>
      <div className="point-card-heading"><span className="eyebrow">位置点 / {selected.id}</span><IconButton label="关闭位置详情" onClick={closePoint}><X size={15} /></IconButton></div>
      <h3>{selected.city || "未记录城市"}</h3><PointLocalTime point={selected} />
      <div className="point-coordinates"><div><span>经度</span><strong>{selected.longitude.toFixed(6)}°</strong></div><div><span>纬度</span><strong>{selected.latitude.toFixed(6)}°</strong></div></div>
      <div className="point-card-meta"><span>{selected.device || "未知设备"}</span></div>
      <Button className="point-context-button" aria-label="绘制前后 24 小时轨迹" title="以此点为中心，绘制前后各 24 小时的轨迹" onClick={drawAroundPoint}><Route size={15} />前后 24 小时轨迹</Button>
      <div className="point-stepper"><Button disabled={selectedIndex <= 0} onClick={() => setSelectedId(visible[selectedIndex - 1].id)}><ArrowLeft size={14} />上一个</Button>
        <span>{selectedIndex + 1} / {count(visible.length)}</span><Button disabled={selectedIndex >= visible.length - 1} onClick={() => setSelectedId(visible[selectedIndex + 1].id)}>下一个<ArrowRight size={14} /></Button></div>
    </aside>}

    <section className="data-drawer" ref={drawerRef} aria-label="轨迹数据表">
      <div className="drawer-header"><div className="drawer-identity"><span className="section-index">02</span><Table2 size={17} /><h2>足迹数据</h2>{!tableDialogOpen && tabs}<span className="drawer-count">{count(tableTab === "points" ? tablePoints.length : tableProjects.length)} <span>{tableTab === "points" ? "条记录" : "个项目"}</span></span></div>
        <div className="drawer-actions">
          <Dialog.Trigger asChild><IconButton label="弹窗查看表格"><Maximize2 size={17} /></IconButton></Dialog.Trigger>
          <IconButton label={drawerOpen ? "收起表格" : "打开表格"} aria-expanded={drawerOpen} onClick={() => { map.current?.stop(); setDrawerOpen(open => !open); }}>
            {drawerOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</IconButton>
        </div></div>
      {drawerOpen && !tableDialogOpen && tableContent}
    </section>
  </main><Dialog.Portal><Dialog.Overlay className="table-dialog-overlay" /><Dialog.Content className="table-dialog" aria-describedby={undefined}
    onOpenAutoFocus={event => { event.preventDefault(); tableSearch.current?.focus(); }}>
    <div className="drawer-header"><div className="drawer-identity"><Table2 size={17} /><Dialog.Title>足迹数据</Dialog.Title>{tabs}<span className="table-dialog-count">{count(tableTab === "points" ? tablePoints.length : tableProjects.length)} {tableTab === "points" ? "条记录" : "个项目"}</span></div>
      <Dialog.Close asChild><IconButton label="关闭表格弹窗"><X size={18} /></IconButton></Dialog.Close></div>
    {tableDialogOpen && tableContent}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
    {projectEditor && <ProjectEditor project={projectEditor.project} initialDraft={projectEditor.initialDraft} onSaved={projectSaved} onClose={() => setProjectEditor(null)}
      restoreFocus={() => { if (editorFocus.current?.isConnected) editorFocus.current.focus(); else tableSearch.current?.focus(); }} />}
  </Tooltip.Provider>;
}

function TimeRangePopover({ filters, range, points, disabled, onSelectRange, onClearRange }: {
  filters: Filters; range: string;
  points: LocationPoint[]; disabled: boolean; onSelectRange: (since: string, until: string, timeWindow?: Filters["timeWindow"]) => void; onClearRange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = !!drawableRange(filters);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><Button className={`range-button ${active ? "range-filtered" : ""}`} aria-label={`选择轨迹时间：${range}`}><CalendarDays size={16} /><span>{range}</span><ChevronDown size={14} />{active && <span className="filter-dot" />}</Button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="popover timeline-popover" align="center" sideOffset={12} collisionPadding={12} aria-label="选择轨迹时间">
      <Timeline points={points} filters={filters} disabled={disabled} onSelect={onSelectRange} onClear={onClearRange} />
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
