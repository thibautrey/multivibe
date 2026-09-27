export type TeamWorkspace = {
  state: "personal" | "team" | "unavailable";
  role: "owner" | "admin" | "billing" | "member" | null;
};
export function canManageWorkspace(context: TeamWorkspace): boolean {
  return context.state !== "team" || context.role === "owner" || context.role === "admin";
}
export function workspaceLabel(context: TeamWorkspace): string {
  if (context.state !== "team") return "Personal workspace";
  return context.role === "owner" || context.role === "admin" ? "Team administration" : "Team workspace";
}
