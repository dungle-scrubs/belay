import { decodeDoctorSnapshot } from "@trevor/session";
import { CommandResult } from "../message";
import { DoctorPanel } from "./doctor-panel";

/**
 * Renders a `/doctor` command result (D-073 M5): when the host sent the structured `doctor.current`
 * snapshot, it renders the health dashboard; otherwise (a legacy `/doctor text` dump or an error)
 * it falls back to the plain command-result row. This keeps `/doctor` in the transcript like any
 * other command while upgrading its default rendering to the dashboard.
 */
export function DoctorResult({
  command,
  text,
  ok,
}: {
  command: string;
  text: string;
  ok: boolean;
}) {
  const snapshot = decodeDoctorSnapshot(text);
  if (!snapshot) {
    return <CommandResult command={command} text={text} ok={ok} />;
  }
  return <DoctorPanel snapshot={snapshot} />;
}
