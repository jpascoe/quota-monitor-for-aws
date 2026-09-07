import { GetCostAndUsageCommand, GetCostForecastCommand, CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { FreeTierClient, GetFreeTierUsageCommand, FreeTierUsage } from "@aws-sdk/client-freetier";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

const tableName = process.env.BILLING_TABLE!;
const readerRoleArn = process.env.BILLING_READER_ROLE_ARN!;
const billingViewArn = process.env.BILLING_VIEW_ARN!;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type CostRecord = { service: string; currentCost: number; forecastCost: number; currency: string };
const day = (value: Date) => value.toISOString().slice(0, 10);
const startOfMonth = (value: Date) => `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-01`;
const startOfNextMonth = (value: Date) => `${value.getUTCFullYear() + (value.getUTCMonth() === 11 ? 1 : 0)}-${String(value.getUTCMonth() === 11 ? 1 : value.getUTCMonth() + 2).padStart(2, "0")}-01`;
const asNumber = (value: string | undefined) => Number(value ?? 0);
const costFilter: any = { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } };

async function billingCredentials() {
  const result = await new STSClient({}).send(new AssumeRoleCommand({ RoleArn: readerRoleArn, RoleSessionName: "quota-monitor-billing-collector", DurationSeconds: 900 }));
  if (!result.Credentials?.AccessKeyId || !result.Credentials.SecretAccessKey || !result.Credentials.SessionToken) throw new Error("Billing reader role did not return credentials");
  return { accessKeyId: result.Credentials.AccessKeyId, secretAccessKey: result.Credentials.SecretAccessKey, sessionToken: result.Credentials.SessionToken, expiration: result.Credentials.Expiration };
}

async function getFreeTierUsage(client: FreeTierClient): Promise<FreeTierUsage[]> {
  const records: FreeTierUsage[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new GetFreeTierUsageCommand({ nextToken }));
    records.push(...(page.freeTierUsages ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return records;
}

export const handler = async (): Promise<void> => {
  const now = new Date();
  const snapshotDate = day(now);
  const expiresAt = Math.floor(now.getTime() / 1000) + 400 * 24 * 60 * 60;
  const credentials = await billingCredentials();
  const ce = new CostExplorerClient({ region: "us-east-1", credentials });
  const freeTier = new FreeTierClient({ region: "us-east-1", credentials });
  const timePeriod = { Start: startOfMonth(now), End: snapshotDate };
  const costs = await ce.send(new GetCostAndUsageCommand({ TimePeriod: timePeriod, Granularity: "MONTHLY", Metrics: ["UnblendedCost"], GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }], Filter: costFilter, BillingViewArn: billingViewArn }));
  const services = (costs.ResultsByTime ?? []).flatMap(result => result.Groups ?? []).map(group => ({ service: group.Keys?.[0] ?? "Unknown", amount: asNumber(group.Metrics?.UnblendedCost?.Amount), currency: group.Metrics?.UnblendedCost?.Unit ?? "USD" }));
  const forecastStart = snapshotDate;
  const costRecords: CostRecord[] = [];
  // Cost Explorer is rate limited. Forecast calls are deliberately serial: this
  // scheduled job is the only caller, and predictable completion is preferable
  // to a burst of throttled requests.
  for (const service of services.filter(service => service.amount > 0)) {
    try {
      const forecast = await ce.send(new GetCostForecastCommand({ TimePeriod: { Start: forecastStart, End: startOfNextMonth(now) }, Metric: "UNBLENDED_COST", Granularity: "MONTHLY", BillingViewArn: billingViewArn, Filter: { And: [costFilter, { Dimensions: { Key: "SERVICE", Values: [service.service] } }] } }));
      const remaining = forecast.Total?.Amount ? asNumber(forecast.Total.Amount) : 0;
      costRecords.push({ service: service.service, currentCost: service.amount, forecastCost: service.amount + remaining, currency: service.currency });
    } catch (error) {
      // Forecast availability varies by service and month. Keep the actual
      // charge visible instead of failing the whole organization snapshot.
      console.warn(JSON.stringify({ message: "Service forecast unavailable", service: service.service, errorName: error instanceof Error ? error.name : "Unknown" }));
      costRecords.push({ service: service.service, currentCost: service.amount, forecastCost: service.amount, currency: service.currency });
    }
  }
  const freeTierRecords = await getFreeTierUsage(freeTier);
  const collectedAt = now.toISOString();
  const puts = [
    ...costRecords.map(record => db.send(new PutCommand({ TableName: tableName, Item: { SnapshotDate: snapshotDate, RecordKey: `COST#${record.service}`, RecordType: "COST", ...record, Estimated: true, CollectedAt: collectedAt, ExpiresAt: expiresAt } }))),
    ...freeTierRecords.map(record => db.send(new PutCommand({ TableName: tableName, Item: { SnapshotDate: snapshotDate, RecordKey: `FREE#${record.service}#${record.usageType}#${record.region}`, RecordType: "FREE_TIER", Service: record.service, Operation: record.operation ?? "", UsageType: record.usageType, Region: record.region, ActualUsage: Number(record.actualUsageAmount ?? 0), ForecastUsage: Number(record.forecastedUsageAmount ?? 0), Limit: Number(record.limit ?? 0), Unit: record.unit, FreeTierType: record.freeTierType, Description: record.description, CollectedAt: collectedAt, ExpiresAt: expiresAt } }))),
  ];
  const currentTotal = costRecords.reduce((total, record) => total + record.currentCost, 0);
  const forecastTotal = costRecords.reduce((total, record) => total + record.forecastCost, 0);
  puts.push(db.send(new PutCommand({ TableName: tableName, Item: { SnapshotDate: snapshotDate, RecordKey: "SUMMARY", RecordType: "SUMMARY", CurrentTotal: currentTotal, ForecastTotal: forecastTotal, Currency: costRecords[0]?.currency ?? "USD", CostServiceCount: costRecords.length, FreeTierCount: freeTierRecords.length, CollectedAt: collectedAt, ExpiresAt: expiresAt } })));
  await Promise.all(puts);
  console.info(JSON.stringify({ message: "Billing snapshot collected", snapshotDate, costServiceCount: costRecords.length, freeTierCount: freeTierRecords.length }));
};
