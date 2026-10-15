import { memo, useEffect, useMemo, useRef, useState } from "react";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type OnChangeFn, type SortingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, LocateFixed } from "lucide-react";
import { formatDate, formatTime, type LocationPoint } from "./model";
export const DataTable = memo(function DataTable({ points, selectedId, onSelect, sorting, onSortingChange }: {
  points: LocationPoint[]; selectedId: number | null; onSelect: (id: number) => void; sorting: SortingState; onSortingChange: OnChangeFn<SortingState>;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [mobile, setMobile] = useState(window.innerWidth < 700);
  useEffect(() => { const resize = () => setMobile(window.innerWidth < 700); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const columns = useMemo<ColumnDef<LocationPoint>[]>(() => [
    { accessorKey: "id", header: "编号", cell: info => <span className="row-id">{String(info.getValue())}</span> },
    { accessorKey: "timestamp", header: "观测时间", cell: info => <span className="table-date">{formatDate(Number(info.getValue()))}<span>{formatTime(Number(info.getValue()))}</span></span> },
    { accessorKey: "longitude", header: "经度", cell: info => Number(info.getValue()).toFixed(6) },
    { accessorKey: "latitude", header: "纬度", cell: info => Number(info.getValue()).toFixed(6) },
    { accessorKey: "city", header: "城市", cell: info => info.getValue() || "—" },
    { accessorKey: "device", header: "设备", cell: info => <span title={String(info.getValue() || "")}>{info.getValue() as string || "—"}</span> },
    { id: "locate", header: "", enableSorting: false, cell: () => <LocateFixed size={15} aria-hidden="true" /> },
  ], []);
  const table = useReactTable({ data: points, columns, state: { sorting }, onSortingChange,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getRowId: p => String(p.id) });
  const rows = table.getRowModel().rows;
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => mobile ? 102 : 46, overscan: 8 });
  useEffect(() => { virtual.measure(); }, [mobile]);
  useEffect(() => {
    if (selectedId === null) return;
    const index = rows.findIndex(row => row.original.id === selectedId);
    if (index >= 0) virtual.scrollToIndex(index, { align: "auto" });
  }, [selectedId, rows]);
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [points]);
  return <div className="table-scroll" ref={scroll}>
    <table className="point-table" aria-label="位置数据点">
      <thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th key={header.id}
        aria-sort={header.column.getIsSorted() === "asc" ? "ascending" : header.column.getIsSorted() === "desc" ? "descending" : undefined}>
        {header.column.getCanSort() ? <button onClick={header.column.getToggleSortingHandler()}>
          {flexRender(header.column.columnDef.header, header.getContext())}
          {header.column.getIsSorted() === "asc" ? <ArrowUp size={12} /> : header.column.getIsSorted() === "desc" ? <ArrowDown size={12} /> : <ArrowUpDown size={11} className="sort-idle" />}
        </button> : flexRender(header.column.columnDef.header, header.getContext())}
      </th>)}</tr>)}</thead>
      <tbody style={{ height: `${virtual.getTotalSize()}px` }}>{virtual.getVirtualItems().map(item => {
        const row = rows[item.index], selected = row.original.id === selectedId;
        return <tr key={row.id} data-index={item.index} ref={virtual.measureElement} onClick={() => onSelect(row.original.id)}
          className={selected ? "row-selected" : ""} style={{ transform: `translateY(${item.start}px)` }}>
          {row.getVisibleCells().map(cell => <td key={cell.id} data-column={cell.column.id}>
            {cell.column.id === "id" ? <button className="row-select" aria-label={`查看数据点 ${row.original.id}`} aria-pressed={selected} onClick={() => onSelect(row.original.id)}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</button>
              : cell.column.id === "locate" ? <button className="row-locate" aria-label={`在地图定位 ${row.original.id}`} onClick={() => onSelect(row.original.id)}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</button>
              : flexRender(cell.column.columnDef.cell, cell.getContext())}
          </td>)}
        </tr>;
      })}</tbody>
    </table>
    {!points.length && <div className="table-empty">暂无匹配的足迹，试试其他日期、项目或搜索词。</div>}
  </div>;
});
