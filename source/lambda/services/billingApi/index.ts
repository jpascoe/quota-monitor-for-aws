import { APIGatewayProxyResultV2, LambdaFunctionURLHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env.BILLING_TABLE!;
const response = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const number = (value: unknown) => Number(value ?? 0);
const latestRecords = (items: Record<string, unknown>[]) => {
  const latest = items.reduce((date, item) => String(item.SnapshotDate) > date ? String(item.SnapshotDate) : date, "");
  return items.filter(item => String(item.SnapshotDate) === latest);
};

export const handler: LambdaFunctionURLHandler = async event => {
  if (event.requestContext.http.method === "OPTIONS") return response(204, "");
  try {
    const result = await db.send(new ScanCommand({ TableName: tableName }));
    const records = latestRecords((result.Items ?? []) as Record<string, unknown>[]);
    const path = `/${(event.rawPath || "/").replace(/^\/+/, "")}`;
    const query = event.queryStringParameters ?? {};
    const generatedAt = new Date().toISOString();
    if (path === "/metadata") return response(200, { items: [], nextCursor: null, generatedAt, snapshotDate: records[0]?.SnapshotDate ?? null });
    const summary = records.find(record => record.RecordType === "SUMMARY");
    if (path === "/summary") return response(200, { items: summary ? [{ currentTotal: number(summary.CurrentTotal), forecastTotal: number(summary.ForecastTotal), currency: summary.Currency, costServiceCount: number(summary.CostServiceCount), freeTierCount: number(summary.FreeTierCount), collectedAt: summary.CollectedAt, estimated: true }] : [], nextCursor: null, generatedAt });
    let items = records.filter(record => path === "/costs" ? record.RecordType === "COST" : record.RecordType === "FREE_TIER");
    if (query.service) items = items.filter(item => String(item.Service ?? item.service) === query.service);
    const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
    const offset = Number(query.cursor ?? 0);
    const page = items.sort((a, b) => path === "/costs" ? number(b.forecastCost) - number(a.forecastCost) : number(b.ForecastUsage) / Math.max(number(b.Limit), 1) - number(a.ForecastUsage) / Math.max(number(a.Limit), 1)).slice(offset, offset + limit);
    return response(200, { items: page, nextCursor: offset + limit < items.length ? String(offset + limit) : null, generatedAt });
  } catch (error) {
    console.error(JSON.stringify({ message: "Billing dashboard data unavailable", error: error instanceof Error ? error.name : "UnknownError" }));
    return response(500, { message: "Billing dashboard data unavailable", code: "BACKEND_ERROR" });
  }
};
