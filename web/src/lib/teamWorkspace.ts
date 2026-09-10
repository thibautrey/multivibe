export type TeamWorkspace = {
  state: "personal" | "team" | "unavailable";
  role: "owner" | "admin" | "billing" | "member" | null;
};
export function canManageWorkspace(context: TeamWorkspace): boolean {
  return context.state === "personal" || (context.state === "team" && (context.role === "owner" || context.role === "admin"));
}
export function workspaceLabel(context: TeamWorkspace): string {
  if (context.state === "personal") return "Personal workspace";
  if (context.state === "unavailable") return "Checking Team access";
  return context.role === "owner" || context.role === "admin" ? "Team administration" : "Team workspace";
}
