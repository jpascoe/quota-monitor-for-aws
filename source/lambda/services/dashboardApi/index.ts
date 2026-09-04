import { APIGatewayProxyResultV2, LambdaFunctionURLHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = process.env.QUOTA_TABLE!;
type Item = Record<string, unknown>;
const number = (v: unknown) => Number(v ?? 0);
const normalize = (x: Item) => { const current = number(x.CurrentUsage), limit = number(x.LimitAmount), percent = limit ? current / limit * 100 : 0; return { quotaId: `${x.AccountId ?? ""}:${x.Region ?? ""}:${x.Service ?? ""}:${x.LimitCode ?? x.LimitName ?? ""}`, accountId: x.AccountId ?? "", region: x.Region ?? "", serviceCode: x.Service ?? "", quotaName: x.LimitName ?? "", quotaCode: x.LimitCode ?? "", currentUtilization: current, quotaValue: limit, utilizationPercent: percent, status: String(x.Status ?? (percent >= 95 ? "ERROR" : percent >= 80 ? "WARN" : "OK")), timestamp: x.TimeStamp ?? "", source: x.Source ?? "" }; };
const response = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const handler: LambdaFunctionURLHandler = async (event) => {
  if (event.requestContext.http.method === "OPTIONS") return response(204, "");
  try {
    const path = event.rawPath || "/"; const qs = event.queryStringParameters ?? {};
    if (path === "/metadata") return response(200, { items: [], generatedAt: new Date().toISOString(), filters: ["service", "accountId", "region", "status"] });
    const result = await db.send(new ScanCommand({ TableName: table }));
    let items = (result.Items ?? []).map(normalize);
    if (qs.service) items = items.filter(x => x.serviceCode === qs.service); if (qs.accountId) items = items.filter(x => x.accountId === qs.accountId); if (qs.region) items = items.filter(x => x.region === qs.region); if (qs.status) items = items.filter(x => x.status === qs.status);
    const latest = new Map<string, ReturnType<typeof normalize>>(); for (const item of items) { const old = latest.get(item.quotaId); if (!old || String(item.timestamp) > String(old.timestamp)) latest.set(item.quotaId, item); }
    items = [...latest.values()].sort((a, b) => b.utilizationPercent - a.utilizationPercent);
    const limit = Math.min(Math.max(Number(qs.limit ?? 100), 1), 500); const offset = Number(qs.cursor ?? 0); const page = items.slice(offset, offset + limit);
    if (path === "/summary") { const counts = { healthy: 0, warning: 0, critical: 0 }; items.forEach(x => { if (x.status === "ERROR" || x.utilizationPercent >= 95) counts.critical++; else if (x.status === "WARN" || x.utilizationPercent >= 80) counts.warning++; else counts.healthy++; }); return response(200, { items: [{ totalQuotas: items.length, ...counts, accounts: new Set(items.map(x => x.accountId)).size, regions: new Set(items.map(x => x.region)).size }], nextCursor: null, generatedAt: new Date().toISOString() }); }
    return response(200, { items: page, nextCursor: offset + limit < items.length ? String(offset + limit) : null, generatedAt: new Date().toISOString() });
  } catch (error) { console.error(error); return response(500, { message: "Dashboard data unavailable", code: "BACKEND_ERROR" }); }
};
