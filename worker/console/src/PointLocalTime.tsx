import { getPointLocalTime } from "./local-time";
import type { LocationPoint } from "./model";

export function PointLocalTime({ point }: { point: LocationPoint }) {
  const time = getPointLocalTime(point);
  if (!time) return <div className="point-local-time"><p className="point-observed">时间未记录</p></div>;
  const recorded = time.timezone !== null;
  return <div className="point-local-time">
    <time className="point-observed" dateTime={new Date(point.timestamp).toISOString()} data-timezone={time.timezone ?? undefined}
      aria-label={recorded ? "观测当地时间" : "观测 UTC 时间"}>{time.date}<span>{time.time}</span></time>
    <p className="point-time-zone"><span>{recorded ? "当地时间" : "UTC 时间"}</span><span>{time.offset}</span>
      {!recorded && <span>未记录时区</span>}</p>
  </div>;
}
