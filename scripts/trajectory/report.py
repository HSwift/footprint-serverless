"""Create local static plots and a review report; no map service or network."""
import html
import json
import math
import os
from pathlib import Path
import sys
from collections import defaultdict
from datetime import datetime, timezone

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

if len(sys.argv) != 2:
    raise SystemExit("Usage: python scripts/trajectory/report.py <analysis-directory>")
os.umask(0o077)
root = Path(sys.argv[1])
summary = json.loads((root / "summary.json").read_text())
analysis = json.loads((root / "analysis.json").read_text())
rows = json.loads((root / "locations.json").read_text())
groups = defaultdict(list)
for row in rows:
    groups[row["Device"]].append(row)
for group in groups.values():
    group.sort(key=lambda p: (p["Date"], p["ID"]))
by_id = {p["ID"]: p for p in rows}
figures = root / "figures"
figures.mkdir(exist_ok=True, mode=0o700)


def esc(value):
    return html.escape(str(value))


def iso(timestamp):
    return datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat(timespec="seconds")


def distance(a, b):
    lat_a, lat_b = math.radians(a["Latitude"]), math.radians(b["Latitude"])
    delta_lat = lat_b - lat_a
    delta_lon = math.radians(b["Longitude"] - a["Longitude"])
    h = math.sin(delta_lat / 2) ** 2 + math.cos(lat_a) * math.cos(lat_b) * math.sin(delta_lon / 2) ** 2
    return 6371.0088 * 2 * math.asin(math.sqrt(max(0, min(1, h))))


plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                     "figure.facecolor": "white", "axes.grid": True, "grid.alpha": 0.15})


def plot_window(before, after, flagged, name, title):
    a, b = by_id[before], by_id[after]
    group = groups[a["Device"]]
    indices = {p["ID"]: i for i, p in enumerate(group)}
    window = group[max(0, indices[before] - 2):indices[after] + 3]
    lat_scale = math.cos(math.radians(a["Latitude"]))

    def x(p):
        return ((p["Longitude"] - a["Longitude"] + 180) % 360 - 180) * 111.195 * lat_scale

    def y(p):
        return (p["Latitude"] - a["Latitude"]) * 111.195

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5), layout="constrained")
    spatial, temporal = axes
    inset_enabled = False
    spatial.plot([x(p) for p in window], [y(p) for p in window], "o-", color="#abb5c5", lw=1, ms=4, label="Raw observations")
    if flagged:
        kept = [p for p in window if p["ID"] not in flagged]
        bad = [p for p in window if p["ID"] in flagged]
        spatial.plot([x(p) for p in kept], [y(p) for p in kept], "o-", color="#14826b", ms=5, label="Retained candidate path")
        spatial.scatter([x(p) for p in bad], [y(p) for p in bad], c="#d14a36", s=35, zorder=4, label="Flagged candidates")
        # Show the retained path at its actual scale when a distant jump hides it.
        spread = max(max(x(p) for p in window) - min(x(p) for p in window),
                     max(y(p) for p in window) - min(y(p) for p in window))
        kept_spread = max(max(x(p) for p in kept) - min(x(p) for p in kept),
                          max(y(p) for p in kept) - min(y(p) for p in kept), 0.1)
        if spread > 10 * kept_spread:
            inset_enabled = True
            inset = spatial.inset_axes([0.47, 0.50, 0.50, 0.38])
            inset.plot([x(p) for p in kept], [y(p) for p in kept], "o-", color="#14826b", ms=3)
            for p in kept:
                if before <= p["ID"] <= after:
                    inset.annotate(str(p["ID"]), (x(p), y(p)), xytext=(3, 3), textcoords="offset points", fontsize=7)
            inset.set_title("Retained path detail", fontsize=8)
            inset.tick_params(labelsize=7)
    else:
        spatial.scatter([x(a), x(b)], [y(a), y(b)], c="#e49325", s=45, zorder=4, label="Unresolved edge endpoints")
    labels = defaultdict(list)
    for p in window:
        if p["ID"] in flagged or (not inset_enabled and p["ID"] in (before, after)):
            labels[(round(x(p), 5), round(y(p), 5))].append(p["ID"])
    for (px, py), ids in labels.items():
        label = "\n".join("/".join(map(str, ids[i:i + 3])) for i in range(0, len(ids), 3))
        offset = (-6, 6) if ids == [before] else (6, -14) if ids == [after] else (6, 6)
        spatial.annotate(label, (px, py), xytext=offset, textcoords="offset points", fontsize=8,
                         ha="right" if ids == [before] else "left")
    spatial.set(xlabel="Approximate east / west (km)", ylabel="Approximate north / south (km)")
    spatial.set_aspect("equal", adjustable="datalim")
    spatial.legend(fontsize=8, loc="upper left")
    minutes = [(p["Date"] - a["Date"]) / 60000 for p in window]
    distances = [distance(a, p) for p in window]
    temporal.plot(minutes, distances, "o-", color="#abb5c5", ms=4)
    temporal.scatter(minutes, distances, c=["#d14a36" if p["ID"] in flagged else "#14826b" if flagged else "#e49325" for p in window], s=25, zorder=3)
    temporal.set(xlabel="Minutes from first anchor", ylabel="Great-circle distance from first anchor (km)")
    fig.suptitle(title, fontsize=13, weight="bold")
    fig.savefig(figures / f"{name}.png", dpi=160)
    plt.close(fig)
    return f"figures/{name}.png"


