import { memo, useMemo, useRef, useState, type PointerEvent } from "react";
import * as Slider from "@radix-ui/react-slider";
import { Button } from "./components";
import { count, type Filters, type LocationPoint } from "./model";
import { calendarDay, constrainRange, DAY_MS, dayDate, drawableRange, monthWindow, panSelection, presetRange, quickRange, selectionInWindow, shiftMonth, type DayRange } from "./timeline";

interface Props {
  points: LocationPoint[];
  filters: Filters;
  disabled: boolean;
  onSelect: (since: string, until: string, timeWindow?: Filters["timeWindow"]) => void;
  onClear: () => void;
}
interface View { first: number; last: number; range: DayRange }
interface Pan { pointer: number; x: number; width: number; range: DayRange; selection: DayRange;
  active: boolean; timeWindow?: Filters["timeWindow"]; shift: number; moved: boolean }

export const Timeline = memo(function Timeline({ points, filters, disabled, onSelect, onClear }: Props) {
  const density = useMemo(() => {
    const counts = new Map<number, number>(); let first = Infinity, last = -Infinity;
    for (const point of points) {
      const day = calendarDay(point.timestamp);
      if (!Number.isFinite(day)) continue;
      first = Math.min(first, day); last = Math.max(last, day);
      counts.set(day, (counts.get(day) || 0) + 1);
    }
    return { counts, first, last, peak: Math.max(1, ...counts.values()) };
  }, [points]);
  const [view, setView] = useState<View | null>(null), [draft, setDraft] = useState<DayRange | null>(null);
  const [panning, setPanning] = useState(false), pan = useRef<Pan | null>(null);
  const hasData = Number.isFinite(density.first), applied = drawableRange(filters);
  const now = Date.now(), currentWeek = quickRange("week", now);
  // Calendar bounds stay independent of data gaps and filtering dates. Include
  // a point's adjacent day so exact 48-hour windows fit at month boundaries.
  const firstMonth = hasData ? dayDate(Math.min(density.first - 1, calendarDay(now) - 1)).slice(0, 7) : "";
  // Quick selections use the current calendar, even if the latest observation
  // is older. Include a week crossing into next month without clamping it.
  const lastMonth = hasData ? dayDate(Math.max(density.last + 1, currentWeek[1])).slice(0, 7) : "";
  const first = hasData ? monthWindow(firstMonth)[0] : 0, last = hasData ? monthWindow(lastMonth)[1] : 0;
  const months = useMemo(() => {
    const result: string[] = [];
    if (firstMonth && lastMonth) for (let value = lastMonth; value >= firstMonth; value = shiftMonth(value, -1)) result.push(value);
    return result;
  }, [firstMonth, lastMonth]);
  const selectedMonth = filters.until.slice(0, 7);
  const initialMonth = selectedMonth >= firstMonth && selectedMonth <= lastMonth && selectedMonth ? selectedMonth
    : hasData ? dayDate(density.last + 1).slice(0, 7) : lastMonth;
  const window: DayRange = view?.first === first && view.last === last ? view.range
    : hasData ? monthWindow(initialMonth) : [0, 0];
  const [minimum, maximum] = window, span = Math.max(1, maximum - minimum);
  const month = hasData ? dayDate(maximum).slice(0, 7) : "";
  const withinHistory = (range: DayRange | null): range is DayRange => !!range && range[0] >= first && range[1] <= last;
  const values = withinHistory(draft) ? draft : withinHistory(applied) ? applied
    : presetRange(Math.max(minimum, Math.min(density.last, maximum)), 7, minimum);
  const latestValues = useRef(values); latestValues.current = values;
  const precise = filters.timeWindow && (pan.current?.timeWindow || (values[0] === applied?.[0] && values[1] === applied?.[1]));
  const days = useMemo(() => Array.from({ length: Math.ceil(maximum) - Math.floor(minimum) + 1 }, (_, i) => ({
    day: Math.floor(minimum) + i, count: density.counts.get(Math.floor(minimum) + i) || 0,
  })), [minimum, maximum, density]);
  const select = (range: DayRange, viewport: DayRange = window, timeWindow?: Filters["timeWindow"]) => {
    if (disabled || !hasData) return;
    setView({ first, last, range: viewport }); setDraft(range); latestValues.current = range;
    onSelect(dayDate(range[0]), dayDate(range[1]), timeWindow);
  };
  const shiftedTimeWindow = (timeWindow: Filters["timeWindow"], shift: number) => timeWindow
    ? { start: timeWindow.start + shift * DAY_MS, end: timeWindow.end + shift * DAY_MS } : undefined;
  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || !hasData || event.button !== 0 || (event.target as Element).closest('[role="slider"]')) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    pan.current = { pointer: event.pointerId, x: event.clientX, width: Math.max(1, bounds.width - 24), range: window,
      selection: values, active: !!applied, timeWindow: precise ? filters.timeWindow : undefined, shift: 0, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId); setPanning(true);
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = pan.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (Math.abs(event.clientX - gesture.x) >= 4) gesture.moved = true;
    if (!gesture.moved) return;
    const offset = (gesture.x - event.clientX) * (gesture.range[1] - gesture.range[0]) / gesture.width;
    const next = panSelection(gesture.range, gesture.selection, offset, first, last);
    gesture.shift = next.shift;
    setView({ first, last, range: next.range }); setDraft(next.selection);
  };
  const finishPan = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const gesture = pan.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    event.stopPropagation(); pan.current = null; setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) {
      setView({ first, last, range: gesture.range }); setDraft(gesture.selection);
    } else if (gesture.moved) {
      // Translate both the viewport and selection equally: the selection stays
      // at the same screen position. Commit once, after snapping to a day.
      const next = panSelection(gesture.range, gesture.selection, Math.round(gesture.shift), first, last);
      if (gesture.active && next.shift !== 0) select(next.selection, next.range, shiftedTimeWindow(gesture.timeWindow, next.shift));
      else { setView({ first, last, range: next.range }); setDraft(next.selection); }
    } else {
      const bounds = event.currentTarget.getBoundingClientRect();
      const day = Math.max(first, Math.min(last, Math.round(minimum + (event.clientX - bounds.left - 12) / Math.max(1, bounds.width - 24) * span)));
      select([day, day]);
    }
  };

  return <section className={`timeline-panel ${applied ? "timeline-active" : ""}`} aria-label="轨迹时间轴">
    <div className="timeline-header">
      <select className="timeline-month" aria-label="选择年月" value={month} disabled={disabled || !hasData} onChange={event => {
        const range = monthWindow(event.target.value);
        const selection = selectionInWindow(values, window, range);
        if (applied) select(selection, range, shiftedTimeWindow(filters.timeWindow, selection[0] - values[0]));
        else { setView({ first, last, range }); setDraft(selection); }
      }}>
        {!hasData && <option value="">选择年月</option>}{months.map(value => <option key={value} value={value}>{value.replace("-", " 年 ")} 月</option>)}
      </select>
      <div className="timeline-presets" role="group" aria-label="快速选择时间范围">
        {([["today", "今天"], ["week", "本周"], ["month", "本月"]] as const).map(([preset, label]) => {
          const range = quickRange(preset, now);
          const active = !filters.timeWindow && applied?.[0] === range[0] && applied[1] === range[1];
          return <Button key={preset} className="timeline-preset" aria-pressed={active} disabled={disabled || !hasData}
            onClick={() => { const selected = quickRange(preset); select(selected, monthWindow(dayDate(selected[1]).slice(0, 7))); }}>{label}</Button>;
        })}
      </div>
      <output className="timeline-selection" aria-label="选取时间范围" aria-live="polite">{hasData ? <>
        <span>{dayDate(Math.round(values[0])).slice(5).replace("-", ".")}<b>—</b>{dayDate(Math.round(values[1])).slice(5).replace("-", ".")}</span>
        <small>{precise ? "48 小时" : `${Math.round(values[1] - values[0]) + 1} 天`} / 最多 1 个月</small>
      </> : <span>{disabled ? "读取中…" : "暂无位置点"}</span>}</output>
      <Button className="timeline-clear" aria-label="清除时间范围，显示全部点位" disabled={!applied} onClick={() => { setDraft(null); onClear(); }}>清除</Button>
    </div>
    <div className={`timeline-axis ${panning ? "is-panning" : ""}`} aria-label="拖动平移时间轴和选段，拖动手柄选取范围"
      onPointerDownCapture={startPan} onPointerMoveCapture={movePan} onPointerUpCapture={event => finishPan(event)}
      onPointerCancelCapture={event => finishPan(event, true)} onLostPointerCapture={event => finishPan(event, true)}>
      <div className="timeline-plot"><svg className="timeline-histogram" viewBox={`0 0 ${span * 10} 44`} preserveAspectRatio="none" role="img" aria-label="每天的位置点数量">
        {days.map(({ day, count: total }) => {
          const height = total ? 3 + Math.sqrt(total / density.peak) * 34 : 1;
          return <rect key={day} x={(day - minimum) * 10 - 4} y={44 - height} width="8" height={height}
            className={day >= values[0] && day <= values[1] ? "density-selected" : ""}><title>{dayDate(day)} · {count(total)} 个点</title></rect>;
        })}
      </svg>
      <Slider.Root className="timeline-slider" value={values} min={minimum} max={Math.max(minimum + 1, maximum)} step={1}
        style={{ left: 0, width: "100%" }}
        disabled={disabled || !hasData || first === last} minStepsBetweenThumbs={0} preserveThumbOrder
        onValueChange={next => {
          const range = constrainRange(next, latestValues.current, Math.ceil(minimum), Math.floor(maximum));
          latestValues.current = range; setDraft(range);
        }} onValueCommit={next => select(constrainRange(next, latestValues.current, Math.ceil(minimum), Math.floor(maximum)))}>
        <Slider.Track className="timeline-track"><Slider.Range className="timeline-range" /></Slider.Track>
        <Slider.Thumb className="timeline-thumb" data-edge="start" aria-label="范围开始日期" aria-valuetext={dayDate(Math.round(values[0]))}><i /></Slider.Thumb>
        <Slider.Thumb className="timeline-thumb" data-edge="end" aria-label="范围结束日期" aria-valuetext={dayDate(Math.round(values[1]))}><i /></Slider.Thumb>
      </Slider.Root>
      </div>
      <div className="timeline-ticks" aria-hidden="true">{hasData && days.filter(({ day }) => day >= minimum && day <= maximum).map(({ day }) => {
        const date = dayDate(day), number = Number(date.slice(8)), fraction = (day - minimum) / span;
        const monthStart = number === 1, major = monthStart || number % 5 === 0;
        return <span key={day} className={`timeline-tick ${major ? "tick-major" : ""} ${monthStart ? "tick-month" : ""} ${number === 15 ? "tick-middle" : ""}`}
          style={{ left: `${fraction * 100}%` }} data-boundary={fraction < .025 ? "start" : fraction > .975 ? "end" : undefined}>
          <i />{major && <b>{date.slice(5).replace("-", ".")}</b>}
        </span>;
      })}</div>
    </div>
  </section>;
});
