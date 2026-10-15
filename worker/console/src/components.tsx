import type { ButtonHTMLAttributes, ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Switch from "@radix-ui/react-switch";

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`button ${className}`} {...props} />;
}
export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <Tooltip.Root><Tooltip.Trigger asChild>
    <Button aria-label={label} className="icon-button" {...props}>{children}</Button>
  </Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={8}>{label}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}
export function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <label className="toggle-label"><span>{label}</span><Switch.Root aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} className="switch"><Switch.Thumb className="switch-thumb" /></Switch.Root></label>;
}
export function Mark() {
  return <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true"><path d="M6 30V14L20 25 34 9" /><circle cx="6" cy="30" r="2.8" /><circle cx="6" cy="14" r="2.8" /><circle cx="20" cy="25" r="2.8" /><circle cx="34" cy="9" r="2.8" /></svg>;
}