intervals, speeds = [], []
for group in groups.values():
    for a, b in zip(group, group[1:]):
        seconds = (b["Date"] - a["Date"]) / 1000
        if seconds > 0:
            intervals.append(seconds)
            speed = distance(a, b) / seconds * 3600
            if speed > 0:
                speeds.append(speed)
fig, axes = plt.subplots(1, 2, figsize=(12, 4), layout="constrained")
for ax, values, label in zip(axes, (intervals, speeds), ("Sampling interval (seconds)", "Raw edge speed (km/h)")):
    minimum = min(values) if values else 1
    maximum = max(max(values) if values else 10, minimum * 1.01)
    lo, hi = math.log10(minimum), math.log10(maximum * 1.001)
    bins = [10 ** (lo + i * (hi - lo) / 60) for i in range(61)]
    ax.hist(values, bins=bins, color="#3f729d")
    ax.set_xscale("log")
    ax.set(xlabel=label, ylabel="Number of edges")
axes[0].axvline(1800, color="#d14a36", ls="--", label="30-minute boundary")
axes[1].axvline(1500, color="#d14a36", ls="--", label="Unresolved speed threshold")
for ax in axes:
    ax.legend(fontsize=8)
fig.suptitle("Sampling is irregular; a speed threshold alone cannot assign a bad point", fontsize=12)
fig.savefig(figures / "distribution.png", dpi=160)
plt.close(fig)

examples = []
high = sorted((c for c in analysis["excursions"] if c["confidence"] == "high"), key=lambda c: -c["maxDeviationMeters"])
review = [c for c in analysis["excursions"] if c["confidence"] == "review"]
for index, c in enumerate(high[:3] + review[:1]):
    image = plot_window(c["beforeId"], c["afterId"], set(c["pointIds"]), f"example-{index + 1}",
                        f'{c["confidence"].upper()} candidate: {c["beforeId"]} to {c["afterId"]}')
    examples.append(f'<article><h3>{esc(c["confidence"])} · {esc(c["reason"])} · 候选 ID {esc(c["pointIds"])}</h3>'
                    f'<p>两端 ID {c["beforeId"]} → {c["afterId"]}，保留中间点 {esc(c["keptInteriorIds"])}。'
                    f'进出速度 {c["entrySpeedKmh"]:.1f} / {c["exitSpeedKmh"]:.1f} km/h，'
                    f'两端直达速度 {c["bypassSpeedKmh"]:.1f} km/h；最大插值偏离 {c["maxDeviationMeters"] / 1000:.2f} km。</p>'
                    f'<img src="{image}" alt="候选轨迹段的空间和时间图"></article>')
if analysis["unresolvedJumps"]:
    e = max(analysis["unresolvedJumps"], key=lambda e: e["speedKmh"])
    image = plot_window(e["beforeId"], e["afterId"], set(), "unresolved", "Unresolved jump: insufficient two-sided evidence")
    examples.append(f'<article><h3>未归因跳变 · {e["beforeId"]} → {e["afterId"]}</h3>'
                    f'<p>{e["seconds"]:.0f} 秒，{e["distanceMeters"] / 1000:.2f} km，{e["speedKmh"]:.1f} km/h。'
                    '尚未通过短窗口或长间隔往返归因，保留为待复核边，不能据此直接删除端点。</p>'
                    f'<img src="{image}" alt="未归因跳变的空间和时间图"></article>')

segment_rows = []
for c in analysis["excursions"]:
    segment_rows.append(f'<tr data-confidence="{c["confidence"]}"><td>{c["confidence"]}</td><td>{esc(c["pointIds"])}</td>'
                        f'<td>{esc(iso(by_id[c["beforeId"]]["Date"]))}</td><td>{c["beforeId"]} → {c["afterId"]}</td>'
                        f'<td>{c["entrySpeedKmh"]:.0f} / {c["exitSpeedKmh"]:.0f}</td>'
                        f'<td>{c["maxDeviationMeters"] / 1000:.2f}</td><td>{esc(c["keptInteriorIds"])}</td></tr>')
sensitivity_rows = ''.join(f'<tr><td>{s["minSpeedKmh"]}</td><td>{s["highPoints"]}</td><td>{s["reviewPoints"]}</td>'
                           f'<td>{s["unresolvedEdges"]}</td></tr>' for s in summary["sensitivity"])
device_rows = ''.join(f'<tr><td>{esc(d["device"])}</td><td>{d["points"]}</td><td>{esc(d["firstTime"])}</td>'
                      f'<td>{esc(d["lastTime"])}</td></tr>' for d in summary["devices"])
document = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Footprint 轨迹偏离点分析</title>
<style>body{{font:16px/1.65 system-ui,sans-serif;color:#182c3b;background:#f3f6f8;margin:0}}main{{max-width:1120px;margin:auto;padding:36px 24px}}h1{{font-size:30px}}h2{{margin-top:36px}}article,.box{{background:white;padding:20px;border-radius:12px;margin:18px 0}}.metrics{{display:flex;gap:14px;flex-wrap:wrap}}.metrics div{{background:white;padding:16px 24px;border-radius:10px}}strong{{font-size:24px}}img{{width:100%;height:auto}}table{{border-collapse:collapse;font-size:14px;width:100%;background:white}}td,th{{text-align:left;border-bottom:1px solid #dee5ea;padding:10px}}.scroll{{overflow:auto}}code{{overflow-wrap:anywhere}}a{{color:#156b83}}select{{font-size:16px;padding:5px}}small{{color:#567}}</style>
<main><h1>轨迹偏离点分析</h1><p>全量 D1 副本 · 原始坐标保留 · 离线实验算法 <code>{esc(analysis["version"])}</code></p>
<div class="metrics"><div><strong>{summary["totalPoints"]:,}</strong><br>位置记录</div>
<div><strong>{summary["highPoints"]}</strong><br>高置信候选 / {summary["highSegments"]} 段</div>
<div><strong>{summary["reviewPoints"]}</strong><br>待复核候选 / {summary["reviewSegments"]} 段</div>
<div><strong>{summary["unresolvedEdges"]}</strong><br>未归因跳变边</div></div>
<div class="box">结果属于候选标记，没有真值标签，不能计算准确率或宣称找出了全部错点。没有修改远程数据库或 API 的查询结果。
采样间隔超过 30 分钟的边共 {summary["gapEdges"]:,} 条；同设备同时间同坐标的重复组 {len(analysis["duplicateGroups"])} 组。</div>
<h2>数据与方法</h2><div class="scroll"><table><tr><th>设备</th><th>记录数</th><th>开始（UTC）</th><th>结束（UTC）</th></tr>{device_rows}</table></div>
<p>按设备与观测时间排序，在短窗口内固定两端，用球面距离与速度约束构建图，再寻找能保留最多观测点的路径。
未被保留的点还需通过偏离距离、绕行比和外侧观测检查。长间隔往返另需近原点锚点、稳定外侧观测和至少一段极端速度。
连续高速行程保留；未通过归因的长间隔与单侧跳变单独复核。</p>
<p>核心参考：<a href="https://arxiv.org/abs/2411.01214">MTCSC（2024）</a> 的最少修复点与动态规划；
<a href="https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/TrajectoryDataMining-tist-yuzheng_published.pdf">Trajectory Data Mining（2015）</a> 的轨迹预处理；
<a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC5191017/">TRDM（2016）</a> 作为后续小幅漂移方法。
当前实现是带两端约束的改编原型，没有复现完整 MTCSC-C/A 或 TRDM。</p>
<img src="figures/distribution.png" alt="采样间隔和原始边速度分布"><small>分布图采用对数横轴，速度图省略零速度；单位为秒和 km/h。</small>
<h2>代表性轨迹段</h2>{''.join(examples)}
<h2>全部候选段</h2><p>筛选 <select id="confidence"><option value="all">全部</option><option value="high">高置信候选</option><option value="review">待复核候选</option></select></p>
<div class="scroll"><table id="findings"><thead><tr><th>分级</th><th>候选 ID</th><th>起始（UTC）</th><th>两端 ID</th><th>进/出速度 km/h</th><th>最大偏离 km</th><th>保留中间 ID</th></tr></thead><tbody>{''.join(segment_rows)}</tbody></table></div>
<h2>参数敏感性</h2><table><tr><th>速度下限 km/h</th><th>高置信候选点</th><th>待复核候选点</th><th>未归因边</th></tr>{sensitivity_rows}</table>
<p>候选数量稳定性不能代替人工标签验证。低速阈值提高时，部分短距离跳点不再满足候选规则。
小幅漂移、长错误定位段、开始或结束处的错点以及物理上合理的错误位置仍可能漏检。</p>
<h2>本地文件</h2><p><a href="findings.csv">逐点候选 CSV</a> · <a href="unresolved.csv">未归因边 CSV</a> ·
<a href="analysis.json">完整结果 JSON</a> · <a href="summary.json">统计与参数 JSON</a> · <a href="snapshot.sql">完整 D1 SQL 副本</a></p>
<p>生成时间：{esc(summary["generatedAt"])}；本机单次检测用时约 {summary["elapsedMs"]:.1f} ms（不含文件读取／敏感性分析，不能当作 Workers 性能保证）。</p>
<p>分析输入 SHA-256：<code>{esc(summary["inputSha256"])}</code></p>
</main><script>document.querySelector('#confidence').addEventListener('change',function(){{for(const row of document.querySelectorAll('#findings tbody tr'))row.hidden=this.value!=='all'&&row.dataset.confidence!==this.value;}});</script></html>'''
(root / "report.html").write_text(document, encoding="utf-8")
print(f"Report: {root / 'report.html'}")
