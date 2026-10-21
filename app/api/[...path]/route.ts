import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { handleApi } from "../../../server/service.mjs";
export const dynamic = "force-dynamic";
async function handle(request: Request) { return handleApi(request, env, await getChatGPTUser()); }
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
