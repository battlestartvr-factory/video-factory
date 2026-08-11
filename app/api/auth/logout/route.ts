import { logoutHandler } from "@/lib/api/projects-handler";

export async function POST() {
  return logoutHandler();
}
