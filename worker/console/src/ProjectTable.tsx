import { memo, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Pencil } from "lucide-react";
import { Button } from "./components";
import { count, formatDate, formatTime, type Project } from "./model";

export const ProjectTable = memo(function ProjectTable({ projects, counts, selectedId, onPreview, onEdit }: {
  projects: Project[]; counts: Map<number, number>; selectedId: string;
  onPreview: (project: Project) => void; onEdit: (project: Project) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [mobile, setMobile] = useState(window.innerWidth < 700);
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 700);
    window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize);
  }, []);
  const virtual = useVirtualizer({ count: projects.length, getScrollElement: () => scroll.current,
    estimateSize: () => mobile ? 130 : 62, overscan: 5, getItemKey: index => projects[index].id });
  useEffect(() => { virtual.measure(); }, [mobile]);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [projects]);
  return <div className="table-scroll" ref={scroll}>
    <table className="project-table" aria-label="项目列表">
      <thead><tr><th>项目</th><th>开始时间</th><th>结束时间</th><th>位置点</th><th>操作</th></tr></thead>
      <tbody style={{ height: `${virtual.getTotalSize()}px` }}>{virtual.getVirtualItems().map(item => {
        const project = projects[item.index], selected = String(project.id) === selectedId;
        return <tr key={project.id} data-index={item.index} data-project-id={project.id} ref={virtual.measureElement}
          tabIndex={0} aria-label={`预览项目 ${project.name}`} aria-selected={selected} onClick={() => onPreview(project)}
          onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onPreview(project); } }}
          className={selected ? "project-selected" : ""} style={{ transform: `translateY(${item.start}px)` }}>
          <td className="project-name"><strong title={project.name}>{project.name}</strong><span>#{project.id}{selected && <em>正在预览</em>}</span></td>
          <td className="project-start"><span>{formatDate(project.startTime)}</span><small>{formatTime(project.startTime)}</small></td>
          <td className="project-end"><span>{formatDate(project.endTime)}</span><small>{formatTime(project.endTime)}</small></td>
          <td className="project-count">{count(counts.get(project.id) ?? 0)}</td>
          <td className="project-actions"><Button aria-label={`编辑项目 ${project.name}`} onClick={event => { event.stopPropagation(); onEdit(project); }}><Pencil size={13} />编辑</Button></td>
        </tr>;
      })}</tbody>
    </table>
    {!projects.length && <div className="table-empty">暂无匹配的项目。</div>}
  </div>;
});
