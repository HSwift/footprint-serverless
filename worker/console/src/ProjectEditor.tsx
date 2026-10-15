import { useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle, X } from "lucide-react";
import { Button, IconButton } from "./components";
import { saveProject } from "./api";
import type { Project } from "./model";
import { projectDraft, projectInput, type ProjectDraft } from "./project";

export function ProjectEditor({ project, initialDraft, onSaved, onClose, restoreFocus }: {
  project?: Project; initialDraft: ProjectDraft; onSaved: (project: Project) => void;
  onClose: () => void; restoreFocus: () => void;
}) {
  const [draft, setDraft] = useState(() => project ? projectDraft(project) : initialDraft);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    setError("");
    try {
      const input = projectInput(draft, project);
      setBusy(true);
      onSaved(await saveProject(input, project?.id));
    } catch (error) { setError(error instanceof Error ? error.message : "项目保存失败，请稍后重试。"); }
    finally { setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="project-dialog-overlay" /><Dialog.Content className="project-dialog"
      onOpenAutoFocus={event => { event.preventDefault(); nameInput.current?.focus(); }}
      onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <div className="project-dialog-heading"><Dialog.Title>{project ? "编辑项目" : "新增项目"}</Dialog.Title>
        <IconButton label="关闭项目编辑" disabled={busy} onClick={onClose}><X size={17} /></IconButton></div>
      <Dialog.Description className="project-description">按起止时间归集足迹，可在地图中预览。</Dialog.Description>
      <form onSubmit={submit} aria-busy={busy}>
        <fieldset disabled={busy}>
          <label className="field">项目名称<input ref={nameInput} aria-label="项目名称" required maxLength={200} placeholder="给这段旅程起个名字" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <div className="project-date-fields"><label className="field">开始时间<input aria-label="开始时间" type="datetime-local" required step="1" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })} /></label>
            <label className="field">结束时间<input aria-label="结束时间" type="datetime-local" required step="1" value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value })} /></label></div>
        </fieldset>
        <p className="project-timezone">北京时间 · UTC+8</p>
        {error && <p className="project-error" role="alert">{error}</p>}
        <div className="project-dialog-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy} className="project-save">{busy && <LoaderCircle size={14} className="spinning" />}{busy ? "保存中…" : "保存项目"}</Button></div>
      </form>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
