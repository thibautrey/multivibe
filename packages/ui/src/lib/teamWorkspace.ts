import { t } from "../i18n/core";

export type TeamWorkspace = {
  state: "personal" | "team" | "unavailable";
  role: "owner" | "admin" | "billing" | "member" | null;
};
export function canManageWorkspace(context: TeamWorkspace): boolean {
  return context.state !== "team" || context.role === "owner" || context.role === "admin";
}
export function workspaceLabel(context: TeamWorkspace): string {
  if (context.state !== "team") return t("Personal workspace");
  return context.role === "owner" || context.role === "admin" ? t("Team administration") : t("Team workspace");
}
