import { env } from "cloudflare:workers";
import { handleHttpApi } from "../../../server/service.mjs";
export const dynamic = "force-dynamic";
async function handle(request: Request) { return handleHttpApi(request, env); }
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
